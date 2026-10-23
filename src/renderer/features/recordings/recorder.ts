import type { TakeFile } from '../../../shared/contracts';

import { DEFAULT_RECORDING_QUALITY, RECORDING_PROFILES, type RecordingQuality } from '../../../shared/recordingQuality';
const AUDIO_BITRATE = 128_000;
const TIMESLICE_MS = 1_000;
const MAX_QUEUED_CHUNKS = 8;

const MP4_CANDIDATES = [
  'video/mp4;codecs="avc1.64001E,mp4a.40.2"',
  'video/mp4;codecs="avc1.4D401E,mp4a.40.2"',
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4;codecs="avc1.42E01F,mp4a.40.2"',
] as const;

export type RecordedTake = TakeFile & { elapsedSeconds: number; quality: RecordingQuality };
type RecorderCallbacks = {
  onError: (message: string) => void;
  onStopped: (result: RecordedTake) => void;
};

/** Returns a supported H.264 + AAC MP4 MIME type, or null if direct MP4 is unavailable. */
export function chooseMp4Type(quality: RecordingQuality = DEFAULT_RECORDING_QUALITY): string | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
  const candidates = quality === '1080p' ? [
    'video/mp4;codecs="avc1.640028,mp4a.40.2"',
    'video/mp4;codecs="avc1.4D4028,mp4a.40.2"',
    'video/mp4;codecs="avc1.42E028,mp4a.40.2"',
  ] : MP4_CANDIDATES;
  for (const candidate of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // Some runtimes throw for unsupported codec probes. Try the next explicit MP4 candidate.
    }
  }
  return null;
}

/** Records the processed canvas and a microphone track, streaming chunks to the main process. */
export class Mp4Recorder {
  private readonly type: string;
  private readonly canvasStream: MediaStream;
  private readonly combinedStream: MediaStream;
  private recorder: MediaRecorder | null = null;
  private startedAt = 0;
  private stoppedAt: number | null = null;
  private started = false;
  private writerOpened = false;
  private settled = false;
  private failure: Error | null = null;
  private writes: Promise<void> = Promise.resolve();
  private queuedChunks = 0;
  private startTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private finalizationTask: Promise<void> | null = null;
  private stopEventPromise: Promise<void> | null = null;
  private resolveStopEvent: (() => void) | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    microphone: MediaStream,
    private readonly callbacks: RecorderCallbacks,
    private readonly quality: RecordingQuality = DEFAULT_RECORDING_QUALITY,
  ) {
    const type = chooseMp4Type(quality);
    if (!type) throw new Error("This Electron runtime does not support recording H.264/AAC MP4 directly.");
    if (!microphone.getAudioTracks().some((track) => track.readyState === "live")) {
      throw new Error("No live microphone audio track is available.");
    }
    this.type = type;
    this.canvasStream = canvas.captureStream(RECORDING_PROFILES[quality].frameRate);
    const videoTracks = this.canvasStream.getVideoTracks();
    if (!videoTracks.length) {
      this.canvasStream.getTracks().forEach((track) => track.stop());
      throw new Error("The processed canvas did not provide a video track.");
    }
    for (const track of videoTracks) {
      track.contentHint = "motion";
    }
    // Only tracks created by captureStream belong to this recorder. The source microphone stays active.
    this.combinedStream = new MediaStream([...videoTracks, ...microphone.getAudioTracks()]);
  }

  get elapsedSeconds(): number {
    if (!this.startedAt) return 0;
    return Math.max(0, Math.floor(((this.stoppedAt ?? Date.now()) - this.startedAt) / 1_000));
  }

  get mimeType(): string {
    return this.type;
  }

  start(): Promise<void> {
    if (this.startTask) return this.startTask;
    if (this.started || this.settled) return Promise.reject(new Error("This recorder has already been started or stopped."));
    this.startTask = this.startInternal();
    return this.startTask;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = this.stopInternal();
    return this.stopTask;
  }

  private async startInternal(): Promise<void> {
    try {
      await window.emcorder.beginRecording(this.type);
      this.writerOpened = true;
      if (this.failure) throw this.failure;

      const recorder = new MediaRecorder(this.combinedStream, {
        mimeType: this.type,
        videoBitsPerSecond: RECORDING_PROFILES[this.quality].videoBitsPerSecond,
        audioBitsPerSecond: AUDIO_BITRATE,
      });
      this.recorder = recorder;
      this.stopEventPromise = new Promise<void>((resolve) => {
        this.resolveStopEvent = resolve;
      });
      recorder.addEventListener("dataavailable", this.onDataAvailable);
      recorder.addEventListener("error", this.onRecorderError);
      recorder.addEventListener("stop", this.onRecorderStop);
      recorder.start(TIMESLICE_MS);
      this.started = true;
      this.startedAt = Date.now();
    } catch (error) {
      this.fail(error, "Could not start the MP4 recorder.");
      await this.closeWriterAfterStartFailure();
      this.cleanupTracks();
      throw this.failure;
    }
  }

  private async stopInternal(): Promise<void> {
    if (!this.startTask) throw new Error("Recording has not started.");
    try {
      await this.startTask;
    } catch {
      throw this.failure ?? new Error("Recording did not start.");
    }
    if (!this.started || !this.recorder) throw this.failure ?? new Error("Recording has not started.");

    this.stoppedAt ??= Date.now();
    if (this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch (error) {
        this.fail(error, "Could not stop the MP4 recorder.");
        this.beginAutomaticFinalization();
      }
    }
    // MediaRecorder emits its final dataavailable before stop. Waiting for stop ensures that
    // final chunk has entered the ordered write queue before finalization snapshots that queue.
    if (!this.finalizationTask) {
      await this.stopEventPromise;
      this.beginAutomaticFinalization();
    }
    await this.finalizationTask;
  }

  private readonly onRecorderStop = (): void => {
    this.stoppedAt ??= Date.now();
    this.resolveStopEvent?.();
    this.beginAutomaticFinalization();
  };

  private readonly onDataAvailable = (event: BlobEvent): void => {
    if (!event.data.size || this.failure || this.settled) return;
    this.queuedChunks += 1;
    if (this.queuedChunks > MAX_QUEUED_CHUNKS) {
      this.fail(new Error("The recording writer is falling behind; recording stopped to protect memory."));
      this.requestStopAfterFailure();
      return;
    }

    // Chain appends to preserve recorder event order and bound retained Blob data.
    this.writes = this.writes.then(async () => {
      const data = await event.data.arrayBuffer();
      if (!this.failure) await window.emcorder.appendChunk(data);
    }).catch((error: unknown) => {
      this.fail(error, "Could not write a recording chunk.");
      this.requestStopAfterFailure();
    }).finally(() => {
      this.queuedChunks -= 1;
    });
  };

  private readonly onRecorderError = (event: Event): void => {
    const mediaError = (event as Event & { error?: DOMException }).error;
    this.fail(mediaError ?? new Error("MediaRecorder reported an encoding error."), "MP4 encoding failed.");
    this.requestStopAfterFailure();
  };

  private requestStopAfterFailure(): void {
    const recorder = this.recorder;
    if (!recorder) {
      this.beginAutomaticFinalization();
    } else if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        this.beginAutomaticFinalization();
      }
    } else {
      this.beginAutomaticFinalization();
    }
  }

  private beginAutomaticFinalization(): void {
    void this.finalize().catch(() => undefined);
  }

  private finalize(): Promise<void> {
    if (this.finalizationTask) return this.finalizationTask;
    this.finalizationTask = this.finalizeInternal();
    return this.finalizationTask;
  }

  private async finalizeInternal(): Promise<void> {
    this.stoppedAt ??= Date.now();
    try {
      await this.writes;
      // Always close an opened writer, even after a write/encoding error. The closed temp
      // recording remains available for the UI's explicit discard/retry flow.
      const result = this.writerOpened ? await window.emcorder.finishRecording() : null;
      this.writerOpened = false;
      if (this.failure) throw this.failure;
      if (!result) throw new Error("The recording writer was not opened.");
      this.settled = true;
      this.callbacks.onStopped({ ...result, elapsedSeconds: this.elapsedSeconds, quality: this.quality });
    } catch (error) {
      const failure = this.fail(error, "Could not finalize the recording.");
      this.settled = true;
      throw failure;
    } finally {
      this.cleanupTracks();
    }
  }

  private async closeWriterAfterStartFailure(): Promise<void> {
    if (!this.writerOpened) return;
    try {
      await window.emcorder.finishRecording();
    } catch (error) {
      this.fail(error, "Could not close the failed recording.");
    } finally {
      this.writerOpened = false;
      this.settled = true;
    }
  }

  private fail(value: unknown, fallback = "Recording failed."): Error {
    if (this.failure) return this.failure;
    const message = value instanceof Error && value.message ? value.message : fallback;
    this.failure = value instanceof Error ? value : new Error(message);
    try {
      this.callbacks.onError(message);
    } catch {
      // Keep callback exceptions from escaping MediaRecorder event handlers.
    }
    return this.failure;
  }

  private cleanupTracks(): void {
    this.canvasStream.getTracks().forEach((track) => track.stop());
    this.recorder?.removeEventListener("dataavailable", this.onDataAvailable);
    this.recorder?.removeEventListener("error", this.onRecorderError);
    this.recorder?.removeEventListener("stop", this.onRecorderStop);
  }
}
