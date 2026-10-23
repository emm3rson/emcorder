import { MAX_SCRIPT_LENGTH } from '../../../shared/contracts'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  OVERLAY_OPACITY_MAX,
  OVERLAY_OPACITY_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
} from './teleprompterModel'

export interface TeleprompterPanelProps {
  script: string
  overlayVisible: boolean
  playing: boolean
  fontSize: number
  scrollSpeed: number
  opacity: number
  canShowOverlay: boolean
  onScriptChange(script: string): void
  onClearScript(): void
  onToggleOverlay(): void
  onTogglePlay(): void
  onRestart(): void
  onFontSizeChange(size: number): void
  onScrollSpeedChange(speed: number): void
  onOpacityChange(opacity: number): void
  onResetBounds(): void
}

export function TeleprompterPanel({
  script,
  overlayVisible,
  playing,
  fontSize,
  scrollSpeed,
  opacity,
  canShowOverlay,
  onScriptChange,
  onClearScript,
  onToggleOverlay,
  onTogglePlay,
  onRestart,
  onFontSizeChange,
  onScrollSpeedChange,
  onOpacityChange,
  onResetBounds,
}: TeleprompterPanelProps) {
  return (
    <section className="card teleprompter-card">
      <div className="section-head">
        <h2>Teleprompter</h2>
      </div>

      <label>
        <textarea
          aria-label="Teleprompter script"
          rows={4}
          maxLength={MAX_SCRIPT_LENGTH}
          placeholder="Paste or type your script here…"
          value={script}
          onChange={(event) => onScriptChange(event.target.value)}
        />
      </label>

      <div className="row pill-group teleprompter-actions">
        <button
          type="button"
          className={overlayVisible ? 'pill-active' : ''}
          onClick={onToggleOverlay}
          disabled={!canShowOverlay}
          aria-label={overlayVisible ? 'Hide overlay' : 'Show overlay'}
        >
          {overlayVisible ? (
            <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
              <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
              <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
              <line x1="2" y1="2" x2="22" y2="22" />
            </svg>
          ) : (
            <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
          <span>{overlayVisible ? 'Hide' : 'Show'}</span>
        </button>
        <button
          type="button"
          className={playing ? 'pill-active' : ''}
          onClick={onTogglePlay}
          disabled={!canShowOverlay}
          aria-label={playing ? 'Pause scroll' : 'Play scroll'}
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
          <span>{playing ? 'Pause' : 'Play'}</span>
        </button>
        <button type="button" onClick={onRestart} aria-label="Restart teleprompter">
          <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          <span>Restart</span>
        </button>
        <button type="button" onClick={onClearScript} disabled={!script} aria-label="Clear script">
          <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
          <span>Clear</span>
        </button>
      </div>

      <div className="slider-stack">
        <label className="slider-row">
          <span className="slider-head">
            <span>Scroll speed</span>
            <span className="slider-value">{scrollSpeed} px/s</span>
          </span>
          <input
            aria-label="Scroll speed"
            type="range"
            min={SCROLL_SPEED_MIN}
            max={SCROLL_SPEED_MAX}
            step={1}
            value={scrollSpeed}
            onChange={(event) => onScrollSpeedChange(Number(event.target.value))}
          />
        </label>

        <label className="slider-row">
          <span className="slider-head">
            <span>Font size</span>
            <span className="slider-value">{fontSize} px</span>
          </span>
          <input
            aria-label="Font size"
            type="range"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={fontSize}
            onChange={(event) => onFontSizeChange(Number(event.target.value))}
          />
        </label>

        <label className="slider-row">
          <span className="slider-head">
            <span>Overlay opacity</span>
            <span className="slider-value">{Math.round(opacity * 100)}%</span>
          </span>
          <input
            aria-label="Overlay opacity"
            type="range"
            min={OVERLAY_OPACITY_MIN}
            max={OVERLAY_OPACITY_MAX}
            step={0.05}
            value={opacity}
            onChange={(event) => onOpacityChange(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="row wrap teleprompter-footer">
        <button type="button" className="subtle-action" onClick={onResetBounds}>
          Reset position
        </button>
      </div>
    </section>
  )
}
