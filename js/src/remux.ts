/**
 * Remux mode — chunk an already-encoded MP4 into seekable HLS.
 *
 * No decoding or re-encoding happens: frames are copied verbatim from the
 * source into fMP4 segments. That makes it near-instant even for a 1 GB file,
 * and it works in any browser with WASM — no WebCodecs required (PLAN.md §3d).
 *
 * Output is produced as an async stream so callers can upload and discard each
 * file as it appears, keeping memory flat regardless of input size.
 */

import { MIME_MANIFEST, MIME_SEGMENT, type UploadItem } from "./types.js";
import { readMoov, readSamples, type SampleLocation } from "./mp4-source.js";
import { ensureWasm } from "./wasm-loader.js";
import { Fmp4Segmenter, Mp4Demuxer } from "./wasm/bitrate_core.js";

/** A file produced by the packager, ready to upload. */
export type OutputFile = Omit<UploadItem, "jobId">;

export interface RemuxOptions {
  /** Base name for output files, e.g. `"720p"`. Default `"video"`. */
  prefix?: string;
  /** Minimum segment length in seconds. Default 6. */
  segmentDuration?: number;
  /** Bytes to coalesce per read. Larger is faster but uses more memory. */
  readWindow?: number;
  /** Cancels the operation; the generator stops at the next sample boundary. */
  signal?: AbortSignal;
  /** Reports progress as a 0–1 fraction of samples processed. */
  onProgress?: (progress: { processed: number; total: number; fraction: number }) => void;
  /**
   * Continue an interrupted run instead of starting over.
   *
   * Supply the durations of the segments already produced, in order, and the
   * number of samples they consumed. Skipped work is not redone (PLAN.md §3e).
   */
  resume?: ResumeState;
  /**
   * Called as each segment completes, so the caller can persist progress and
   * be able to resume later. Receives everything {@link ResumeState} needs.
   */
  onSegment?: (info: { index: number; duration: number; samplesProcessed: number }) => void;
}

/** Where a previous run stopped. */
export interface ResumeState {
  /** Durations of already-produced segments, in index order. */
  completedSegmentDurations: readonly number[];
  /** How many source samples those segments consumed. */
  samplesProcessed: number;
}

/** What the source turned out to contain. */
export interface SourceInfo {
  width: number;
  height: number;
  timescale: number;
  sampleCount: number;
  /** Duration in seconds. */
  duration: number;
}

/** Inspect a source without packaging it — useful for validation and UI. */
export async function inspect(file: Blob): Promise<SourceInfo> {
  await ensureWasm();
  const moov = await readMoov(file);
  const demuxer = new Mp4Demuxer(moov);
  try {
    return {
      width: demuxer.width,
      height: demuxer.height,
      timescale: demuxer.timescale,
      sampleCount: demuxer.sampleCount,
      duration: demuxer.duration,
    };
  } finally {
    demuxer.free();
  }
}

/**
 * Package `file` into HLS, yielding each output file as it is produced.
 *
 * Yields, in order: the init segment, each media segment, then the playlist
 * (last, because it can only be finalized once every segment duration is known).
 *
 * @example
 * ```ts
 * for await (const out of remux(file, { prefix: "720p" })) {
 *   await upload(out.name, out.blob, out.contentType);
 * }
 * ```
 */
export async function* remux(file: Blob, options: RemuxOptions = {}): AsyncGenerator<OutputFile> {
  const { prefix = "video", segmentDuration = 6, readWindow, signal, onProgress, onSegment, resume } =
    options;

  await ensureWasm();
  signal?.throwIfAborted();

  const moov = await readMoov(file);
  const demuxer = new Mp4Demuxer(moov);

  let segmenter: Fmp4Segmenter | undefined;
  try {
    segmenter = new Fmp4Segmenter(
      prefix,
      demuxer.timescale,
      demuxer.width,
      demuxer.height,
      demuxer.codecConfig,
      segmentDuration,
    );

    // The init segment is identical on a resume, but re-emitting it is cheap
    // and makes a resumed run self-contained if the first upload never landed.
    yield {
      name: segmenter.initName(),
      blob: new Blob([segmenter.initSegment() as BlobPart], { type: MIME_SEGMENT }),
      contentType: MIME_SEGMENT,
      isManifest: false,
    };

    const allSamples = buildSampleList(demuxer);
    // The index is all we keep from the demuxer; release its WASM memory now
    // rather than holding it for the whole packaging run.
    demuxer.free();

    // Replay what a previous run finished so numbering, the playlist and the
    // decode timeline all continue rather than restarting.
    let skipped = 0;
    if (resume) {
      for (const duration of resume.completedSegmentDurations) {
        segmenter.restoreSegment(duration);
      }
      skipped = Math.min(Math.max(resume.samplesProcessed, 0), allSamples.length);
    }
    const samples = skipped > 0 ? allSamples.slice(skipped) : allSamples;

    let processed = skipped;
    const total = allSamples.length;

    for await (const { sample, data } of readSamples(file, samples, { readWindow, signal })) {
      segmenter.pushSample(data, sample.duration, sample.isSync, sample.compositionOffset);

      // Drain eagerly so finished segments are handed over (and freed) as soon
      // as they exist, instead of accumulating until the end.
      //
      // `processed` is reported *before* the increment on purpose: a segment is
      // closed by the keyframe that starts the *next* one, so the segment just
      // finished contains only the samples before the current sample. Reporting
      // the post-increment count would make a resume skip that keyframe.
      yield* drain(segmenter, processed, onSegment);

      processed++;
      if (onProgress && processed % 100 === 0) {
        onProgress({ processed, total, fraction: processed / total });
      }
    }

    segmenter.finish();
    yield* drain(segmenter, processed, onSegment);

    onProgress?.({ processed, total, fraction: 1 });

    yield {
      name: segmenter.playlistName(),
      blob: new Blob([segmenter.playlistText()], { type: MIME_MANIFEST }),
      contentType: MIME_MANIFEST,
      isManifest: true,
    };
  } finally {
    // WASM objects are not garbage collected; free them on every path,
    // including an abort or a caller that stops consuming the generator.
    segmenter?.free();
    safeFree(demuxer);
  }
}

/** Hand over every finished segment the segmenter is holding. */
function* drain(
  segmenter: Fmp4Segmenter,
  samplesProcessed: number,
  onSegment: RemuxOptions["onSegment"],
): Generator<OutputFile> {
  for (;;) {
    const segment = segmenter.takeSegment();
    if (!segment) return;
    const index = segment.index;
    const duration = segment.duration;
    try {
      yield {
        name: segmenter.segmentName(index),
        blob: new Blob([segment.data as BlobPart], { type: MIME_SEGMENT }),
        contentType: MIME_SEGMENT,
        isManifest: false,
      };
    } finally {
      segment.free();
    }
    // Reported after the yield so a caller persisting progress only records a
    // segment the consumer has actually received.
    onSegment?.({ index, duration, samplesProcessed });
  }
}

/**
 * Transpose the demuxer's parallel arrays into per-sample records.
 *
 * The WASM side returns typed arrays rather than objects because a two-hour
 * video has ~200k samples, and one boundary crossing per sample would dominate
 * the runtime.
 */
function buildSampleList(demuxer: Mp4Demuxer): SampleLocation[] {
  const offsets = demuxer.sampleOffsets();
  const sizes = demuxer.sampleSizes();
  const durations = demuxer.sampleDurations();
  const sync = demuxer.sampleSyncFlags();
  const cts = demuxer.sampleCompositionOffsets();

  const out: SampleLocation[] = new Array(offsets.length);
  for (let i = 0; i < offsets.length; i++) {
    out[i] = {
      offset: offsets[i]!,
      size: sizes[i]!,
      duration: durations[i]!,
      isSync: sync[i] === 1,
      compositionOffset: cts[i]!,
    };
  }
  return out;
}

/** Free a WASM object that may already have been freed. */
function safeFree(obj: { free: () => void }): void {
  try {
    obj.free();
  } catch {
    // Already freed on the happy path; nothing to do.
  }
}
