import { useCallback, useEffect, useRef, useState } from 'react'
import { AdvisorySession, blurAdvisory, type Advisory } from './advisories'

interface Props {
  blurStatus: string
  microphoneQuiet: boolean
  qualityNotice: string
  limitReached: boolean
  modalOpen: boolean
}

function AdvisoryToast({ advisory, onDismiss, hidden }: { advisory: Advisory; onDismiss: () => void; hidden: boolean }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const remaining = useRef(6000)

  useEffect(() => {
    if (hidden || hovered || focused) return
    const started = performance.now()
    const timer = window.setTimeout(onDismiss, remaining.current)
    return () => {
      window.clearTimeout(timer)
      remaining.current = Math.max(0, remaining.current - (performance.now() - started))
    }
  }, [hidden, hovered, focused, onDismiss])

  return (
    <div className="advisory-toast" hidden={hidden}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
      <p role="status" aria-atomic="true">{advisory.message}</p>
      <button type="button" className="toast-dismiss" aria-label="Dismiss notification" onClick={onDismiss}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div>
  )
}

/** Remounted by the studio for a new take or an explicit device/blur retry. */
export function StudioAdvisories({ blurStatus, microphoneQuiet, qualityNotice, limitReached, modalOpen }: Props) {
  const [session] = useState(() => new AdvisorySession())
  const [queue, setQueue] = useState<Advisory[]>([])
  const blurNotice = blurAdvisory(blurStatus)
  const blurId = blurNotice?.id
  const blurMessage = blurNotice?.message
  const blurDelay = blurNotice?.delayMs

  useEffect(() => {
    const active: Advisory[] = []
    if (microphoneQuiet) active.push({ id: 'microphone-quiet', message: 'Microphone input is quiet. Check your microphone if you’re speaking.', delayMs: 0 })
    if (limitReached) active.push({ id: 'recording-limit', message: 'The 15-minute limit was reached. Your take has been finalized.', delayMs: 0 })
    if (qualityNotice) active.push({ id: 'quality-fallback', message: qualityNotice, delayMs: 0 })
    if (blurId && blurMessage) active.push({ id: blurId, message: blurMessage, delayMs: blurDelay ?? 2000 })
    const activeIds = new Set(active.map((item) => item.id))
    const check = () => {
      const ready = session.observe(active, performance.now())
      setQueue((current) => {
        // Finish the visible toast, but drop queued notices that are no longer relevant.
        const retained = current.filter((item, index) => index === 0 || activeIds.has(item.id))
        if (!ready.length && retained.length === current.length) return current
        return [...retained, ...ready]
      })
    }
    check()
    if (!session.waiting) return
    const timer = window.setInterval(() => {
      check()
      if (!session.waiting) window.clearInterval(timer)
    }, 200)
    return () => window.clearInterval(timer)
  }, [session, blurId, blurMessage, blurDelay, microphoneQuiet, qualityNotice, limitReached])

  const dismiss = useCallback(() => setQueue((current) => current.slice(1)), [])
  const current = queue[0]
  return current ? <AdvisoryToast key={current.id} advisory={current} onDismiss={dismiss} hidden={modalOpen} /> : null
}
