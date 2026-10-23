export type WorkerRequest =
  | { type: 'init'; wasmBaseUrl: string; modelUrl: string; fallbackModelUrl?: string }
  | { type: 'segment'; bitmap: ImageBitmap; timestampMs?: number }

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'mask'; bitmap: ImageBitmap; segmentationMs: number }
  | { type: 'error'; message: string }
