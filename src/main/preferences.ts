import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OverlayBounds, StudioPreferences, UpdatableStudioPreferences } from '../shared/contracts'
import { MAX_SCRIPT_LENGTH } from '../shared/contracts'
import { DEFAULT_RECORDING_QUALITY, isRecordingQuality } from '../shared/recordingQuality'
import { DEFAULT_BLUR_STRENGTH, isBlurStrength } from '../shared/blurStrength'
import {
  DEFAULT_COUNTDOWN_SECONDS, DEFAULT_MIRROR_VIDEO, DEFAULT_AUTO_START_PROMPTER, isCountdownSeconds,
} from '../shared/studioSettings'
import {
  DEFAULT_OVERLAY_BOUNDS, DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE,
  DEFAULT_SCROLL_SPEED, MIN_SCROLL_SPEED, MAX_SCROLL_SPEED,
  DEFAULT_OVERLAY_OPACITY, MIN_OVERLAY_OPACITY, MAX_OVERLAY_OPACITY,
  MIN_OVERLAY_WIDTH, MAX_OVERLAY_WIDTH, MIN_OVERLAY_HEIGHT, MAX_OVERLAY_HEIGHT,
} from '../shared/teleprompter'

export type { OverlayBounds, StudioPreferences, UpdatableStudioPreferences }
export { MAX_SCRIPT_LENGTH }
export * from '../shared/teleprompter'

const deviceId = (value: unknown): string => typeof value === 'string' && value.length <= 4096 ? value : ''
const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const round = (value: number): number => Math.round(value * 10_000) / 10_000

export function clampOverlayBounds(bounds: OverlayBounds): OverlayBounds {
  const width = round(clamp(bounds.width, MIN_OVERLAY_WIDTH, MAX_OVERLAY_WIDTH))
  const height = round(clamp(bounds.height, MIN_OVERLAY_HEIGHT, MAX_OVERLAY_HEIGHT))
  const x = round(clamp(bounds.x, 0, 1 - width))
  const y = round(clamp(bounds.y, 0, 1 - height))
  return { x, y, width, height }
}

function isValidOverlayBounds(value: unknown): value is OverlayBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 4 || !keys.every((key) => key === 'x' || key === 'y' || key === 'width' || key === 'height')) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.x === 'number' && Number.isFinite(record.x) &&
    typeof record.y === 'number' && Number.isFinite(record.y) &&
    typeof record.width === 'number' && Number.isFinite(record.width) &&
    typeof record.height === 'number' && Number.isFinite(record.height)
  )
}

export class PreferencesStore {
  private readonly file: string
  private current: StudioPreferences
  private writes: Promise<void> = Promise.resolve()
  constructor(userDataPath: string, private readonly videosPath: string) {
    this.file = join(userDataPath, 'preferences.json')
    this.current = this.defaults()
  }

  private defaults(): StudioPreferences {
    return {
      cameraId: '',
      micId: '',
      blur: true,
      blurStrength: DEFAULT_BLUR_STRENGTH,
      quality: DEFAULT_RECORDING_QUALITY,
      countdownSeconds: DEFAULT_COUNTDOWN_SECONDS,
      mirrorVideo: DEFAULT_MIRROR_VIDEO,
      autoStartPrompter: DEFAULT_AUTO_START_PROMPTER,
      outputFolder: this.videosPath,
      script: '',
      fontSize: DEFAULT_FONT_SIZE,
      scrollSpeed: DEFAULT_SCROLL_SPEED,
      overlayOpacity: DEFAULT_OVERLAY_OPACITY,
      overlayBounds: { ...DEFAULT_OVERLAY_BOUNDS }
    }
  }

  private clone(): StudioPreferences {
    return {
      ...this.current,
      overlayBounds: { ...this.current.overlayBounds }
    }
  }

  async load(): Promise<StudioPreferences> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = parsed as Record<string, unknown>
        this.current = {
          cameraId: deviceId(value.cameraId),
          micId: deviceId(value.micId),
          blur: typeof value.blur === 'boolean' ? value.blur : true,
          blurStrength: isBlurStrength(value.blurStrength) ? value.blurStrength : DEFAULT_BLUR_STRENGTH,
          quality: isRecordingQuality(value.quality) ? value.quality : DEFAULT_RECORDING_QUALITY,
          countdownSeconds: isCountdownSeconds(value.countdownSeconds) ? value.countdownSeconds : DEFAULT_COUNTDOWN_SECONDS,
          mirrorVideo: typeof value.mirrorVideo === 'boolean' ? value.mirrorVideo : DEFAULT_MIRROR_VIDEO,
          autoStartPrompter: typeof value.autoStartPrompter === 'boolean' ? value.autoStartPrompter : DEFAULT_AUTO_START_PROMPTER,
          outputFolder: await this.validDirectory(value.outputFolder) ? value.outputFolder as string : this.videosPath,
          script: typeof value.script === 'string' && value.script.length <= MAX_SCRIPT_LENGTH ? value.script : '',
          fontSize: inRange(value.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE) ? value.fontSize : DEFAULT_FONT_SIZE,
          scrollSpeed: inRange(value.scrollSpeed, MIN_SCROLL_SPEED, MAX_SCROLL_SPEED) ? value.scrollSpeed : DEFAULT_SCROLL_SPEED,
          overlayOpacity: inRange(value.overlayOpacity, MIN_OVERLAY_OPACITY, MAX_OVERLAY_OPACITY) ? value.overlayOpacity : DEFAULT_OVERLAY_OPACITY,
          overlayBounds: isValidOverlayBounds(value.overlayBounds) ? clampOverlayBounds(value.overlayBounds) : { ...DEFAULT_OVERLAY_BOUNDS }
        }
      }
    } catch { /* Missing or malformed settings use defaults. */ }
    return this.clone()
  }

  get(): StudioPreferences { return this.clone() }

  async update(patch: Partial<UpdatableStudioPreferences>): Promise<void> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid preference update.')
    const allowed = new Set(['cameraId', 'micId', 'blur', 'blurStrength', 'quality', 'countdownSeconds', 'mirrorVideo', 'autoStartPrompter', 'script', 'fontSize', 'scrollSpeed', 'overlayOpacity', 'overlayBounds'])
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) throw new Error('Only device and blur, recording, or teleprompter preferences can be updated here.')
    }
    if ('cameraId' in patch) {
      if (typeof patch.cameraId !== 'string' || patch.cameraId.length > 4096) throw new Error('Invalid camera preference.')
    }
    if ('micId' in patch) {
      if (typeof patch.micId !== 'string' || patch.micId.length > 4096) throw new Error('Invalid microphone preference.')
    }
    if ('blur' in patch) {
      if (typeof patch.blur !== 'boolean') throw new Error('Invalid blur preference.')
    }
    if ('blurStrength' in patch) {
      if (!isBlurStrength(patch.blurStrength)) throw new Error('Invalid blur strength preference.')
    }
    if ('quality' in patch) {
      if (!isRecordingQuality(patch.quality)) throw new Error('Invalid recording quality preference.')
    }
    if ('countdownSeconds' in patch) {
      if (!isCountdownSeconds(patch.countdownSeconds)) throw new Error('Invalid countdown preference.')
    }
    if ('mirrorVideo' in patch) {
      if (typeof patch.mirrorVideo !== 'boolean') throw new Error('Invalid mirror video preference.')
    }
    if ('autoStartPrompter' in patch) {
      if (typeof patch.autoStartPrompter !== 'boolean') throw new Error('Invalid auto-start prompter preference.')
    }
    if ('script' in patch) {
      if (typeof patch.script !== 'string' || patch.script.length > MAX_SCRIPT_LENGTH) throw new Error('Invalid script preference.')
    }
    if ('fontSize' in patch) {
      if (!inRange(patch.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE)) throw new Error('Invalid font size preference.')
    }
    if ('scrollSpeed' in patch) {
      if (!inRange(patch.scrollSpeed, MIN_SCROLL_SPEED, MAX_SCROLL_SPEED)) throw new Error('Invalid scroll speed preference.')
    }
    if ('overlayOpacity' in patch) {
      if (!inRange(patch.overlayOpacity, MIN_OVERLAY_OPACITY, MAX_OVERLAY_OPACITY)) throw new Error('Invalid overlay opacity preference.')
    }
    if ('overlayBounds' in patch) {
      if (!isValidOverlayBounds(patch.overlayBounds)) throw new Error('Invalid overlay bounds preference.')
    }
    const normalizedPatch: Partial<UpdatableStudioPreferences> = { ...patch }
    if (patch.overlayBounds) {
      normalizedPatch.overlayBounds = clampOverlayBounds(patch.overlayBounds)
    }
    await this.enqueue(async () => {
      const next: StudioPreferences = {
        ...this.current,
        ...normalizedPatch,
        overlayBounds: normalizedPatch.overlayBounds
          ? { ...normalizedPatch.overlayBounds }
          : { ...this.current.overlayBounds }
      }
      await this.persist(next)
    })
  }

  async setOutputFolder(folder: string): Promise<void> {
    if (typeof folder !== 'string' || !await this.validDirectory(folder)) throw new Error('Choose a folder that exists and can be accessed.')
    await this.enqueue(async () => {
      await this.persist({ ...this.clone(), outputFolder: folder })
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation)
    this.writes = result.then(() => undefined, () => undefined)
    return result
  }

  private async validDirectory(path: unknown): Promise<boolean> {
    if (typeof path !== 'string' || !path.trim()) return false
    try { return (await stat(path)).isDirectory() } catch { return false }
  }

  private async persist(next: StudioPreferences): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.file)
      this.current = next
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOSPC') throw new Error('There is not enough disk space to save preferences.')
      if (code === 'EACCES' || code === 'EPERM') throw new Error('Windows could not save preferences in the application data folder.')
      throw error
    }
  }
}
