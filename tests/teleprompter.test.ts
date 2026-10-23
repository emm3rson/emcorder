import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampOverlayBounds,
  clampScrollOnEdit,
  DEFAULT_FONT_SIZE,
  DEFAULT_OVERLAY_BOUNDS,
  DEFAULT_OVERLAY_OPACITY,
  DEFAULT_SCROLL_SPEED,
  dragOverlayBounds,
  MAX_OVERLAY_HEIGHT,
  MAX_OVERLAY_WIDTH,
  maxScrollOffset,
  MIN_OVERLAY_HEIGHT,
  MIN_OVERLAY_WIDTH,
  resizeOverlayBounds,
  resolveStudioShortcut,
  stepScrollOffset,
} from '../src/renderer/features/teleprompter/teleprompterModel'

test('teleprompter defaults stay within supported bounds', () => {
  const clamped = clampOverlayBounds(DEFAULT_OVERLAY_BOUNDS)
  assert.deepEqual(clamped, DEFAULT_OVERLAY_BOUNDS)
  assert.equal(DEFAULT_FONT_SIZE, 24)
  assert.equal(DEFAULT_SCROLL_SPEED, 36)
  assert.equal(DEFAULT_OVERLAY_OPACITY, 0.78)
})

test('clampOverlayBounds enforces minimum/maximum dimensions and keeps overlay inside [0, 1]', () => {
  const tooSmall = clampOverlayBounds({ x: -0.5, y: -0.2, width: 0.1, height: 0.05 })
  assert.equal(tooSmall.width, MIN_OVERLAY_WIDTH)
  assert.equal(tooSmall.height, MIN_OVERLAY_HEIGHT)
  assert.equal(tooSmall.x, 0)
  assert.equal(tooSmall.y, 0)

  const tooLargeAndOverflowing = clampOverlayBounds({ x: 0.9, y: 0.9, width: 1.5, height: 1.2 })
  assert.equal(tooLargeAndOverflowing.width, MAX_OVERLAY_WIDTH)
  assert.equal(tooLargeAndOverflowing.height, MAX_OVERLAY_HEIGHT)
  assert.ok(Math.abs(tooLargeAndOverflowing.x - (1 - MAX_OVERLAY_WIDTH)) < 1e-9)
  assert.ok(Math.abs(tooLargeAndOverflowing.y - (1 - MAX_OVERLAY_HEIGHT)) < 1e-9)
})

test('invalid position fallbacks stay inside the preview at maximum overlay size', () => {
  const bounds = clampOverlayBounds({
    x: Number.NaN,
    y: Number.POSITIVE_INFINITY,
    width: MAX_OVERLAY_WIDTH,
    height: MAX_OVERLAY_HEIGHT,
  })
  assert.equal(bounds.x, 1 - MAX_OVERLAY_WIDTH)
  assert.equal(bounds.y, DEFAULT_OVERLAY_BOUNDS.y)
  assert.ok(bounds.x + bounds.width <= 1)
  assert.ok(bounds.y + bounds.height <= 1)
  assert.deepEqual(clampOverlayBounds(bounds), bounds)
})

test('dragOverlayBounds translates pixel deltas into normalized ratios and clamps at edges', () => {
  const start = { x: 0.2, y: 0.1, width: 0.5, height: 0.4 }
  const moved = dragOverlayBounds(start, 100, 50, 1000, 500)
  assert.ok(Math.abs(moved.x - 0.3) < 1e-9)
  assert.ok(Math.abs(moved.y - 0.2) < 1e-9)
  assert.equal(moved.width, 0.5)
  assert.equal(moved.height, 0.4)

  const clampedRightBottom = dragOverlayBounds(start, 2000, 2000, 1000, 500)
  assert.ok(Math.abs(clampedRightBottom.x - 0.5) < 1e-9)
  assert.ok(Math.abs(clampedRightBottom.y - 0.6) < 1e-9)

  const clampedLeftTop = dragOverlayBounds(start, -2000, -2000, 1000, 500)
  assert.equal(clampedLeftTop.x, 0)
  assert.equal(clampedLeftTop.y, 0)

  const zeroContainer = dragOverlayBounds(start, 100, 100, 0, 0)
  assert.deepEqual(zeroContainer, start)
})

test('resizeOverlayBounds resizes from bottom-right without overflowing container or minimum size', () => {
  const start = { x: 0.2, y: 0.15, width: 0.5, height: 0.4 }
  const grown = resizeOverlayBounds(start, 200, 100, 1000, 500)
  assert.equal(grown.x, 0.2)
  assert.equal(grown.y, 0.15)
  assert.ok(Math.abs(grown.width - 0.7) < 1e-9)
  assert.ok(Math.abs(grown.height - 0.6) < 1e-9)

  const overflowAttempt = resizeOverlayBounds(start, 2000, 2000, 1000, 500)
  assert.equal(overflowAttempt.x, 0.2)
  assert.equal(overflowAttempt.y, 0.15)
  assert.ok(Math.abs(overflowAttempt.width - 0.8) < 1e-9)
  assert.ok(Math.abs(overflowAttempt.height - 0.85) < 1e-9)

  const shrinkAttempt = resizeOverlayBounds(start, -2000, -2000, 1000, 500)
  assert.equal(shrinkAttempt.width, MIN_OVERLAY_WIDTH)
  assert.equal(shrinkAttempt.height, MIN_OVERLAY_HEIGHT)
})

test('stepScrollOffset advances smoothly, clamps large frame deltas, and stops at maxScrollOffset', () => {
  assert.equal(maxScrollOffset(500, 200), 300)
  assert.equal(maxScrollOffset(150, 200), 0)

  const step1 = stepScrollOffset(0, 40, 100, 500, 200)
  assert.ok(Math.abs(step1.offset - 4) < 1e-9)
  assert.equal(step1.reachedEnd, false)

  // Delta > 250ms is clamped to 250ms so background tab jumps do not skip script lines
  const hiccupStep = stepScrollOffset(10, 40, 2000, 500, 200)
  assert.ok(Math.abs(hiccupStep.offset - 20) < 1e-9)
  assert.equal(hiccupStep.reachedEnd, false)

  const finalStep = stepScrollOffset(295, 40, 250, 500, 200)
  assert.equal(finalStep.offset, 300)
  assert.equal(finalStep.reachedEnd, true)

  const shortContentStep = stepScrollOffset(0, 40, 100, 120, 200)
  assert.equal(shortContentStep.offset, 0)
  assert.equal(shortContentStep.reachedEnd, false)
})

test('clampScrollOnEdit preserves scroll offset during live edits and clamps only when content shrinks past offset', () => {
  // Appending or editing script while scrolled at 140px keeps offset at 140px (never resets to 0)
  assert.equal(clampScrollOnEdit(140, 600, 200), 140)
  assert.equal(clampScrollOnEdit(140, 800, 200), 140)

  // If script is shortened so max scroll is now 90px, clamp to 90px instead of 0
  assert.equal(clampScrollOnEdit(140, 290, 200), 90)
})

test('resolveStudioShortcut handles Space, R, and Ctrl+Shift+R and suppresses shortcuts in inputs/modals/buttons', () => {
  assert.equal(resolveStudioShortcut({ key: ' ', code: 'Space', targetTagName: 'DIV' }), 'toggle-scroll')
  assert.equal(resolveStudioShortcut({ key: 'r', code: 'KeyR', targetTagName: 'DIV' }), 'restart-script')
  assert.equal(resolveStudioShortcut({ key: 'R', code: 'KeyR', targetTagName: 'BODY' }), 'restart-script')
  assert.equal(
    resolveStudioShortcut({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true, targetTagName: 'DIV' }),
    'toggle-recording',
  )

  // Ignored while typing in script editor or form fields (TEL-08)
  assert.equal(resolveStudioShortcut({ key: ' ', code: 'Space', targetTagName: 'TEXTAREA' }), null)
  assert.equal(resolveStudioShortcut({ key: 'r', code: 'KeyR', targetTagName: 'INPUT' }), null)
  assert.equal(resolveStudioShortcut({ key: 'r', code: 'KeyR', targetTagName: 'SELECT' }), null)
  assert.equal(
    resolveStudioShortcut({ key: 'R', ctrlKey: true, shiftKey: true, targetTagName: 'TEXTAREA' }),
    null,
  )
  assert.equal(
    resolveStudioShortcut({ key: ' ', code: 'Space', targetTagName: 'DIV', isContentEditable: true }),
    null,
  )

  // Single-key shortcuts do not hijack focused buttons, but Ctrl+Shift+R still works on buttons
  assert.equal(resolveStudioShortcut({ key: ' ', code: 'Space', targetTagName: 'BUTTON' }), null)
  assert.equal(resolveStudioShortcut({ key: 'r', code: 'KeyR', targetTagName: 'BUTTON' }), null)
  assert.equal(
    resolveStudioShortcut({ key: 'R', ctrlKey: true, shiftKey: true, targetTagName: 'BUTTON' }),
    'toggle-recording',
  )

  // Ignored when modal is open, event is repeated, or defaultPrevented
  assert.equal(resolveStudioShortcut({ key: ' ', code: 'Space', modalOpen: true }), null)
  assert.equal(resolveStudioShortcut({ key: ' ', code: 'Space', repeat: true }), null)
  assert.equal(resolveStudioShortcut({ key: ' ', code: 'Space', defaultPrevented: true }), null)
})
