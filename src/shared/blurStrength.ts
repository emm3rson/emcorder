export const BLUR_STRENGTHS = {
  light: { label: 'Light', scale: 0.5 },
  standard: { label: 'Standard', scale: 1 },
  strong: { label: 'Strong', scale: 1.5 },
} as const

export type BlurStrength = keyof typeof BLUR_STRENGTHS
export const DEFAULT_BLUR_STRENGTH: BlurStrength = 'standard'

export function isBlurStrength(value: unknown): value is BlurStrength {
  return typeof value === 'string' && Object.hasOwn(BLUR_STRENGTHS, value)
}
