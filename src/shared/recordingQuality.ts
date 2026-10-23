export type RecordingQuality = '720p' | '1080p'

export const DEFAULT_RECORDING_QUALITY: RecordingQuality = '720p'
export const RECORDING_PROFILES = {
  '720p': { width: 1280, height: 720, frameRate: 30, videoBitsPerSecond: 6_000_000 },
  '1080p': { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 12_000_000 },
} as const

export function isRecordingQuality(value: unknown): value is RecordingQuality {
  return value === '720p' || value === '1080p'
}
