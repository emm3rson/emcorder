export type RecordingInspection = { duration: number; seekable: boolean; message: string };

const CHECK_TIMEOUT_MS = 15_000;

/** Loads a recorded file and verifies metadata plus a real midpoint seek. */
export function inspectRecording(url: string, signal?: AbortSignal): Promise<RecordingInspection> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    let timer: number | undefined;

    const finish = (result: RecordingInspection): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      video.pause();
      video.removeAttribute("src");
      video.load();
      resolve(result);
    };

    const onAbort = (): void => finish({ duration: 0, seekable: false, message: "Recording inspection cancelled." });

    const onError = (): void => finish({
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      seekable: false,
      message: "The recording could not be opened for playback.",
    });

    const onSeeked = (): void => {
      const duration = video.duration;
      const target = duration / 2;
      const seekable = Number.isFinite(duration) && duration > 0 && Math.abs(video.currentTime - target) < 1;
      finish({
        duration: Number.isFinite(duration) ? duration : 0,
        seekable,
        message: seekable
          ? "MP4 metadata loaded and midpoint seeking works."
          : "The recording loaded, but seeking to its midpoint did not complete correctly.",
      });
    };

    const onMetadata = (): void => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        finish({ duration: 0, seekable: false, message: "The recording has no valid duration." });
        return;
      }
      video.addEventListener("seeked", onSeeked, { once: true });
      try {
        video.currentTime = duration / 2;
      } catch {
        finish({ duration, seekable: false, message: "The recording duration loaded, but seeking is unavailable." });
      }
    };

    video.addEventListener("loadedmetadata", onMetadata, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = window.setTimeout(() => finish({
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      seekable: false,
      message: "Timed out while checking the recording metadata and seek support.",
    }), CHECK_TIMEOUT_MS);
    video.src = url;
  });
}
