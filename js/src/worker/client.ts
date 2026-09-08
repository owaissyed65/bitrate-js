/**
 * Transcoding on a worker thread, with the same shape as doing it on the main
 * one.
 *
 * `transcodeInWorker(file, options)` is an async generator yielding the same
 * `OutputFile`s as {@link transcode}, so swapping one for the other is a
 * one-word change. What differs is that the tab stays responsive, and that a
 * backgrounded tab keeps encoding at full speed rather than being throttled.
 */

import type { OutputFile } from "../remux.js";
import type { TranscodeOptions } from "../transcode.js";
import type { FromWorker, ToWorker, WorkerTranscodeOptions } from "./protocol.js";

export interface WorkerTranscodeArgs extends TranscodeOptions {
  /**
   * Use an existing worker instead of spawning one.
   *
   * Spawning costs a module load and a WASM instantiation, so a queue running
   * many files should create one worker and pass it in each time.
   */
  worker?: Worker;
}

/** Whether this browser can transcode on a worker thread. */
export function isWorkerTranscodeSupported(): boolean {
  return typeof Worker === "function" && typeof globalThis.VideoEncoder === "function";
}

/**
 * Spawn a transcode worker.
 *
 * Exposed so a caller processing several files can pay the startup cost once.
 * Terminate it when finished.
 *
 * @example
 * ```ts
 * const worker = createTranscodeWorker();
 * try {
 *   for (const file of files) {
 *     for await (const out of transcodeInWorker(file, { worker })) await upload(out);
 *   }
 * } finally {
 *   worker.terminate();
 * }
 * ```
 */
export function createTranscodeWorker(): Worker {
  // Bundlers detect this exact pattern statically and emit the worker as its
  // own chunk. Written any other way — a variable URL, a string concat — it is
  // not analysable and silently fails to bundle.
  return new Worker(new URL("./transcode.worker.js", import.meta.url), { type: "module" });
}

let nextId = 1;

/**
 * Re-encode `file` into an HLS ladder on a worker thread.
 *
 * @example
 * ```ts
 * for await (const out of transcodeInWorker(file, { ladder: LADDERS.standard })) {
 *   await upload(out.name, out.blob, out.contentType);
 * }
 * ```
 */
export async function* transcodeInWorker(
  file: Blob,
  options: WorkerTranscodeArgs = {},
): AsyncGenerator<OutputFile> {
  if (!isWorkerTranscodeSupported()) {
    throw new Error(
      "Transcoding on a worker needs Web Workers and WebCodecs, which this browser does not provide.",
    );
  }

  const { worker: provided, signal, onProgress, onPhase, onSegment, ...rest } = options;

  const worker = provided ?? createTranscodeWorker();
  const owned = provided === undefined;
  const id = nextId++;

  const send = (message: ToWorker) => worker.postMessage(message);

  /** Files delivered but not yet yielded — at most one, by the pull protocol. */
  const inbox: OutputFile[] = [];
  let finished = false;
  let failure: Error | null = null;

  /** Resolved whenever anything arrives that the generator might be waiting on. */
  let wake: (() => void) | null = null;
  const nudge = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const onMessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message.type === "ready") return;
    // One worker may be shared across files, so ignore other jobs' traffic.
    if (!("id" in message) || message.id !== id) return;

    switch (message.type) {
      case "file":
        inbox.push({
          name: message.name,
          blob: message.blob,
          contentType: message.contentType as OutputFile["contentType"],
          isManifest: message.isManifest,
        });
        break;
      case "progress":
        onProgress?.({
          processed: message.processed,
          total: message.total,
          fraction: message.fraction,
        });
        return; // no yield is waiting on this
      case "phase":
        onPhase?.(message.phase);
        return;
      case "segment":
        onSegment?.({
          index: message.index,
          duration: message.duration,
          samplesProcessed: message.samplesProcessed,
          audioSamplesProcessed: message.audioSamplesProcessed,
          resumeAtMicros: message.resumeAtMicros,
        });
        return;
      case "done":
        finished = true;
        break;
      case "error": {
        const error = new Error(message.message);
        error.name = message.name;
        failure = error;
        finished = true;
        break;
      }
    }
    nudge();
  };

  /**
   * A worker that cannot be loaded never sends a message, so without this the
   * generator waits forever on a file that is never coming. That is exactly how
   * a wrong output path presented itself: a silent hang, no error anywhere.
   */
  const onError = (event: ErrorEvent | Event) => {
    const detail = "message" in event && event.message ? event.message : "the worker failed to load";
    failure = new Error(
      `Transcode worker error: ${detail}. If this package is being served without a bundler, ` +
        `check that transcode.worker.js sits next to the module importing it.`,
    );
    finished = true;
    nudge();
  };

  const onAbort = () => {
    send({ type: "cancel", id });
    failure = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
    finished = true;
    nudge();
  };

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onError);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    signal?.throwIfAborted();
    send({ type: "start", id, file, options: rest as WorkerTranscodeOptions });

    for (;;) {
      while (inbox.length === 0 && !finished) {
        await new Promise<void>((resolve) => (wake = resolve));
      }

      if (inbox.length > 0) {
        const output = inbox.shift()!;
        yield output;
        // Only now does the worker resume, which is what keeps exactly one
        // file in flight and memory flat.
        send({ type: "pull", id });
        continue;
      }

      if (failure) throw failure;
      return;
    }
  } finally {
    // A consumer that breaks out of the loop early lands here too, so the
    // worker must be told to stop rather than left encoding into nothing.
    if (!finished) send({ type: "cancel", id });
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
    worker.removeEventListener("messageerror", onError);
    signal?.removeEventListener("abort", onAbort);
    if (owned) worker.terminate();
  }
}
