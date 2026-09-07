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
import { readFragments, readMoov, readSamples, type SampleLocation } from "./mp4-source.js";
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
  onSegment?: (info: {
    index: number;
    duration: number;
    samplesProcessed: number;
    audioSamplesProcessed: number;
  }) => void;
}

/** Where a previous run stopped. */
export interface ResumeState {
  /** Durations of already-produced segments, in index order. */
  completedSegmentDurations: readonly number[];
  /** How many video samples those segments consumed. */
  samplesProcessed: number;
  /**
   * How many audio frames those segments consumed.
   *
   * Recorded rather than derived from elapsed time: the two tracks have
   * different frame rates, so any time-based estimate would drop or duplicate
   * a frame at the resume point.
   */
  audioSamplesProcessed?: number;
}

/** What the source turned out to contain. */
export interface SourceInfo {
  width: number;
  height: number;
  timescale: number;
  sampleCount: number;
  /** Duration in seconds. */
  duration: number;
  /** Whether the source carries an audio track that will be carried through. */
  hasAudio: boolean;
  /** Audio sample rate, or 0 when silent. */
  audioTimescale: number;
  /** Number of audio frames, or 0 when silent. */
  audioSampleCount: number;
  /** Audio channel count, or 0 when silent or not AAC. */
  audioChannels: number;
  /** Bytes of AudioSpecificConfig, which transcoding needs in order to decode. */
  audioConfigBytes: number;
}

/**
 * Open a source and return a demuxer with its sample index populated.
 *
 * A fragmented file keeps its samples in `moof` boxes rather than the sample
 * tables, so those are walked and fed in before the index is usable.
 */
async function openDemuxer(
  file: Blob,
  signal?: AbortSignal | undefined,
): Promise<Mp4Demuxer> {
  const moov = await readMoov(file);
  const demuxer = new Mp4Demuxer(moov);

  if (demuxer.isFragmented) {
    let fragments = 0;
    try {
      for await (const fragment of readFragments(file, { signal })) {
        demuxer.addFragment(fragment.bytes, fragment.offset);
        fragments++;
      }
    } catch (error) {
      demuxer.free();
      throw error;
    }

    if (demuxer.sampleCount === 0) {
      demuxer.free();
      throw new Error(
        fragments === 0
          ? "This file declares fragmented media but contains no 'moof' boxes, so it has no samples to package."
          : `Read ${fragments} fragments but found no video samples in them. The file may be truncated.`,
      );
    }
  }

  return demuxer;
}

/** Inspect a source without packaging it — useful for validation and UI. */
export async function inspect(file: Blob): Promise<SourceInfo> {
  await ensureWasm();
  const demuxer = await openDemuxer(file);
  try {
    return {
      width: demuxer.width,
      height: demuxer.height,
      timescale: demuxer.timescale,
      sampleCount: demuxer.sampleCount,
      duration: demuxer.duration,
      hasAudio: demuxer.hasAudio,
      audioTimescale: demuxer.audioTimescale,
      audioSampleCount: demuxer.audioSampleCount,
      audioChannels: demuxer.audioChannels,
      audioConfigBytes: demuxer.audioSpecificConfig.length,
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

  const demuxer = await openDemuxer(file, signal);

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

    // Audio must be declared before the init segment, since it changes the moov.
    const hasAudio = demuxer.hasAudio;
    if (hasAudio) {
      segmenter.setAudio(demuxer.audioTimescale, demuxer.audioSampleEntry);
    }

    // The init segment is identical on a resume, but re-emitting it is cheap
    // and makes a resumed run self-contained if the first upload never landed.
    yield {
      name: segmenter.initName(),
      blob: new Blob([segmenter.initSegment() as BlobPart], { type: MIME_SEGMENT }),
      contentType: MIME_SEGMENT,
      isManifest: false,
    };

    const allSamples = buildSampleList(demuxer);
    const audioSamples = hasAudio ? buildAudioSampleList(demuxer) : [];
    const videoTimescale = demuxer.timescale;
    const audioTimescale = demuxer.audioTimescale;
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

    // Skip exactly the audio the earlier run consumed. The count is recorded at
    // checkpoint time rather than inferred from elapsed time, because the two
    // tracks advance at different rates and an estimate would drop or duplicate
    // a frame right at the join.
    const audioSkipped = Math.min(
      Math.max(resume?.audioSamplesProcessed ?? 0, 0),
      audioSamples.length,
    );
    const audioForRun = audioSkipped > 0 ? audioSamples.slice(audioSkipped) : audioSamples;

    // Continue the audio timeline exactly where it stopped. Segment durations
    // cannot imply this — a 1s segment does not hold a whole number of audio
    // frames — so the tick count is carried across explicitly.
    const audioTicksSkipped = audioSamples
      .slice(0, audioSkipped)
      .reduce((t, s) => t + s.duration, 0);
    if (hasAudio && audioTicksSkipped > 0) {
      segmenter.restoreAudioTime(audioTicksSkipped);
    }

    let processed = skipped;
    let audioProcessed = audioSkipped;
    const total = allSamples.length;

    const stream = hasAudio
      ? mergeTracks(file, samples, videoTimescale, audioForRun, audioTimescale, {
          readWindow,
          signal,
          startVideoTime:
            allSamples.slice(0, skipped).reduce((t, s) => t + s.duration, 0) / videoTimescale,
          startAudioTime:
            audioSamples.slice(0, audioSkipped).reduce((t, s) => t + s.duration, 0) /
            audioTimescale,
        })
      : videoOnly(file, samples, { readWindow, signal });

    for await (const { track, sample, data } of stream) {
      if (track === "audio") {
        segmenter.pushAudioSample(data, sample.duration);
        audioProcessed++;
        continue;
      }

      segmenter.pushSample(data, sample.duration, sample.isSync, sample.compositionOffset);

      // Drain eagerly so finished segments are handed over (and freed) as soon
      // as they exist, instead of accumulating until the end.
      //
      // `processed` is reported *before* the increment on purpose: a segment is
      // closed by the keyframe that starts the *next* one, so the segment just
      // finished contains only the samples before the current sample. Reporting
      // the post-increment count would make a resume skip that keyframe.
      yield* drain(segmenter, processed, audioProcessed, onSegment);

      processed++;
      if (onProgress && processed % 100 === 0) {
        onProgress({ processed, total, fraction: processed / total });
      }
    }

    segmenter.finish();
    yield* drain(segmenter, processed, audioProcessed, onSegment);

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
  audioSamplesProcessed: number,
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
    onSegment?.({ index, duration, samplesProcessed, audioSamplesProcessed });
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

/** The audio track's sample locations, in decode order. */
function buildAudioSampleList(demuxer: Mp4Demuxer): SampleLocation[] {
  const offsets = demuxer.audioSampleOffsets();
  const sizes = demuxer.audioSampleSizes();
  const durations = demuxer.audioSampleDurations();

  const out: SampleLocation[] = new Array(offsets.length);
  for (let i = 0; i < offsets.length; i++) {
    out[i] = {
      offset: offsets[i]!,
      size: sizes[i]!,
      duration: durations[i]!,
      // Every audio frame is independently decodable.
      isSync: true,
      compositionOffset: 0,
    };
  }
  return out;
}

/** Adapt a single-track read into the merged shape, for silent sources. */
async function* videoOnly(
  file: Blob,
  samples: readonly SampleLocation[],
  options: { readWindow?: number | undefined; signal?: AbortSignal | undefined },
): AsyncGenerator<MergedSample> {
  for await (const { sample, data } of readSamples(file, samples, options)) {
    yield { track: "video", sample, data };
  }
}

/** One sample from either track, tagged with its track and time. */
interface MergedSample {
  track: "video" | "audio";
  sample: SampleLocation;
  data: Uint8Array;
}

/**
 * Interleave two tracks by decode time, without giving up sequential reads.
 *
 * A naive merge would alternate between distant file offsets and defeat the
 * read coalescing in `readSamples`. Instead each track is read by its own
 * sequential iterator and only the *emission order* is interleaved, so both
 * tracks stream forwards while audio still reaches the segmenter before the
 * video segment it belongs to closes.
 */
async function* mergeTracks(
  file: Blob,
  video: readonly SampleLocation[],
  videoTimescale: number,
  audio: readonly SampleLocation[],
  audioTimescale: number,
  options: {
    readWindow?: number | undefined;
    signal?: AbortSignal | undefined;
    /** Elapsed time already consumed, so a resumed run keeps the same phase. */
    startVideoTime?: number;
    startAudioTime?: number;
  },
): AsyncGenerator<MergedSample> {
  const videoIter = readSamples(file, video, options)[Symbol.asyncIterator]();
  const audioIter = readSamples(file, audio, options)[Symbol.asyncIterator]();

  let videoNext = await videoIter.next();
  let audioNext = await audioIter.next();
  // Seeded rather than zeroed: interleaving depends on the *relative* position
  // of the two clocks, so a resume that restarted them at zero would order the
  // first few samples differently and shift a frame between segments.
  let videoTime = options.startVideoTime ?? 0;
  let audioTime = options.startAudioTime ?? 0;

  while (!videoNext.done || !audioNext.done) {
    // Emit whichever track is further behind, so neither runs ahead of the
    // other by more than one sample.
    const takeAudio = !audioNext.done && (videoNext.done || audioTime <= videoTime);

    if (takeAudio && !audioNext.done) {
      const { sample, data } = audioNext.value;
      yield { track: "audio", sample, data };
      audioTime += sample.duration / audioTimescale;
      audioNext = await audioIter.next();
    } else if (!videoNext.done) {
      const { sample, data } = videoNext.value;
      yield { track: "video", sample, data };
      videoTime += sample.duration / videoTimescale;
      videoNext = await videoIter.next();
    }
  }
}

/** Free a WASM object that may already have been freed. */
function safeFree(obj: { free: () => void }): void {
  try {
    obj.free();
  } catch {
    // Already freed on the happy path; nothing to do.
  }
}
