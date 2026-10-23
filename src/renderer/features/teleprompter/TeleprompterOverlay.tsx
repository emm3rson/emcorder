import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import {
  clampOverlayBounds,
  clampScrollOnEdit,
  dragOverlayBounds,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  maxScrollOffset,
  OVERLAY_OPACITY_MAX,
  OVERLAY_OPACITY_MIN,
  resizeOverlayBounds,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  stepScrollOffset,
  type OverlayBounds,
} from './teleprompterModel'

export interface TeleprompterOverlayProps {
  script: string
  playing: boolean
  scrollOffset: number
  fontSize: number
  scrollSpeed: number
  opacity: number
  bounds: OverlayBounds
  onTogglePlay(): void
  onRestart(): void
  onScrollOffsetChange(offset: number, reachedEnd?: boolean): void
  onFontSizeChange(size: number): void
  onScrollSpeedChange(speed: number): void
  onOpacityChange(opacity: number): void
  onBoundsChange(bounds: OverlayBounds): void
}

const DEFAULT_SAMPLE_SCRIPT =
  'Look toward your camera. Speak naturally, then check that this text stays out of your recording.'

interface GestureState {
  pointerId: number
  startX: number
  startY: number
  startBounds: OverlayBounds
  containerWidth: number
  containerHeight: number
}

export function TeleprompterOverlay({
  script,
  playing,
  scrollOffset,
  fontSize,
  scrollSpeed,
  opacity,
  bounds,
  onTogglePlay,
  onRestart,
  onScrollOffsetChange,
  onFontSizeChange,
  onScrollSpeedChange,
  onOpacityChange,
  onBoundsChange,
}: TeleprompterOverlayProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<GestureState | null>(null)
  const resizeStateRef = useRef<GestureState | null>(null)

  const clampedBounds = clampOverlayBounds(bounds)
  const scrollOffsetRef = useRef(scrollOffset)
  scrollOffsetRef.current = scrollOffset
  const scrollSpeedRef = useRef(scrollSpeed)
  scrollSpeedRef.current = scrollSpeed
  const onScrollOffsetChangeRef = useRef(onScrollOffsetChange)
  onScrollOffsetChangeRef.current = onScrollOffsetChange

  useEffect(() => {
    if (!playing) return

    const initialContentHeight = contentRef.current?.scrollHeight ?? 0
    const initialViewportHeight = measureViewportHeight()
    const initialMax = maxScrollOffset(initialContentHeight, initialViewportHeight)
    if (initialMax > 0 && scrollOffsetRef.current >= initialMax) {
      scrollOffsetRef.current = 0
      onScrollOffsetChangeRef.current(0, false)
    }

    let frameId = 0
    let lastTime: number | null = null

    const tick = (now: number) => {
      if (lastTime === null) {
        lastTime = now
        frameId = window.requestAnimationFrame(tick)
        return
      }
      const deltaMs = now - lastTime
      lastTime = now

      const contentHeight = contentRef.current?.scrollHeight ?? 0
      const viewportHeight = measureViewportHeight()
      const next = stepScrollOffset(
        scrollOffsetRef.current,
        scrollSpeedRef.current,
        deltaMs,
        contentHeight,
        viewportHeight,
      )
      scrollOffsetRef.current = next.offset
      onScrollOffsetChangeRef.current(next.offset, next.reachedEnd)

      if (!next.reachedEnd) {
        frameId = window.requestAnimationFrame(tick)
      }
    }

    frameId = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [playing])

  useEffect(() => {
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) return

    const clampOffset = () => {
      const clamped = clampScrollOnEdit(scrollOffsetRef.current, content.scrollHeight, measureViewportHeight())
      if (clamped !== scrollOffsetRef.current) {
        scrollOffsetRef.current = clamped
        onScrollOffsetChangeRef.current(clamped, false)
      }
    }
    // Observe actual layout, including window resizing and toolbar wrapping while paused.
    const observer = new ResizeObserver(clampOffset)
    observer.observe(content)
    observer.observe(viewport)
    clampOffset()
    return () => observer.disconnect()
  }, [])

  function measureViewportHeight(): number {
    const viewport = viewportRef.current
    if (!viewport) return 0
    // clientHeight includes padding, but the text must finish above the bottom padding.
    const style = window.getComputedStyle(viewport)
    return Math.max(0, viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
  }

  function measureContainer(): { width: number; height: number } {
    const rect = overlayRef.current?.parentElement?.getBoundingClientRect()
    return {
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
    }
  }

  function handleHeaderPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, label, select, textarea')) {
      return
    }
    const container = measureContainer()
    if (container.width <= 0 || container.height <= 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startBounds: clampedBounds,
      containerWidth: container.width,
      containerHeight: container.height,
    }
  }

  function handleHeaderPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const nextBounds = dragOverlayBounds(
      drag.startBounds,
      event.clientX - drag.startX,
      event.clientY - drag.startY,
      drag.containerWidth,
      drag.containerHeight,
    )
    onBoundsChange(nextBounds)
  }

  function handleHeaderPointerEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragStateRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function handleResizePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return
    event.stopPropagation()
    const container = measureContainer()
    if (container.width <= 0 || container.height <= 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startBounds: clampedBounds,
      containerWidth: container.width,
      containerHeight: container.height,
    }
  }

  function handleResizePointerMove(event: PointerEvent<HTMLButtonElement>) {
    const resize = resizeStateRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const nextBounds = resizeOverlayBounds(
      resize.startBounds,
      event.clientX - resize.startX,
      event.clientY - resize.startY,
      resize.containerWidth,
      resize.containerHeight,
    )
    onBoundsChange(nextBounds)
  }

  function handleResizePointerEnd(event: PointerEvent<HTMLButtonElement>) {
    const resize = resizeStateRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    resizeStateRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const step = 0.04
    let dw = 0
    let dh = 0
    if (event.key === 'ArrowRight') dw = step
    else if (event.key === 'ArrowLeft') dw = -step
    else if (event.key === 'ArrowDown') dh = step
    else if (event.key === 'ArrowUp') dh = -step
    else return

    event.preventDefault()
    onBoundsChange(resizeOverlayBounds(clampedBounds, dw, dh, 1, 1))
  }

  function handleViewportWheel(event: WheelEvent<HTMLDivElement>) {
    const contentHeight = contentRef.current?.scrollHeight ?? 0
    const viewportHeight = measureViewportHeight()
    const max = maxScrollOffset(contentHeight, viewportHeight)
    const nextOffset = Math.min(max, Math.max(0, scrollOffsetRef.current + event.deltaY))
    scrollOffsetRef.current = nextOffset
    onScrollOffsetChange(nextOffset, max > 0 && nextOffset >= max)
  }

  const displayScript = script.trim().length > 0 ? script : DEFAULT_SAMPLE_SCRIPT

  return (
    <div
      ref={overlayRef}
      className="prompter-overlay"
      data-testid="prompter-overlay"
      style={{
        left: `${clampedBounds.x * 100}%`,
        top: `${clampedBounds.y * 100}%`,
        width: `${clampedBounds.width * 100}%`,
        height: `${clampedBounds.height * 100}%`,
        backgroundColor: `rgba(21, 21, 21, ${opacity})`,
      }}
    >
      <div
        className="prompter-header"
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={handleHeaderPointerEnd}
        onPointerCancel={handleHeaderPointerEnd}
        onLostPointerCapture={handleHeaderPointerEnd}
      >
        <div className="prompter-title">
          <span>Prompter</span>
        </div>
        <div className="prompter-toolbar">
          <button
            type="button"
            aria-label={playing ? 'Pause teleprompter' : 'Play teleprompter'}
            title={playing ? 'Pause' : 'Play'}
            onClick={onTogglePlay}
          >
            {playing ? (
              <svg className="btn-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg className="btn-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <polygon points="6 4 20 12 6 20 6 4" />
              </svg>
            )}
          </button>
          <button
            type="button"
            aria-label="Restart teleprompter"
            title="Restart"
            onClick={onRestart}
          >
            <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
          <label className="prompter-mini-control">
            <span>Speed</span>
            <input
              aria-label="Overlay scroll speed"
              type="range"
              min={SCROLL_SPEED_MIN}
              max={SCROLL_SPEED_MAX}
              step={1}
              value={scrollSpeed}
              onChange={(event) => onScrollSpeedChange(Number(event.target.value))}
            />
          </label>
          <label className="prompter-mini-control">
            <span>Size</span>
            <input
              aria-label="Overlay font size"
              type="range"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={1}
              value={fontSize}
              onChange={(event) => onFontSizeChange(Number(event.target.value))}
            />
          </label>
          <label className="prompter-mini-control">
            <span>Opacity</span>
            <input
              aria-label="Overlay panel opacity"
              type="range"
              min={OVERLAY_OPACITY_MIN}
              max={OVERLAY_OPACITY_MAX}
              step={0.05}
              value={opacity}
              onChange={(event) => onOpacityChange(Number(event.target.value))}
            />
          </label>
        </div>
      </div>

      <div ref={viewportRef} className="prompter-viewport" onWheel={handleViewportWheel}>
        <div
          ref={contentRef}
          className="prompter-content"
          style={{
            fontSize: `${fontSize}px`,
            transform: `translate3d(0, -${scrollOffset}px, 0)`,
            whiteSpace: 'pre-wrap',
          }}
        >
          {displayScript}
        </div>
      </div>

      <button
        type="button"
        className="prompter-resize-handle"
        aria-label="Resize teleprompter overlay"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        onLostPointerCapture={handleResizePointerEnd}
        onKeyDown={handleResizeKeyDown}
      />
    </div>
  )
}
