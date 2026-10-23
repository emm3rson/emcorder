import { chromium } from 'playwright'
import { mkdir, writeFile, copyFile, readdir, stat, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import electronPath from 'electron'
import { addOverlayMarker } from './overlay-marker.mjs'

// Default to Chromium's synthetic camera. Use --physical to select the attached UGREEN camera.
const quick = process.argv.includes('--quick')
const physical = process.argv.includes('--physical')
const cover = quick || process.argv.includes('--cover')
const lengths = quick ? [20] : [60, 300]
const artifactDir = resolve('tests/artifacts')
const runLabel = `${physical ? 'physical' : 'synthetic'}${quick ? '-quick' : ''}`
const resultsPath = join(artifactDir, `spike-${runLabel}-results.json`)
await mkdir(artifactDir, { recursive: true })
const env = { ...process.env }
env.EMCORDER_TEST_USER_DATA = join(artifactDir, `spike-${runLabel}-user-data`)
delete env.ELECTRON_RUN_AS_NODE
const mediaArgs = physical
  ? ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  : ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
const portServer = createServer()
await new Promise((resolve, reject) => {
  portServer.once('error', reject)
  portServer.listen(0, '127.0.0.1', resolve)
})
const remoteDebuggingPort = portServer.address().port
await new Promise((resolve) => portServer.close(resolve))
const child = spawn(electronPath, [`--remote-debugging-port=${remoteDebuggingPort}`, '--remote-debugging-address=127.0.0.1', ...mediaArgs, '.'], { env, stdio: 'ignore', windowsHide: false })
const endpoint = `http://127.0.0.1:${remoteDebuggingPort}`
let application
let studio
const connectStartedAt = Date.now()
while (!application && Date.now() - connectStartedAt < 30_000) {
  if (child.exitCode !== null) throw new Error(`Electron exited before its CDP endpoint was ready (code ${child.exitCode})`)
  try {
    application = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 2_000 })
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
if (!application) {
  child.kill()
  throw new Error('Timed out connecting to the Electron CDP endpoint')
}
const context = application.contexts()[0]
if (!context) {
  await application.close().catch(() => {})
  child.kill()
  throw new Error('Electron did not expose a browser context over CDP')
}
const pageStartedAt = Date.now()
while (!studio && Date.now() - pageStartedAt < 30_000) {
  studio = context.pages()[0]
  if (!studio) await new Promise((resolve) => setTimeout(resolve, 100))
}
if (!studio) {
  await application.close().catch(() => {})
  child.kill()
  throw new Error('Electron did not open its studio page')
}
const evidence = { physical, synthetic: !physical, quick, startedAt: new Date().toISOString(), clips: [], errors: [], info: [], externalAttempts: [], blockedExternalRequests: [], externalResponses: [] }
let coverBrowser
let currentStudio
let recordingAttempted = false

function positionStudio(covered) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SpikeWindow { [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach); }';
    $handle = (Get-Process -Id ([int]$env:EMCORDER_TEST_PID)).MainWindowHandle;
    if ($handle -eq [IntPtr]::Zero) { throw 'Could not resolve the studio window' };
    if ($env:EMCORDER_TEST_COVERED -eq '1') {
      if (-not [SpikeWindow]::SetWindowPos($handle, [IntPtr]1, 0, 0, 0, 0, 0x0013)) { throw 'Could not cover the studio' };
      $coverHandle = (Get-Process -Id ([int]$env:EMCORDER_TEST_COVER_PID)).MainWindowHandle;
      if ($coverHandle -eq [IntPtr]::Zero) { throw 'Could not resolve the covering window' };
      [uint32]$foregroundPid = 0;
      $foregroundThread = [SpikeWindow]::GetWindowThreadProcessId([SpikeWindow]::GetForegroundWindow(), [ref]$foregroundPid);
      $currentThread = [SpikeWindow]::GetCurrentThreadId();
      [void][SpikeWindow]::AttachThreadInput($currentThread, $foregroundThread, $true);
      try { [void][SpikeWindow]::SetForegroundWindow($coverHandle) } finally { [void][SpikeWindow]::AttachThreadInput($currentThread, $foregroundThread, $false) }
    } else {
      if (-not [SpikeWindow]::SetWindowPos($handle, [IntPtr]0, 0, 0, 0, 0, 0x0043)) { throw 'Could not restore the studio' };
      [void][SpikeWindow]::SetForegroundWindow($handle)
    }
  `], { env: { ...process.env, EMCORDER_TEST_PID: String(child.pid), EMCORDER_TEST_COVER_PID: String(coverBrowser?.pid || 0), EMCORDER_TEST_COVERED: covered ? '1' : '0' }, windowsHide: true })
}

async function launchCoverApp() {
  const failures = []
  for (const channel of ['msedge', 'chrome']) {
    try {
      const browser = await chromium.launch({ channel, headless: false, args: ['--start-maximized'] })
      // A null viewport lets the maximized native browser use the full display bounds.
      const page = await browser.newPage({ viewport: null })
      await page.setContent(`<!doctype html><html><head><title>EmCorder occlusion test</title><style>
        * { box-sizing: border-box } html, body { width: 100%; height: 100%; margin: 0 }
        body { display: grid; place-items: center; background: #e9e6df; color: #252421; font: 32px system-ui }
        main { position: fixed; inset: 0; display: grid; place-items: center }
      </style></head><body><main>Recording test — another app covers EmCorder</main></body></html>`)
      const cdp = await browser.newBrowserCDPSession()
      const processes = await cdp.send('SystemInfo.getProcessInfo')
      const pid = processes.processInfo.find((process) => process.type === 'browser')?.id
      assert(pid, 'Could not resolve the covering browser process')
      return { browser, page, channel, pid }
    } catch (error) {
      failures.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Could not launch Edge or Chrome for the cover test. ${failures.join(' | ')}`)
}

async function countMagentaPixels(page, screenshot, region = null) {
  return page.evaluate(async ({ base64, region }) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const surface = new OffscreenCanvas(image.width, image.height)
    const context = surface.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Could not inspect the local PNG screenshot.')
    context.drawImage(image, 0, 0)
    image.close()
    const pixels = context.getImageData(0, 0, surface.width, surface.height).data
    let count = 0
    const x0 = region ? Math.floor(region.x * surface.width) : 0
    const y0 = region ? Math.floor(region.y * surface.height) : 0
    const x1 = region ? Math.ceil((region.x + region.width) * surface.width) : surface.width
    const y1 = region ? Math.ceil((region.y + region.height) * surface.height) : surface.height
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * surface.width + x) * 4
        if (pixels[i] > 240 && pixels[i + 1] < 24 && pixels[i + 2] > 240 && pixels[i + 3] > 240) count++
      }
    }
    return count
  }, { base64: screenshot.toString('base64'), region })
}

try {
  currentStudio = studio
  positionStudio(false)
  studio.on('pageerror', (error) => evidence.errors.push(String(error)))
  studio.on('console', (message) => {
    if (message.type() !== 'error') return
    // MediaPipe writes this informational native-runtime message to stderr.
    if (message.text() === 'INFO: Created TensorFlow Lite XNNPACK delegate for CPU.') evidence.info.push(message.text())
    else evidence.errors.push(message.text())
  })
  const externalRequest = (request) => /^https?:/i.test(request.url())
  studio.on('request', (request) => { if (externalRequest(request)) evidence.externalAttempts.push(request.url()) })
  studio.on('requestfailed', (request) => {
    if (externalRequest(request)) evidence.blockedExternalRequests.push({ url: request.url(), error: request.failure()?.errorText || 'request failed' })
  })
  studio.on('response', (response) => {
    if (externalRequest(response.request()) && response.status() >= 200 && response.status() < 300) {
      evidence.externalResponses.push({ url: response.url(), status: response.status() })
    }
  })

  if (physical) {
    // Grant device-label access first so the known camera can be selected even when
    // Windows' default camera cannot satisfy the app's exact 720p/30 request.
    const ugreen = await studio.evaluate(async () => {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      permissionStream.getTracks().forEach((track) => track.stop())
      const devices = await navigator.mediaDevices.enumerateDevices()
      const device = devices.find((item) => item.kind === 'videoinput' && /UGREEN/i.test(item.label))
      return device ? { label: device.label, value: device.deviceId } : null
    })
    assert(ugreen, 'No camera option labelled UGREEN is available after permission was granted')
    const camera = studio.getByLabel('Camera', { exact: true })
    await studio.waitForFunction((label) => [...document.querySelectorAll('label select')].some((select) => [...select.options].some((option) => option.label === label)), ugreen.label, { timeout: 10_000 })
    await camera.selectOption({ label: ugreen.label })
    evidence.selectedCamera = ugreen.label
  }

  // Bypass animation-frame actionability checks: an occluded window can suspend RAF.
  // Native focus and visibility are checked separately below.
  if (physical) await studio.getByRole('button', { name: 'Connect', exact: true }).click({ force: true })
  else await studio.getByRole('button', { name: 'Connect camera', exact: true }).click({ force: true })
  await studio.getByRole('button', { name: /(?:●\s*)?Record/, exact: true }).waitFor({ state: 'visible' })
  await studio.waitForFunction(() => ![...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Record'))?.disabled, null, { timeout: 30_000, polling: 100 })
  await studio.waitForFunction(() => {
    return [...document.querySelectorAll('[role=status]')].some((node) => node.textContent === 'Camera blur is ready.' || node.textContent?.startsWith('Camera blur is running slowly;'))
  }, null, { timeout: 30_000, polling: 100 })

  const overlay = studio.getByTestId('prompter-overlay')
  await studio.getByRole('button', { name: 'Show overlay', exact: true }).click({ force: true })
  await overlay.waitFor({ state: 'visible' })
  assert((await overlay.innerText()).trim(), 'Prompter overlay should contain sample text')
  await studio.getByRole('button', { name: 'Hide overlay', exact: true }).click({ force: true })
  await overlay.waitFor({ state: 'hidden' })
  await studio.getByRole('button', { name: 'Show prompter', exact: true }).click({ force: true })
  await overlay.waitFor({ state: 'visible' })
  const marker = await addOverlayMarker(studio)
  await marker.waitFor({ state: 'visible' })
  const visibleMarkerPixels = await countMagentaPixels(studio, await marker.screenshot())
  assert(visibleMarkerPixels > 0, 'Overlay test marker is not visible on screen')
  const markerBox = await marker.boundingBox()
  const previewBox = await studio.locator('.preview-frame').boundingBox()
  assert(markerBox && previewBox, 'Could not locate the preview overlay marker')
  const markerRegion = {
    x: (markerBox.x - previewBox.x) / previewBox.width,
    y: (markerBox.y - previewBox.y) / previewBox.height,
    width: markerBox.width / previewBox.width,
    height: markerBox.height / previewBox.height,
  }
  await studio.screenshot({ path: join(artifactDir, `studio-${runLabel}-overlay.png`) })

  const runtime = await studio.evaluate(() => ({ userAgent: navigator.userAgent }))
  runtime.userData = env.EMCORDER_TEST_USER_DATA
  evidence.runtime = runtime
  assert.equal(context.pages().length, 1, 'The studio must remain the only Electron window')

  for (const seconds of lengths) {
    // Review unmounts the overlay, so instrument each new take's DOM layer.
    const takeMarker = await addOverlayMarker(studio)
    assert(await countMagentaPixels(studio, await takeMarker.screenshot()) > 0, 'Each take must have a visible exclusion marker')
    const takesDir = join(runtime.userData, 'takes')
    const existingTakes = new Set(await readdir(takesDir).catch(() => []))

    // Launch a separate browser app before recording. Bringing its neutral page forward
    // during capture covers the studio without opening another Electron BrowserWindow.
    if (cover) {
      coverBrowser = await launchCoverApp()
      evidence.coverBrowser = coverBrowser.channel
    }
    recordingAttempted = true
    await studio.getByRole('button', { name: /(?:●\s*)?Record/, exact: true }).click({ force: true })
    await studio.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true }).waitFor()
    const recordingStartedAt = Date.now()
    const liveName = (await readdir(takesDir)).find((name) => !existingTakes.has(name))
    assert(liveName, 'The main process did not create a temporary take')
    await studio.screenshot({ path: join(artifactDir, `studio-${runLabel}-${seconds}s-visible.png`) })
    if (cover) {
      await coverBrowser.page.screenshot({ path: join(artifactDir, `cover-${runLabel}-${seconds}s.png`) })
      await coverBrowser.page.bringToFront()
      positionStudio(true)
      await studio.waitForFunction(() => !document.hasFocus(), null, { timeout: 5000, polling: 100 })
      const focusState = await studio.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState }))
      assert.equal(focusState.focused, false, 'The studio must actually lose focus for this test')
      evidence.coveredFocusState = focusState
    }

    let streamedBytes = 0
    while (Date.now() - recordingStartedAt < seconds * 1000 && await studio.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true }).isVisible()) {
      const handle = await open(join(takesDir, liveName), 'r')
      try { streamedBytes = Math.max(streamedBytes, (await handle.stat()).size) } finally { await handle.close() }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, seconds * 1000 - (Date.now() - recordingStartedAt)))))
    }
    assert(streamedBytes > 0, 'No chunks reached disk while recording')
    if (cover) positionStudio(false)
    if (await studio.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true }).isVisible()) await studio.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true }).click({ force: true })
    await coverBrowser?.browser.close()
    coverBrowser = undefined
    await studio.bringToFront()

    await studio.locator('#review-video[aria-busy="false"]').waitFor({ timeout: 30_000 })
    recordingAttempted = false
    await studio.bringToFront()
    const media = await studio.locator('#review-video').evaluate(async (video) => {
      await video.play()
      await new Promise((resolve) => setTimeout(resolve, 1200))
      video.pause()
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime, decoded: video.getVideoPlaybackQuality().totalVideoFrames }
    })
    assert.equal(media.width, 1280)
    assert.equal(media.height, 720)
    assert(Math.abs(media.duration - seconds) < 3, `Unexpected duration: ${media.duration}`)
    assert(media.currentTime > 0.5 && media.decoded > 0, 'Video did not decode during playback')

    const frameHashes = []
    const fractions = physical ? [0.5] : [0.1, 0.5, 0.9]
    const reviewVideo = studio.locator('#review-video')
    await reviewVideo.evaluate((video) => { video.controls = false })
    for (const fraction of fractions) {
      await reviewVideo.evaluate(async (video, target) => {
        const targetTime = video.duration * target
        const sought = new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }))
        const rendered = new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error('Timed out decoding a sampled frame')), 10_000)
          const waitForTargetFrame = (_now, metadata) => {
            if (Math.abs(metadata.mediaTime - targetTime) <= 0.15) {
              clearTimeout(deadline)
              resolve()
            } else video.requestVideoFrameCallback(waitForTargetFrame)
          }
          video.requestVideoFrameCallback(waitForTargetFrame)
        })
        video.currentTime = targetTime
        await Promise.all([sought, rendered])
      }, fraction)
      const frame = await reviewVideo.screenshot()
      const magentaPixels = await countMagentaPixels(studio, frame, markerRegion)
      assert(magentaPixels < visibleMarkerPixels * 0.1, 'The DOM prompter overlay marker leaked into the recorded video')
      frameHashes.push(createHash('sha256').update(frame).digest('hex'))
      await writeFile(join(artifactDir, `frame-${runLabel}-${seconds}s-${fraction}.png`), frame)
    }
    if (!physical) assert.equal(new Set(frameHashes).size, 3, 'Synthetic clock/pie frames froze during recording')
    await reviewVideo.evaluate((video) => { video.controls = true })

    const files = await Promise.all((await readdir(takesDir)).map(async (name) => ({ name, info: await stat(join(takesDir, name)) })))
    const latest = files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)[0]
    const output = join(artifactDir, `${runLabel}-${seconds}s.mp4`)
    await copyFile(join(takesDir, latest.name), output)
    evidence.clips.push({ targetSeconds: seconds, ...media, frameHashes, streamedBytes, bytes: latest.info.size, file: output, blur: await studio.locator('.card [role=status]').textContent(), overlayVisiblePixels: visibleMarkerPixels })
    await studio.screenshot({ path: join(artifactDir, `review-${runLabel}-${seconds}s.png`) })
    console.log(JSON.stringify(evidence.clips.at(-1)))
    await studio.getByRole('button', { name: 'Retake', exact: true }).click({ force: true })
    await studio.getByRole('button', { name: 'Discard', exact: true }).click({ force: true })
  }
  assert.equal(evidence.externalResponses.length, 0, 'An external runtime request received a successful response')
  assert.equal(evidence.errors.length, 0, 'Renderer errors occurred')
} catch (error) {
  evidence.failure = String(error)
  const studio = currentStudio
  if (studio) {
    evidence.screen = await studio.locator('body').innerText().catch(() => '')
    await studio.screenshot({ path: join(artifactDir, `failure-${runLabel}.png`) }).catch(() => {})
  }
  throw error
} finally {
  if (recordingAttempted && currentStudio) {
    try { positionStudio(false) } catch {}
    await coverBrowser?.browser.close().catch(() => {})
    coverBrowser = undefined
    try {
      const stop = currentStudio.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true })
      if (await stop.isVisible()) await stop.click({ timeout: 2_000, force: true })
      await currentStudio.locator('#review-video[aria-busy="false"]').waitFor({ timeout: 20_000 })
    } catch {
      // Preserve any partially written take for investigation; never discard it on failure.
    }
  }
  await coverBrowser?.browser.close().catch(() => {})
  await writeFile(resultsPath, JSON.stringify(evidence, null, 2))
  await Promise.race([
    studio?.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1_500)),
  ])
  await application?.close().catch(() => {})
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
  }
  if (child.exitCode === null) child.kill()
}
