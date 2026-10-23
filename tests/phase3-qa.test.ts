import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  DEFAULT_OVERLAY_BOUNDS,
  MAX_OVERLAY_HEIGHT,
  MAX_OVERLAY_WIDTH,
  MAX_SCRIPT_LENGTH,
  MIN_OVERLAY_HEIGHT,
  MIN_OVERLAY_WIDTH,
  PreferencesStore,
} from '../src/main/preferences'
import { TakeStore } from '../src/main/take-store'
import {
  clampOverlayBounds,
  clampScrollOnEdit,
  dragOverlayBounds,
  maxScrollOffset,
  resizeOverlayBounds,
  resolveStudioShortcut,
   SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  stepScrollOffset,
} from '../src/renderer/features/teleprompter/teleprompterModel'

const temporaryRoots: string[] = []

async function createTempEnv() {
  const root = await mkdtemp(join(tmpdir(), 'emcorder-phase3-qa-'))
  temporaryRoots.push(root)
  const userData = join(root, 'userData')
  const videos = join(root, 'Videos')
  const takesDir = join(userData, 'takes')
  await mkdir(videos, { recursive: true })
  return {
    root,
    userData,
    videos,
    preferences: new PreferencesStore(userData, videos),
    takes: new TakeStore(takesDir),
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

test('Phase 3 QA (TEL-01, TEL-07): persists and reloads a 60k-character and 100k-character script, and rejects scripts exceeding MAX_SCRIPT_LENGTH', async () => {
  const { userData, videos, preferences } = await createTempEnv()
  await preferences.load()

  const paragraph =
    'Good morning. Today I will walk through the architecture, design decisions, and reliability safeguards built into EmCorder for Windows 11.\n\n'
  const longScript = paragraph.repeat(450)
  assert.ok(longScript.length > 50_000 && longScript.length < MAX_SCRIPT_LENGTH)

  await preferences.update({ script: longScript })
  const reloaded = new PreferencesStore(userData, videos)
  const loadedPrefs = await reloaded.load()
  assert.equal(loadedPrefs.script.length, longScript.length)
  assert.equal(loadedPrefs.script, longScript)

  const exactMaxScript = 'A'.repeat(MAX_SCRIPT_LENGTH)
  await reloaded.update({ script: exactMaxScript })
  const reloadedMax = new PreferencesStore(userData, videos)
  assert.equal((await reloadedMax.load()).script.length, MAX_SCRIPT_LENGTH)

  const oversizedScript = 'B'.repeat(MAX_SCRIPT_LENGTH + 1)
  await assert.rejects(
    reloadedMax.update({ script: oversizedScript }),
    /Invalid script preference/,
  )
  assert.equal(reloadedMax.get().script.length, MAX_SCRIPT_LENGTH)
})

test('Phase 3 QA (TEL-01, TEL-03): steps scroll smoothly across a multi-minute script with live speed changes and live-edit clamping', () => {
  const contentHeight = 14_400
  const viewportHeight = 320
  const expectedMax = maxScrollOffset(contentHeight, viewportHeight)
  assert.equal(expectedMax, 14_080)

  let offset = 0
  let reachedEnd = false

  // Scroll for 30 seconds at minimum speed (5 px/s -> 150 px)
  for (let i = 0; i < 300; i++) {
    const step = stepScrollOffset(offset, SCROLL_SPEED_MIN, 100, contentHeight, viewportHeight)
    offset = step.offset
    reachedEnd = step.reachedEnd
  }
  assert.ok(Math.abs(offset - 150) < 1e-6)
  assert.equal(reachedEnd, false)

  // Simulate a 3-second renderer stall; delta is clamped to 250ms so the reader never loses their place
  const afterStall = stepScrollOffset(offset, 60, 3_000, contentHeight, viewportHeight)
  assert.ok(Math.abs(afterStall.offset - (150 + 60 * 0.25)) < 1e-6)
  offset = afterStall.offset

  // Live edit: user appends more paragraphs while scrolled mid-take; offset is preserved
  const expandedContentHeight = 18_000
  offset = clampScrollOnEdit(offset, expandedContentHeight, viewportHeight)
  assert.ok(Math.abs(offset - 165) < 1e-6)

  // Fast-forward at maximum speed (60 px/s) until the end of the expanded script
  let steps = 0
  while (!reachedEnd && steps < 3_000) {
    const step = stepScrollOffset(offset, SCROLL_SPEED_MAX, 100, expandedContentHeight, viewportHeight)
    assert.ok(step.offset >= offset)
    offset = step.offset
    reachedEnd = step.reachedEnd
    steps++
  }
  assert.equal(reachedEnd, true)
  assert.equal(offset, maxScrollOffset(expandedContentHeight, viewportHeight))

  // Live edit: user trims the bottom of the script; scroll clamps to the new bottom instead of resetting to 0
  const trimmedHeight = 5_000
  const clampedAfterTrim = clampScrollOnEdit(offset, trimmedHeight, viewportHeight)
  assert.equal(clampedAfterTrim, maxScrollOffset(trimmedHeight, viewportHeight))
  assert.ok(clampedAfterTrim > 0)
})

test('Phase 3 QA (TEL-02): overlay placement and resizing remain bounded across extreme deltas, corners, and non-finite inputs', () => {
  const nanBounds = clampOverlayBounds({
    x: Number.NaN,
    y: Number.POSITIVE_INFINITY,
    width: Number.NEGATIVE_INFINITY,
    height: Number.NaN,
  })
  assert.deepEqual(nanBounds, DEFAULT_OVERLAY_BOUNDS)

  // Drag from top-left to bottom-right and back across a 1280x720 preview container
  const topLeft = dragOverlayBounds(DEFAULT_OVERLAY_BOUNDS, -5_000, -5_000, 1280, 720)
  assert.equal(topLeft.x, 0)
  assert.equal(topLeft.y, 0)

  const bottomRight = dragOverlayBounds(topLeft, 5_000, 5_000, 1280, 720)
  assert.ok(Math.abs(bottomRight.x - (1 - DEFAULT_OVERLAY_BOUNDS.width)) < 1e-9)
  assert.ok(Math.abs(bottomRight.y - (1 - DEFAULT_OVERLAY_BOUNDS.height)) < 1e-9)

  // Resize when positioned near the bottom-right corner cannot exceed (1 - x) or (1 - y)
  const nearCorner = { x: 0.65, y: 0.72, width: 0.3, height: 0.24 }
  const resizedAtCorner = resizeOverlayBounds(nearCorner, 2_000, 2_000, 1280, 720)
  assert.equal(resizedAtCorner.x, 0.65)
  assert.equal(resizedAtCorner.y, 0.72)
  assert.ok(resizedAtCorner.width <= 1 - nearCorner.x + 1e-9)
  assert.ok(resizedAtCorner.height <= 1 - nearCorner.y + 1e-9)

  // Resize from origin to maximum and minimum allowed dimensions
  const fromOrigin = { x: 0, y: 0, width: 0.5, height: 0.5 }
  const maxSized = resizeOverlayBounds(fromOrigin, 10_000, 10_000, 1280, 720)
  assert.equal(maxSized.width, MAX_OVERLAY_WIDTH)
  assert.equal(maxSized.height, MAX_OVERLAY_HEIGHT)

  const minSized = resizeOverlayBounds(fromOrigin, -10_000, -10_000, 1280, 720)
  assert.equal(minSized.width, MIN_OVERLAY_WIDTH)
  assert.equal(minSized.height, MIN_OVERLAY_HEIGHT)

  // Invalid container dimensions safely return clamped starting bounds
  assert.deepEqual(dragOverlayBounds(fromOrigin, 100, 100, -1280, 720), fromOrigin)
  assert.deepEqual(resizeOverlayBounds(fromOrigin, 100, 100, Number.NaN, 720), fromOrigin)
})

test('Phase 3 QA (CAM-06, CAM-07): interrupted save recovery preserves temporary recording across missing folders, invalid names, and collisions until saved cleanly', async () => {
  const { root, takes } = await createTempEnv()
  await takes.begin()

  const chunks = [
    new TextEncoder().encode('ftypisom-header-'),
    new TextEncoder().encode('moov-track-video-audio-'),
    new TextEncoder().encode('mdat-payload-frames'),
  ]
  for (const chunk of chunks) {
    await takes.append(chunk)
  }

  // Saving or discarding before finish() is rejected without losing the recording
  await assert.rejects(
    takes.save({ filename: 'early.mp4', directory: root }),
    /Stop recording before saving/,
  )
  await assert.rejects(takes.discard(), /Stop recording before discarding/)

  const totalBytes = await takes.finish()
  assert.equal(totalBytes, chunks.reduce((sum, c) => sum + c.byteLength, 0))
  const tempSource = takes.temporaryFilePath!
  assert.ok(tempSource)

  // 1. Missing destination directory fails and preserves temporary source
  const missingDir = join(root, 'does-not-exist')
  await assert.rejects(
    takes.save({ filename: 'intro.mp4', directory: missingDir }),
    /Choose an existing folder/,
  )
  assert.equal(takes.temporaryFilePath, tempSource)
  assert.equal(takes.isSaved, false)

  // 2. Invalid Windows filenames fail and preserve temporary source
  for (const badName of ['', '   ', ' leading.mp4', 'bad:name.mp4', 'sub/file.mp4', 'AUX.mp4']) {
    await assert.rejects(
      takes.save({ filename: badName, directory: root }),
      /Enter a valid filename/,
    )
  }
  assert.equal(takes.temporaryFilePath, tempSource)

  // 3. Retry with an existing name adds a suffix without overwriting the original.
  const collidingPath = join(root, 'collision.mp4')
  await writeFile(collidingPath, 'original-existing-video')
  const savedPath = await takes.save({ filename: 'collision', directory: root })
  assert.equal(await readFile(collidingPath, 'utf8'), 'original-existing-video')
  assert.equal(savedPath, join(root, 'collision_2.mp4'))
  assert.equal(takes.isSaved, true)
  assert.equal(takes.temporaryFilePath, null)
  assert.equal(
    await readFile(savedPath, 'utf8'),
    'ftypisom-header-moov-track-video-audio-mdat-payload-frames',
  )
  await assert.rejects(stat(tempSource), { code: 'ENOENT' })
})

test('Phase 3 QA (TEL-08): keyboard shortcut isolation across modifiers, interactive controls, and editor focus states', () => {
  // Exact modifier requirements: Ctrl+R, Shift+R, Alt+R, Meta+R, or Ctrl+Shift+Alt+R must not trigger
  assert.equal(resolveStudioShortcut({ key: 'r', ctrlKey: true, targetTagName: 'DIV' }), null)
  assert.equal(resolveStudioShortcut({ key: 'r', shiftKey: true, targetTagName: 'DIV' }), null)
  assert.equal(resolveStudioShortcut({ key: 'r', altKey: true, targetTagName: 'DIV' }), null)
  assert.equal(resolveStudioShortcut({ key: 'r', metaKey: true, targetTagName: 'DIV' }), null)
  assert.equal(
    resolveStudioShortcut({ key: 'r', ctrlKey: true, shiftKey: true, altKey: true, targetTagName: 'DIV' }),
    null,
  )
  assert.equal(
    resolveStudioShortcut({ key: 'r', ctrlKey: true, shiftKey: true, metaKey: true, targetTagName: 'DIV' }),
    null,
  )

  // Space with any modifier must not toggle scroll
  assert.equal(resolveStudioShortcut({ key: ' ', code: 'Space', shiftKey: true, targetTagName: 'DIV' }), null)
  assert.equal(resolveStudioShortcut({ key: ' ', code: 'Space', ctrlKey: true, targetTagName: 'DIV' }), null)

  // Interactive elements (BUTTON, SUMMARY, A, role="button") block single-key Space/R but allow Ctrl+Shift+R
  for (const target of [
    { targetTagName: 'BUTTON' },
    { targetTagName: 'SUMMARY' },
    { targetTagName: 'A' },
    { targetTagName: 'DIV', targetRole: 'button' },
  ]) {
    assert.equal(resolveStudioShortcut({ key: ' ', code: 'Space', ...target }), null)
    assert.equal(resolveStudioShortcut({ key: 'r', code: 'KeyR', ...target }), null)
    assert.equal(
      resolveStudioShortcut({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true, ...target }),
      'toggle-recording',
    )
  }

  // Form controls and contentEditable block all shortcuts including Ctrl+Shift+R
  for (const editorTarget of [
    { targetTagName: 'TEXTAREA' },
    { targetTagName: 'INPUT' },
    { targetTagName: 'SELECT' },
    { targetTagName: 'DIV', isContentEditable: true },
  ]) {
    assert.equal(resolveStudioShortcut({ key: ' ', code: 'Space', ...editorTarget }), null)
    assert.equal(resolveStudioShortcut({ key: 'r', code: 'KeyR', ...editorTarget }), null)
    assert.equal(
      resolveStudioShortcut({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true, ...editorTarget }),
      null,
    )
  }
})
