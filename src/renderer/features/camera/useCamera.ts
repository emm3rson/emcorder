import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import { RECORDING_PROFILES, type RecordingQuality } from '../../../shared/recordingQuality'
import type { BlurStrength } from '../../../shared/blurStrength'
import { createPipeline } from '../blur/pipeline'

export type UseCameraOptions = {
  inputVideo: RefObject<HTMLVideoElement | null>
  canvas: RefObject<HTMLCanvasElement | null>
  cameraId: string
  micId: string
  blur: boolean
  mirrorVideo?: boolean
  blurStrength: BlurStrength
  quality: RecordingQuality
  onQualityChange: (quality: RecordingQuality) => void
  onSelectedIds: (cameraId: string, micId: string) => void
  onDisconnect: (message: string) => void | Promise<void>
}

export type CameraSelection = Pick<UseCameraOptions, 'cameraId' | 'micId' | 'quality'>

export type CameraHook = {
  activeQuality: RecordingQuality | null
  supports1080p: boolean
  qualityNotice: string
  devices: MediaDeviceInfo[]
  connected: boolean
  connecting: boolean
  connect: (selection?: Partial<CameraSelection>) => Promise<boolean>
  disconnect: () => void
  stream: MutableRefObject<MediaStream | null>
  level: number
  silent: boolean
  blurStatus: string
  error: string
}

const DISCONNECTED_MESSAGE = 'A camera or microphone disconnected. Reconnect it before the next take.'
const TRACK_MUTE_WARNING_MS = 1800
const SILENCE_GRACE_MS = 3500
const SILENCE_THRESHOLD = 0.015

function captureError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') return 'Camera or microphone access was denied. Enable desktop app access in Windows Settings → Privacy & security → Camera and Microphone, then connect again.'
    if (error.name === 'NotReadableError') return 'The camera or microphone is busy. Close other camera apps, then connect again.'
    if (error.name === 'NotFoundError') return 'Connect a camera and microphone, then try again.'
    if (error.name === 'OverconstrainedError') return 'This camera cannot provide 1280 × 720 at 30 FPS. Select a camera that supports this format.'
  }
  return error instanceof Error ? error.message : String(error)
}

export function useCamera({ inputVideo, canvas, cameraId, micId, blur, blurStrength, mirrorVideo = true, quality, onQualityChange, onSelectedIds, onDisconnect }: UseCameraOptions): CameraHook {
  const currentMirrorVideo = useRef(mirrorVideo)
  currentMirrorVideo.current = mirrorVideo
  const previousCapture = useRef<{ cameraId: string; quality: RecordingQuality } | null>(null)
  const rejected1080 = useRef(new Set<string>())
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({})
  const [activeQuality, setActiveQuality] = useState<RecordingQuality | null>(null)
  const [qualityNotice, setQualityNotice] = useState('')
  const supports1080p = capabilities[cameraId] === true
  const stream = useRef<MediaStream | null>(null)
  const pipeline = useRef<Awaited<ReturnType<typeof createPipeline>> | null>(null)
  const audio = useRef<AudioContext | null>(null)
  const meterTimer = useRef<number | null>(null)
  const trackTimers = useRef(new Map<MediaStreamTrack, number>())
  const disconnectingStream = useRef<MediaStream | null>(null)
  const generation = useRef(0)
  const mounted = useRef(true)
  const permissionGranted = useRef(false)
  const pendingFallbackNotice = useRef(false)
  const selectedIds = useRef({ cameraId, micId })
  selectedIds.current = { cameraId, micId }
  const callbacks = useRef({ onSelectedIds, onDisconnect, onQualityChange })
  callbacks.current = { onSelectedIds, onDisconnect, onQualityChange }

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [level, setLevel] = useState(0)
  const [silent, setSilent] = useState(false)
  const [blurStatus, setBlurStatus] = useState('Connect your camera to begin.')
  const [error, setError] = useState('')

  const clearMeter = useCallback(() => {
    if (meterTimer.current !== null) window.clearInterval(meterTimer.current)
    meterTimer.current = null
    trackTimers.current.forEach((timer) => window.clearTimeout(timer))
    trackTimers.current.clear()
    void audio.current?.close().catch(() => {})
    audio.current = null
    setLevel(0)
    setSilent(false)
  }, [])

  const teardown = useCallback((stopTracks: boolean) => {
    pipeline.current?.dispose()
    pipeline.current = null
    const active = stream.current
    stream.current = null
    if (active) {
      active.getTracks().forEach((track) => {
        track.onended = null
        track.onmute = null
        track.onunmute = null
        if (stopTracks) track.stop()
      })
    }
    const video = inputVideo.current
    if (video) {
      video.pause()
      video.srcObject = null
    }
    clearMeter()
    if (mounted.current) { setConnected(false); setActiveQuality(null) }
  }, [clearMeter, inputVideo])

  const disconnect = useCallback(() => {
    if (disconnectingStream.current && disconnectingStream.current === stream.current) return
    generation.current++
    teardown(true)
    if (mounted.current) {
      setConnecting(false)
      setBlurStatus('Connect your camera to begin.')
    }
  }, [teardown])

  const handleDeviceLoss = useCallback((message: string, affectedStream: MediaStream, expectedGeneration?: number) => {
    if (!mounted.current || stream.current !== affectedStream || disconnectingStream.current === affectedStream) return
    if (expectedGeneration !== undefined && generation.current !== expectedGeneration) return
    generation.current++
    const cleanupGeneration = generation.current
    disconnectingStream.current = affectedStream
    setConnected(false)
    setConnecting(false)
    setError(message)

    void (async () => {
      try {
        await callbacks.current.onDisconnect(message)
      } catch {
        // Device cleanup must still run if the parent stop/finalization callback fails.
      } finally {
        if (mounted.current && generation.current === cleanupGeneration && stream.current === affectedStream) {
          teardown(true)
          setConnecting(false)
          setError(message)
        }
        if (disconnectingStream.current === affectedStream) disconnectingStream.current = null
      }
    })().catch(() => {
      // Keep asynchronous event handlers from producing unhandled rejections.
    })
  }, [teardown])

  useEffect(() => {
    mounted.current = true
    const enumerate = () => {
      void navigator.mediaDevices.enumerateDevices().then((found) => {
        if (!mounted.current) return
        setDevices(found)
        if (permissionGranted.current && found.some((device) => device.label.trim())) {
          const current = selectedIds.current
          const cameras = new Set(found.filter((device) => device.kind === 'videoinput').map((device) => device.deviceId))
          const microphones = new Set(found.filter((device) => device.kind === 'audioinput').map((device) => device.deviceId))
          const nextCamera = current.cameraId && !cameras.has(current.cameraId) ? '' : current.cameraId
          const nextMic = current.micId && !microphones.has(current.micId) ? '' : current.micId
          if (nextCamera !== current.cameraId || nextMic !== current.micId) {
            selectedIds.current = { cameraId: nextCamera, micId: nextMic }
            pendingFallbackNotice.current = true
            callbacks.current.onSelectedIds(nextCamera, nextMic)
          }
        }
        const active = stream.current
        if (!active) return
        const activeIds = active.getTracks().map((track) => track.getSettings().deviceId).filter((id): id is string => typeof id === 'string' && id.length > 0)
        const available = new Set(found.map((device) => device.deviceId))
        if (activeIds.some((id) => !available.has(id))) handleDeviceLoss(DISCONNECTED_MESSAGE, active)
      }).catch(() => {})
    }
    enumerate()
    navigator.mediaDevices.addEventListener('devicechange', enumerate)
    return () => {
      mounted.current = false
      generation.current++
      navigator.mediaDevices.removeEventListener('devicechange', enumerate)
      teardown(true)
    }
  }, [handleDeviceLoss])

  useEffect(() => { pipeline.current?.setBlur(blur) }, [blur])
  useEffect(() => { pipeline.current?.setBlurStrength(blurStrength) }, [blurStrength])
  useEffect(() => { pipeline.current?.setMirrorVideo(mirrorVideo) }, [mirrorVideo])

  const connect = useCallback(async (selection: Partial<CameraSelection> = {}): Promise<boolean> => {
    const requested = { cameraId, micId, quality, ...selection }
    const request = ++generation.current
    teardown(true)
    setConnecting(true)
    setError('')
    setQualityNotice('')
    setBlurStatus('Loading camera blur…')
    let captured: MediaStream | null = null
    let ownedPipeline: Awaited<ReturnType<typeof createPipeline>> | null = null
    let context: AudioContext | null = null
    try {
      const knownDevices = await navigator.mediaDevices.enumerateDevices()
      if (!mounted.current || generation.current !== request) return false
      const permissionLabelsAvailable = permissionGranted.current || knownDevices.some((device) => device.label.trim())
      const cameras = new Set(knownDevices.filter((device) => device.kind === 'videoinput').map((device) => device.deviceId))
      const microphones = new Set(knownDevices.filter((device) => device.kind === 'audioinput').map((device) => device.deviceId))
      let requestedCameraId = requested.cameraId
      let requestedMicId = requested.micId
      let fellBackToDefault = pendingFallbackNotice.current
      if (permissionLabelsAvailable) {
        if (requestedCameraId && !cameras.has(requestedCameraId)) { requestedCameraId = ''; fellBackToDefault = true }
        if (requestedMicId && !microphones.has(requestedMicId)) { requestedMicId = ''; fellBackToDefault = true }
        if (fellBackToDefault) {
          selectedIds.current = { cameraId: requestedCameraId, micId: requestedMicId }
          callbacks.current.onSelectedIds(requestedCameraId, requestedMicId)
        }
      }
      let captureQuality = requested.quality
      let fallbackNotice = ''
      let rejectedRequested1080 = false
      const capture = async (selectedCameraId: string, selectedMicId: string): Promise<MediaStream> => {
        const attempt = async (requestedQuality: RecordingQuality): Promise<MediaStream> => {
          const profile = RECORDING_PROFILES[requestedQuality]
          const result = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: selectedCameraId ? { exact: selectedCameraId } : undefined, width: { exact: profile.width }, height: { exact: profile.height }, frameRate: { min: profile.frameRate, ideal: profile.frameRate, max: profile.frameRate } },
            audio: { deviceId: selectedMicId ? { exact: selectedMicId } : undefined, noiseSuppression: true, autoGainControl: true, echoCancellation: false },
          })
          if (!mounted.current || generation.current !== request) {
            result.getTracks().forEach((track) => track.stop())
            throw new Error('Connection cancelled.')
          }
          const settings = result.getVideoTracks()[0]?.getSettings()
          if (!settings || settings.width !== profile.width || settings.height !== profile.height || (settings.frameRate || 0) < 29.9) {
            result.getTracks().forEach((track) => track.stop())
            throw new DOMException(`The camera did not supply ${profile.width} × ${profile.height} at 30 FPS.`, 'OverconstrainedError')
          }
          return result
        }
        try {
          return await attempt(captureQuality)
        } catch (failure) {
          if (!mounted.current || generation.current !== request) throw failure
          const constraintFailure = failure instanceof DOMException && failure.name === 'OverconstrainedError'
          const resolutionFailure = constraintFailure && (!('constraint' in failure) || failure.constraint !== 'deviceId')
          const transientCaptureFailure = failure instanceof DOMException && (failure.name === 'NotReadableError' || failure.name === 'AbortError')
          const previous = previousCapture.current
          const previousQuality = previous?.cameraId === selectedCameraId && previous.quality !== captureQuality ? previous.quality : null
          // Chromium can report deviceId when this camera exists but cannot supply 1080p.
          // Try 720p on the same devices before treating the selection as unavailable.
          const unsupported1080 = captureQuality === '1080p' && constraintFailure
          if (!unsupported1080 && !(previousQuality && (resolutionFailure || transientCaptureFailure))) throw failure
          const restoredQuality = previousQuality ?? '720p'
          const restored = await attempt(restoredQuality)
          if (unsupported1080) {
            rejectedRequested1080 = true
            if (selectedCameraId) rejected1080.current.add(selectedCameraId)
          }
          const failedQuality = captureQuality
          captureQuality = restoredQuality
          fallbackNotice = unsupported1080
            ? ''
            : `Could not switch to ${failedQuality}. Restored ${captureQuality} at 30 FPS.`
          return restored
        }
      }
      try {
        captured = await capture(requestedCameraId, requestedMicId)
      } catch (failure) {
        if (!mounted.current || generation.current !== request) return false
        const isMissingDeviceError = failure instanceof DOMException && (
          failure.name === 'NotFoundError' ||
          (failure.name === 'OverconstrainedError' && 'constraint' in failure && failure.constraint === 'deviceId')
        )
        const selectedDevicesAvailable = permissionLabelsAvailable &&
          (!requestedCameraId || cameras.has(requestedCameraId)) &&
          (!requestedMicId || microphones.has(requestedMicId))
        if (fellBackToDefault || selectedDevicesAvailable || (!requestedCameraId && !requestedMicId) || !isMissingDeviceError) throw failure
        // The saved id may be stale before Chromium exposes device labels. Retry with defaults after a missing-device result.
        captured = await capture('', '')
        if (!mounted.current || generation.current !== request) {
          captured.getTracks().forEach((track) => track.stop())
          return false
        }
        requestedCameraId = ''
        requestedMicId = ''
        selectedIds.current = { cameraId: '', micId: '' }
        callbacks.current.onSelectedIds('', '')
      }
      if (!mounted.current || generation.current !== request) {
        captured.getTracks().forEach((track) => track.stop())
        return false
      }
      stream.current = captured
      permissionGranted.current = true
      const videoTrack = captured.getVideoTracks()[0]
      const audioTrack = captured.getAudioTracks()[0]
      if (!videoTrack || !audioTrack) throw new Error('Both a camera and microphone are required. Check the selected devices and try again.')
      const settings = videoTrack.getSettings()
      const actualCameraId = settings.deviceId || requestedCameraId
      let capability: MediaTrackCapabilities | undefined
      try { capability = videoTrack.getCapabilities?.() } catch { /* Capability reporting is optional; successful capture still works. */ }
      const can1080 = captureQuality === '1080p' || ((capability?.width?.max ?? 0) >= 1920 && (capability?.height?.max ?? 0) >= 1080 && (capability?.frameRate?.max ?? 0) >= 30)
      const supported = can1080 && !rejectedRequested1080 && !rejected1080.current.has(actualCameraId)
      if (rejectedRequested1080) rejected1080.current.add(actualCameraId)
      setCapabilities((current) => ({ ...current, [actualCameraId]: supported, [requestedCameraId]: supported }))
      const actualMicId = audioTrack.getSettings().deviceId || requestedMicId
      selectedIds.current = { cameraId: actualCameraId, micId: actualMicId }
      callbacks.current.onSelectedIds(actualCameraId, actualMicId)
      const video = inputVideo.current
      const outputCanvas = canvas.current
      if (!video || !outputCanvas) throw new Error('The camera preview is unavailable. Close and reopen the studio, then try again.')
      video.srcObject = captured
      await video.play()
      if (!mounted.current || generation.current !== request) return false

      ownedPipeline = await createPipeline(video, outputCanvas, {
        mirrorVideo: currentMirrorVideo.current,
        onStatus: (message) => { if (generation.current === request && mounted.current) setBlurStatus(message) },
      }, captureQuality)
      if (!mounted.current || generation.current !== request) {
        ownedPipeline.dispose()
        captured.getTracks().forEach((track) => track.stop())
        return false
      }
      pipeline.current = ownedPipeline
      ownedPipeline.setBlur(blur)
      ownedPipeline.setBlurStrength(blurStrength)
      ownedPipeline.setMirrorVideo(currentMirrorVideo.current)

      context = new AudioContext()
      audio.current = context
      await context.resume()
      if (!mounted.current || generation.current !== request) return false
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      context.createMediaStreamSource(new MediaStream([audioTrack])).connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      let quietSince = performance.now()
      meterTimer.current = window.setInterval(() => {
        if (generation.current !== request) return
        analyser.getByteTimeDomainData(data)
        const rms = Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length)
        const now = performance.now()
        setLevel(Math.min(1, rms * 5))
        if (rms < SILENCE_THRESHOLD) {
          if (!quietSince) quietSince = now
          setSilent(now - quietSince >= SILENCE_GRACE_MS)
        } else {
          quietSince = 0
          setSilent(false)
        }
      }, 100)

      captured.getTracks().forEach((track) => {
        track.onended = () => handleDeviceLoss(DISCONNECTED_MESSAGE, captured!, request)
        track.onmute = () => {
          const oldTimer = trackTimers.current.get(track)
          if (oldTimer !== undefined) window.clearTimeout(oldTimer)
          const timer = window.setTimeout(() => handleDeviceLoss('The camera or microphone stopped responding. Check the connection, then reconnect.', captured!, request), TRACK_MUTE_WARNING_MS)
          trackTimers.current.set(track, timer)
        }
        track.onunmute = () => {
          const timer = trackTimers.current.get(track)
          if (timer !== undefined) window.clearTimeout(timer)
          trackTimers.current.delete(track)
        }
      })
      const currentDevices = await navigator.mediaDevices.enumerateDevices()
      if (!mounted.current || generation.current !== request) return false
      setDevices(currentDevices)
      if (captured.getTracks().some((track) => track.readyState !== 'live')) throw new Error(DISCONNECTED_MESSAGE)
      previousCapture.current = { cameraId: actualCameraId, quality: captureQuality }
      setActiveQuality(captureQuality)
      setQualityNotice(fallbackNotice)
      if (captureQuality !== requested.quality) callbacks.current.onQualityChange(captureQuality)
      setConnected(true)
      setConnecting(false)
      pendingFallbackNotice.current = false
      return true
    } catch (failure) {
      if (generation.current !== request) {
        captured?.getTracks().forEach((track) => track.stop())
        ownedPipeline?.dispose()
        return false
      }
      captured?.getTracks().forEach((track) => track.stop())
      if (ownedPipeline && pipeline.current !== ownedPipeline) ownedPipeline.dispose()
      teardown(true)
      const message = captureError(failure)
      if (mounted.current) {
        setConnecting(false)
        setError(message)
      }
      return false
    } finally {
      if (context && audio.current !== context) void context.close().catch(() => {})
    }
  }, [cameraId, micId, blur, blurStrength, quality, inputVideo, canvas, teardown, handleDeviceLoss])

  return { devices, activeQuality, supports1080p, qualityNotice, connected, connecting, connect, disconnect, stream, level, silent, blurStatus, error }
}
