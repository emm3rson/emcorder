export const MIN_COUNTDOWN_SECONDS = 3
export const MAX_COUNTDOWN_SECONDS = 10
export const DEFAULT_COUNTDOWN_SECONDS = 3
export const DEFAULT_MIRROR_VIDEO = true
export const DEFAULT_AUTO_START_PROMPTER = true

export function isCountdownSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= MIN_COUNTDOWN_SECONDS && value <= MAX_COUNTDOWN_SECONDS
}
