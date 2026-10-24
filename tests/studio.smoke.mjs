import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { addOverlayMarker } from './overlay-marker.mjs'

const root = await mkdtemp(join(tmpdir(), 'emcorder-studio-smoke-'))
const userData = join(root, 'user-data')
const outputDir = join(root, 'saved')
const typedOutputDir = join(root, 'typed-destination')
const takesDir = join(userData, 'takes')
const artifactDir = resolve('tests/artifacts')
await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(typedOutputDir, { recursive: true }), mkdir(artifactDir, { recursive: true })])
const env = { ...process.env, EMCORDER_TEST_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE

let app
let page

async function launch(connectCamera = true) {
  app = await electron.launch({
    executablePath: electronPath,
    env,
    headless: false,
    timeout: 30_000,
    chromiumSandbox: false,
    args: [
      '--use-fake-device-for-media-stream=fps=30',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      resolve('.'),
    ],
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => { throw error })
  if (connectCamera) await connect()
  return page
}

async function connect() {
  const recovery = page.getByRole('button', { name: 'Reconnect', exact: true })
  if (await recovery.isVisible()) await recovery.click()
  else await page.getByRole('button', { name: 'Connect camera', exact: true }).click()
  await page.getByRole('button', { name: /(?:●\s*)?Record/, exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Record'))?.disabled, null, { timeout: 30_000 })
}

async function rejectNextCameraRequest(errorName) {
  await page.evaluate((name) => {
    const media = navigator.mediaDevices
    if (!window.__smokeOriginalGetUserMedia) {
      window.__smokeOriginalGetUserMedia = media.getUserMedia
    }
    Object.defineProperty(media, 'getUserMedia', {
      configurable: true,
      writable: true,
      value: async () => { throw new DOMException('Synthetic camera failure', name) },
    })
  }, errorName)
  const reconnect = page.getByRole('button', { name: 'Reconnect', exact: true })
  if (await reconnect.isVisible()) await reconnect.click()
  else await page.getByRole('button', { name: 'Connect camera', exact: true }).click()
  const expected = errorName === 'NotAllowedError'
    ? /Camera or microphone access was denied/
    : /camera or microphone is busy/i
  await page.getByRole('alert').filter({ hasText: expected }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Reconnect', exact: true }).waitFor({ state: 'visible' })
}

async function restoreCameraRequest() {
  await page.evaluate(() => {
    if (window.__smokeOriginalGetUserMedia) {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        writable: true,
        value: window.__smokeOriginalGetUserMedia,
      })
      delete window.__smokeOriginalGetUserMedia
    }
    if (window.__smokeOriginalEnumerateDevices) {
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
        configurable: true,
        writable: true,
        value: window.__smokeOriginalEnumerateDevices,
      })
      delete window.__smokeOriginalEnumerateDevices
    }
  })
}

async function closeCleanly() {
  if (!app) return
  if (page) {
    try {
      const stop = page.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true })
      if (await stop.isVisible()) {
        await stop.click({ timeout: 2_000, force: true })
        await page.locator('#review-video').waitFor({ state: 'visible', timeout: 20_000 })
      }
      const retake = page.getByRole('button', { name: 'Retake', exact: true })
      if (await retake.isVisible()) {
        await retake.click({ timeout: 2_000, force: true })
        const dialog = page.getByRole('dialog', { name: 'Retake this recording?' })
        const discard = dialog.getByRole('button', { name: 'Discard', exact: true })
        if (await discard.isVisible({ timeout: 1_000 }).catch(() => false)) await discard.click({ timeout: 2_000, force: true })
      }
    } catch { /* Best-effort recovery before closing the test app. */ }
  }
  const closing = app.close().catch(() => {})
  await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 5_000))])
  app = undefined
  page = undefined
}

async function takeNames() {
  return new Set(await readdir(takesDir).catch(() => []))
}

async function retakeUnsaved() {
  await page.getByRole('button', { name: 'Retake', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Retake this recording?' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
  await page.locator('.sidebar').waitFor({ state: 'visible' })
}

async function countMagentaPixels(screenshot, region) {
  return page.evaluate(async ({ base64, region }) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Could not inspect screenshot pixels')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const x0 = region ? Math.floor(region.x * canvas.width) : 0
    const y0 = region ? Math.floor(region.y * canvas.height) : 0
    const x1 = region ? Math.ceil((region.x + region.width) * canvas.width) : canvas.width
    const y1 = region ? Math.ceil((region.y + region.height) * canvas.height) : canvas.height
    let count = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const offset = (y * canvas.width + x) * 4
      if (pixels[offset] > 240 && pixels[offset + 1] < 24 && pixels[offset + 2] > 240 && pixels[offset + 3] > 240) count++
    }
    return count
  }, { base64: screenshot.toString('base64'), region })
}

async function waitForReview(inspectionComplete = true) {
  await page.locator('#review-video').waitFor({ state: 'visible', timeout: 20_000 })
  if (inspectionComplete) await page.locator('#review-video[aria-busy="false"]').waitFor({ timeout: 20_000 })
  const media = await page.locator('#review-video').evaluate(async (video) => {
    await new Promise((resolve, reject) => {
      if (Number.isFinite(video.duration) && video.duration > 0) return resolve()
      video.addEventListener('loadedmetadata', resolve, { once: true })
      video.addEventListener('error', () => reject(new Error('Review MP4 failed to load')), { once: true })
    })
    const duration = video.duration
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Review video did not seek')), 5_000)
      video.addEventListener('seeked', () => { clearTimeout(timeout); resolve() }, { once: true })
      video.currentTime = duration / 2
    })
    return { duration, currentTime: video.currentTime, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight }
  })
  assert(Number.isFinite(media.duration) && media.duration > 0, 'Review MP4 must have finite positive duration')
  assert(media.currentTime > 0, 'Review MP4 must seek to a nonzero position')
  return media
}

async function assertMirroredSides(selector, mirrored = true) {
  const media = page.locator(selector)
  assert.equal(await media.evaluate((element) => getComputedStyle(element).transform), 'none', 'Displayed media must preserve its pixel orientation')
  // Review uses recording://, so inspect a screenshot without tainting the canvas.
  const screenshot = await media.screenshot()
  const sides = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = 100
    canvas.height = 100
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0, 100, 100)
    bitmap.close()
    return {
      left: [...context.getImageData(25, 50, 1, 1).data],
      right: [...context.getImageData(75, 50, 1, 1).data],
    }
  }, screenshot.toString('base64'))
  const blue = mirrored ? sides.left : sides.right
  const red = mirrored ? sides.right : sides.left
  assert(blue[2] > 200 && blue[0] < 40, `Blue must appear on the ${mirrored ? 'left' : 'right'}`)
  assert(red[0] > 200 && red[2] < 40, `Red must appear on the ${mirrored ? 'right' : 'left'}`)
}

try {
  await launch(false)
  // Exercise real advisory delivery without depending on host segmentation speed.
  await page.evaluate(() => {
    window.__smokeNativeWorker = window.Worker
    window.Worker = class { constructor() { throw new Error('Synthetic blur failure') } }
  })
  await connect()
  const blurCard = page.locator('.blur-card')
  const beforeNotice = await blurCard.boundingBox()
  const toast = page.locator('.advisory-toast')
  await toast.waitFor({ state: 'visible' })
  assert.match(await toast.innerText(), /camera is showing without blur/)
  assert.deepEqual(await blurCard.boundingBox(), beforeNotice, 'Advisories must not resize or move the blur card')
  assert.equal(await blurCard.getByRole('status').count(), 0, 'Blur status must not appear inside the card')
  assert.equal(await toast.evaluate((element) => getComputedStyle(element).position), 'fixed')
  assert.equal(await toast.evaluate((element) => document.querySelector('.preview-frame')?.contains(element) ?? false), false,
    'Toast must be separate from the camera preview and recording canvas')
  const dismissNotice = page.getByRole('button', { name: 'Dismiss notification' })
  await toast.hover()
  await page.waitForTimeout(6200)
  assert(await toast.isVisible(), 'Hover must pause the toast timeout')
  await dismissNotice.focus()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(6200)
  assert(await toast.isVisible(), 'Keyboard focus must pause the toast timeout')
  await dismissNotice.click()
  await toast.waitFor({ state: 'detached' })
  await page.waitForTimeout(2300)
  assert.equal(await toast.count(), 0, 'A dismissed ongoing issue must not repeat')
  await page.getByLabel('Background blur', { exact: true }).uncheck()
  await page.getByLabel('Background blur', { exact: true }).check()
  await toast.waitFor({ state: 'visible' })
  assert(await page.getByLabel('Background blur', { exact: true }).evaluate((element) => document.activeElement === element),
    'A toast must not take keyboard focus')
  await page.mouse.move(0, 0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await toast.waitFor({ state: 'hidden' })
  await page.waitForTimeout(6200)
  await page.keyboard.press('Escape')
  await toast.waitFor({ state: 'visible' })
  await toast.waitFor({ state: 'detached', timeout: 9000 })
  await page.getByRole('button', { name: 'Record', exact: true }).click()
  await toast.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor()
  await dismissNotice.click()
  await page.waitForTimeout(2300)
  assert.equal(await toast.count(), 0, 'An ongoing issue must not repeat during the same take')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await waitForReview()
  await retakeUnsaved()
  await page.evaluate(() => {
    window.Worker = window.__smokeNativeWorker
    delete window.__smokeNativeWorker
  })
  // Check the real compositor upload path as well as the bundled model.
  await page.evaluate(() => {
    const prototype = WebGL2RenderingContext.prototype
    const probe = { original: prototype.texSubImage2D, context: null }
    window.__smokeBlurTextureProbe = probe
    prototype.texSubImage2D = function (...args) {
      const result = probe.original.apply(this, args)
      probe.context = this
      return result
    }
  })
  try {
    await page.getByRole('button', { name: 'Restart camera and microphone', exact: true }).click()
    await page.waitForFunction(() => window.__smokeBlurTextureProbe.context !== null, null, { timeout: 30_000 })
    assert.equal(await page.evaluate(() => window.__smokeBlurTextureProbe.context.getError()), 0,
      'The real compositor must accept immutable texture storage and content updates without WebGL errors')
  } finally {
    await page.evaluate(() => {
      WebGL2RenderingContext.prototype.texSubImage2D = window.__smokeBlurTextureProbe.original
      delete window.__smokeBlurTextureProbe
    })
  }

  // Feed stable camera pixels through the real compositor, filters, and MP4
  // encoder so this checks recorded output rather than preview-only CSS.
  const imageCard = page.locator('.image-card')
  assert.equal(await imageCard.evaluate((card) => card.open), false, 'Image controls should start collapsed')
  await imageCard.locator('summary').click()
  const imageSliders = ['Brightness', 'Contrast', 'Saturation'].map((name) => page.getByRole('slider', { name, exact: true }))
  const resetImage = page.getByRole('button', { name: 'Reset image adjustments', exact: true })
  for (const slider of imageSliders) assert.equal(await slider.inputValue(), '100')
  assert(await resetImage.isDisabled(), 'Neutral image settings need no Reset')
  const imageTrackIds = await page.locator('.source-video').evaluate((video) => video.srcObject.getTracks().map((track) => track.id))
  await page.evaluate(() => {
    window.__smokeImageDrawImage = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      window.__smokeImageDrawImage.call(this, source, ...args)
      if (source instanceof HTMLVideoElement && source.classList.contains('source-video')) {
        this.save()
        this.fillStyle = 'rgb(80, 120, 160)'
        this.fillRect(0, 0, this.canvas.width, this.canvas.height)
        this.restore()
      }
    }
  })
  const waitForImagePixel = (expected) => page.waitForFunction((expected) => {
    const canvas = document.querySelector('.camera-preview')
    const pixel = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
    return expected.every((value, channel) => Math.abs(value - pixel[channel]) <= 3)
  }, expected)
  await waitForImagePixel([80, 120, 160])
  await imageSliders[0].press('End')
  assert.equal(await imageSliders[0].inputValue(), '150', 'Brightness should support native range keys')
  await waitForImagePixel([120, 180, 240])
  await imageSliders[1].press('Home')
  await waitForImagePixel([124, 154, 184])
  await imageSliders[2].press('Home')
  const adjustedPixel = [137, 152, 167]
  await waitForImagePixel(adjustedPixel)
  assert.deepEqual(await page.locator('.source-video').evaluate((video) => video.srcObject.getTracks().map((track) => track.id)), imageTrackIds,
    'Image adjustments must not reconnect the camera or microphone')
  await page.getByLabel('Background blur', { exact: true }).uncheck()
  await waitForImagePixel(adjustedPixel)
  await page.getByLabel('Background blur', { exact: true }).check()
  await waitForImagePixel(adjustedPixel)
  await page.getByRole('button', { name: 'Record', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor()
  for (const control of [...imageSliders, resetImage]) assert(await control.isDisabled(), 'Image controls must lock during countdown')
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor()
  for (const control of [...imageSliders, resetImage]) assert(await control.isDisabled(), 'Image controls must lock during recording')
  await page.waitForTimeout(1_200)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await waitForReview()
  const recordedPixel = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(100, 100)
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0, 100, 100)
    bitmap.close()
    return [...context.getImageData(50, 50, 1, 1).data]
  }, (await page.locator('#review-video').screenshot()).toString('base64'))
  assert(adjustedPixel.every((value, channel) => Math.abs(value - recordedPixel[channel]) <= 12),
    `Encoded MP4 must retain image adjustments (observed ${recordedPixel})`)
  await retakeUnsaved()
  for (const slider of imageSliders) assert(await slider.isEnabled(), 'Retake must unlock image controls')
  await resetImage.click()
  for (const slider of imageSliders) assert.equal(await slider.inputValue(), '100')
  await waitForImagePixel([80, 120, 160])
  assert(await page.getByRole('radio', { name: 'Standard', exact: true }).isChecked(), 'Reset must preserve blur strength')
  assert.deepEqual(await page.locator('.source-video').evaluate((video) => video.srcObject.getTracks().map((track) => track.id)), imageTrackIds,
    'Reset must reuse the active capture')
  await page.waitForFunction(async () => {
    const preferences = await window.emcorder.getPreferences()
    return preferences.brightness === 100 && preferences.contrast === 100 && preferences.saturation === 100
  })
  await page.evaluate(() => {
    CanvasRenderingContext2D.prototype.drawImage = window.__smokeImageDrawImage
    delete window.__smokeImageDrawImage
  })
  await imageCard.locator('summary').click()

  let settingsButton, settingsDialog, countdownSetting, mirrorSetting, autoStartSetting, folderButton
  function bindSettings() {
    settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
    settingsDialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    countdownSetting = settingsDialog.getByLabel('Countdown', { exact: true })
    mirrorSetting = settingsDialog.getByRole('checkbox', { name: 'Mirror video', exact: true })
    autoStartSetting = settingsDialog.getByRole('checkbox', { name: 'Start prompter automatically', exact: true })
    folderButton = settingsDialog.getByRole('button', { name: /Change folder/ })
  }
  bindSettings()
  const closeSettings = () => settingsDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await settingsButton.click()
  assert.equal(await countdownSetting.inputValue(), '3')
  assert(await mirrorSetting.isChecked())
  assert(await autoStartSetting.isChecked())
  await settingsDialog.getByRole('heading', { name: 'Keyboard shortcuts' }).waitFor()
  await page.keyboard.press('Control+Shift+R')
  assert.equal(await page.locator('.countdown').count(), 0, 'Settings must block studio shortcuts')
  // A failed preferences write must remain visible until a later update succeeds.
  // All files here belong to this isolated test profile.
  const preferencesFile = join(userData, 'preferences.json')
  const preferencesBackup = join(userData, 'preferences-backup.json')
  await rename(preferencesFile, preferencesBackup)
  await mkdir(preferencesFile)
  try {
    await mirrorSetting.uncheck()
    await settingsDialog.getByRole('alert').filter({ hasText: /Preferences could not be saved/ }).waitFor()
  } finally {
    await rmdir(preferencesFile)
    await rename(preferencesBackup, preferencesFile)
  }
  await mirrorSetting.check()
  await settingsDialog.getByRole('alert').filter({ hasText: /Preferences could not be saved/ }).waitFor({ state: 'hidden' })
  await page.waitForFunction(async () => (await window.emcorder.getPreferences()).mirrorVideo)
  const originalFolder = (await page.evaluate(() => window.emcorder.getPreferences())).outputFolder
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
  await folderButton.click()
  await settingsDialog.getByRole('button', { name: 'Close', exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.emcorder.getPreferences())).outputFolder, originalFolder, 'Cancelling folder selection must retain the destination')
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => { throw new Error('Synthetic folder selection failure') } })
  await folderButton.click()
  await settingsDialog.getByRole('alert').filter({ hasText: 'Synthetic folder selection failure' }).waitFor()
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, outputDir)
  await folderButton.click()
  await settingsDialog.getByText(outputDir, { exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.emcorder.getPreferences())).outputFolder, outputDir)
  await page.keyboard.press('Escape')
  await settingsDialog.waitFor({ state: 'hidden' })
  assert(await settingsButton.evaluate((button) => document.activeElement === button), 'Closing Settings should restore header focus')

  const blurToggle = page.getByLabel('Background blur', { exact: true })
  const blurStrength = page.getByRole('group', { name: 'Blur strength', exact: true })
  const standardBlur = blurStrength.getByRole('radio', { name: 'Standard', exact: true })
  assert(await standardBlur.isChecked(), 'New profiles should keep the original Standard blur')
  const captureTrackIds = () => page.locator('.source-video').evaluate((video) => video.srcObject.getTracks().map((track) => track.id))
  const restartDevices = page.getByRole('button', { name: 'Restart camera and microphone', exact: true })
  const selectedBeforeRestart = await page.locator('select').evaluateAll((selects) => selects.map((select) => select.value))
  await page.locator('.source-video').evaluate((video) => {
    window.__smokePreviousTracks = video.srcObject.getTracks()
    video.pause()
    const media = navigator.mediaDevices
    window.__smokeOriginalGetUserMedia = media.getUserMedia
    Object.defineProperty(media, 'getUserMedia', { configurable: true, writable: true, value: async function (constraints) {
      window.__smokeRestartConstraints = constraints
      await new Promise((resolve) => { window.__smokeReleaseRestart = resolve })
      return window.__smokeOriginalGetUserMedia.call(this, constraints)
    } })
  })
  await restartDevices.click()
  await page.waitForFunction(() => !!window.__smokeReleaseRestart)
  assert(await restartDevices.isDisabled(), 'Restart must lock while reconnecting')
  for (const slider of await imageCard.locator('input[type="range"]').all()) assert(await slider.isDisabled(), 'Image adjustments must lock while reconnecting')
  assert(await page.getByRole('button', { name: 'Record', exact: true }).isDisabled(), 'Recording must lock while reconnecting')
  assert(await page.evaluate(() => window.__smokePreviousTracks.every((track) => track.readyState === 'ended')), 'Restart must release the old camera and microphone')
  await page.evaluate(() => window.__smokeReleaseRestart())
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Restart camera and microphone"]').disabled)
  assert(await page.locator('.source-video').evaluate((video) => !video.paused && video.srcObject.getTracks().every((track) => track.readyState === 'live')), 'Restart must resume live capture')
  await page.waitForFunction(() => document.querySelector('.source-video').currentTime > 0.1)
  assert.deepEqual(await page.locator('select').evaluateAll((selects) => selects.map((select) => select.value)), selectedBeforeRestart, 'Restart must retain selected devices and quality')
  const restartConstraints = await page.evaluate(() => window.__smokeRestartConstraints)
  assert.equal(restartConstraints.video.deviceId.exact, selectedBeforeRestart[0])
  assert.equal(restartConstraints.audio.deviceId.exact, selectedBeforeRestart[2])
  await restoreCameraRequest()

  // A failed manual restart must keep the normal recovery path available.
  await page.evaluate(() => {
    window.__smokeOriginalGetUserMedia = navigator.mediaDevices.getUserMedia
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, writable: true, value: async () => {
      throw new DOMException('Synthetic restart failure', 'NotReadableError')
    } })
  })
  await restartDevices.click()
  await page.getByRole('alert').filter({ hasText: /camera or microphone is busy/i }).waitFor()
  await restoreCameraRequest()
  await connect()
  const initialTrackIds = await captureTrackIds()
  await blurStrength.getByText('Light', { exact: true }).click()
  await page.waitForFunction(async () => (await window.emcorder.getPreferences()).blurStrength === 'light')
  await blurStrength.getByRole('radio', { name: 'Light', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  assert(await standardBlur.isChecked(), 'Native radio keys should select the next strength')
  await blurStrength.getByText('Strong', { exact: true }).click()
  await page.waitForFunction(async () => (await window.emcorder.getPreferences()).blurStrength === 'strong')
  assert.deepEqual(await captureTrackIds(), initialTrackIds, 'Blur strength changes must not reconnect capture')
  await blurToggle.uncheck()
  assert.equal(await blurStrength.count(), 0, 'Strength choices should hide when blur is off')
  await blurToggle.check()
  assert(await blurStrength.getByRole('radio', { name: 'Strong', exact: true }).isChecked(), 'Toggling blur should retain strength')

  // Exercise silence timing with deterministic analyser samples, without changing capture audio.
  await page.evaluate(() => {
    window.__smokeOriginalAnalyser = AnalyserNode.prototype.getByteTimeDomainData
    window.__smokeMicQuiet = true
    AnalyserNode.prototype.getByteTimeDomainData = function (data) {
      data.fill(window.__smokeMicQuiet ? 128 : 144)
    }
  })
  const micWarning = page.locator('.advisory-toast').filter({ hasText: 'Microphone input is quiet.' })
  await page.waitForTimeout(4_000)
  assert.equal(await micWarning.count(), 0, 'Preparation silence must not show a warning')
  await page.getByRole('button', { name: 'Record', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'visible' })
  assert.equal(await micWarning.count(), 0, 'Countdown silence must not show a warning')
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'visible' })
  await page.waitForTimeout(2_000)
  assert.equal(await micWarning.count(), 0, 'Preparation silence must not trigger an immediate recording warning')
  await micWarning.waitFor({ state: 'visible', timeout: 6_000 })
  assert.match(await micWarning.innerText(), /if you’re speaking/)
  await page.evaluate(() => { window.__smokeMicQuiet = false })
  await micWarning.waitFor({ state: 'hidden' })
  await page.evaluate(() => { window.__smokeMicQuiet = true })
  await page.waitForTimeout(9_000)
  assert.equal(await micWarning.count(), 0, 'A repeated quiet period must not notify again during the same take')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await waitForReview()
  assert.equal(await micWarning.count(), 0, 'Review must not show a microphone warning')
  await retakeUnsaved()
  await page.waitForTimeout(5_500)
  assert.equal(await micWarning.count(), 0, 'Stopping must cancel any pending silence warning')
  await page.evaluate(() => {
    AnalyserNode.prototype.getByteTimeDomainData = window.__smokeOriginalAnalyser
    delete window.__smokeOriginalAnalyser
    delete window.__smokeMicQuiet
  })

  const camera = page.getByLabel('Camera', { exact: true })
  const microphone = page.getByLabel('Microphone', { exact: true })
  const quality = page.getByLabel('Quality', { exact: true })
  assert.equal(await page.getByRole('button', { name: 'Apply', exact: true }).count(), 0, 'Device settings should not have an Apply button')
  assert.equal(await quality.inputValue(), '720p', 'New profiles should default to720p')
  assert.equal(await page.locator('.camera-preview').evaluate((canvas) => canvas.width), 1280)
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Quality"] option[value="1080p"]').disabled)
  await page.evaluate(() => {
    const media = navigator.mediaDevices
    window.__smokeOriginalGetUserMedia = media.getUserMedia
    window.__smokeQualityRequests = []
    Object.defineProperty(media, 'getUserMedia', { configurable: true, writable: true, value: function (constraints) {
      window.__smokeQualityRequests.push(structuredClone(constraints))
      return window.__smokeOriginalGetUserMedia.call(this, constraints)
    } })
  })
  await quality.selectOption('1080p')
  await page.waitForFunction(() => document.querySelector('.camera-preview').width === 1920 && !document.querySelector('select[aria-label="Quality"]').disabled)
  await page.waitForFunction(async () => (await window.emcorder.getPreferences()).quality === '1080p')
  const qualityRequests = await page.evaluate(() => window.__smokeQualityRequests)
  assert.equal(qualityRequests.length, 1, 'Quality selection should start exactly one reconnect')
  assert.equal(qualityRequests[0].video.width.exact, 1920, 'Quality reconnect should request 1080p immediately')
  assert.equal(qualityRequests[0].video.deviceId.exact, await camera.inputValue(), 'Quality reconnect should retain the selected camera')
  assert.equal(qualityRequests[0].audio.deviceId.exact, await microphone.inputValue(), 'Quality reconnect should retain the selected microphone')
  await restoreCameraRequest()

  // Selection changes on an active camera reconnect with the changed device
  // while retaining the other selected settings. Synthetic option IDs are
  // rewritten only at the browser boundary so Chromium's fake devices can
  // satisfy the request and the app still receives the exact requested IDs.
  await page.evaluate(() => {
    const media = navigator.mediaDevices
    const original = media.getUserMedia.bind(media)
    window.__smokeOriginalGetUserMedia = media.getUserMedia
    window.__smokeGumRequests = []
    window.__smokeHoldGum = false
    window.__smokeReject720 = false
    window.__smokeGumWaiters = []
    const realCamera = document.querySelector('select[aria-label="Camera"]').value
    const realMicrophone = document.querySelector('select[aria-label="Microphone"]').value
    window.__smokeRealCamera = realCamera
    window.__smokeRealMicrophone = realMicrophone
    window.__smokeOriginalEnumerateDevices = media.enumerateDevices
    const enumerate = media.enumerateDevices.bind(media)
    Object.defineProperty(media, 'enumerateDevices', { configurable: true, writable: true, value: async function () {
      return [...await enumerate(),
        { deviceId: 'smoke-camera-id', groupId: 'smoke-camera-group', kind: 'videoinput', label: 'Synthetic camera' },
        { deviceId: 'smoke-camera-720-id', groupId: 'smoke-camera-720-group', kind: 'videoinput', label: 'Synthetic 720p camera' },
        { deviceId: 'smoke-mic-id', groupId: 'smoke-mic-group', kind: 'audioinput', label: 'Synthetic microphone' },
      ]
    } })
    Object.defineProperty(media, 'getUserMedia', { configurable: true, writable: true, value: async function (constraints) {
      window.__smokeGumRequests.push(structuredClone(constraints))
      if (window.__smokeHoldGum) await new Promise((resolve) => window.__smokeGumWaiters.push(resolve))
      if (constraints.video?.deviceId?.exact === 'smoke-camera-720-id' && constraints.video?.width?.exact === 1920) {
        const failure = new DOMException('Synthetic device-specific 1080p rejection', 'OverconstrainedError')
        Object.defineProperty(failure, 'constraint', { value: 'deviceId' })
        throw failure
      }
      if (window.__smokeReject720 && constraints.video?.deviceId?.exact === 'smoke-camera-720-id' && constraints.video?.width?.exact === 1280) {
        const failure = new DOMException('Synthetic device-specific 720p rejection', 'OverconstrainedError')
        Object.defineProperty(failure, 'constraint', { value: 'deviceId' })
        throw failure
      }
      const actual = structuredClone(constraints)
      if (actual.video?.deviceId?.exact === 'smoke-camera-id') actual.video.deviceId.exact = realCamera
      if (actual.video?.deviceId?.exact === 'smoke-camera-720-id') actual.video.deviceId.exact = realCamera
      if (actual.audio?.deviceId?.exact === 'smoke-mic-id') actual.audio.deviceId.exact = realMicrophone
      const stream = await original(actual)
      for (const track of stream.getTracks()) {
        const syntheticId = track.kind === 'video' && ['smoke-camera-id', 'smoke-camera-720-id'].includes(constraints.video?.deviceId?.exact)
          ? constraints.video.deviceId.exact
          : track.kind === 'audio' && constraints.audio?.deviceId?.exact === 'smoke-mic-id'
            ? 'smoke-mic-id'
            : null
        if (syntheticId) {
          const settings = track.getSettings.bind(track)
          Object.defineProperty(track, 'getSettings', { configurable: true, value: () => ({ ...settings(), deviceId: syntheticId }) })
        }
      }
      return stream
    } })
    media.dispatchEvent(new Event('devicechange'))
  })
  await page.waitForFunction(() =>
    [...document.querySelector('select[aria-label="Camera"]').options].some((option) => option.value === 'smoke-camera-id') &&
    [...document.querySelector('select[aria-label="Microphone"]').options].some((option) => option.value === 'smoke-mic-id'))
  await page.evaluate(() => { window.__smokeHoldGum = true })
  await camera.selectOption('smoke-camera-id')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Record'))?.disabled)
  assert(await camera.isDisabled(), 'Camera selection should lock while its capture request is pending')
  assert(await microphone.isDisabled(), 'Microphone selection should lock while a capture request is pending')
  assert(await quality.isDisabled(), 'Quality selection should lock while a capture request is pending')
  assert.equal(await page.getByRole('button', { name: 'Apply', exact: true }).count(), 0)
  await page.waitForFunction(() => window.__smokeGumWaiters.length > 0)
  await page.evaluate(() => { for (const resolve of window.__smokeGumWaiters.splice(0)) resolve(); window.__smokeHoldGum = false })
  await page.waitForFunction(() => document.querySelector('.camera-preview').width === 1920 && !document.querySelector('select[aria-label="Camera"]').disabled)
  let requests = await page.evaluate(() => window.__smokeGumRequests)
  assert.equal(requests.length, 1, 'Camera selection should start exactly one reconnect')
  assert.equal(requests[0].video.deviceId.exact, 'smoke-camera-id', 'Reconnect should request the newly selected camera')
  assert.equal(requests[0].video.width.exact, 1920, 'Camera reconnect should retain 1080p quality')
  assert.equal(requests[0].audio.deviceId.exact, await microphone.inputValue(), 'Camera reconnect should retain the selected microphone')
  await page.evaluate(() => { window.__smokeGumRequests.length = 0; window.__smokeHoldGum = true })
  await microphone.selectOption('smoke-mic-id')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Record'))?.disabled)
  await page.waitForFunction(() => window.__smokeGumWaiters.length > 0)
  await page.evaluate(() => { for (const resolve of window.__smokeGumWaiters.splice(0)) resolve(); window.__smokeHoldGum = false })
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Microphone"]').disabled)
  requests = await page.evaluate(() => window.__smokeGumRequests)
  assert.equal(requests.length, 1, 'Microphone selection should start exactly one reconnect')
  assert.equal(requests[0].audio.deviceId.exact, 'smoke-mic-id', 'Reconnect should request the newly selected microphone')
  assert.equal(requests[0].video.deviceId.exact, 'smoke-camera-id', 'Microphone reconnect should retain the selected camera')
  assert.equal(requests[0].video.width.exact, 1920, 'Microphone reconnect should retain 1080p quality')

  await page.evaluate(() => { window.__smokeGumRequests.length = 0 })
  await camera.selectOption('smoke-camera-720-id')
  await page.waitForFunction(() =>
    document.querySelector('.camera-preview').width === 1280 &&
    !document.querySelector('select[aria-label="Camera"]').disabled &&
    !document.querySelector('select[aria-label="Quality"]').disabled &&
    document.querySelector('select[aria-label="Quality"]').value === '720p' &&
    document.querySelector('select[aria-label="Quality"] option[value="1080p"]').disabled)
  requests = await page.evaluate(() => window.__smokeGumRequests)
  assert.equal(requests.length, 2, 'Camera change should try 1080p then retry once at720p')
  assert.deepEqual(requests.map((request) => request.video.width.exact), [1920, 1280], '1080p should be attempted before the same-device 720p retry')
  assert(requests.every((request) => request.video.deviceId.exact === 'smoke-camera-720-id'), 'Both attempts should retain the selected synthetic camera')
  assert(requests.every((request) => request.audio.deviceId.exact === 'smoke-mic-id'), 'Both attempts should retain the selected microphone')
  assert.equal(await camera.inputValue(), 'smoke-camera-720-id', 'Fallback should keep the selected camera')
  assert.equal(await quality.inputValue(), '720p', 'Fallback should update the selected quality')
  await page.waitForFunction(async () => {
    const preferences = await window.emcorder.getPreferences()
    return preferences.cameraId === 'smoke-camera-720-id' && preferences.micId === 'smoke-mic-id' && preferences.quality === '720p'
  })
  assert(await quality.locator('option[value="1080p"]').evaluate((option) => option.disabled), '1080p should be disabled for the camera that rejected it')
  assert.equal(await page.getByRole('status').filter({ hasText: /could not provide 1080p/ }).count(), 0, 'Automatic1080p fallback should not show a notice')
  assert.equal(await page.evaluate(() => window.__smokeGumRequests.some((request) => !request.video?.deviceId?.exact)), false, 'Fallback should not request the default camera')

  await camera.selectOption(await page.evaluate(() => window.__smokeRealCamera))
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Camera"]').disabled)
  await microphone.selectOption(await page.evaluate(() => window.__smokeRealMicrophone))
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Microphone"]').disabled)
  await quality.selectOption('1080p')
  await page.waitForFunction(() => document.querySelector('.camera-preview').width === 1920 && !document.querySelector('select[aria-label="Quality"]').disabled)
  await page.evaluate(() => { window.__smokeGumRequests.length = 0; window.__smokeReject720 = true })
  await camera.selectOption('smoke-camera-720-id')
  await page.getByRole('alert').filter({ hasText: /cannot provide 1280 × 720/ }).waitFor()
  await page.getByRole('button', { name: 'Reconnect', exact: true }).waitFor({ state: 'visible' })
  requests = await page.evaluate(() => window.__smokeGumRequests)
  const requestedMicrophone = await microphone.inputValue()
  assert.equal(requests.length, 2, 'Unavailable listed camera should try 1080p and720p exactly once each')
  assert.deepEqual(requests.map((request) => request.video.width.exact), [1920, 1280], 'Both supported-quality capture attempts should be made before reporting failure')
  assert(requests.every((request) => request.video.deviceId.exact === 'smoke-camera-720-id'), 'Failed attempts should retain the selected listed camera')
  assert(requests.every((request) => request.audio.deviceId.exact === requestedMicrophone), 'Failed attempts should retain the selected microphone')
  assert.equal(await camera.inputValue(), 'smoke-camera-720-id', 'A listed camera failure should keep that camera selected')
  assert.equal(await page.evaluate(() => window.__smokeGumRequests.some((request) => !request.video?.deviceId?.exact)), false, 'A listed camera failure should not request the default camera')

  await page.evaluate(() => { window.__smokeReject720 = false })
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await page.waitForFunction(() =>
    document.querySelector('.camera-preview').width === 1280 &&
    !document.querySelector('select[aria-label="Camera"]').disabled &&
    !document.querySelector('select[aria-label="Quality"]').disabled)
  assert.equal(await camera.inputValue(), 'smoke-camera-720-id', 'Reconnect should recover on the same selected camera')
  assert.equal(await quality.inputValue(), '720p', 'Reconnect should use the selected camera’s available 720p quality')
  await page.waitForFunction(async () => {
    const preferences = await window.emcorder.getPreferences()
    return preferences.cameraId === 'smoke-camera-720-id' && preferences.quality === '720p'
  })
  await camera.selectOption(await page.evaluate(() => window.__smokeRealCamera))
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Camera"]').disabled)
  await quality.selectOption('1080p')
  await page.waitForFunction(() => document.querySelector('.camera-preview').width === 1920 && !document.querySelector('select[aria-label="Quality"]').disabled)
  await page.evaluate(() => { window.__smokeGumRequests.length = 0 })
  await page.getByLabel('Background blur', { exact: true }).check()
  await page.waitForFunction(async () => (await window.emcorder.getPreferences()).blur)
  assert.equal(await page.evaluate(() => window.__smokeGumRequests.length), 0, 'Blur changes should not reconnect capture')
  await page.getByLabel('Background blur', { exact: true }).uncheck()
  await page.waitForFunction(async () => !(await window.emcorder.getPreferences()).blur)
  assert.equal(await page.evaluate(() => window.__smokeGumRequests.length), 0, 'Blur changes should not reconnect capture')
  await page.getByLabel('Background blur', { exact: true }).check()
  await page.waitForFunction(async () => (await window.emcorder.getPreferences()).blur)
  await restoreCameraRequest()

  await page.getByLabel('Teleprompter script', { exact: true }).fill('A fresh take starts here.\n\n'.repeat(100))
  assert.equal(await page.getByLabel('Teleprompter script', { exact: true }).getAttribute('maxlength'), '100000', 'Script editing should respect the persisted length limit')

  assert.equal(await page.getByText('Capture diagnostics', { exact: true }).count(), 0, 'Capture diagnostics should be retired')
  await page.getByRole('button', { name: 'Show overlay', exact: true }).click()
  const overlay = page.getByTestId('prompter-overlay')
  const initialMarkup = await overlay.innerHTML()
  assert.equal(await page.getByTestId('overlay-marker').count(), 0, 'The app should not add test visuals')
  await page.getByRole('button', { name: 'Hide overlay', exact: true }).click()
  await overlay.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Show prompter', exact: true }).click()
  assert.equal(await overlay.innerHTML(), initialMarkup, 'Both overlay controls should render identical content')
  const marker = await addOverlayMarker(page)
  await marker.waitFor({ state: 'visible' })
  const markerPixels = await countMagentaPixels(await marker.screenshot(), null)
  assert(markerPixels > 0, 'Preview-only marker should be visible during capture')

  // Both speed controls must show the saved default and reach the advertised maximum.
  const panelSpeed = page.getByLabel('Scroll speed', { exact: true })
  const overlaySpeed = page.getByLabel('Overlay scroll speed', { exact: true })
  assert.equal(await panelSpeed.inputValue(), '36')
  assert.equal(await overlaySpeed.inputValue(), '36')
  for (const speedControl of [panelSpeed, overlaySpeed]) {
    await speedControl.focus()
    await speedControl.press('End')
    assert.equal(await panelSpeed.inputValue(), '60')
    assert.equal(await overlaySpeed.inputValue(), '60')
    for (let step = 0; step < 24; step++) await speedControl.press('ArrowLeft')
    assert.equal(await panelSpeed.inputValue(), '36')
    assert.equal(await overlaySpeed.inputValue(), '36')
  }

  // Paused text must clamp after layout changes, without requiring a Play click.
  const originalHeight = await page.locator('.prompter-content').evaluate((content) => content.scrollHeight)
  await page.locator('.preview-frame').evaluate((frame) => { frame.style.width = '40%' })
  await page.waitForFunction((height) => document.querySelector('.prompter-content').scrollHeight > height, originalHeight)
  await page.locator('.prompter-viewport').dispatchEvent('wheel', { deltaY: 1_000_000 })
  await page.waitForFunction(() => {
    const content = document.querySelector('.prompter-content')
    const viewport = document.querySelector('.prompter-viewport')
    const style = getComputedStyle(viewport)
    const height = viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    const max = Math.max(0, content.scrollHeight - height)
    const contentBottom = content.getBoundingClientRect().bottom
    const readableBottom = viewport.getBoundingClientRect().bottom - parseFloat(style.paddingBottom)
    return max > 0 && Math.abs(new DOMMatrixReadOnly(getComputedStyle(content).transform).m42) === max && contentBottom <= readableBottom + 1
  })
  const beforeResize = await page.locator('.prompter-content').evaluate((content) => Math.abs(new DOMMatrixReadOnly(getComputedStyle(content).transform).m42))
  await page.locator('.preview-frame').evaluate((frame) => { frame.style.removeProperty('width') })
  await page.waitForFunction((previous) => {
    const content = document.querySelector('.prompter-content')
    const viewport = document.querySelector('.prompter-viewport')
    const style = getComputedStyle(viewport)
    const height = viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    const offset = Math.abs(new DOMMatrixReadOnly(getComputedStyle(content).transform).m42)
    return offset < previous && offset <= Math.max(0, content.scrollHeight - height)
  }, beforeResize)
  const longScript = await page.getByLabel('Teleprompter script', { exact: true }).inputValue()
  await page.getByLabel('Teleprompter script', { exact: true }).fill('A short script.')
  await page.locator('.prompter-viewport').dispatchEvent('wheel', { deltaY: 1_000_000 })
  await page.waitForFunction(() => {
    const content = document.querySelector('.prompter-content')
    return new DOMMatrixReadOnly(getComputedStyle(content).transform).m42 === 0
  })
  await page.getByLabel('Teleprompter script', { exact: true }).fill(longScript)
  await page.getByRole('complementary').getByRole('button', { name: 'Restart teleprompter', exact: true }).click()

  const markerBox = await marker.boundingBox()
  const previewBox = await page.locator('.preview-frame').boundingBox()
  assert(markerBox && previewBox, 'Could not locate the overlay marker in the camera preview')
  const markerRegion = {
    x: (markerBox.x - previewBox.x) / previewBox.width,
    y: (markerBox.y - previewBox.y) / previewBox.height,
    width: markerBox.width / previewBox.width,
    height: markerBox.height / previewBox.height,
  }

  const beforeCancel = await takeNames()
  await page.getByRole('button', { name: /(?:●\s*)?Record/, exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'visible' })
  assert(await quality.isDisabled(), 'Quality should be locked during countdown')
  assert(await restartDevices.isDisabled(), 'Device restart must lock during countdown')
  assert(await blurToggle.isDisabled(), 'Blur toggle should be locked during countdown')
  for (const radio of await blurStrength.getByRole('radio').all()) assert(await radio.isDisabled(), 'Strength should be locked during countdown')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: /(?:●\s*)?Record/, exact: true }).waitFor({ state: 'visible' })
  assert.deepEqual(await takeNames(), beforeCancel, 'Cancelling countdown must not create a temporary take')
  assert(await blurToggle.isEnabled(), 'Cancelling countdown should unlock blur')
  assert(await standardBlur.isEnabled(), 'Cancelling countdown should unlock strength')

  // Use asymmetric camera pixels to check actual preview and encoded MP4 orientation.
  await page.evaluate(() => {
    window.__smokeOriginalDrawImage = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      window.__smokeOriginalDrawImage.call(this, source, ...args)
      if (source instanceof HTMLVideoElement && source.classList.contains('source-video')) {
        this.save()
        this.fillStyle = '#ff0000'
        this.fillRect(0, 0, this.canvas.width / 2, this.canvas.height)
        this.fillStyle = '#0000ff'
        this.fillRect(this.canvas.width / 2, 0, this.canvas.width / 2, this.canvas.height)
        this.restore()
      }
    }
  })
  await page.waitForTimeout(200)
  await assertMirroredSides('.camera-preview')

  const scrollOffset = () => page.locator('.prompter-content').evaluate((content) => Math.abs(new DOMMatrixReadOnly(getComputedStyle(content).transform).m42))
  const tracksBeforeSettings = await captureTrackIds()
  await settingsButton.click()
  await countdownSetting.selectOption('5')
  await mirrorSetting.uncheck()
  await autoStartSetting.uncheck()
  await closeSettings()
  await page.waitForTimeout(200)
  assert.deepEqual(await captureTrackIds(), tracksBeforeSettings, 'Settings changes must not reconnect devices')
  await assertMirroredSides('.camera-preview', false)
  // Measure in the renderer from the Record click. Settings interactions below
  // consume countdown time and must not shift the timing assertion's origin.
  await page.getByRole('button', { name: 'Record', exact: true }).evaluate((button) => {
    window.__smokeCountdownDuration = new Promise((resolve) => {
      button.addEventListener('click', () => {
        const startedAt = performance.now()
        const observer = new MutationObserver(() => {
          if (!document.querySelector('.recording-badge')?.textContent.startsWith('Recording ')) return
          observer.disconnect()
          resolve(performance.now() - startedAt)
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      }, { once: true, capture: true })
    })
  })
  await page.getByRole('button', { name: 'Record', exact: true }).click()
  assert.equal(await page.locator('.countdown strong').innerText(), '5', 'Record must use the configured countdown')
  await settingsButton.click()
  for (const control of [countdownSetting, mirrorSetting, autoStartSetting, folderButton]) assert(await control.isDisabled(), 'Capture settings must lock during countdown')
  await closeSettings()
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 10_000 })
  const countdownDuration = await page.evaluate(() => window.__smokeCountdownDuration)
  assert(countdownDuration >= 4_800, `A five-second countdown must wait five seconds before capture (observed ${countdownDuration} ms)`)
  await page.waitForTimeout(1_200)
  assert.equal(await scrollOffset(), 0, 'Disabling automatic start must hold the prompter when recording begins')
  await page.getByRole('button', { name: 'Play scroll', exact: true }).click()
  await page.waitForFunction(() => {
    const content = document.querySelector('.prompter-content')
    return content && Math.abs(new DOMMatrixReadOnly(getComputedStyle(content).transform).m42) > 0
  }, null, { timeout: 5_000 })
  assert(await scrollOffset() > 0, 'Manual scrolling must still work with automatic start disabled')
  await settingsButton.click()
  for (const control of [countdownSetting, mirrorSetting, autoStartSetting, folderButton]) assert(await control.isDisabled(), 'Capture settings must lock during recording')
  await closeSettings()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await waitForReview()
  await assertMirroredSides('#review-video', false)
  assert.equal(await countMagentaPixels(await page.locator('#review-video').screenshot(), markerRegion), 0, 'Unmirrored recording must exclude the teleprompter')
  await settingsButton.click()
  assert(await mirrorSetting.isDisabled(), 'Review must retain the recorded orientation')
  assert(await folderButton.isEnabled(), 'Review should allow selecting a save destination')
  await closeSettings()
  await retakeUnsaved()
  await settingsButton.click()
  await mirrorSetting.check()
  await autoStartSetting.check()
  await closeSettings()
  await page.waitForTimeout(200)
  await assertMirroredSides('.camera-preview')
  const beforeRecord = await takeNames()
  await page.getByRole('button', { name: 'Play scroll', exact: true }).click()
  await page.waitForTimeout(1_000)
  assert(await scrollOffset() > 0, 'Teleprompter should scroll before recording')
  await page.getByRole('button', { name: /(?:●\s*)?Record/, exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'visible' })
  assert.equal(await scrollOffset(), 0, 'Record should reset the teleprompter and hold it during countdown')
  await page.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true }).waitFor({ state: 'visible' })
  assert(await blurToggle.isDisabled(), 'Blur toggle should stay locked while recording')
  assert(await restartDevices.isDisabled(), 'Device restart must lock while recording')
  for (const radio of await blurStrength.getByRole('radio').all()) assert(await radio.isDisabled(), 'Strength should stay locked while recording')
  await page.waitForTimeout(3_000)
  assert(await scrollOffset() > 0, 'Teleprompter should automatically play when recording starts')
  const firstTake = [...(await takeNames())].find((name) => !beforeRecord.has(name))
  assert(firstTake, 'The first take should exist before restarting')
  await page.getByRole('button', { name: 'Retake', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('.countdown strong').innerText(), '5', 'Retake should use the configured five-second countdown')
  assert.equal(await scrollOffset(), 0, 'Retake should hold the script at the top during countdown')
  assert.equal((await takeNames()).size, 0, 'Retake countdown should have no recording file open')
  await page.waitForTimeout(1_000)
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).isVisible(), false, 'Capture should wait for the retake countdown')
  assert.equal(await scrollOffset(), 0, 'Script should remain paused during the retake countdown')
  await page.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true }).waitFor({ state: 'visible' })
  const restartedCaptureAt = Date.now()
  assert.equal(await page.locator('.transport .timer').innerText(), '00:00', 'Restart should reset the recording timer')
  assert(!(await takeNames()).has(firstTake), 'Restart should delete the discarded take')
  assert.equal((await takeNames()).size, 1, 'Restart should leave only the new take')
  await page.waitForTimeout(3_000)
  assert(await scrollOffset() > 0, 'Restarted take should automatically scroll the teleprompter')
  await page.screenshot({ path: join(artifactDir, 'restart-recording.png') })
  await page.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true }).click()
  const restartedCaptureSeconds = (Date.now() - restartedCaptureAt) / 1000
  const media = await waitForReview()
  await assertMirroredSides('#review-video')
  await page.evaluate(() => {
    CanvasRenderingContext2D.prototype.drawImage = window.__smokeOriginalDrawImage
    delete window.__smokeOriginalDrawImage
  })
  assert.equal(media.width, 1920, '1080p recording must contain1920px video, not an upscaled preview label')
  assert.equal(media.height, 1080)
  assert.equal(await page.locator('.sidebar').isVisible(), false, 'Review should hide setup controls')
  assert.equal(await page.locator('.transport .timer').count(), 0, 'Review should use playback duration without a duplicate timer')
  assert.equal(await page.getByText('MP4 metadata loaded and midpoint seeking works.', { exact: true }).count(), 0, 'Successful playback checks should stay out of the review UI')
  const reviewBounds = await page.locator('.preview-frame').boundingBox()
  const actionsBounds = await page.locator('.transport').boundingBox()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert(Math.abs(reviewBounds.x + reviewBounds.width / 2 - viewport.width / 2) < 2, 'Review should be horizontally centered')
  assert(actionsBounds.y + actionsBounds.height < viewport.height, 'Review actions should fit without scrolling')
  // Screenshot and assertion work can extend this take on slower machines.
  // Compare encoded duration with capture time so countdown leakage still fails.
  assert(media.duration >= 2 && Math.abs(media.duration - restartedCaptureSeconds) <= 2, `Expected ${restartedCaptureSeconds}s of capture, received ${media.duration}s in the MP4`)
  assert.equal(await countMagentaPixels(await page.locator('#review-video').screenshot(), markerRegion), 0, 'Preview-only overlay marker must not appear in the MP4')
  const created = [...(await takeNames())].filter((name) => !beforeRecord.has(name))
  assert.equal(created.length, 1, 'A manual stop should leave exactly one temporary take for review')
  const tempTake = join(takesDir, created[0])
  assert((await stat(tempTake)).size > 0, 'Temporary MP4 should contain data')

  // Move the elapsed clock to the warning and hard-stop boundaries without
  // waiting 14 or 15 minutes. Media capture itself remains on the real clock.
  await retakeUnsaved()
  await page.getByRole('button', { name: /(?:●\s*)?Record/, exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: /(?:●\s*)?Record/, exact: true }).click()
  await page.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true }).waitFor({ state: 'visible' })
  await page.waitForTimeout(1_200)
  await page.evaluate(() => {
    window.__smokeRealDateNow = Date.now
    const realNow = Date.now.bind(Date)
    const started = realNow()
    window.__smokeStartedAt = started
    Date.now = () => started + 14 * 60_000
  })
  await page.getByText(/14 minutes|one minute|1 minute/i).waitFor({ state: 'visible', timeout: 5_000 })
  await page.evaluate(() => {
    const started = window.__smokeStartedAt
    Date.now = () => started + 15 * 60_000
  })
  await page.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true }).waitFor({ state: 'hidden', timeout: 5_000 })
  await waitForReview()
  await page.screenshot({ path: join(artifactDir, 'phase1-review.png') })
  await page.evaluate(() => {
    if (window.__smokeRealDateNow) Date.now = window.__smokeRealDateNow
    delete window.__smokeRealDateNow
    delete window.__smokeStartedAt
  })

  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, outputDir)
  await page.evaluate(() => window.emcorder.chooseOutputFolder())
  assert.equal((await page.evaluate(() => window.emcorder.getPreferences())).outputFolder, outputDir, 'Chosen output folder should persist')

  const saveDialog = page.getByRole('dialog', { name: 'Save recording' })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await saveDialog.waitFor({ state: 'visible' })
  await saveDialog.getByText('1920 × 1080 px · 30 FPS · H.264 MP4', { exact: true }).waitFor()
  const filename = saveDialog.getByLabel('Filename', { exact: true })
  assert.match(await filename.inputValue(), /^EmCorder_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/)
  const destination = saveDialog.getByLabel('Destination', { exact: true })
  await page.screenshot({ path: join(artifactDir, 'phase1-save-dialog.png') })
  const collisionName = 'phase1-existing.mp4'
  await writeFile(join(typedOutputDir, collisionName), 'keep existing file')
  await filename.fill(collisionName)
  await destination.fill(join(typedOutputDir, 'missing-folder'))
  await saveDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await saveDialog.getByRole('alert').filter({ hasText: /take is still available|existing folder/i }).waitFor({ state: 'visible' })
  const tempAfterFailedSave = [...(await takeNames())]
  assert.equal(tempAfterFailedSave.length, 1, 'A failed save must retain the temporary take for retry')
  assert((await stat(join(takesDir, tempAfterFailedSave[0]))).size > 0, 'Temporary MP4 should remain after a failed save')
  assert(await page.locator('#review-video').getAttribute('src'), 'Playback should be restored after a failed save')

  const savedName = 'phase1-existing_2.mp4'
  await destination.fill(typedOutputDir)
  await saveDialog.getByRole('button', { name: 'Save', exact: true }).click()
  const savedFile = join(typedOutputDir, savedName)
  await page.getByText(savedFile, { exact: false }).waitFor({ state: 'visible' })
  assert((await stat(savedFile)).size > 0, 'Saved MP4 should exist at the selected destination')
  assert.equal(await readFile(join(typedOutputDir, collisionName), 'utf8'), 'keep existing file')
  assert.equal((await page.evaluate(() => window.emcorder.getPreferences())).outputFolder, typedOutputDir, 'Typed save destination should update the persisted output folder')
  await page.getByRole('button', { name: 'Retake', exact: true }).click()
  await page.getByRole('button', { name: /(?:●\s*)?Record/, exact: true }).waitFor({ state: 'visible' })
  assert((await stat(savedFile)).size > 0, 'Retake must keep the saved recording')
  assert.equal((await takeNames()).size, 0, 'Retake should remove the temporary take')

  await quality.selectOption('720p')
  await page.waitForFunction(() => document.querySelector('.camera-preview').width === 1280 && !document.querySelector('select[aria-label="Quality"]').disabled)
  // A camera can advertise1080p yet reject that exact capture format.
  await page.evaluate(() => {
    const media = navigator.mediaDevices
    let attempts1080 = 0
    window.__smokeOriginalGetUserMedia = media.getUserMedia
    Object.defineProperty(media, 'getUserMedia', { configurable: true, writable: true, value: async function (constraints) {
      if (constraints.video?.width?.exact === 1920) {
        attempts1080++
        throw new DOMException('Synthetic 1080p rejection', attempts1080 === 1 ? 'NotReadableError' : 'OverconstrainedError')
      }
      return window.__smokeOriginalGetUserMedia.call(this, constraints)
    } })
  })
  await quality.selectOption('1080p')
  await page.getByRole('status').filter({ hasText: /Restored 720p/ }).waitFor()
  assert.equal(await quality.inputValue(), '720p', 'A transient switch failure should restore the previous quality')
  assert.equal(await quality.locator('option[value="1080p"]').evaluate((option) => option.disabled), false, 'A busy camera should not mark 1080p unsupported')
  await quality.selectOption('1080p')
  await page.waitForFunction(() => document.querySelector('.camera-preview').width === 1280 && document.querySelector('select[aria-label="Quality"]').value === '720p' && !document.querySelector('select[aria-label="Quality"]').disabled && document.querySelector('select[aria-label="Quality"] option[value="1080p"]').disabled)
  assert.equal(await page.getByRole('status').filter({ hasText: /could not provide 1080p/ }).count(), 0, 'Automatic unsupported1080p fallback should not show a notice')
  assert.equal(await quality.inputValue(), '720p', 'Rejected1080p should automatically fall back to720p')
  assert(await quality.locator('option[value="1080p"]').evaluate((option) => option.disabled), 'Rejected1080p should be unselectable for this camera')
  await restoreCameraRequest()

  const blur = page.getByLabel('Background blur', { exact: true })
  await blur.setChecked(false)
  await page.waitForFunction(async () => !(await window.emcorder.getPreferences()).blur, null, { timeout: 5_000, polling: 100 })
  const selectedCamera = await camera.inputValue()
  const selectedMicrophone = await microphone.inputValue()
  await imageCard.locator('summary').click()
  for (const slider of imageSliders) await slider.press('End')
  await page.waitForFunction(async () => {
    const preferences = await window.emcorder.getPreferences()
    return preferences.brightness === 150 && preferences.contrast === 150 && preferences.saturation === 150
  })
  const preferences = await page.evaluate(() => window.emcorder.getPreferences())
  assert.equal(preferences.countdownSeconds, 5)
  await settingsButton.click()
  await mirrorSetting.uncheck()
  await autoStartSetting.uncheck()
  await closeSettings()
  await page.waitForFunction(async () => {
    const preferences = await window.emcorder.getPreferences()
    return !preferences.mirrorVideo && !preferences.autoStartPrompter
  })
  assert.equal(preferences.blur, false, 'Blur preference should persist before relaunch')
  assert.equal(preferences.blurStrength, 'strong', 'Strength should persist while blur is off')
  assert.equal(preferences.outputFolder, typedOutputDir)
  await closeCleanly()

  await launch(false)
  bindSettings()
  await page.getByRole('button', { name: 'Connect camera', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Connect camera')
    return !!button && !button.disabled
  }, null, { timeout: 10_000 })
  assert.equal(await page.getByLabel('Background blur', { exact: true }).isChecked(), false, 'Blur preference should restore')
  assert.equal(await page.getByRole('group', { name: 'Blur strength', exact: true }).count(), 0)
  await page.getByLabel('Background blur', { exact: true }).check()
  assert(await page.getByRole('radio', { name: 'Strong', exact: true }).isChecked(), 'Strength should restore across app launches')
  await page.getByLabel('Background blur', { exact: true }).uncheck()
  assert.equal(await page.getByLabel('Camera', { exact: true }).inputValue(), selectedCamera, 'Camera preference should restore')
  assert.equal(await page.getByLabel('Microphone', { exact: true }).inputValue(), selectedMicrophone, 'Microphone preference should restore')
  const restored = await page.evaluate(() => window.emcorder.getPreferences())
  assert.equal(restored.outputFolder, typedOutputDir, 'Output directory preference should restore')
  assert.equal(await page.locator('.image-card').evaluate((card) => card.open), false, 'Restored image controls should start collapsed')
  await page.locator('.image-card summary').click()
  for (const [name, value] of [['Brightness', '150'], ['Contrast', '150'], ['Saturation', '150']]) {
    assert.equal(await page.getByRole('slider', { name, exact: true }).inputValue(), value, 'Image adjustments should restore across launches')
  }
  await page.getByRole('button', { name: 'Reset image adjustments', exact: true }).click()
  await page.locator('.image-card summary').click()
  await settingsButton.click()
  assert.equal(await countdownSetting.inputValue(), '5', 'Countdown preference should restore')
  assert.equal(await mirrorSetting.isChecked(), false, 'Mirror preference should restore')
  assert.equal(await autoStartSetting.isChecked(), false, 'Automatic prompter preference should restore')
  await countdownSetting.selectOption('3')
  await mirrorSetting.check()
  await autoStartSetting.check()
  await closeSettings()

  await rejectNextCameraRequest('NotAllowedError')
  await rejectNextCameraRequest('NotReadableError')
  await restoreCameraRequest()
  await connect()

  // Exercise automatic device-loss handling with a synthetic media track.
  const beforeLoss = await takeNames()
  await page.getByRole('button', { name: /(?:●\s*)?Record/, exact: true }).click()
  await page.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true }).waitFor({ state: 'visible' })
  await page.waitForTimeout(1_200)
  await page.evaluate(() => {
    // Hold the next hidden inspection without delaying the visible review video.
    // Saving must cancel this pending check and inspect the saved file afresh.
    const createElement = document.createElement
    document.createElement = function (name, options) {
      const element = createElement.call(this, name, options)
      if (name === 'video') {
        document.createElement = createElement
        Object.defineProperty(element, 'src', { configurable: true, set: () => {} })
      }
      return element
    }
    const track = document.querySelector('video')?.srcObject?.getVideoTracks()[0]
    if (!track) throw new Error('Synthetic camera track was not found')
    track.stop()
    track.dispatchEvent(new Event('ended'))
  })
  const lossMedia = await waitForReview(false)
  assert.equal(lossMedia.width, 1280)
  assert.equal(lossMedia.height, 720)
  assert(Number.isFinite(lossMedia.duration) && lossMedia.duration > 0, 'Device-loss take should remain a valid MP4')
  assert((await takeNames()).size > beforeLoss.size, 'Device loss should stop and preserve the partial take for review')
  const deviceLossTake = [...(await takeNames())][0]
  assert(deviceLossTake, 'Device-loss take should remain in temporary storage')
  const deviceLossPath = join(takesDir, deviceLossTake)
  assert((await stat(deviceLossPath)).size > 0, 'Device-loss MP4 should contain data before closing')

  assert.equal(await page.locator('#review-video').getAttribute('aria-busy'), 'true', 'The hidden inspection should still be pending')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const earlySaveDialog = page.getByRole('dialog', { name: 'Save recording' })
  await earlySaveDialog.getByLabel('Filename', { exact: true }).fill('pending-inspection.mp4')
  await earlySaveDialog.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByText('Saved successfully.', { exact: true }).waitFor()
  await waitForReview()
  assert.equal(await page.getByText('Saved successfully.', { exact: true }).count(), 1, 'Completing inspection must preserve saved status')
  await page.getByRole('button', { name: 'Retake', exact: true }).click()
  await page.locator('.sidebar').waitFor({ state: 'visible' })
  await connect()
  const beforeCloseTake = await takeNames()
  await page.getByRole('button', { name: /(?:●\s*)?Record/, exact: true }).click()
  await page.getByRole('button', { name: /(?:■\s*)?Stop/, exact: true }).waitFor({ state: 'visible' })
  await page.waitForTimeout(1_200)
  const recordingTake = [...(await takeNames())].find((name) => !beforeCloseTake.has(name))
  assert(recordingTake, 'Recording should create a temporary take before safe close')
  const safeClosePath = join(takesDir, recordingTake)

  const child = app.process()
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('EmCorder did not exit after the confirmed safe close')), 10_000)
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }) })
  })
  await app.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showMessageBoxSync = () => 1
    BrowserWindow.getAllWindows()[0].close()
  })
  const exit = await exited
  assert.equal(exit.code, 0, `EmCorder exited unsuccessfully: ${JSON.stringify(exit)}`)
  const finalizedBytes = await readFile(safeClosePath)
  assert(finalizedBytes.length > 0, 'Safe close should preserve a nonempty temporary recording')
  const mp4Atoms = finalizedBytes.toString('latin1')
  assert(mp4Atoms.includes('ftyp') && mp4Atoms.includes('moov') && mp4Atoms.includes('mdat'), 'Safe close should finalize a readable MP4 container')
  app = undefined
  page = undefined

  console.log(JSON.stringify({ ok: true, media, savedFile, restored, temporaryTakeCleaned: true, safeCloseFinalizedTake: safeClosePath, safeCloseBytes: finalizedBytes.length }))
} finally {
  await closeCleanly()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
