/**
 * The worker side of transcoding.
 *
 * This file is the worker's entry point. It is bundled separately and loaded
 * with `new Worker(new URL("./transcode.worker.js", import.meta.url))`, which
 * every modern bundler understands statically — so consumers need no
 * configuration, which is the whole promise of the package.
 *
 * Everything here runs off the main thread. WebCodecs and WebAssembly are both
 * available in a worker, and a worker escapes the timer throttling a background
 * tab suffers — measured at ~170x on a hidden page — so switching tabs no
 * longer slows an encode to a crawl.
 */

import { transcode } from "../transcode.js";
import type { FromWorker, ToWorker, WorkerTranscodeOptions } from "./protocol.js";

/** Cancellation, per job, since AbortSignal cannot be cloned across threads. */
const running = new Map<number, AbortController>();

/**
 * Per job, the resolver waiting for the page to ask for the next file.
 *
 * Without this the worker would run flat out and post every segment as it was
 * produced, while the page was still uploading the first one. The messages
 * would queue, every Blob would be held at once, and memory would grow with the
 * length of the video — exactly the thing streaming output exists to avoid.
 */
const pulls = new Map<number, () => void>();

const post = (message: FromWorker) => (self as unknown as Worker).postMessage(message);

/** Wait until the page asks for another file. */
function awaitPull(id: number): Promise<void> {
  return new Promise((resolve) => pulls.set(id, resolve));
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;

  switch (message.type) {
    case "start":
      void run(message.id, message.file, message.options);
      break;

    case "pull": {
      const resolve = pulls.get(message.id);
      pulls.delete(message.id);
      resolve?.();
      break;
    }

    case "cancel": {
      running.get(message.id)?.abort();
      // A cancelled job may be parked waiting for a pull that will never come.
      const resolve = pulls.get(message.id);
      pulls.delete(message.id);
      resolve?.();
      break;
    }
  }
};

async function run(id: number, file: Blob, options: WorkerTranscodeOptions): Promise<void> {
  const controller = new AbortController();
  running.set(id, controller);

  try {
    const stream = transcode(file, {
      ...options,
      signal: controller.signal,
      onProgress: ({ processed, total, fraction }) =>
        post({ type: "progress", id, processed, total, fraction }),
      onPhase: (phase) => post({ type: "phase", id, phase }),
      onSegment: (info) => post({ type: "segment", id, ...info }),
    });

    for await (const output of stream) {
      // A Blob crossing a thread boundary is a reference, not a copy of the
      // bytes, so handing segments back costs almost nothing.
      post({
        type: "file",
        id,
        name: output.name,
        blob: output.blob,
        contentType: output.contentType,
        isManifest: output.isManifest,
      });

      // One file in flight at a time.
      await awaitPull(id);
      controller.signal.throwIfAborted();
    }

    post({ type: "done", id });
  } catch (error) {
    // An Error survives cloning but loses its subclass, so send the parts and
    // let the page rebuild something useful.
    const err = error instanceof Error ? error : new Error(String(error));
    post({ type: "error", id, message: err.message, name: err.name });
  } finally {
    running.delete(id);
    pulls.delete(id);
  }
}

post({ type: "ready" });
