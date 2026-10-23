import type { OverlayBounds } from '../../../shared/contracts'
import {
  DEFAULT_OVERLAY_BOUNDS, MIN_OVERLAY_WIDTH, MAX_OVERLAY_WIDTH,
  MIN_OVERLAY_HEIGHT, MAX_OVERLAY_HEIGHT, DEFAULT_SCROLL_SPEED,
  MAX_SCROLL_SPEED as SCROLL_SPEED_MAX,
} from '../../../shared/teleprompter'
export type { OverlayBounds } from '../../../shared/contracts'
export {
  DEFAULT_OVERLAY_BOUNDS, MIN_OVERLAY_WIDTH, MAX_OVERLAY_WIDTH,
  MIN_OVERLAY_HEIGHT, MAX_OVERLAY_HEIGHT, DEFAULT_FONT_SIZE,
  MIN_FONT_SIZE as FONT_SIZE_MIN, MAX_FONT_SIZE as FONT_SIZE_MAX,
  DEFAULT_SCROLL_SPEED, MIN_SCROLL_SPEED as SCROLL_SPEED_MIN, MAX_SCROLL_SPEED as SCROLL_SPEED_MAX,
  DEFAULT_OVERLAY_OPACITY, MIN_OVERLAY_OPACITY as OVERLAY_OPACITY_MIN, MAX_OVERLAY_OPACITY as OVERLAY_OPACITY_MAX,
} from '../../../shared/teleprompter'

function clamp(value: number, min: number, max: number, fallback = min): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback))
}

export function clampOverlayBounds(bounds: OverlayBounds): OverlayBounds {
  const width = clamp(bounds.width, MIN_OVERLAY_WIDTH, MAX_OVERLAY_WIDTH, DEFAULT_OVERLAY_BOUNDS.width)
  const height = clamp(bounds.height, MIN_OVERLAY_HEIGHT, MAX_OVERLAY_HEIGHT, DEFAULT_OVERLAY_BOUNDS.height)
  const x = clamp(bounds.x, 0, Math.max(0, 1 - width), DEFAULT_OVERLAY_BOUNDS.x)
  const y = clamp(bounds.y, 0, Math.max(0, 1 - height), DEFAULT_OVERLAY_BOUNDS.y)
  return { x, y, width, height }
}

export function dragOverlayBounds(
  start: OverlayBounds,
  deltaX: number,
  deltaY: number,
  containerWidth: number,
  containerHeight: number,
): OverlayBounds {
  const base = clampOverlayBounds(start)
  if (
    !Number.isFinite(containerWidth) ||
    !Number.isFinite(containerHeight) ||
    containerWidth <= 0 ||
    containerHeight <= 0
  ) {
    return base
  }
  const dx = Number.isFinite(deltaX) ? deltaX / containerWidth : 0
  const dy = Number.isFinite(deltaY) ? deltaY / containerHeight : 0
  return clampOverlayBounds({
    x: base.x + dx,
    y: base.y + dy,
    width: base.width,
    height: base.height,
  })
}

export function resizeOverlayBounds(
  start: OverlayBounds,
  deltaX: number,
  deltaY: number,
  containerWidth: number,
  containerHeight: number,
): OverlayBounds {
  const base = clampOverlayBounds(start)
  if (
    !Number.isFinite(containerWidth) ||
    !Number.isFinite(containerHeight) ||
    containerWidth <= 0 ||
    containerHeight <= 0
  ) {
    return base
  }
  const dx = Number.isFinite(deltaX) ? deltaX / containerWidth : 0
  const dy = Number.isFinite(deltaY) ? deltaY / containerHeight : 0
  const maxWidth = Math.max(MIN_OVERLAY_WIDTH, Math.min(MAX_OVERLAY_WIDTH, 1 - base.x))
  const maxHeight = Math.max(MIN_OVERLAY_HEIGHT, Math.min(MAX_OVERLAY_HEIGHT, 1 - base.y))
  const width = clamp(base.width + dx, MIN_OVERLAY_WIDTH, maxWidth, base.width)
  const height = clamp(base.height + dy, MIN_OVERLAY_HEIGHT, maxHeight, base.height)
  return {
    x: base.x,
    y: base.y,
    width,
    height,
  }
}

export function maxScrollOffset(contentHeight: number, viewportHeight: number): number {
  const safeContent = Number.isFinite(contentHeight) ? Math.max(0, contentHeight) : 0
  const safeViewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0
  return Math.max(0, safeContent - safeViewport)
}

export function stepScrollOffset(
  currentOffset: number,
  speedPxPerSec: number,
  deltaMs: number,
  contentHeight: number,
  viewportHeight: number,
): { offset: number; reachedEnd: boolean } {
  const max = maxScrollOffset(contentHeight, viewportHeight)
  const clampedDeltaMs = clamp(deltaMs, 0, 250, 0)
  const safeSpeed = clamp(speedPxPerSec, 0, SCROLL_SPEED_MAX * 4, DEFAULT_SCROLL_SPEED)
  const safeCurrent = clamp(currentOffset, 0, max, 0)
  const nextOffset = clamp(safeCurrent + safeSpeed * (clampedDeltaMs / 1000), 0, max, 0)
  return {
    offset: nextOffset,
    reachedEnd: max > 0 && nextOffset >= max,
  }
}

export function clampScrollOnEdit(
  currentOffset: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  const max = maxScrollOffset(contentHeight, viewportHeight)
  return clamp(currentOffset, 0, max, 0)
}

export type StudioShortcutAction = 'toggle-scroll' | 'restart-script' | 'toggle-recording' | null

export interface ShortcutEventInput {
  key: string
  code?: string
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  repeat?: boolean
  defaultPrevented?: boolean
  targetTagName?: string | null
  targetRole?: string | null
  isContentEditable?: boolean
  modalOpen?: boolean
}

export function resolveStudioShortcut(input: ShortcutEventInput): StudioShortcutAction {
  if (input.defaultPrevented || input.repeat || input.modalOpen) {
    return null
  }

  const tag = (input.targetTagName || '').toUpperCase()
  if (
    input.isContentEditable ||
    tag === 'TEXTAREA' ||
    tag === 'INPUT' ||
    tag === 'SELECT'
  ) {
    return null
  }

  const ctrl = Boolean(input.ctrlKey)
  const shift = Boolean(input.shiftKey)
  const alt = Boolean(input.altKey)
  const meta = Boolean(input.metaKey)
  const keyLower = (input.key || '').toLowerCase()

  if (ctrl && shift && !alt && !meta && keyLower === 'r') {
    return 'toggle-recording'
  }

  if (
    tag === 'BUTTON' ||
    tag === 'SUMMARY' ||
    tag === 'A' ||
    input.targetRole === 'button'
  ) {
    return null
  }

  if (!ctrl && !shift && !alt && !meta) {
    if (input.code === 'Space' || input.key === ' ') {
      return 'toggle-scroll'
    }
    if (keyLower === 'r') {
      return 'restart-script'
    }
  }

  return null
}
