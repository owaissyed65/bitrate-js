/**
 * Public types for `bitrate-js`.
 *
 * See PLAN.md §3 for the API design and SECURITY.md §1 for why upload adapters
 * never accept credentials.
 */

/** MIME types the packager emits. */
export const MIME_MANIFEST = "application/vnd.apple.mpegurl";
export const MIME_SEGMENT = "video/mp4";

/** One rung of the adaptive-bitrate ladder. */
export interface Rung {
  /** Target height in pixels, e.g. 1080. Never upscaled beyond the source. */
  height: number;
  /** Target bitrate in bits per second, e.g. 5_000_000. */
  bitrate: number;
}

/**
 * A single file produced by the packager, handed to an {@link UploadAdapter}.
 *
 * The shape is identical for every storage provider — it is always
 * "store these bytes at this path with this content type".
 */
export interface UploadItem {
  /** Which source video this belongs to. */
  jobId: string;
  /** Sanitized relative path/filename, e.g. `1080p_00001.m4s`. */
  name: string;
  /** The bytes. */
  blob: Blob;
  /** Correct MIME type — required for playback to work. */
  contentType: typeof MIME_MANIFEST | typeof MIME_SEGMENT;
  /** True for `.m3u8` playlists, so callers can apply a shorter cache TTL. */
  isManifest: boolean;
}

/**
 * The upload contract — implement this to send output anywhere.
 *
 * SECURITY: never close over long-lived cloud credentials here. Use an
 * app-owned authenticated client, or a short-lived pre-signed URL fetched
 * from your backend. See SECURITY.md §1.
 */
export type UploadAdapter = (item: UploadItem) => Promise<void>;

/** How much work the packager does per file. */
export type PackageMode =
  /** Chunk an already-encoded file into HLS without re-encoding. Near-instant. */
  | "remux"
  /** Decode and re-encode into a full ABR ladder. Slower, produces multiple qualities. */
  | "transcode"
  /** Use `remux` when the source is already suitable, otherwise `transcode`. */
  | "auto";

/** Segment container format. */
export type Container = "fmp4" | "ts";

export interface PackagerOptions {
  /** ABR ladder. Ignored in `remux` mode. */
  ladder?: Rung[];
  /** Target segment length in seconds. Default 6. */
  segmentDuration?: number;
  /** Output container. Default `"fmp4"` (`.m4s`). */
  container?: Container;
  /** Default `"auto"`. */
  mode?: PackageMode;
}

export interface JobProgress {
  jobId: string;
  /** Which ladder rung is being produced, or `null` in remux mode. */
  rung: number | null;
  /** 0–100. */
  percent: number;
  /** Estimated seconds remaining, when known. */
  etaSeconds?: number;
  /**
   * What the job is doing, for a caller that wants to say so.
   *
   * `percent` covers video encoding only. A transcode spends real time before
   * that — indexing a fragmented source reads the whole file, and the audio is
   * re-encoded in full first — and reporting 0% throughout looks like a hang.
   * `stage` names that work; `detail` is a line fit to show as-is.
   */
  stage?: "reading" | "packaging" | "audio" | "encoding" | "finishing" | "uploading";
  detail?: string;
  /** How far through the current stage, 0–100, where that is knowable. */
  stagePercent?: number;
}

export interface JobResult {
  jobId: string;
  /** Relative path of the ROOT playlist to hand a player, e.g. `master.m3u8`. */
  masterPlaylist: string;
  /** Every file produced, in upload order. */
  files: string[];
}

export interface JobFailure {
  jobId: string;
  error: Error;
}

/** Outcome of draining a queue — failures never abort the batch. */
export interface QueueReport {
  succeeded: JobResult[];
  failed: JobFailure[];
}
