import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chooseMp4Type, Mp4Recorder, type RecordedTake } from "../src/renderer/features/recordings/recorder";

class FakeTrack {
  readyState = "live";
  stopped = false;
  contentHint = "";
  stop(): void { this.stopped = true; }
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[], private readonly audioOnly = false) {}
  getTracks(): FakeTrack[] { return this.tracks; }
  getVideoTracks(): FakeTrack[] { return this.tracks.slice(0, 1); }
  getAudioTracks(): FakeTrack[] { return this.audioOnly ? this.tracks : this.tracks.slice(1); }
}

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(type: string): boolean { return type.startsWith("video/mp4;"); }
  static startThrows = false;
  static asyncStop = false;
  state: RecordingState = "inactive";
  constructor(readonly stream: MediaStream, readonly options?: MediaRecorderOptions) { super(); }
  start(_timeslice?: number): void {
    if (FakeMediaRecorder.startThrows) throw new Error("encoder start failed");
    this.state = "recording";
  }
  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    const finishStop = () => {
      this.emitChunk("final");
      this.dispatchEvent(new Event("stop"));
    };
    if (FakeMediaRecorder.asyncStop) setTimeout(finishStop, 0);
    else finishStop();
  }
  emitChunk(value: string): void {
    const blobEvent = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(blobEvent, "data", { value: new Blob([value]) });
    this.dispatchEvent(blobEvent);
  }
}

const originalMediaRecorder = globalThis.MediaRecorder;
const originalMediaStream = globalThis.MediaStream;
const originalWindow = globalThis.window;
let activeRecorder: FakeMediaRecorder | null = null;

function installFakes(options: { append?: (data: ArrayBuffer) => Promise<void>; begin?: () => Promise<void>; quality?: "720p" | "1080p" } = {}) {
  FakeMediaRecorder.startThrows = false;
  FakeMediaRecorder.asyncStop = false;
  globalThis.MediaRecorder = class extends FakeMediaRecorder {
    constructor(stream: MediaStream, recorderOptions?: MediaRecorderOptions) {
      super(stream, recorderOptions);
      activeRecorder = this;
    }
  } as unknown as typeof MediaRecorder;
  globalThis.MediaStream = FakeStream as unknown as typeof MediaStream;

  const calls = { begin: 0, append: [] as string[], finish: 0 };
  const track = new FakeTrack();
  const bridge = {
    beginRecording: async () => { calls.begin += 1; await options.begin?.(); },
    appendChunk: async (data: ArrayBuffer) => {
      const value = new TextDecoder().decode(data);
      calls.append.push(value);
      await options.append?.(data);
    },
    finishRecording: async () => { calls.finish += 1; return { url: "file:///take.mp4", bytes: 42 }; },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { emcorder: bridge } });

  const canvasTrack = new FakeTrack();
  const canvas = {
    captureStream: () => new FakeStream([canvasTrack]),
  } as unknown as HTMLCanvasElement;
  const microphone = new FakeStream([track], true) as unknown as MediaStream;
  const errors: string[] = [];
  const stopped: RecordedTake[] = [];
  const recorder = new Mp4Recorder(canvas, microphone, {
    onError: (message) => errors.push(message),
    onStopped: (result) => stopped.push(result),
  }, options.quality);
  return { recorder, track, canvasTrack, calls, errors, stopped };
}

afterEach(() => {
  globalThis.MediaRecorder = originalMediaRecorder;
  globalThis.MediaStream = originalMediaStream;
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  FakeMediaRecorder.startThrows = false;
  FakeMediaRecorder.asyncStop = false;
  activeRecorder = null;
});

test("appends recorder chunks in order, drains the final chunk, and leaves microphone active", async () => {
  const { recorder, track, canvasTrack, calls, stopped } = installFakes();
  await recorder.start();
  activeRecorder!.emitChunk("first");
  activeRecorder!.emitChunk("second");
  await recorder.stop();

  assert.deepEqual(calls.append, ["first", "second", "final"]);
  assert.equal(calls.finish, 1);
  assert.equal(stopped.length, 1);
  assert.equal(track.stopped, false);
  assert.equal(canvasTrack.stopped, true);
});

test("automatically closes the writer on append failure and reports no successful take", async () => {
  const { recorder, calls, errors, stopped } = installFakes({
    append: async () => { throw new Error("disk write failed"); },
  });
  await recorder.start();
  activeRecorder!.emitChunk("broken");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  await assert.rejects(recorder.stop(), /disk write failed/);
  assert.equal(calls.finish, 1);
  assert.equal(stopped.length, 0);
  assert.match(errors[0], /disk write failed/);
});

test("closes an opened writer when MediaRecorder.start fails", async () => {
  const { recorder, calls, stopped } = installFakes();
  FakeMediaRecorder.startThrows = true;

  await assert.rejects(recorder.start(), /encoder start failed/);
  assert.equal(calls.begin, 1);
  assert.equal(calls.finish, 1);
  assert.equal(stopped.length, 0);
});

test("automatically finalizes when MediaRecorder stops without a UI stop call", async () => {
  const { recorder, calls, stopped } = installFakes();
  await recorder.start();
  activeRecorder!.emitChunk("last");
  activeRecorder!.state = "inactive";
  activeRecorder!.dispatchEvent(new Event("stop"));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.finish, 1);
  assert.equal(stopped.length, 1);
  await recorder.stop();
});

test("does not close the writer before asynchronous final dataavailable and stop events", async () => {
  const { recorder, calls, stopped } = installFakes();
  await recorder.start();
  activeRecorder!.emitChunk("first");
  FakeMediaRecorder.asyncStop = true;

  const stopping = recorder.stop();
  assert.equal(calls.finish, 0);
  await stopping;

  assert.deepEqual(calls.append, ["first", "final"]);
  assert.equal(calls.finish, 1);
  assert.equal(stopped.length, 1);
});

for (const [quality, bitrate, codec] of [['720p', 6_000_000, '64001E'], ['1080p', 12_000_000, '640028']] as const) {
  test(quality + ' records the processed canvas and microphone at its profile bitrate', async () => {
    const { recorder, track, canvasTrack, stopped } = installFakes({ quality });
    await recorder.start();
    assert.equal(activeRecorder!.options!.videoBitsPerSecond, bitrate);
    assert.match(recorder.mimeType, new RegExp(codec));
    assert.equal(canvasTrack.contentHint, "motion");
    assert.deepEqual(activeRecorder!.stream.getTracks(), [canvasTrack, track]);
    await recorder.stop();
    assert.equal(stopped[0].quality, quality);
    assert.equal(track.stopped, false);
  });
}

test('1080p never falls back to a 720p H264 level', () => {
  installFakes();
  const probes: string[] = [];
  MediaRecorder.isTypeSupported = (type: string) => {
    probes.push(type);
    return type.includes('42E01E');
  };
  assert.equal(chooseMp4Type('1080p'), null);
  assert.equal(probes.length, 3);
  assert.deepEqual(probes, [
    'video/mp4;codecs="avc1.640028,mp4a.40.2"',
    'video/mp4;codecs="avc1.4D4028,mp4a.40.2"',
    'video/mp4;codecs="avc1.42E028,mp4a.40.2"',
  ]);
  assert.match(chooseMp4Type()!, /42E01E/);
});
