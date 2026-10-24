import { useEffect, useId, useRef, useState } from 'react'
import { errorMessage } from '../recordings/presentation'
import { MAX_COUNTDOWN_SECONDS, MIN_COUNTDOWN_SECONDS } from '../../../shared/studioSettings'

const countdownOptions = Array.from(
  { length: MAX_COUNTDOWN_SECONDS - MIN_COUNTDOWN_SECONDS + 1 },
  (_, index) => MIN_COUNTDOWN_SECONDS + index,
)

interface SettingsDialogProps {
  countdownSeconds: number
  mirrorVideo: boolean
  autoStartPrompter: boolean
  outputFolder: string
  captureLocked: boolean
  folderLocked: boolean
  preferenceError: string
  onCountdownChange: (value: number) => void
  onMirrorChange: (value: boolean) => void
  onAutoStartPrompterChange: (value: boolean) => void
  onFolderChange: (path: string) => void
  onClose: () => void
}

export function SettingsDialog({
  countdownSeconds,
  mirrorVideo,
  autoStartPrompter,
  outputFolder,
  captureLocked,
  folderLocked,
  preferenceError,
  onCountdownChange,
  onMirrorChange,
  onAutoStartPrompterChange,
  onFolderChange,
  onClose,
}: SettingsDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pickerBusy = useRef(false)
  const [busy, setBusy] = useState(false)
  const [folderError, setFolderError] = useState('')
  const id = useId()

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
    return () => element?.close()
  }, [])

  async function changeFolder() {
    if (folderLocked || pickerBusy.current) return
    pickerBusy.current = true
    setBusy(true)
    setFolderError('')
    try {
      const selected = await window.emcorder.chooseOutputFolder()
      if (selected) onFolderChange(selected)
    } catch (failure) {
      setFolderError(errorMessage(failure))
    } finally {
      pickerBusy.current = false
      setBusy(false)
    }
  }

  function close() {
    if (pickerBusy.current) return
    dialog.current?.close()
    onClose()
  }

  return (
    <dialog
      ref={dialog}
      className="save-dialog settings-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="save-dialog-header">
        <h2 id={`${id}-title`}>Settings</h2>
      </div>
      <p className="quiet">EmCorder {__APP_VERSION__}</p>

      <div className="settings-group">
        <label className="settings-row" htmlFor={`${id}-countdown`}>
          <span className="settings-label">Countdown</span>
          <select
            id={`${id}-countdown`}
            aria-label="Countdown"
            value={countdownSeconds}
            disabled={captureLocked || busy}
            onChange={(event) => onCountdownChange(Number(event.target.value))}
          >
            {countdownOptions.map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
          </select>
        </label>
        <label className="settings-row" htmlFor={`${id}-mirror`}>
          <span className="settings-copy">
            <span className="settings-label">Mirror video</span>
            <span className="quiet" id={`${id}-mirror-help`}>Applies to the preview and saved video.</span>
          </span>
          <input
            className="toggle"
            type="checkbox"
            id={`${id}-mirror`}
            aria-label="Mirror video"
            aria-describedby={`${id}-mirror-help`}
            checked={mirrorVideo}
            disabled={captureLocked || busy}
            onChange={(event) => onMirrorChange(event.target.checked)}
          />
        </label>
        <label className="settings-row" htmlFor={`${id}-auto-start`}>
          <span className="settings-copy">
            <span className="settings-label">Start prompter automatically</span>
            <span className="quiet" id={`${id}-auto-start-help`}>Scroll after the recording countdown ends.</span>
          </span>
          <input
            className="toggle"
            type="checkbox"
            id={`${id}-auto-start`}
            aria-label="Start prompter automatically"
            aria-describedby={`${id}-auto-start-help`}
            checked={autoStartPrompter}
            disabled={captureLocked || busy}
            onChange={(event) => onAutoStartPrompterChange(event.target.checked)}
          />
        </label>
      </div>

      <section className="settings-group settings-folder" aria-labelledby={`${id}-folder-title`}>
        <h3 id={`${id}-folder-title`} className="settings-label">Default save folder</h3>
        <p className="saved-path">{outputFolder || 'No folder selected'}</p>
        <button type="button" disabled={folderLocked || busy} onClick={() => void changeFolder()}>
          {busy ? 'Choosing folder…' : 'Change folder'}
        </button>
      </section>

      <section className="settings-group settings-shortcuts" aria-labelledby={`${id}-shortcuts-title`}>
        <h3 id={`${id}-shortcuts-title`} className="settings-label">Keyboard shortcuts</h3>
        <dl>
          <div><dt><kbd>Space</kbd></dt><dd>Start or pause scrolling</dd></div>
          <div><dt><kbd>R</kbd></dt><dd>Restart script</dd></div>
          <div><dt><kbd>Ctrl + Shift + R</kbd></dt><dd>Start or stop recording; cancel countdown</dd></div>
        </dl>
      </section>

      {folderError && <p role="alert" className="dialog-error">{folderError}</p>}
      {preferenceError && <p role="alert" className="dialog-error">{preferenceError}</p>}

      <div className="dialog-actions">
        <button type="button" autoFocus disabled={busy} onClick={close}>Close</button>
      </div>
    </dialog>
  )
}
