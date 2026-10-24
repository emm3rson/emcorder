import {
  DEFAULT_IMAGE_ADJUSTMENTS,
  IMAGE_ADJUSTMENT_LIMITS,
  type ImageAdjustments,
} from '../../../shared/imageAdjustments'

const CONTROLS = [
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
] as const

interface ImagePanelProps {
  adjustments: ImageAdjustments
  disabled: boolean
  onChange(adjustments: ImageAdjustments): void
}

export function ImagePanel({ adjustments, disabled, onChange }: ImagePanelProps) {
  const neutral = CONTROLS.every(({ key }) => adjustments[key] === DEFAULT_IMAGE_ADJUSTMENTS[key])

  return (
    <details className="card image-card">
      <summary>
        <h2>Image</h2>
        <svg className="btn-icon image-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 5 7 7-7 7" />
        </svg>
      </summary>
      <fieldset className="image-controls" disabled={disabled}>
        <legend className="sr-only">Image adjustments</legend>
        <div className="slider-stack">
          {CONTROLS.map(({ key, label }) => (
            <label className="slider-row" key={key}>
              <span className="slider-head">
                <span>{label}</span>
                <span className="slider-value">{adjustments[key]}%</span>
              </span>
              <input
                aria-label={label}
                aria-valuetext={`${adjustments[key]}%`}
                type="range"
                min={IMAGE_ADJUSTMENT_LIMITS[key].min}
                max={IMAGE_ADJUSTMENT_LIMITS[key].max}
                step={1}
                value={adjustments[key]}
                onChange={(event) => onChange({ ...adjustments, [key]: Number(event.target.value) })}
              />
            </label>
          ))}
        </div>
        <div className="image-actions">
          <button type="button" className="subtle-action" aria-label="Reset image adjustments" disabled={neutral} onClick={() => onChange({ ...DEFAULT_IMAGE_ADJUSTMENTS })}>
            Reset
          </button>
        </div>
      </fieldset>
    </details>
  )
}
