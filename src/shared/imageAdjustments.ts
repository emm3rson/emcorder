export interface ImageAdjustments {
  brightness: number
  contrast: number
  saturation: number
}

export const DEFAULT_IMAGE_ADJUSTMENTS: Readonly<ImageAdjustments> = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
}

export const IMAGE_ADJUSTMENT_LIMITS = {
  brightness: { min: 50, max: 150 },
  contrast: { min: 50, max: 150 },
  saturation: { min: 50, max: 150 },
} as const

export function isImageAdjustment(key: keyof ImageAdjustments, value: unknown): value is number {
  const { min, max } = IMAGE_ADJUSTMENT_LIMITS[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

export function imageAdjustmentFilter({ brightness, contrast, saturation }: ImageAdjustments): string {
  if (brightness === 100 && contrast === 100 && saturation === 100) return 'none'
  return `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`
}
