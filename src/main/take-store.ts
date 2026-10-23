import { mkdir, open, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/** One take at a time. A saved recording is user-owned and is never removed here. */
export class TakeStore {
  private temporaryPath: string | null = null
  private savedPath: string | null = null
  private handle: FileHandle | null = null
  private writes: Promise<void> = Promise.resolve()
  private writeError: Error | null = null
  private accepting = false
  private finishing: Promise<number> | null = null
  private saving = false
  private changing = false
  get path(): string | null { return this.savedPath ?? this.temporaryPath }
  get temporaryFilePath(): string | null { return this.temporaryPath }
  get isSaved(): boolean { return this.savedPath !== null }
  get recording(): boolean { return this.accepting }

  constructor(
    private readonly directory: string,
    private readonly openFile: typeof open = open,
  ) {}

  async begin(): Promise<void> {
    if (this.changing) throw new Error('Wait for the current take operation to finish.')
    if (this.path) throw new Error('Save or discard the previous take before recording again.')
    this.changing = true
    try {
      await mkdir(this.directory, { recursive: true })
      const path = join(this.directory, `${randomUUID()}.mp4`)
      this.handle = await this.openFile(path, 'wx')
      this.temporaryPath = path
      this.writeError = null
      this.writes = Promise.resolve()
      this.finishing = null
      this.accepting = true
    } finally { this.changing = false }
  }

  append(data: Uint8Array): Promise<void> {
    if (!this.accepting || !this.handle) return Promise.reject(new Error('No recording is accepting data.'))
    const handle = this.handle
    const next = this.writes.then(async () => {
      if (this.writeError) throw this.writeError
      let offset = 0
      while (offset < data.byteLength) {
        const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset)
        if (!bytesWritten) throw new Error('The recording could not be written to disk.')
        offset += bytesWritten
      }
    })
    this.writes = next.catch((error: Error) => { this.writeError = error })
    return next
  }

  finish(): Promise<number> {
    if (this.changing) return Promise.reject(new Error('Wait for the current take operation to finish.'))
    if (this.finishing) return this.finishing
    this.accepting = false
    this.finishing = this.finishOnce()
    return this.finishing
  }

  private async finishOnce(): Promise<number> {
    await this.writes
    const handle = this.handle
    this.handle = null
    if (handle) {
      try { await handle.sync() } finally { await handle.close() }
    }
    if (this.writeError) throw this.writeError
    if (!this.temporaryPath) throw new Error('No take is available.')
    const { size } = await stat(this.temporaryPath)
    if (!size) throw new Error('The encoder produced an empty file. Retake after checking the camera.')
    return size
  }

  async save(options: { filename: string; directory: string }): Promise<string> {
    if (this.changing) throw new Error('Wait for the current take operation to finish.')
    if (this.saving) throw new Error('This take is already being saved.')
    if (this.accepting || this.handle) throw new Error('Stop recording before saving.')
    if (!this.temporaryPath) throw new Error('No unsaved take is available.')
    const filename = options.filename
    const windowsDeviceName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(filename)
    if (!filename.trim() || filename !== filename.trim() || filename === '.' || filename === '..' || filename.endsWith('.') || filename.endsWith(' ') || windowsDeviceName || basename(filename) !== filename || /[<>:"|?*\\/\x00-\x1f]/.test(filename)) {
      throw new Error('Enter a valid filename without folder separators or Windows reserved characters.')
    }
    if (typeof options.directory !== 'string' || !isAbsolute(options.directory)) throw new Error('Choose an absolute folder path to save the recording.')
    const directory = resolve(options.directory)
    const outputName = filename.toLowerCase().endsWith('.mp4') ? filename : `${filename}.mp4`
    let destination = join(directory, outputName)
    const source = this.temporaryPath
    // Exclusive creation prevents clobbering any existing file. A partial output
    // is removed on failure while the complete temporary source remains intact.
    let created = false
    this.saving = true
    try {
      // Finalization may still be syncing, or may have failed after closing the
      // handle. Never promote an incomplete take to a successful saved recording.
      await this.finish()
      let destinationIsDirectory = false
      try { destinationIsDirectory = (await stat(directory)).isDirectory() } catch {}
      if (!destinationIsDirectory) throw new Error('Choose an existing folder to save the recording.')
      let input: FileHandle | null = null
      let target: FileHandle | null = null
      try {
        try {
          input = await this.openFile(source, 'r')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error('The temporary recording file could not be found.')
          }
          throw error
        }
        for (let suffix = 2; ; suffix++) {
          try {
            target = await this.openFile(destination, 'wx', 0o600)
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            destination = join(directory, `${outputName.slice(0, -4)}_${suffix}${outputName.slice(-4)}`)
          }
        }
        created = true
        const buffer = Buffer.allocUnsafe(1024 * 1024)
        let position = 0
        while (true) {
          const { bytesRead } = await input.read(buffer, 0, buffer.byteLength, position)
          if (!bytesRead) break
          let written = 0
          while (written < bytesRead) {
            const result = await target.write(buffer, written, bytesRead - written, position + written)
            if (!result.bytesWritten) throw new Error('The recording could not be copied to its destination.')
            written += result.bytesWritten
          }
          position += bytesRead
        }
        await target.sync()
      } finally {
        try { if (input) await input.close() } finally { if (target) await target.close() }
      }
      created = false
      this.temporaryPath = null
      this.savedPath = destination
      this.finishing = null
      await unlink(source).catch(() => undefined)
      return destination
    } catch (error) {
      if (created) {
        try { await unlink(destination) } catch {}
      }
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOSPC') throw new Error('There is not enough disk space to save this recording. Free space and try again.')
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
        let stillDirectory = false
        try { stillDirectory = (await stat(directory)).isDirectory() } catch {}
        if (!stillDirectory) throw new Error('Choose an existing folder to save the recording.')
        throw new Error('Windows could not write to that folder. If Controlled Folder Access is turned on in Windows Security, allow EmCorder or choose another folder such as Downloads.')
      }
      throw error
    } finally {
      this.saving = false
    }
  }

  async discard(): Promise<void> {
    if (this.changing) throw new Error('Wait for the current take operation to finish.')
    if (this.saving) throw new Error('Wait for the save to finish before retaking.')
    if (this.accepting) throw new Error('Stop recording before discarding.')
    this.changing = true
    try {
      // A failed finish still leaves a take that the user may explicitly discard.
      if (this.finishing) await this.finishing.catch(() => undefined)
      await this.writes
      if (this.handle) { await this.handle.close(); this.handle = null }
      if (this.temporaryPath) {
        try { await unlink(this.temporaryPath) }
        catch (error) {
          // Retake can still clear stale review state if the temporary file was
          // removed outside the app. Other failures must remain visible.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      this.temporaryPath = null
      // Clearing review state after Retake must never delete a saved user file.
      this.savedPath = null
      this.finishing = null
    } finally { this.changing = false }
  }
}
