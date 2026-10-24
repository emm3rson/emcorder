import type { RecordingQuality } from './recordingQuality'
import type { BlurStrength } from './blurStrength'
import type { ImageAdjustments } from './imageAdjustments'

export const MAX_SCRIPT_LENGTH = 100_000

export interface TakeFile { url: string; bytes: number }
export interface OverlayBounds {
  x: number
  y: number
  width: number
  height: number
}
export interface StudioPreferences extends ImageAdjustments {
  cameraId: string
  micId: string
  blur: boolean
  blurStrength: BlurStrength
  quality: RecordingQuality
  countdownSeconds: number
  mirrorVideo: boolean
  autoStartPrompter: boolean
  outputFolder: string
  script: string
  fontSize: number
  scrollSpeed: number
  overlayOpacity: number
  overlayBounds: OverlayBounds
}
export type UpdatableStudioPreferences = Pick<
  StudioPreferences,
  'cameraId' | 'micId' | 'blur' | 'blurStrength' | 'quality' | 'countdownSeconds' | 'mirrorVideo' | 'autoStartPrompter' | 'script' | 'fontSize' | 'scrollSpeed' | 'overlayOpacity' | 'overlayBounds' | 'brightness' | 'contrast' | 'saturation'
>
export interface EmcorderBridge {
  beginRecording(mimeType: string): Promise<void>
  appendChunk(data: ArrayBuffer): Promise<void>
  finishRecording(): Promise<TakeFile>
  discardRecording(): Promise<void>
  saveRecording(options: { filename: string; directory: string }): Promise<string>
  getPreferences(): Promise<StudioPreferences>
  updatePreferences(patch: Partial<UpdatableStudioPreferences>): Promise<void>
  chooseOutputFolder(): Promise<string | null>
  onRequestStop(callback: () => void): () => void
}
declare global { interface Window { emcorder: EmcorderBridge } }
