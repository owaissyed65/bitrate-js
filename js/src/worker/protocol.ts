/**
 * The messages that cross between the page and the transcode worker.
 *
 * Kept in its own module because both sides import it, and a mismatch between
 * them is the kind of bug that only shows up at runtime in a thread you cannot
 * put a breakpoint in.
 *
 * What can and cannot cross matters here:
 *
 * - `Blob` and `File` are structured-cloneable and cheap — they are references
 *   to storage, not copies of the bytes. Output goes back as Blobs.
 * - `AbortSignal` is **not** cloneable, so cancellation is its own message.
 * - Functions are not cloneable, so `onProgress`, `onPhase` and `onSegment`
 *   become messages rather than callbacks.
 * - `Error` survives cloning but loses its subclass, so failures cross as plain
 *   fields and are rebuilt on the other side.
 */

import type { TranscodeOptions, TranscodePhase } from "../transcode.js";
import type { Rung } from "../types.js";

/** The options that survive being cloned into a worker. */
export type WorkerTranscodeOptions = Omit<
  TranscodeOptions,
  "signal" | "onProgress" | "onPhase" | "onSegment"
> & { ladder?: Rung[] };

/** Page -> worker. */
export type ToWorker =
  | { type: "start"; id: number; file: Blob; options: WorkerTranscodeOptions }
  /**
   * Ask for the next file.
   *
   * The worker holds after every file until this arrives. Without it the worker
   * would post every segment as fast as it could produce them while the page
   * was still uploading the first, and memory would grow with the length of the
   * video rather than staying flat.
   */
  | { type: "pull"; id: number }
  | { type: "cancel"; id: number };

/** Worker -> page. */
export type FromWorker =
  | { type: "ready" }
  | {
      type: "file";
      id: number;
      name: string;
      blob: Blob;
      contentType: string;
      isManifest: boolean;
    }
  | { type: "progress"; id: number; processed: number; total: number; fraction: number }
  | { type: "phase"; id: number; phase: TranscodePhase }
  | {
      type: "segment";
      id: number;
      index: number;
      duration: number;
      samplesProcessed: number;
      audioSamplesProcessed: number;
      resumeAtMicros: number;
    }
  | { type: "done"; id: number }
  | { type: "error"; id: number; message: string; name: string };
