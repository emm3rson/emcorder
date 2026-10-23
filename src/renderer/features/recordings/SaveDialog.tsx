import { useEffect, useRef, useState } from 'react'
import { errorMessage, formatDuration } from './presentation'
import { RECORDING_PROFILES, type RecordingQuality } from '../../../shared/recordingQuality'

const formatMegabytes = (bytes?: number) => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

export function SaveDialog({
  folder,
  initialFilename,
  bytes,
  elapsedSeconds,
  quality,
  onFolderChange,
  onSave,
  onCancel,
}: {
  folder: string
  initialFilename: string
  bytes?: number
  elapsedSeconds?: number
  quality: RecordingQuality
  onFolderChange?: (directory: string) => void
  onSave: (filename: string, directory: string) => Promise<void>
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [filename, setFilename] = useState(initialFilename)
  const [directory, setDirectory] = useState(folder)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])

  async function browse() {
    setBusy(true); setError('')
    try {
      const selected = await window.emcorder.chooseOutputFolder()
      if (selected) {
        setDirectory(selected)
        onFolderChange?.(selected)
      }
    } catch (failure) { setError(errorMessage(failure)) }
    finally { setBusy(false) }
  }

  const durationLabel = typeof elapsedSeconds === 'number' && Number.isFinite(elapsedSeconds)
    ? formatDuration(elapsedSeconds) : null
  const sizeLabel = formatMegabytes(bytes)
  const pillSummary = [durationLabel, sizeLabel].filter(Boolean).join(' · ') || `${quality} · MP4`
  const profile = RECORDING_PROFILES[quality]
  const displayFilename = filename.trim() || initialFilename

  return (
    <dialog
      ref={dialog}
      aria-labelledby="save-title"
      className="save-dialog"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (busy) return
          setBusy(true)
          setError('')
          void onSave(filename.trim(), directory.trim()).catch((failure: unknown) => {
            setError(`The take is still available. ${errorMessage(failure)}`)
            setBusy(false)
          })
        }}
      >
        <div className="save-dialog-header">
          <h2 id="save-title">Save recording</h2>
          <div className="save-summary-row">
            <div className="save-summary-file">
              <span className="save-file-thumb" aria-hidden="true">
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <rect x="2.5" y="4.5" width="11" height="11" rx="2.5" />
                  <path d="M13.5 8.5L17.5 6.2V13.8L13.5 11.5V8.5Z" strokeLinejoin="round" />
                </svg>
              </span>
              <div className="save-summary-text">
                <strong className="save-summary-name">{displayFilename}</strong>
                <span className="quiet">{profile.width} × {profile.height} px · {profile.frameRate} FPS · H.264 MP4</span>
              </div>
            </div>
            <span className="save-meta-pill">{pillSummary}</span>
          </div>
        </div>

        <div className="save-options">
          <label>
            <span className="save-field-label">Filename</span>
            <input
              autoFocus
              required
              aria-label="Filename"
              value={filename}
              disabled={busy}
              onChange={(event) => setFilename(event.target.value)}
            />
          </label>
        </div>

        <div className="save-options">
          <label>
            <span className="save-field-label">Destination</span>
            <input
              required
              aria-label="Destination"
              value={directory}
              disabled={busy}
              onChange={(event) => setDirectory(event.target.value)}
            />
          </label>
          <div className="save-field-foot">
            <button type="button" disabled={busy} onClick={() => void browse()}>
              <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
              </svg>
              <span>Browse…</span>
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" className="dialog-error">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={busy} type="submit">
            <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            <span>{busy ? 'Saving…' : 'Save'}</span>
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function DiscardDialog({
  failed,
  onDiscard,
  onCancel,
}: {
  failed: boolean
  onDiscard: () => Promise<void>
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])

  return (
    <dialog
      ref={dialog}
      aria-labelledby="discard-title"
      className="save-dialog discard-dialog"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <div className="save-dialog-header">
        <h2 id="discard-title">{failed ? 'Discard this take?' : 'Retake this recording?'}</h2>
        <p className="quiet">The unsaved temporary recording will be deleted from this PC.</p>
      </div>
      {error && (
        <p role="alert" className="dialog-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button autoFocus disabled={busy} onClick={onCancel}>
          <span>Cancel</span>
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void onDiscard().catch((failure: unknown) => {
              setError(errorMessage(failure))
              setBusy(false)
            })
          }}
        >
          <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
          <span>{busy ? 'Discarding…' : 'Discard'}</span>
        </button>
      </div>
    </dialog>
  )
}
