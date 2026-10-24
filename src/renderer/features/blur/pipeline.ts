import { DEFAULT_RECORDING_QUALITY, RECORDING_PROFILES, type RecordingQuality } from '../../../shared/recordingQuality'
import { BLUR_STRENGTHS, DEFAULT_BLUR_STRENGTH, type BlurStrength } from '../../../shared/blurStrength'
import type { WorkerRequest, WorkerResponse } from './segmentation.protocol'
import { createWebGLBlurCompositor, SEGMENTATION_MASK_SIZE } from './webglCompositor'

export interface BlurPipelineOptions {
  mirrorVideo?: boolean
  onStatus?: (message: string) => void
}

const SEGMENT_WIDTH = SEGMENTATION_MASK_SIZE
const SEGMENT_HEIGHT = SEGMENTATION_MASK_SIZE
const FRAME_INTERVAL_MS = 1000 / 30
const SEGMENT_INTERVAL_MS = 40
const SLOW_SEGMENT_THRESHOLD_MS = 100
const INIT_TIMEOUT_MS = 20_000
const SEGMENT_TIMEOUT_MS = 1_500
const MASK_STALE_MS = 800

function coverDraw(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  aspectWidth = width,
  aspectHeight = height,
): void {
  if (!sourceWidth || !sourceHeight) return
  const scale = Math.max(aspectWidth / sourceWidth, aspectHeight / sourceHeight)
  const cropWidth = aspectWidth / scale
  const cropHeight = aspectHeight / scale
  const sx = (sourceWidth - cropWidth) / 2
  const sy = (sourceHeight - cropHeight) / 2
  context.drawImage(source, sx, sy, cropWidth, cropHeight, 0, 0, width, height)
}

/** Creates a quality-sized 30 FPS camera output with a segmented blur. */
export async function createPipeline(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  options: BlurPipelineOptions = {},
  quality: RecordingQuality = DEFAULT_RECORDING_QUALITY,
): Promise<{ setBlur(enabled: boolean): void; setBlurStrength(strength: BlurStrength): void; setMirrorVideo(enabled: boolean): void; dispose(): void }> {
  const { width: outputWidth, height: outputHeight } = RECORDING_PROFILES[quality]
  const effectScale = outputHeight / 720
  const output = canvas.getContext('2d', { alpha: false })
  if (!output) throw new Error('Camera output canvas is unavailable.')

  canvas.width = outputWidth
  canvas.height = outputHeight
  // Orient the final composite so preview and recorded pixels share one orientation.
  // Source frames and segmentation masks stay in their original coordinate space.
  const applyMirrorVideo = (enabled: boolean) => output.setTransform(enabled ? -1 : 1, 0, 0, 1, enabled ? outputWidth : 0, 0)
  applyMirrorVideo(options.mirrorVideo ?? true)

  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = outputWidth
  sourceCanvas.height = outputHeight
  const sourceContext = sourceCanvas.getContext('2d', { alpha: false })
  const foregroundCanvas = document.createElement('canvas')
  foregroundCanvas.width = outputWidth
  foregroundCanvas.height = outputHeight
  const foregroundContext = foregroundCanvas.getContext('2d')
  const segmentationCanvas = document.createElement('canvas')
  segmentationCanvas.width = SEGMENT_WIDTH
  segmentationCanvas.height = SEGMENT_HEIGHT
  const segmentationContext = segmentationCanvas.getContext('2d', { alpha: false })
  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = SEGMENT_WIDTH
  maskCanvas.height = SEGMENT_HEIGHT
  const maskContext = maskCanvas.getContext('2d')
  if (!sourceContext || !foregroundContext || !segmentationContext || !maskContext) {
    throw new Error('Camera processing canvas is unavailable.')
  }
  const segmentationCtx = segmentationContext
  const webglCompositor = createWebGLBlurCompositor(outputWidth, outputHeight)

  let worker: Worker | null = null
  let disposed = false
  let blurEnabled = true
  let blurStrength = DEFAULT_BLUR_STRENGTH
  let segmentationPending = false
  let workerReady = false
  let maskReady = false
  let segmentationFailed = false
  let lastMaskAt = 0
  let maskRevision = 0
  let nextFrameId = 0
  let invalidBeforeFrameId = 0
  let activeFrame: { frameId: number; timestampMs: number } | null = null
  let resetHistory = true
  let smoothedRoundtripMs = 0
  let hasCompletedSegmentation = false
  let lastVideoTime = Number.NaN
  let lastSampleAt = Number.NEGATIVE_INFINITY
  let segmentIntervalMs = SEGMENT_INTERVAL_MS
  let segmentTimer = 0
  let inflightTimeout = 0
  let initTimeout = 0
  let statusMessage = ''
  let segmentationStatus = 'Loading camera blur…'

  const publishStatus = () => {
    const message = blurEnabled ? segmentationStatus : 'Camera blur is off.'
    if (message === statusMessage) return
    statusMessage = message
    options.onStatus?.(message)
  }

  const reportStatus = (message: string) => {
    segmentationStatus = message
    publishStatus()
  }

  const close = (bitmap?: ImageBitmap) => bitmap?.close()

  const failSegmentation = (message: string) => {
    if (disposed || segmentationFailed) return
    segmentationFailed = true
    workerReady = false
    segmentationPending = false
    maskReady = false
    window.clearTimeout(inflightTimeout)
    window.clearTimeout(initTimeout)
    window.clearTimeout(segmentTimer)
    worker?.terminate()
    reportStatus(`Camera blur unavailable: ${message} Showing the camera without blur.`)
  }

  const handleWorkerMessage = (event: MessageEvent<WorkerResponse>) => {
    const data = event.data
    if (segmentationFailed || disposed) {
      if (data.type === 'mask') close(data.bitmap)
      return
    }
    if (data.type === 'ready') {
      workerReady = true
      window.clearTimeout(initTimeout)
      reportStatus(maskReady ? 'Camera blur is ready.' : 'Camera blur is preparing…')
      scheduleSegment(0)
    } else if (data.type === 'mask') {
      if (!activeFrame || data.frameId !== activeFrame.frameId) {
        close(data.bitmap)
        return
      }
      const sampledAt = activeFrame.timestampMs
      hasCompletedSegmentation = true
      activeFrame = null
      segmentationPending = false
      window.clearTimeout(inflightTimeout)
      const validEpoch = blurEnabled && data.frameId >= invalidBeforeFrameId
      const fresh = performance.now() - sampledAt <= MASK_STALE_MS
      try {
        if (validEpoch && fresh) {
          maskContext.clearRect(0, 0, SEGMENT_WIDTH, SEGMENT_HEIGHT)
          maskContext.drawImage(data.bitmap, 0, 0, SEGMENT_WIDTH, SEGMENT_HEIGHT)
          maskRevision = data.frameId
          maskReady = true
          lastMaskAt = sampledAt
        } else if (validEpoch) {
          maskReady = false
          reportStatus('Camera blur is delayed. Showing the camera without blur until a fresh mask arrives.')
        }
      } catch (error) {
        failSegmentation(error instanceof Error ? error.message : 'could not draw the person mask.')
      } finally {
        close(data.bitmap)
      }
      const roundtripMs = Math.max(0, performance.now() - sampledAt)
      smoothedRoundtripMs = smoothedRoundtripMs === 0 ? roundtripMs : smoothedRoundtripMs * 0.75 + roundtripMs * 0.25
      const targetIntervalMs = Math.min(500, Math.max(SEGMENT_INTERVAL_MS, smoothedRoundtripMs * 1.1))
      // Ignore small timing noise instead of changing cadence on every result.
      if (Math.abs(targetIntervalMs - segmentIntervalMs) >= Math.max(8, segmentIntervalMs * 0.15)) {
        segmentIntervalMs = targetIntervalMs
      }
      if (validEpoch && maskReady) {
        reportStatus(roundtripMs > SLOW_SEGMENT_THRESHOLD_MS
          ? 'Camera blur is running slowly; reduce other camera effects for smoother video.'
          : 'Camera blur is ready.')
      }
      scheduleSegment(Math.max(0, segmentIntervalMs - roundtripMs))
    } else if (data.type === 'error') {
      failSegmentation(data.message)
    }
  }

  const handleWorkerError = (event: ErrorEvent) => {
    if (disposed) return
    failSegmentation(event.message || 'the segmentation worker stopped.')
  }
  const handleWorkerMessageError = () => failSegmentation('the segmentation worker returned an unreadable message.')

  const wasmBaseUrl = new URL('mediapipe/', document.baseURI).href
  const modelUrl = new URL('models/selfie_multiclass_256x256.tflite', document.baseURI).href
  const fallbackModelUrl = new URL('models/selfie_segmenter.tflite', document.baseURI).href
  const initialize: WorkerRequest = { type: 'init', wasmBaseUrl, modelUrl, fallbackModelUrl }
  reportStatus('Loading camera blur…')
  try {
    worker = new Worker(new URL('./segmentation.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', handleWorkerMessage)
    worker.addEventListener('error', handleWorkerError)
    worker.addEventListener('messageerror', handleWorkerMessageError)
    worker.postMessage(initialize)
    initTimeout = window.setTimeout(() => failSegmentation('the local model took too long to load.'), INIT_TIMEOUT_MS)
  } catch (error) {
    failSegmentation(error instanceof Error ? error.message : 'could not start the segmentation worker.')
  }

  const frameTimer = window.setInterval(() => {
    if (disposed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return
    coverDraw(sourceContext, video, video.videoWidth, video.videoHeight, outputWidth, outputHeight)
    const maskFresh = maskReady && performance.now() - lastMaskAt <= MASK_STALE_MS
    if (blurEnabled && maskReady && !maskFresh) {
      maskReady = false
      reportStatus('Camera blur is delayed. Showing the camera without blur until a fresh mask arrives.')
    }
    if (blurEnabled && maskFresh && webglCompositor?.render(sourceCanvas, maskCanvas, blurStrength, maskRevision)) {
      output.filter = 'none'
      output.drawImage(webglCompositor.canvas, 0, 0)
    } else {
      output.filter = blurEnabled && maskFresh ? `blur(${18 * effectScale * BLUR_STRENGTHS[blurStrength].scale}px)` : 'none'
      output.drawImage(sourceCanvas, 0, 0)

      if (blurEnabled && maskFresh) {
        foregroundContext.clearRect(0, 0, outputWidth, outputHeight)
        coverDraw(foregroundContext, video, video.videoWidth, video.videoHeight, outputWidth, outputHeight)
        foregroundContext.globalCompositeOperation = 'destination-in'
        foregroundContext.filter = `blur(${1.5 * effectScale}px)`
        foregroundContext.drawImage(maskCanvas, 0, 0, SEGMENT_WIDTH, SEGMENT_HEIGHT, 0, 0, outputWidth, outputHeight)
        foregroundContext.filter = 'none'
        foregroundContext.globalCompositeOperation = 'source-over'
        output.filter = 'none'
        output.drawImage(foregroundCanvas, 0, 0)
      }
    }
  }, FRAME_INTERVAL_MS)

  function scheduleSegment(delay: number) {
    window.clearTimeout(segmentTimer)
    if (disposed || segmentationFailed || !blurEnabled || !workerReady || segmentationPending) return
    segmentTimer = window.setTimeout(segmentFrame, delay)
  }

  function segmentFrame() {
    if (disposed || segmentationFailed || !blurEnabled || !workerReady || segmentationPending) return
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) {
      scheduleSegment(SEGMENT_INTERVAL_MS)
      return
    }
    // Avoid resampling the same decoded frame, but retry within 200 ms if a
    // device/browser stops updating currentTime while frames remain available.
    const now = performance.now()
    if (Number.isFinite(video.currentTime) && video.currentTime === lastVideoTime && now - lastSampleAt < 200) {
      scheduleSegment(SEGMENT_INTERVAL_MS)
      return
    }
    lastVideoTime = video.currentTime
    lastSampleAt = now
    // Capture the sampling time before drawing and asynchronous bitmap preparation.
    const frame = { frameId: ++nextFrameId, timestampMs: performance.now() }
    activeFrame = frame
    segmentationPending = true
    window.clearTimeout(inflightTimeout)
    // A cold GPU may compile the model on its first inference. Subsequent
    // requests retain the shorter watchdog once the worker has completed one.
    inflightTimeout = window.setTimeout(
      () => failSegmentation('segmentation stopped responding.'),
      hasCompletedSegmentation ? SEGMENT_TIMEOUT_MS : INIT_TIMEOUT_MS,
    )
    try {
      coverDraw(segmentationCtx, video, video.videoWidth, video.videoHeight, SEGMENT_WIDTH, SEGMENT_HEIGHT, outputWidth, outputHeight)
      createImageBitmap(segmentationCanvas).then((bitmap) => {
        if (disposed || segmentationFailed || !worker) {
          bitmap.close()
          segmentationPending = false
          window.clearTimeout(inflightTimeout)
          return
        }
        if (!blurEnabled || frame.frameId < invalidBeforeFrameId) {
          bitmap.close()
          activeFrame = null
          segmentationPending = false
          window.clearTimeout(inflightTimeout)
          scheduleSegment(0)
          return
        }
        const request: WorkerRequest = { type: 'segment', bitmap, ...frame, resetHistory }
        try {
          worker.postMessage(request, [bitmap])
          resetHistory = false
        } catch (error) {
          // A failed transfer still belongs to this thread.
          bitmap.close()
          throw error
        }
      }).catch((error: unknown) => {
        failSegmentation(error instanceof Error ? error.message : 'could not prepare a camera frame.')
      })
    } catch (error) {
      failSegmentation(error instanceof Error ? error.message : 'could not prepare a camera frame.')
    }
  }

  return {
    setMirrorVideo(enabled) {
      if (!disposed) applyMirrorVideo(enabled)
    },
    setBlurStrength(strength) {
      if (!disposed) blurStrength = strength
    },
    setBlur(enabled) {
      if (disposed || blurEnabled === enabled) return
      blurEnabled = enabled
      maskReady = false
      invalidBeforeFrameId = nextFrameId + 1
      resetHistory = true
      window.clearTimeout(segmentTimer)
      if (enabled && !segmentationFailed) {
        reportStatus(workerReady ? 'Camera blur is preparing…' : 'Loading camera blur…')
        scheduleSegment(0)
      } else {
        publishStatus()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      window.clearInterval(frameTimer)
      window.clearTimeout(segmentTimer)
      window.clearTimeout(inflightTimeout)
      window.clearTimeout(initTimeout)
      worker?.removeEventListener('message', handleWorkerMessage)
      worker?.removeEventListener('error', handleWorkerError)
      worker?.removeEventListener('messageerror', handleWorkerMessageError)
      worker?.terminate()
      webglCompositor?.dispose()
      output.filter = 'none'
      output.globalCompositeOperation = 'source-over'
      sourceCanvas.width = sourceCanvas.height = 1
      foregroundCanvas.width = foregroundCanvas.height = 1
      segmentationCanvas.width = segmentationCanvas.height = 1
      maskCanvas.width = maskCanvas.height = 1
    },
  }
}
