/**
 * bitrate-js — client-side HLS / adaptive-bitrate packager.
 *
 * Chunk, transcode and upload large videos entirely in the browser.
 * Rust/WASM does the muxing and manifests; WebCodecs does the encoding.
 *
 * @example
 * ```ts
 * import { HlsQueue } from "bitrate-js";
 * import { presignedAdapter } from "bitrate-js/adapters/presigned";
 *
 * const q = new HlsQueue({
 *   mode: "remux",
 *   upload: presignedAdapter({ getUrl: (n) => fetch(`/api/sign?f=${n}`).then(r => r.text()) }),
 * });
 * q.add([file1, file2]);
 * const report = await q.drain();
 * ```
 */

export type {
  Rung,
  UploadItem,
  UploadAdapter,
  PackageMode,
  Container,
  PackagerOptions,
  JobProgress,
  JobResult,
  JobFailure,
  QueueReport,
} from "./types.js";

export { MIME_MANIFEST, MIME_SEGMENT } from "./types.js";

export { remux, inspect } from "./remux.js";
export type { OutputFile, RemuxOptions, SourceInfo } from "./remux.js";

export { HlsQueue } from "./queue.js";
export type { HlsQueueOptions, JobStatus, QueueJob, ResumeRequest } from "./queue.js";

export {
  JobStore,
  isStorageAvailable,
  matchesJob,
  checkQuota,
  requestPersistence,
  assertRoomFor,
} from "./storage.js";
export type { StoredJob, StoredSegment, QuotaReport } from "./storage.js";

export { withRetry, PermanentUploadError, joinKey, assertSafeKey } from "./upload.js";
export type { RetryOptions } from "./upload.js";

export { ensureWasm } from "./wasm-loader.js";

/** What the environment must provide for each mode. */
export interface SupportReport {
  /** Chunking an already-encoded file. Needs only WASM + File APIs. */
  remux: boolean;
  /** Re-encoding into an ABR ladder. Needs WebCodecs. */
  transcode: boolean;
  /** Resuming interrupted jobs across reloads. Needs IndexedDB. */
  resume: boolean;
  /** One-click resume without re-picking the file. Needs File System Access API. */
  seamlessResume: boolean;
  /** Human-readable reasons for anything unsupported. */
  reasons: string[];
}

/**
 * Feature-detect what this browser can do.
 *
 * Call before starting work so you can steer users to `remux` (widely supported)
 * rather than failing mid-job in `transcode`.
 */
export function isSupported(): SupportReport {
  const reasons: string[] = [];

  const hasWasm = typeof WebAssembly === "object";
  if (!hasWasm) reasons.push("WebAssembly is unavailable.");

  const hasFile = typeof Blob !== "undefined" && typeof File !== "undefined";
  if (!hasFile) reasons.push("File/Blob APIs are unavailable.");

  const hasWebCodecs =
    typeof globalThis.VideoEncoder === "function" &&
    typeof globalThis.VideoDecoder === "function";
  if (!hasWebCodecs) {
    reasons.push("WebCodecs is unavailable — transcoding is not possible; use mode 'remux'.");
  }

  const hasIdb = typeof indexedDB !== "undefined";
  if (!hasIdb) reasons.push("IndexedDB is unavailable — interrupted jobs cannot resume.");

  const hasFsa = typeof (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";
  if (!hasFsa) {
    reasons.push("File System Access API is unavailable — resuming will ask the user to re-pick the file.");
  }

  const remux = hasWasm && hasFile;
  return {
    remux,
    transcode: remux && hasWebCodecs,
    resume: hasIdb,
    seamlessResume: hasFsa,
    reasons,
  };
}

export {
  transcode,
  packageFrames,
  isTranscodeSupported,
  planLadder,
  codecStringFromAvcC,
  levelForFrame,
  DEFAULT_LADDER,
} from "./transcode.js";
export type { TranscodeOptions } from "./transcode.js";

// Saving a whole rendition as one archive is a common need for anything that
// lets a user download the result. Tiny, and also available at `bitrate-js/zip`.
export { createZip, downloadZip, crc32 } from "./zip.js";
export type { ZipEntry } from "./zip.js";
