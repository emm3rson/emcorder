import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_RECORDING_QUALITY, type RecordingQuality } from '../../shared/recordingQuality'
import { BLUR_STRENGTHS, DEFAULT_BLUR_STRENGTH, type BlurStrength } from '../../shared/blurStrength'
import { DEFAULT_COUNTDOWN_SECONDS, DEFAULT_MIRROR_VIDEO, DEFAULT_AUTO_START_PROMPTER } from '../../shared/studioSettings'
import { DEFAULT_IMAGE_ADJUSTMENTS, type ImageAdjustments } from '../../shared/imageAdjustments'
import { useCamera, type CameraSelection } from '../features/camera/useCamera'
import { chooseMp4Type, Mp4Recorder, type RecordedTake } from '../features/recordings/recorder'
import { inspectRecording, type RecordingInspection } from '../features/recordings/mediaChecks'
import { DiscardDialog, SaveDialog } from '../features/recordings/SaveDialog'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import { errorMessage as message, formatDuration as time, newRecordingFilename as newFilename } from '../features/recordings/presentation'
import {
  clampOverlayBounds,
  DEFAULT_FONT_SIZE,
  DEFAULT_OVERLAY_BOUNDS,
  DEFAULT_OVERLAY_OPACITY,
  DEFAULT_SCROLL_SPEED,
  resolveStudioShortcut,
  type OverlayBounds,
} from '../features/teleprompter/teleprompterModel'
import { TeleprompterOverlay } from '../features/teleprompter/TeleprompterOverlay'
import { TeleprompterPanel } from '../features/teleprompter/TeleprompterPanel'
import { ImagePanel } from '../features/image/ImagePanel'

type Stage = 'idle' | 'ready' | 'countdown' | 'starting' | 'recording' | 'finalizing' | 'review' | 'saved' | 'error'

function BlurStrengthIcon({ strength }: { strength: BlurStrength }) {
  if (strength === 'light') {
    return (
      <svg className="btn-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="10" cy="10" r="1.4" />
        <circle cx="14" cy="10" r="1.4" />
        <circle cx="10" cy="14" r="1.4" />
        <circle cx="14" cy="14" r="1.4" />
        <circle cx="10" cy="6" r="0.9" />
        <circle cx="14" cy="6" r="0.9" />
        <circle cx="6" cy="10" r="0.9" />
        <circle cx="18" cy="10" r="0.9" />
        <circle cx="6" cy="14" r="0.9" />
        <circle cx="18" cy="14" r="0.9" />
        <circle cx="10" cy="18" r="0.9" />
        <circle cx="14" cy="18" r="0.9" />
      </svg>
    )
  }
  if (strength === 'strong') {
    return (
      <svg className="btn-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="10" cy="10" r="1.6" />
        <circle cx="14" cy="10" r="1.6" />
        <circle cx="10" cy="14" r="1.6" />
        <circle cx="14" cy="14" r="1.6" />
        <circle cx="10" cy="6" r="1.1" />
        <circle cx="14" cy="6" r="1.1" />
        <circle cx="6" cy="10" r="1.1" />
        <circle cx="18" cy="10" r="1.1" />
        <circle cx="6" cy="14" r="1.1" />
        <circle cx="18" cy="14" r="1.1" />
        <circle cx="10" cy="18" r="1.1" />
        <circle cx="14" cy="18" r="1.1" />
        <circle cx="6" cy="6" r="1.1" />
        <circle cx="18" cy="6" r="1.1" />
        <circle cx="6" cy="18" r="1.1" />
        <circle cx="18" cy="18" r="1.1" />
        <circle cx="10" cy="2.5" r="0.65" />
        <circle cx="14" cy="2.5" r="0.65" />
        <circle cx="2.5" cy="10" r="0.65" />
        <circle cx="2.5" cy="14" r="0.65" />
        <circle cx="21.5" cy="10" r="0.65" />
        <circle cx="21.5" cy="14" r="0.65" />
        <circle cx="10" cy="21.5" r="0.65" />
        <circle cx="14" cy="21.5" r="0.65" />
      </svg>
    )
  }
  return (
    <svg className="btn-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="10" cy="10" r="1.6" />
      <circle cx="14" cy="10" r="1.6" />
      <circle cx="10" cy="14" r="1.6" />
      <circle cx="14" cy="14" r="1.6" />
      <circle cx="10" cy="6" r="1.1" />
      <circle cx="14" cy="6" r="1.1" />
      <circle cx="6" cy="10" r="1.1" />
      <circle cx="18" cy="10" r="1.1" />
      <circle cx="6" cy="14" r="1.1" />
      <circle cx="18" cy="14" r="1.1" />
      <circle cx="10" cy="18" r="1.1" />
      <circle cx="14" cy="18" r="1.1" />
      <circle cx="6" cy="6" r="1.1" />
      <circle cx="18" cy="6" r="1.1" />
      <circle cx="6" cy="18" r="1.1" />
      <circle cx="18" cy="18" r="1.1" />
    </svg>
  )
}

export function Studio() {
  const [stage, setStage] = useState<Stage>('idle')
  const stageRef = useRef<Stage>('idle')
  const transition = useCallback((next: Stage) => { stageRef.current = next; setStage(next) }, [])
  const [error, setError] = useState('')
  const [preferenceError, setPreferenceError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [cameraId, setCameraId] = useState('')
  const [micId, setMicId] = useState('')
  const [quality, setQuality] = useState<RecordingQuality>(DEFAULT_RECORDING_QUALITY)
  const [blur, setBlur] = useState(true)
  const [blurStrength, setBlurStrength] = useState<BlurStrength>(DEFAULT_BLUR_STRENGTH)
  const [imageAdjustments, setImageAdjustments] = useState<ImageAdjustments>(() => ({ ...DEFAULT_IMAGE_ADJUSTMENTS }))
  const [outputFolder, setOutputFolder] = useState('')
  const [countdownSeconds, setCountdownSeconds] = useState(DEFAULT_COUNTDOWN_SECONDS)
  const [mirrorVideo, setMirrorVideo] = useState(DEFAULT_MIRROR_VIDEO)
  const [autoStartPrompter, setAutoStartPrompter] = useState(DEFAULT_AUTO_START_PROMPTER)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [script, setScript] = useState('')
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  const [scrollSpeed, setScrollSpeed] = useState(DEFAULT_SCROLL_SPEED)
  const [overlayOpacity, setOverlayOpacity] = useState(DEFAULT_OVERLAY_OPACITY)
  const [overlayBounds, setOverlayBounds] = useState<OverlayBounds>(() => ({ ...DEFAULT_OVERLAY_BOUNDS }))
  const [showOverlay, setShowOverlay] = useState(false)
  const [prompterPlaying, setPrompterPlaying] = useState(false)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [countdown, setCountdown] = useState(DEFAULT_COUNTDOWN_SECONDS)
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [micSilenceWarning, setMicSilenceWarning] = useState(false)
  const [limitReached, setLimitReached] = useState(false)
  const [take, setTake] = useState<RecordedTake | null>(null)
  const [reviewPlaying, setReviewPlaying] = useState(false)
  const [inspection, setInspection] = useState<RecordingInspection | null>(null)
  const inspectionGeneration = useRef(0)
  const inspectionAbort = useRef<AbortController | null>(null)
  const [savePath, setSavePath] = useState('')
  const [filename, setFilename] = useState(newFilename)
  const [saveOpen, setSaveOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const inputVideo = useRef<HTMLVideoElement>(null)
  const reviewVideo = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const recorder = useRef<Mp4Recorder | null>(null)
  const stopTask = useRef<Promise<void> | null>(null)
  const restarting = useRef(false)
  const restartTake = useRef<RecordedTake | null>(null)
  const mounted = useRef(true)
  const [has1080Mp4] = useState(() => chooseMp4Type('1080p') !== null)
  const prompter = useRef({ script, showOverlay, autoStartPrompter })
  prompter.current = { script, showOverlay, autoStartPrompter }

  const cancelInspection = useCallback(() => {
    inspectionGeneration.current++
    inspectionAbort.current?.abort()
    inspectionAbort.current = null
  }, [])

  const inspectTake = useCallback((result: RecordedTake) => {
    cancelInspection()
    setInspection(null)
    const generation = inspectionGeneration.current
    const controller = new AbortController()
    inspectionAbort.current = controller
    void inspectRecording(result.url, controller.signal).then((checked) => {
      if (mounted.current && generation === inspectionGeneration.current) setInspection(checked)
    })
  }, [cancelInspection])

  const reviewTake = useCallback((result: RecordedTake) => {
    setElapsed(result.elapsedSeconds)
    setTake(result)
    setReviewPlaying(false)
    transition('review')
    inspectTake(result)
  }, [inspectTake, transition])

  const releasePlayback = useCallback(() => {
    cancelInspection()
    const playback = reviewVideo.current
    if (playback) { playback.pause(); playback.removeAttribute('src'); playback.load() }
    setReviewPlaying(false)
  }, [cancelInspection])

  function restorePlayback() {
    const playback = reviewVideo.current
    if (playback && take) { playback.src = take.url; playback.load() }
    setReviewPlaying(false)
    if (take && !inspection) inspectTake(take)
  }

  const toggleReviewPlayback = useCallback(() => {
    const playback = reviewVideo.current
    if (!playback) return
    if (playback.paused || playback.ended) {
      void playback.play().catch(() => {})
    } else {
      playback.pause()
    }
  }, [])

  const cancelCountdown = useCallback(() => {
    if (countdownTimer.current !== null) clearInterval(countdownTimer.current)
    countdownTimer.current = null
    if (stageRef.current === 'countdown') transition('ready')
  }, [transition])
  const stop = useCallback((): Promise<void> => {
    if (stopTask.current) return stopTask.current
    if (!recorder.current || !['recording', 'starting'].includes(stageRef.current)) return Promise.resolve()
    transition('finalizing')
    stopTask.current = recorder.current.stop().catch((failure: unknown) => {
      setError(`The take could not be finalized. Its temporary data has been kept. ${message(failure)}`)
      transition('error')
    }).finally(() => { stopTask.current = null })
    return stopTask.current
  }, [transition])
  const onSelectedIds = useCallback((camera: string, mic: string) => { setCameraId(camera); setMicId(mic) }, [])
  const onDisconnect = useCallback((detail: string) => {
    setError(detail)
    if (stageRef.current === 'countdown') { cancelCountdown(); transition('idle') }
    else if (['recording', 'starting'].includes(stageRef.current)) return stop()
    else if (stageRef.current === 'ready') transition('idle')
  }, [cancelCountdown, stop, transition])
  const camera = useCamera({ inputVideo, canvas, cameraId, micId, quality, blur, blurStrength, mirrorVideo, imageAdjustments, onSelectedIds, onQualityChange: setQuality, onDisconnect })
  const hasMp4 = useMemo(() => chooseMp4Type(camera.activeQuality ?? DEFAULT_RECORDING_QUALITY) !== null, [camera.activeQuality])
  const locked = !loaded || camera.connecting || !['idle', 'ready'].includes(stage) || discarding

  useEffect(() => {
    setMicSilenceWarning(false)
    if (stage !== 'recording' || !camera.connected || !camera.silent) return
    // Give normal pauses extra time and never carry preparation silence into a take immediately.
    const timer = setTimeout(() => setMicSilenceWarning(true), 5000)
    return () => clearTimeout(timer)
  }, [stage, camera.connected, camera.silent])

  useEffect(() => {
    mounted.current = true
    void window.emcorder.getPreferences().then((preferences) => {
      if (!mounted.current) return
      setCameraId(preferences.cameraId)
      setMicId(preferences.micId)
      setQuality(preferences.quality)
      setBlur(preferences.blur)
      setBlurStrength(preferences.blurStrength)
      setImageAdjustments({ brightness: preferences.brightness, contrast: preferences.contrast, saturation: preferences.saturation })
      setOutputFolder(preferences.outputFolder)
      setCountdownSeconds(preferences.countdownSeconds)
      setMirrorVideo(preferences.mirrorVideo)
      setAutoStartPrompter(preferences.autoStartPrompter)
      setScript(preferences.script)
      setFontSize(preferences.fontSize)
      setScrollSpeed(preferences.scrollSpeed)
      setOverlayOpacity(preferences.overlayOpacity)
      setOverlayBounds(clampOverlayBounds(preferences.overlayBounds))
      setLoaded(true)
    }).catch((failure: unknown) => {
      if (!mounted.current) return
      setPreferenceError(`Preferences could not be loaded. ${message(failure)}`); setLoaded(true)
    })
    return () => { mounted.current = false; cancelCountdown(); cancelInspection() }
  }, [cancelCountdown, cancelInspection])
  useEffect(() => {
    if (!loaded) return
    let current = true
    void window.emcorder.updatePreferences({
      cameraId,
      micId,
      quality,
      blur,
      blurStrength,
      ...imageAdjustments,
      countdownSeconds,
      mirrorVideo,
      autoStartPrompter,
      script,
      fontSize,
      scrollSpeed,
      overlayOpacity,
      overlayBounds,
    }).then(() => {
      if (current) setPreferenceError('')
    }).catch((failure: unknown) => {
      if (current) setPreferenceError(`Preferences could not be saved. ${message(failure)}`)
    })
    return () => { current = false }
  }, [loaded, cameraId, micId, quality, blur, blurStrength, imageAdjustments, countdownSeconds, mirrorVideo, autoStartPrompter, script, fontSize, scrollSpeed, overlayOpacity, overlayBounds])
  useEffect(() => window.emcorder.onRequestStop(() => { void stop() }), [stop])
  useEffect(() => {
    if (stage !== 'recording') return
    const timer = setInterval(() => {
      const seconds = recorder.current?.elapsedSeconds || 0
      setElapsed(seconds)
      if (seconds >= 900) { setLimitReached(true); void stop() }
    }, 100)
    return () => clearInterval(timer)
  }, [stage, stop])

  const startRecording = useCallback(async () => {
    if (stageRef.current !== 'countdown' || !camera.stream.current || !canvas.current) return
    transition('starting'); setError(''); setElapsed(0); setLimitReached(false); setInspection(null); setSavePath(''); setFilename(newFilename())
    try {
      recorder.current = new Mp4Recorder(canvas.current, camera.stream.current, {
        onError: (detail) => {
          setError(detail)
          if (stageRef.current === 'recording') queueMicrotask(() => { void stop() })
        },
        onStopped: (result) => {
          setPrompterPlaying(false)
          // Keep review playback from opening the file while restart deletes it.
          if (restarting.current) { restartTake.current = result; return }
          reviewTake(result)
        }
      }, camera.activeQuality ?? DEFAULT_RECORDING_QUALITY)
      await recorder.current.start()
      if ((stageRef.current as Stage) === 'starting') {
        setScrollOffset(0)
        setPrompterPlaying(prompter.current.autoStartPrompter && prompter.current.showOverlay && Boolean(prompter.current.script.trim()))
        transition('recording')
      }
    } catch (failure) { setError(`Recording could not start. ${message(failure)}`); transition('error') }
  }, [camera.stream, camera.activeQuality, reviewTake, stop, transition])

  const startCountdown = useCallback(() => {
    if (stageRef.current !== 'ready' || !camera.connected || !hasMp4 || camera.connecting) return
    setError(''); setElapsed(0); setCountdown(countdownSeconds); setScrollOffset(0); setPrompterPlaying(false); transition('countdown')
    const deadline = performance.now() + countdownSeconds * 1000
    countdownTimer.current = setInterval(() => {
      const remaining = Math.ceil((deadline - performance.now()) / 1000)
      if (remaining > 0) { setCountdown(remaining); return }
      if (countdownTimer.current !== null) clearInterval(countdownTimer.current)
      countdownTimer.current = null
      void startRecording()
    }, 50)
  }, [camera.connected, camera.connecting, countdownSeconds, hasMp4, startRecording, transition])

  const restartRecording = useCallback(async () => {
    if (stageRef.current !== 'recording' || !recorder.current || restarting.current) return
    restarting.current = true
    transition('finalizing')
    setPrompterPlaying(false)
    try {
      await recorder.current.stop()
      try {
        await window.emcorder.discardRecording()
      } catch (failure) {
        if (restartTake.current) reviewTake(restartTake.current)
        setError(`The take could not be discarded. ${message(failure)}`)
        return
      }
      cancelInspection()
      recorder.current = null
      setTake(null); setInspection(null); setElapsed(0); setScrollOffset(0)
      if (!camera.stream.current?.getVideoTracks().some((track) => track.readyState === 'live')) {
        transition('idle')
        return
      }
      transition('ready')
      startCountdown()
    } catch (failure) {
      setError(`Recording could not restart. Its temporary data has been kept. ${message(failure)}`)
      transition('error')
    } finally {
      restarting.current = false
      restartTake.current = null
    }
  }, [camera.stream, cancelInspection, reviewTake, startCountdown, transition])

  const toggleOverlay = useCallback(() => {
    setShowOverlay((open) => {
      const next = !open
      if (!next) {
        setPrompterPlaying(false)
      }
      return next
    })
  }, [])

  const togglePrompterPlay = useCallback(() => {
    setPrompterPlaying((playing) => {
      const next = !playing
      if (next) setShowOverlay(true)
      return next
    })
  }, [])

  const restartPrompter = useCallback(() => {
    setScrollOffset(0)
  }, [])

  const clearScript = useCallback(() => {
    setScript('')
    setScrollOffset(0)
    setPrompterPlaying(false)
  }, [])

  const resetOverlayBounds = useCallback(() => {
    setOverlayBounds({ ...DEFAULT_OVERLAY_BOUNDS })
  }, [])

  const handleScrollOffsetChange = useCallback((offset: number, reachedEnd?: boolean) => {
    setScrollOffset(offset)
    if (reachedEnd) setPrompterPlaying(false)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const action = resolveStudioShortcut({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
        defaultPrevented: event.defaultPrevented,
        targetTagName: target?.tagName ?? null,
        targetRole: target?.getAttribute?.('role') ?? null,
        isContentEditable: Boolean(target?.isContentEditable),
        modalOpen: saveOpen || discardOpen || settingsOpen,
      })
      if (!action) return
      if (action === 'toggle-scroll') {
        if (take) {
          event.preventDefault()
          toggleReviewPlayback()
          return
        }
        event.preventDefault()
        togglePrompterPlay()
      } else if (action === 'restart-script') {
        if (take) return
        event.preventDefault()
        restartPrompter()
      } else if (action === 'toggle-recording') {
        event.preventDefault()
        if (stageRef.current === 'recording' || stageRef.current === 'starting') {
          void stop()
        } else if (stageRef.current === 'countdown') {
          cancelCountdown()
        } else if (stageRef.current === 'ready') {
          startCountdown()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cancelCountdown, discardOpen, restartPrompter, saveOpen, settingsOpen, startCountdown, stop, take, togglePrompterPlay, toggleReviewPlayback])

  async function connect(selection?: Partial<CameraSelection>) {
    if (locked || take) return
    setError('')
    if (await camera.connect(selection)) transition('ready')
    else transition('idle')
  }
  function changeDevices(selection: Partial<CameraSelection>) {
    if (locked || take) return
    if (selection.cameraId !== undefined) setCameraId(selection.cameraId)
    if (selection.micId !== undefined) setMicId(selection.micId)
    if (selection.quality !== undefined) setQuality(selection.quality)
    // Pass the new values directly because state updates take effect on the next render.
    if (camera.connected) void connect(selection)
  }
  async function retake() {
    if (discarding) return
    setDiscarding(true)
    releasePlayback()
    try {
      await window.emcorder.discardRecording()
      recorder.current = null; setTake(null); setInspection(null); setSavePath(''); setElapsed(0); setError(''); setLimitReached(false); setDiscardOpen(false)
      transition(camera.connected ? 'ready' : 'idle')
    } catch (failure) {
      restorePlayback()
      setError(message(failure)); throw failure
    } finally { setDiscarding(false) }
  }
  async function save(name: string, directory: string) {
    releasePlayback()
    try {
      const path = await window.emcorder.saveRecording({ filename: name, directory })
      setOutputFolder(directory); setFilename(name); setSavePath(path); setSaveOpen(false); transition('saved')
      if (take) {
        const savedTake = { ...take, url: `recording://take/current.mp4?t=${Date.now()}` }
        setTake(savedTake)
        inspectTake(savedTake)
      }
    } catch (failure) {
      restorePlayback()
      throw failure
    }
  }
  const status = camera.connecting ? 'Connecting devices…' : ({ idle: 'Connect your camera', ready: 'Ready to record', countdown: 'Get ready', starting: 'Starting recording…', recording: 'Recording', finalizing: 'Finishing your take…', review: 'Review your take', saved: 'Recording saved', error: 'Recording needs attention' } as const)[stage]
  const cameraOptions = camera.devices.filter((device) => device.kind === 'videoinput')
  const micOptions = camera.devices.filter((device) => device.kind === 'audioinput')
  const permissionDenied = /access was denied/i.test(camera.error)
  const deviceBusy = /busy/i.test(camera.error)
  const emptyTitle = permissionDenied
    ? 'Camera or microphone access is turned off.'
    : deviceBusy
      ? 'Your camera or microphone is in use.'
      : 'Your camera, ready when you are.'
  const emptyPrompt = permissionDenied
    ? 'Allow desktop apps to use your camera and microphone in Windows Privacy settings, then reconnect.'
    : deviceBusy
      ? 'Close any other video or calling app using your webcam, then connect again.'
      : 'Select your camera and microphone to begin.'

  return <main className="studio">
    <header className="topbar">
      <h1 className="studio-brand">
        <img src="./branding/logo-primary-mark.svg" alt="" width="32" height="32" />
        <span>EmCorder</span>
      </h1>
      <button type="button" className="settings-button" aria-label="Settings" title="Settings" aria-haspopup="dialog" disabled={!loaded || saveOpen || discardOpen || discarding} onClick={() => setSettingsOpen(true)}>
        <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9.5 3-.6 2.2-1.7 1L5 5.6 2.5 9.9l1.6 1.6v2L2.5 15 5 19.3l2.2-.6 1.7 1 .6 2.3h5l.6-2.3 1.7-1 2.2.6 2.5-4.3-1.6-1.5v-2L21.5 10 19 5.6l-2.2.6-1.7-1L14.5 3z" />
          <circle cx="12" cy="12.5" r="3" />
        </svg>
      </button>
    </header>
    <div className={`workspace ${take ? 'workspace--review' : ''}`}>
      <section className="camera-area" aria-label="Camera studio">
        <div className="preview-frame">
          <canvas ref={canvas} className={`camera-preview ${take ? 'concealed' : ''}`} aria-label={mirrorVideo ? 'Mirrored live camera preview' : 'Live camera preview'} />
          {take && (
            <video
              ref={reviewVideo}
              id="review-video"
              aria-label="Recorded take"
              aria-busy={!inspection}
              className="review-video"
              src={take.url}
              controls
              playsInline
              onPlay={() => setReviewPlaying(true)}
              onPause={() => setReviewPlaying(false)}
              onEnded={() => setReviewPlaying(false)}
            />
          )}
          {showOverlay && !take && (
            <TeleprompterOverlay
              script={script}
              playing={prompterPlaying}
              scrollOffset={scrollOffset}
              fontSize={fontSize}
              scrollSpeed={scrollSpeed}
              opacity={overlayOpacity}
              bounds={overlayBounds}
              onTogglePlay={togglePrompterPlay}
              onRestart={restartPrompter}
              onScrollOffsetChange={handleScrollOffsetChange}
              onFontSizeChange={setFontSize}
              onScrollSpeedChange={setScrollSpeed}
              onOpacityChange={setOverlayOpacity}
              onBoundsChange={setOverlayBounds}
            />
          )}
          {!camera.connected && !take && (
            <div className="empty-preview">
              {(permissionDenied || deviceBusy) && <span className="camera-symbol" aria-hidden="true">
                {permissionDenied ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <rect x="5" y="11" width="14" height="9" rx="2.5" />
                    <path d="M8 11V8a4 4 0 0 1 8 0v3" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v4.5M12 15.8h.01" strokeLinecap="round" />
                  </svg>
                )}
              </span>}
              <h2>{emptyTitle}</h2>
              {(permissionDenied || deviceBusy) && <p>{emptyPrompt}</p>}
              <button className="primary" disabled={locked} onClick={() => void connect()}>
                <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="2.5" y="6" width="13.5" height="12" rx="3" /><path d="M16 10.2L21.5 7v10L16 13.8v-3.6Z" strokeLinejoin="round" /></svg>
                {camera.connecting ? 'Connecting…' : 'Connect camera'}
              </button>
            </div>
          )}
          {stage === 'countdown' && <div className="countdown" role="status" aria-live="assertive"><strong>{countdown}</strong><span>Get ready</span><button onClick={cancelCountdown}>Cancel</button></div>}
          {['recording', 'finalizing', 'starting'].includes(stage) && <div className="recording-badge"><span className="record-dot" />{stage === 'recording' ? `Recording ${time(elapsed)}` : stage === 'starting' ? 'Starting…' : 'Finishing MP4…'}</div>}
        </div>
        <div className="transport-dock">
          <div className="transport">
            {!take && <span className="timer">{time(elapsed)}</span>}
            {stage === 'recording' ? (
              <>
                <button className="primary stop" onClick={() => void stop()}>
                  <svg className="btn-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
                  <span>Stop</span>
                </button>
                <button onClick={() => void restartRecording()} title="Discard this take and restart the countdown">
                  <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  <span>Retake</span>
                </button>
              </>
            ) : take ? (
              <>
                <button
                  type="button"
                  disabled={discarding}
                  onClick={toggleReviewPlayback}
                  title={reviewPlaying ? 'Pause video' : 'Play video'}
                  aria-label={reviewPlaying ? 'Pause' : 'Play'}
                >
                  {reviewPlaying ? (
                    <>
                      <svg className="btn-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="6" y="5" width="4" height="14" rx="1" />
                        <rect x="14" y="5" width="4" height="14" rx="1" />
                      </svg>
                      <span>Pause</span>
                    </>
                  ) : (
                    <>
                      <svg className="btn-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <polygon points="6 4 20 12 6 20 6 4" />
                      </svg>
                      <span>Play</span>
                    </>
                  )}
                </button>
                <button disabled={discarding} onClick={() => { if (savePath) void retake().catch(() => {}); else setDiscardOpen(true) }}>
                  <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  <span>Retake</span>
                </button>
                {!savePath && (
                  <button className="primary" disabled={discarding} onClick={() => setSaveOpen(true)}>
                    <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                      <polyline points="17 21 17 13 7 13 7 21" />
                      <polyline points="7 3 7 8 15 8" />
                    </svg>
                    <span>Save</span>
                  </button>
                )}
              </>
            ) : (
              <button className="primary" disabled={stage !== 'ready' || !hasMp4 || camera.connecting} onClick={startCountdown}>
                {stage === 'finalizing' ? 'Finishing…' : stage === 'starting' ? 'Starting…' : stage === 'countdown' ? 'Get ready…' : (
                  <>
                    <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
                      <path d="m15.5 10 5.5-3.5v11l-5.5-3.5v-4z" />
                    </svg>
                    <span>Record</span>
                  </>
                )}
              </button>
            )}
            {!take && (
              <button type="button" className={showOverlay ? 'pill-active' : ''} aria-label={showOverlay ? 'Hide prompter' : 'Show prompter'} title={showOverlay ? 'Hide prompter' : 'Show prompter'} aria-pressed={showOverlay} onClick={toggleOverlay}>
                <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {showOverlay ? (
                    <>
                      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                      <line x1="2" y1="2" x2="22" y2="22" />
                    </>
                  ) : (
                    <>
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  )}
                </svg>
                <span>Prompter</span>
              </button>
            )}
          </div>
          {stage === 'error' && <p className="studio-status" role="status">{status}</p>}
        </div>
        {stage === 'recording' && elapsed >= 840 && <div className="notice warning" role="alert">One minute remaining. Recording stops automatically at 15 minutes.</div>}
        {limitReached && take && <div className="notice" role="status">The 15-minute limit was reached. Your take has been finalized.</div>}
        {(error || camera.error) && <div role="alert" className="notice error"><p>{error || camera.error}</p>{stage === 'error' && <button onClick={() => setDiscardOpen(true)}>Discard take</button>}{!take && stage === 'idle' && <button disabled={camera.connecting} onClick={() => void connect()}>Reconnect</button>}</div>}
        {preferenceError && <p role="alert" className="quiet">{preferenceError}</p>}
        {!hasMp4 && <div role="alert" className="notice error">MP4 recording is unavailable in this runtime. Restart EmCorder with its bundled Electron runtime.</div>}
        {take && inspection && !inspection.seekable && <div className="notice warning" role="alert"><p>{inspection.message}</p><p>The recording is still available to save or retake.</p></div>}
        {take && savePath && <div className="review-saved" role="status"><p>Saved successfully.</p><p className="saved-path">{savePath}</p></div>}
      </section>
      <aside className="sidebar" hidden={!!take}>
        <section className="card">
          <div className="section-head">
            <h2>Devices</h2>
            <button
              type="button"
              className="restart-devices subtle-action"
              aria-label="Restart camera and microphone"
              title="Restart camera and microphone to refresh the preview"
              disabled={locked || !!take}
              onClick={() => void connect()}
            >
              <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          </div>
          <label>
            <span className="field-label">Camera</span>
            <select aria-label="Camera" value={cameraId} disabled={locked || !!take} onChange={(event) => changeDevices({ cameraId: event.target.value })}>
              <option value="">Default camera</option>
              {cameraId && !cameraOptions.some((device) => device.deviceId === cameraId) && <option value={cameraId}>Previous camera (connect to check)</option>}
              {cameraOptions.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
            </select>
          </label>
          <label>
            <span className="field-label">Quality</span>
            <select aria-label="Quality" value={quality} disabled={locked || !!take} onChange={(event) => changeDevices({ quality: event.target.value as RecordingQuality })}>
              <option value="720p">720p (1280 × 720, 30 FPS)</option>
              <option value="1080p" disabled={!camera.supports1080p || !has1080Mp4}>1080p (1920 × 1080, 30 FPS)</option>
            </select>
          </label>
          {camera.qualityNotice && <p className="quiet" role="status">{camera.qualityNotice}</p>}
          <label>
            <span className="field-label">Microphone</span>
            <select aria-label="Microphone" value={micId} disabled={locked || !!take} onChange={(event) => changeDevices({ micId: event.target.value })}>
              <option value="">Default microphone</option>
              {micId && !micOptions.some((device) => device.deviceId === micId) && <option value={micId}>Previous microphone (connect to check)</option>}
              {micOptions.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
            </select>
          </label>
          <div className="meter-block">
            <span className="field-label">Input level</span>
            <meter aria-label="Microphone input level" min="0" max="1" value={camera.level} />
          </div>
          {stage === 'recording' && camera.connected && camera.silent && micSilenceWarning && <p className="mic-warning" role="status">Microphone input is quiet. Check your microphone if you’re speaking.</p>}
        </section>
        <section className="card blur-card">
          <div className="card-heading">
            <h2>Background blur</h2>
            <input aria-label="Background blur" className="toggle" type="checkbox" checked={blur} disabled={locked || !!take} onChange={(event) => setBlur(event.target.checked)} />
          </div>
          {blur && <fieldset className="blur-strength" disabled={locked || !!take}>
            <legend className="sr-only">Blur strength</legend>
            {Object.entries(BLUR_STRENGTHS).map(([strength, { label }]) => (
              <label key={strength} className="blur-strength-option">
                <input className="sr-only" type="radio" name="blur-strength" value={strength} checked={blurStrength === strength} onChange={() => setBlurStrength(strength as BlurStrength)} />
                <span>
                  <BlurStrengthIcon strength={strength as BlurStrength} />
                  <span>{label}</span>
                </span>
              </label>
            ))}
          </fieldset>}
          <p className={`quiet ${!camera.connected || camera.blurStatus === 'Camera blur is ready.' || camera.blurStatus === 'Camera blur is off.' ? 'sr-only' : ''}`} role="status">{camera.blurStatus}</p>
        </section>
        <ImagePanel adjustments={imageAdjustments} disabled={locked || !!take} onChange={setImageAdjustments} />
        <TeleprompterPanel
          script={script}
          overlayVisible={showOverlay && !take}
          playing={prompterPlaying}
          fontSize={fontSize}
          scrollSpeed={scrollSpeed}
          opacity={overlayOpacity}
          canShowOverlay={!take}
          onScriptChange={setScript}
          onClearScript={clearScript}
          onToggleOverlay={toggleOverlay}
          onTogglePlay={togglePrompterPlay}
          onRestart={restartPrompter}
          onFontSizeChange={setFontSize}
          onScrollSpeedChange={setScrollSpeed}
          onOpacityChange={setOverlayOpacity}
          onResetBounds={resetOverlayBounds}
        />
      </aside>
    </div>
    <video ref={inputVideo} className="source-video" muted playsInline aria-hidden="true" />
    {settingsOpen && <SettingsDialog countdownSeconds={countdownSeconds} mirrorVideo={mirrorVideo} autoStartPrompter={autoStartPrompter} outputFolder={outputFolder} captureLocked={locked} folderLocked={!loaded || camera.connecting || ['countdown', 'starting', 'recording', 'finalizing'].includes(stage) || discarding} preferenceError={preferenceError} onCountdownChange={setCountdownSeconds} onMirrorChange={setMirrorVideo} onAutoStartPrompterChange={setAutoStartPrompter} onFolderChange={setOutputFolder} onClose={() => setSettingsOpen(false)} />}
    {saveOpen && <SaveDialog folder={outputFolder} initialFilename={filename} bytes={take?.bytes} elapsedSeconds={take?.elapsedSeconds} quality={take?.quality ?? DEFAULT_RECORDING_QUALITY} onFolderChange={setOutputFolder} onSave={save} onCancel={() => setSaveOpen(false)} />}
    {discardOpen && <DiscardDialog failed={stage === 'error'} onDiscard={retake} onCancel={() => setDiscardOpen(false)} />}
  </main>
}
