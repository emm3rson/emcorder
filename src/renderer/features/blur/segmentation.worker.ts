import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'
import type { WorkerRequest, WorkerResponse } from './segmentation.protocol'

let segmenter: ImageSegmenter | undefined
let initializing: Promise<void> | undefined
let stopped = false
let consoleFilterInstalled = false
let lastTimestampMs = 0
let lastSampleTimestampMs: number | undefined

let maskCanvas: OffscreenCanvas | null = null
let maskContext: OffscreenCanvasRenderingContext2D | null = null
let maskImageData: ImageData | null = null
let rawConfidences: Float32Array | null = null
let previousConfidences: Float32Array | null = null
let scratchConfidences: Float32Array | null = null

export function computePersonConfidence(masks: Float32Array[], index: number): number {
  if (masks.length >= 6) {
    const bg = masks[0][index] ?? 0
    const hair = masks[1][index] ?? 0
    const body = masks[2][index] ?? 0
    const face = masks[3][index] ?? 0
    const clothes = masks[4][index] ?? 0
    const others = masks[5][index] ?? 0

    const humanCore = hair * 1.12 + body * 1.05 + face * 1.08
    // Clothing and accessories can occupy pixels without any skin or hair.
    // Relax their penalty only when background confidence is already low.
    const accessoryReliability =
      Math.max(0, Math.min(1, (others - 0.50) / 0.30)) *
      Math.max(0, Math.min(1, (0.30 - bg) / 0.20))
    const accessoryScore = humanCore >= 0.05 ? others * 1.06 : others * (0.65 + 0.29 * accessoryReliability)
    const clothesReliability = Math.max(0, Math.min(1, (0.30 - bg) / 0.10))
    const clothesScore = bg > 0.30 && humanCore < 0.06 ? clothes * 0.60 : clothes * (0.94 + 0.06 * clothesReliability)
    const foregroundSum = humanCore + accessoryScore + clothesScore
    const nonBg = 1 - bg
    const raw = Math.min(nonBg, foregroundSum)
    return Math.max(0, Math.min(1, raw))
  }

  if (masks.length >= 1) {
    return Math.max(0, Math.min(1, masks[0][index] ?? 0))
  }

  return 0
}

export function refineConfidenceBuffer(
  source: Float32Array,
  width: number,
  height: number,
  target: Float32Array,
): void {
  // Keep half the center confidence so the Gaussian softens staircase edges
  // without averaging away narrow fingers, hair, or clothing boundaries.
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width
    const y0 = Math.max(0, y - 1) * width
    const y2 = Math.min(height - 1, y + 1) * width
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - 1)
      const x2 = Math.min(width - 1, x + 1)
      const center = source[rowOffset + x]
      const gaussian =
        (source[y0 + x0] +
          source[y0 + x] * 2 +
          source[y0 + x2] +
          source[rowOffset + x0] * 2 +
          center * 4 +
          source[rowOffset + x2] * 2 +
          source[y2 + x0] +
          source[y2 + x] * 2 +
          source[y2 + x2]) * 0.0625
      target[rowOffset + x] = center * 0.5 + gaussian * 0.5
    }
  }
}

export function smoothConfidenceBuffer(
  current: Float32Array,
  previous: Float32Array | null,
  elapsedMs = 40,
  resetHistory = false,
): Float32Array {
  if (!previous || previous.length !== current.length) {
    return new Float32Array(current)
  }

  // Do not revive an old silhouette after a long pause or blur being disabled.
  if (resetHistory || !Number.isFinite(elapsedMs) || elapsedMs >= 800) {
    previous.set(current)
    return previous
  }
  const elapsedFrames = Math.max(1, Math.min(800, elapsedMs)) / 40

  for (let i = 0; i < current.length; i++) {
    const target = current[i]
    const prev = previous[i]
    const diff = Math.abs(target - prev)
    // Small per-pixel confidence changes get more damping than large changes.
    // This is confidence adaptation, not motion estimation or object tracking.
    const confidenceChange = Math.max(0, Math.min(1, (diff - 0.06) / 0.20))
    const baseBlend = 0.28 + confidenceChange * 0.62
    const blend = 1 - Math.pow(1 - baseBlend, elapsedFrames)
    previous[i] = prev + (target - prev) * blend
  }

  return previous
}

function installMediaPipeConsoleFilter(): void {
  if (consoleFilterInstalled) return
  consoleFilterInstalled = true
  const originalError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('INFO:')) {
      console.info(...args)
      return
    }
    originalError(...args)
  }
}

async function createSegmenterForModel(
  vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  modelAssetPath: string,
): Promise<ImageSegmenter> {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return await ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath, delegate: 'GPU' },
        runningMode: 'VIDEO',
        canvas: new OffscreenCanvas(256, 256),
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      })
    } catch {
      // Fall back to CPU delegate when WebGL2 / GPU delegate creation is unavailable.
    }
  }

  return ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath, delegate: 'CPU' },
    runningMode: 'VIDEO',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  })
}

const send = (message: WorkerResponse, transfer: Transferable[] = []) => {
  if (!stopped) self.postMessage(message, transfer)
  else if (message.type === 'mask') message.bitmap.close()
}

async function initialize(
  wasmBaseUrl: string,
  modelUrl: string,
  fallbackModelUrl?: string,
): Promise<void> {
  if (segmenter) return
  if (initializing) return initializing
  initializing = (async () => {
    installMediaPipeConsoleFilter()
    // This is a module worker. Ask MediaPipe for its ES module loader so the
    // importScripts fallback can dynamically import a loader that installs
    // globalThis.ModuleFactory before the WASM graph runner is initialized.
    const vision = await FilesetResolver.forVisionTasks(wasmBaseUrl, true)
    try {
      segmenter = await createSegmenterForModel(vision, modelUrl)
    } catch (primaryError) {
      if (!fallbackModelUrl || fallbackModelUrl === modelUrl) {
        throw primaryError
      }
      segmenter = await createSegmenterForModel(vision, fallbackModelUrl)
    }
  })()
  try {
    await initializing
  } finally {
    initializing = undefined
  }
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
    const request = event.data
    if (request.type === 'init') {
      void initialize(request.wasmBaseUrl, request.modelUrl, request.fallbackModelUrl)
        .then(() => send({ type: 'ready' }))
        .catch((error: unknown) => {
          send({
            type: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Could not load the local segmentation model.',
          })
        })
      return
    }

    const bitmap = request.bitmap
    let outputBitmap: ImageBitmap | undefined
    try {
      if (!segmenter) throw new Error('The segmentation model is still loading.')
      const nowMs = Math.max(
        lastTimestampMs + 1,
        request.timestampMs,
      )
      lastTimestampMs = nowMs
      const startedAt = performance.now()
      // Callback masks are borrowed. Read, refine, and render them synchronously;
      // MediaPipe owns their lifetime and must not have its result closed here.
      segmenter.segmentForVideo(bitmap, nowMs, (result) => {
        const confidenceMasks = result.confidenceMasks
        if (!confidenceMasks || confidenceMasks.length === 0) {
          throw new Error('The segmentation model did not return a person confidence mask.')
        }

        const firstMask = confidenceMasks[0]
        const maskWidth = firstMask.width
        const maskHeight = firstMask.height
        const pixelCount = maskWidth * maskHeight
        const maskArrays = confidenceMasks.map((m) => m.getAsFloat32Array())

        if (!rawConfidences || rawConfidences.length !== pixelCount) {
          rawConfidences = new Float32Array(pixelCount)
        }
        for (let i = 0; i < pixelCount; i++) {
          rawConfidences[i] = computePersonConfidence(maskArrays, i)
        }

        const dimensionsChanged = maskCanvas?.width !== maskWidth || maskCanvas?.height !== maskHeight
        const elapsedMs = lastSampleTimestampMs === undefined ? 40 : request.timestampMs - lastSampleTimestampMs
        const smoothed = smoothConfidenceBuffer(
          rawConfidences,
          dimensionsChanged ? null : previousConfidences,
          elapsedMs,
          request.resetHistory,
        )
        previousConfidences = smoothed
        lastSampleTimestampMs = request.timestampMs

        if (!scratchConfidences || scratchConfidences.length !== pixelCount) {
          scratchConfidences = new Float32Array(pixelCount)
        }

        if (
          !maskCanvas ||
          maskCanvas.width !== maskWidth ||
          maskCanvas.height !== maskHeight ||
          !maskContext ||
          !maskImageData
        ) {
          maskCanvas = new OffscreenCanvas(maskWidth, maskHeight)
          maskContext = maskCanvas.getContext('2d')
          if (!maskContext) throw new Error('Could not create the segmentation mask canvas.')
          maskImageData = new ImageData(new Uint8ClampedArray(pixelCount * 4), maskWidth, maskHeight)
        }

        refineConfidenceBuffer(smoothed, maskWidth, maskHeight, scratchConfidences)

        const pixels = maskImageData.data
        for (let index = 0; index < pixelCount; index++) {
          const c = scratchConfidences[index]
          const offset = index * 4
          pixels[offset] = 255
          pixels[offset + 1] = 255
          pixels[offset + 2] = 255
          pixels[offset + 3] = Math.round(Math.max(0, Math.min(1, c)) * 255)
        }

        maskContext.putImageData(maskImageData, 0, 0)
        outputBitmap = maskCanvas.transferToImageBitmap()
        const segmentationMs = performance.now() - startedAt
        send({
          type: 'mask', bitmap: outputBitmap, segmentationMs,
          timestampMs: request.timestampMs, frameId: request.frameId,
        }, [outputBitmap])
        outputBitmap = undefined // Ownership moved to the renderer (or send closed it).
      })
    } catch (error) {
      previousConfidences = null
      lastSampleTimestampMs = undefined
      send({
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not segment the camera frame.',
      })
    } finally {
      outputBitmap?.close()
      bitmap.close()
    }
  })

  self.addEventListener('close', () => {
    stopped = true
    segmenter?.close()
    segmenter = undefined
    maskCanvas = null
    maskContext = null
    maskImageData = null
    rawConfidences = null
    previousConfidences = null
    scratchConfidences = null
    lastSampleTimestampMs = undefined
    lastTimestampMs = 0
  })
}
