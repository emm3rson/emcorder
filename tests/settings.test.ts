import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  clampOverlayBounds,
  DEFAULT_FONT_SIZE,
  DEFAULT_OVERLAY_BOUNDS,
  DEFAULT_OVERLAY_OPACITY,
  DEFAULT_SCROLL_SPEED,
  PreferencesStore,
  type StudioPreferences
} from '../src/main/preferences'
import {
  DEFAULT_COUNTDOWN_SECONDS, DEFAULT_MIRROR_VIDEO, DEFAULT_AUTO_START_PROMPTER,
  MIN_COUNTDOWN_SECONDS, MAX_COUNTDOWN_SECONDS,
} from '../src/shared/studioSettings'

const roots: string[] = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'emcorder-settings-'))
  roots.push(root)
  const userData = join(root, 'userData')
  const videos = join(root, 'Videos')
  const output = join(root, 'Recordings')
  await Promise.all([mkdir(videos), mkdir(output)])
  return { root, userData, videos, output, store: new PreferencesStore(userData, videos) }
}

function defaultPrefs(outputFolder: string, overrides: Partial<StudioPreferences> = {}): StudioPreferences {
  return {
    cameraId: '',
    micId: '',
    blur: true,
    blurStrength: 'standard',
    quality: '720p',
    countdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
    mirrorVideo: DEFAULT_MIRROR_VIDEO,
    autoStartPrompter: DEFAULT_AUTO_START_PROMPTER,
    outputFolder,
    script: '',
    fontSize: DEFAULT_FONT_SIZE,
    scrollSpeed: DEFAULT_SCROLL_SPEED,
    overlayOpacity: DEFAULT_OVERLAY_OPACITY,
    overlayBounds: { ...DEFAULT_OVERLAY_BOUNDS },
    ...overrides
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('defaults to Videos and atomically persists device and blur settings', async () => {
  const { userData, videos, store } = await setup()
  assert.deepEqual(await store.load(), defaultPrefs(videos))

  await store.update({ cameraId: 'camera-1', micId: 'mic-2', blur: true })
  const reloaded = new PreferencesStore(userData, videos)
  assert.deepEqual(await reloaded.load(), defaultPrefs(videos, { cameraId: 'camera-1', micId: 'mic-2', blur: true }))
  const file = await readFile(join(userData, 'preferences.json'), 'utf8')
  assert.match(file, /"cameraId": "camera-1"/)
  assert.deepEqual(await readdir(userData), ['preferences.json'])
})

test('restores a valid output folder and falls back when it no longer exists', async () => {
  const { userData, videos, output, store } = await setup()
  await store.load()
  await store.setOutputFolder(output)
  const restored = new PreferencesStore(userData, videos)
  assert.equal((await restored.load()).outputFolder, output)

  await writeFile(join(userData, 'preferences.json'), JSON.stringify({ cameraId: 'c', micId: 'm', blur: true, outputFolder: join(output, 'removed') }))
  const missing = new PreferencesStore(userData, videos)
  assert.deepEqual(await missing.load(), defaultPrefs(videos, { cameraId: 'c', micId: 'm', blur: true }))
})

test('persists recording settings and accepts every countdown second including boundaries', async () => {
  const { userData, videos, store } = await setup()
  await store.load()
  await store.update({ mirrorVideo: false, autoStartPrompter: false })
  for (let countdownSeconds = MIN_COUNTDOWN_SECONDS; countdownSeconds <= MAX_COUNTDOWN_SECONDS; countdownSeconds++) {
    await store.update({ countdownSeconds })
    const loaded = await new PreferencesStore(userData, videos).load()
    assert.equal(loaded.countdownSeconds, countdownSeconds)
    assert.equal(loaded.mirrorVideo, false)
    assert.equal(loaded.autoStartPrompter, false)
  }
  await store.update({ mirrorVideo: true, autoStartPrompter: true })
  const loaded = await new PreferencesStore(userData, videos).load()
  assert.equal(loaded.mirrorVideo, true)
  assert.equal(loaded.autoStartPrompter, true)
})

test('legacy and malformed recording settings fall back independently', async () => {
  const { userData, videos } = await setup()
  await mkdir(userData, { recursive: true })
  for (const countdownSeconds of [undefined, null, 2, 11, 3.5, '5', true]) {
    await writeFile(join(userData, 'preferences.json'), JSON.stringify({
      countdownSeconds, mirrorVideo: false, autoStartPrompter: false,
    }))
    const loaded = await new PreferencesStore(userData, videos).load()
    assert.equal(loaded.countdownSeconds, DEFAULT_COUNTDOWN_SECONDS)
    assert.equal(loaded.mirrorVideo, false)
    assert.equal(loaded.autoStartPrompter, false)
  }
  for (const invalidBoolean of [undefined, null, 0, 1, 'false', [], {}]) {
    await writeFile(join(userData, 'preferences.json'), JSON.stringify({
      countdownSeconds: MAX_COUNTDOWN_SECONDS,
      mirrorVideo: invalidBoolean,
      autoStartPrompter: invalidBoolean,
    }))
    const loaded = await new PreferencesStore(userData, videos).load()
    assert.equal(loaded.countdownSeconds, MAX_COUNTDOWN_SECONDS)
    assert.equal(loaded.mirrorVideo, DEFAULT_MIRROR_VIDEO)
    assert.equal(loaded.autoStartPrompter, DEFAULT_AUTO_START_PROMPTER)
  }
})

test('rejects invalid recording settings without mutating or persisting other patch values', async () => {
  const { userData, videos, store } = await setup()
  await store.load()
  await store.update({ countdownSeconds: 7, mirrorVideo: false, autoStartPrompter: false })
  const saved = store.get()
  for (const countdownSeconds of [undefined, null, 2, 11, 3.5, Number.NaN, Infinity, -Infinity, '5', true]) {
    await assert.rejects(store.update({ countdownSeconds, mirrorVideo: true } as never), /Invalid countdown preference/)
  }
  for (const invalidBoolean of [undefined, null, 0, 1, 'false', [], {}]) {
    await assert.rejects(store.update({ mirrorVideo: invalidBoolean, countdownSeconds: 5 } as never), /Invalid mirror video preference/)
    await assert.rejects(store.update({ autoStartPrompter: invalidBoolean, countdownSeconds: 5 } as never), /Invalid auto-start prompter preference/)
  }
  assert.deepEqual(store.get(), saved)
  assert.deepEqual(await new PreferencesStore(userData, videos).load(), saved)
})

test('defaults recording quality to 720p, persists 1080p, and rejects unknown quality updates', async () => {
  const { userData, videos, store } = await setup()
  assert.equal((await store.load()).quality, '720p')
  await store.update({ quality: '1080p' })
  const reloaded = new PreferencesStore(userData, videos)
  assert.equal((await reloaded.load()).quality, '1080p')
  await assert.rejects(reloaded.update({ quality: '4k' } as never), /Invalid recording quality preference/)
  assert.equal(reloaded.get().quality, '1080p')
  assert.equal((await new PreferencesStore(userData, videos).load()).quality, '1080p')

  for (const saved of [{}, { quality: '4k' }, { quality: 1080 }, { quality: null }]) {
    await writeFile(join(userData, 'preferences.json'), JSON.stringify(saved))
    assert.equal((await new PreferencesStore(userData, videos).load()).quality, '720p')
  }
})

test('restores blur presets, preserves the choice while off, and safely handles old or invalid settings', async () => {
  const { userData, videos, store } = await setup()
  assert.equal((await store.load()).blurStrength, 'standard')
  for (const blurStrength of ['light', 'standard', 'strong'] as const) {
    await store.update({ blurStrength })
    assert.equal((await new PreferencesStore(userData, videos).load()).blurStrength, blurStrength)
  }
  await store.update({ blur: false })
  assert.equal((await new PreferencesStore(userData, videos).load()).blurStrength, 'strong')
  for (const blurStrength of ['extreme', 2, null, undefined, 'constructor']) {
    await assert.rejects(store.update({ blurStrength } as never), /Invalid blur strength preference/)
    assert.equal(store.get().blurStrength, 'strong')
    await writeFile(join(userData, 'preferences.json'), JSON.stringify({ blur: false, blurStrength }))
    const loaded = await new PreferencesStore(userData, videos).load()
    assert.equal(loaded.blurStrength, 'standard')
    assert.equal(loaded.blur, false)
  }
})

test('malformed settings and invalid patches safely use defaults or reject', async () => {
  const { userData, videos, store } = await setup()
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, 'preferences.json'), '{broken')
  assert.deepEqual(await store.load(), defaultPrefs(videos))
  await assert.rejects(store.update({ blur: 'yes' as unknown as boolean }), /Invalid blur preference/)
  await assert.rejects(store.update({ outputFolder: videos } as never), /Only device and blur/)
  assert.deepEqual(store.get(), defaultPrefs(videos))
})

test('output folder must exist and be a directory', async () => {
  const { root, store } = await setup()
  await store.load()
  await assert.rejects(store.setOutputFolder(join(root, 'missing')), /Choose a folder/)
  const file = join(root, 'file.txt')
  await writeFile(file, 'not a directory')
  await assert.rejects(store.setOutputFolder(file), /Choose a folder/)
})

test('concurrent settings updates preserve device, blur, and output folder changes', async () => {
  const { userData, videos, output, store } = await setup()
  await store.load()

  await Promise.all([
    store.update({ cameraId: 'camera-concurrent' }),
    store.update({ micId: 'mic-concurrent' }),
    store.update({ blur: false }),
    store.setOutputFolder(output)
  ])

  const reloaded = new PreferencesStore(userData, videos)
  assert.deepEqual(await reloaded.load(), defaultPrefs(output, {
    cameraId: 'camera-concurrent',
    micId: 'mic-concurrent',
    blur: false
  }))
})

test('persists and reloads teleprompter script, typography, speed, opacity, and overlay bounds', async () => {
  const { userData, videos, store } = await setup()
  await store.load()

  await store.update({
    script: 'Hello EmCorder!\nSecond line.',
    fontSize: 32,
    scrollSpeed: 60,
    overlayOpacity: 0.85,
    overlayBounds: { x: 0.1, y: 0.12, width: 0.7, height: 0.5 }
  })

  const reloaded = new PreferencesStore(userData, videos)
  assert.deepEqual(await reloaded.load(), defaultPrefs(videos, {
    script: 'Hello EmCorder!\nSecond line.',
    fontSize: 32,
    scrollSpeed: 60,
    overlayOpacity: 0.85,
    overlayBounds: { x: 0.1, y: 0.12, width: 0.7, height: 0.5 }
  }))

  await reloaded.update({ script: '' })
  const cleared = new PreferencesStore(userData, videos)
  assert.equal((await cleared.load()).script, '')
})

test('clamps overlayBounds on update and load when out of bounds or below minimum size', async () => {
  const { userData, videos, store } = await setup()
  await store.load()

  await store.update({
    overlayBounds: { x: 0.8, y: 0.9, width: 0.5, height: 0.4 }
  })
  assert.deepEqual(store.get().overlayBounds, { x: 0.5, y: 0.6, width: 0.5, height: 0.4 })

  assert.deepEqual(clampOverlayBounds({ x: -0.2, y: -0.5, width: 0.1, height: 0.05 }), {
    x: 0,
    y: 0,
    width: 0.28,
    height: 0.22
  })

  await writeFile(join(userData, 'preferences.json'), JSON.stringify({
    cameraId: 'cam-1',
    micId: 'mic-1',
    blur: false,
    outputFolder: videos,
    script: 'Saved script',
    fontSize: 999,
    scrollSpeed: 2,
    overlayOpacity: 1.5,
    overlayBounds: { x: 0.95, y: 0.95, width: 0.99, height: 0.99 }
  }))

  const fromDisk = new PreferencesStore(userData, videos)
  assert.deepEqual(await fromDisk.load(), {
    cameraId: 'cam-1',
    micId: 'mic-1',
    blur: false,
    blurStrength: 'standard',
    quality: '720p',
    countdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
    mirrorVideo: DEFAULT_MIRROR_VIDEO,
    autoStartPrompter: DEFAULT_AUTO_START_PROMPTER,
    outputFolder: videos,
    script: 'Saved script',
    fontSize: DEFAULT_FONT_SIZE,
    scrollSpeed: DEFAULT_SCROLL_SPEED,
    overlayOpacity: DEFAULT_OVERLAY_OPACITY,
    overlayBounds: { x: 0.04, y: 0.12, width: 0.96, height: 0.88 }
  })
})

test('backward-compatible loading of Phase 1 preferences.json populates teleprompter defaults', async () => {
  const { userData, videos } = await setup()
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, 'preferences.json'), JSON.stringify({
    cameraId: 'phase1-cam',
    micId: 'phase1-mic',
    blur: false,
    outputFolder: videos
  }))

  const store = new PreferencesStore(userData, videos)
  const loaded = await store.load()
  assert.deepEqual(loaded, defaultPrefs(videos, {
    cameraId: 'phase1-cam',
    micId: 'phase1-mic',
    blur: false
  }))

  loaded.overlayBounds.x = 0.99
  assert.deepEqual(store.get().overlayBounds, DEFAULT_OVERLAY_BOUNDS)
})

test('accepts both scroll speed boundaries', async () => {
  const { store } = await setup()
  await store.load()
  await store.update({ scrollSpeed: 5 })
  assert.equal(store.get().scrollSpeed, 5)
  await store.update({ scrollSpeed: 60 })
  assert.equal(store.get().scrollSpeed, 60)
})

test('rejects invalid teleprompter preference patches', async () => {
  const { store } = await setup()
  await store.load()

  await assert.rejects(store.update({ script: 123 as unknown as string }), /Invalid script preference/)
  await assert.rejects(store.update({ fontSize: 12 }), /Invalid font size preference/)
  await assert.rejects(store.update({ fontSize: 60 }), /Invalid font size preference/)
  await assert.rejects(store.update({ scrollSpeed: 4 }), /Invalid scroll speed preference/)
  await assert.rejects(store.update({ scrollSpeed: 61 }), /Invalid scroll speed preference/)
  await assert.rejects(store.update({ overlayOpacity: 0.1 }), /Invalid overlay opacity preference/)
  await assert.rejects(store.update({ overlayOpacity: 1 }), /Invalid overlay opacity preference/)
  await assert.rejects(
    store.update({ overlayBounds: { x: 0.1, y: 0.1, width: 0.5 } as never }),
    /Invalid overlay bounds preference/
  )
  await assert.rejects(
    store.update({ overlayBounds: { x: 0.1, y: 0.1, width: 0.5, height: Number.NaN } }),
    /Invalid overlay bounds preference/
  )
  await assert.rejects(
    store.update({ overlayBounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.4, extra: 1 } as never }),
    /Invalid overlay bounds preference/
  )
})
