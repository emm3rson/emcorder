export interface Advisory {
  id: string
  message: string
  delayMs: number
}

export function blurAdvisory(status: string): Advisory | null {
  if (status.startsWith('Camera blur is running slowly')) {
    return { id: 'blur-slow', message: 'Background blur is running slowly. Reduce other camera effects for smoother video.', delayMs: 2000 }
  }
  if (status.startsWith('Camera blur is delayed') || status.startsWith('Camera blur unavailable:')) {
    return { id: 'blur-unavailable', message: 'Background blur is unavailable. The camera is showing without blur.', delayMs: 2000 }
  }
  return null
}

/** One preparation or take. Recovery never rearms an already announced issue. */
export class AdvisorySession {
  private readonly seen = new Set<string>()
  private readonly pending = new Map<string, number>()

  get waiting(): boolean { return this.pending.size > 0 }

  observe(active: readonly Advisory[], now: number): Advisory[] {
    const activeIds = new Set(active.map((item) => item.id))
    for (const id of this.pending.keys()) {
      if (!activeIds.has(id)) this.pending.delete(id)
    }
    const ready: Advisory[] = []
    for (const item of active) {
      if (this.seen.has(item.id)) continue
      const since = this.pending.get(item.id) ?? now
      this.pending.set(item.id, since)
      if (now - since < item.delayMs) continue
      this.seen.add(item.id)
      this.pending.delete(item.id)
      ready.push(item)
    }
    return ready
  }
}
