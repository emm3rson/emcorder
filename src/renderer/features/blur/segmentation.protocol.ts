export type WorkerRequest =
  | { type: 'init'; wasmBaseUrl: string; modelUrl: string; fallbackModelUrl?: string }
  | { type: 'segment'; bitmap: ImageBitmap; timestampMs: number; frameId: number; resetHistory?: boolean }

export type WorkerResponse =
  | { type: 'ready' }
  // Echo the renderer's sampling time unchanged; worker and window clocks differ.
  | { type: 'mask'; bitmap: ImageBitmap; segmentationMs: number; timestampMs: number; frameId: number }
  | { type: 'error'; message: string }
