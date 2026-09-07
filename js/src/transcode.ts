/**
 * Transcode mode — re-encode video into an adaptive-bitrate HLS ladder.
 *
 * WebCodecs does the codec work (hardware-accelerated where available) and the
 * Rust core packages the results. The source is decoded **once** and fanned out
 * to every rung's encoder, rather than decoding per rung — that alone is
 * roughly an Nx saving on an N-rung ladder (PLAN.md §3d).
 *
 * Requires WebCodecs. Check {@link isTranscodeSupported} first and fall back to
 * `remux` where it is missing.
 */

import { MIME_MANIFEST, MIME_SEGMENT, type Rung } from "./types.js";
import { readMoov, readSamples, type SampleLocation } from "./mp4-source.js";
import type { OutputFile } from "./remux.js";
import { ensureWasm } from "./wasm-loader.js";
import { Fmp4Segmenter, Mp4Demuxer } from "./wasm/bitrate_core.js";

/** WebCodecs timestamps are microseconds, so the track timescale matches. */
const TIMESCALE = 1_000_000;

/**
 * Frames allowed in flight per encoder before we wait.
 *
 * Without this the decoder races ahead and every decoded frame piles up in
 * memory — the classic way a browser tab dies on a long video.
 */
const MAX_QUEUED_FRAMES = 8;

export interface TranscodeOptions {
  /**
   * The ABR ladder. Rungs taller than the source are dropped rather than
   * upscaled — upscaling costs time and storage and adds no quality.
   */
  ladder?: Rung[];
  /** Minimum segment length in seconds. Default 6. */
  segmentDuration?: number;
  /** Base name; each rung is named `<prefix>_<height>p`. Default `"video"`. */
  prefix?: string;
  /** Bytes coalesced per source read. */
  readWindow?: number | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((p: { processed: number; total: number; fraction: number }) => void) | undefined;
}

/** A sensible default ladder for 16:9 content. */
export const DEFAULT_LADDER: Rung[] = [
  { height: 1080, bitrate: 5_000_000 },
  { height: 720, bitrate: 2_800_000 },
  { height: 480, bitrate: 1_200_000 },
];

/** Whether this browser can transcode (as opposed to only remux). */
export function isTranscodeSupported(): boolean {
  return (
    typeof globalThis.VideoEncoder === "function" && typeof globalThis.VideoDecoder === "function"
  );
}

/**
 * Drop rungs that would upscale, and scale widths to preserve aspect ratio.
 *
 * Encoders require even dimensions for 4:2:0 chroma, so widths are rounded to
 * the nearest even number.
 */
export function planLadder(
  ladder: readonly Rung[],
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number; bitrate: number }[] {
  const usable = ladder.filter((r) => r.height <= sourceHeight);
  // If every rung is taller than the source, keep the source resolution at the
  // lowest requested bitrate rather than producing nothing.
  const rungs = usable.length > 0 ? usable : [{ height: sourceHeight, bitrate: lowestBitrate(ladder) }];

  return rungs
    .map((r) => {
      const height = even(r.height);
      const width = even(Math.round((sourceWidth * height) / sourceHeight));
      return { width, height, bitrate: r.bitrate };
    })
    .sort((a, b) => b.height - a.height);
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const lowestBitrate = (ladder: readonly Rung[]) =>
  ladder.reduce((min, r) => Math.min(min, r.bitrate), Number.POSITIVE_INFINITY) || 1_000_000;

/** One rung's encoder plus the segmenter it feeds. */
interface RungPipeline {
  name: string;
  width: number;
  height: number;
  bitrate: number;
  encoder: VideoEncoder;
  segmenter?: Fmp4Segmenter;
  /** Output waiting to be yielded to the caller. */
  pending: OutputFile[];
  error?: Error;
}

/**
 * Re-encode `file` into an HLS ladder, yielding output as it is produced.
 *
 * @example
 * ```ts
 * for await (const out of transcode(file, { ladder: DEFAULT_LADDER })) {
 *   await upload(out.name, out.blob);
 * }
 * ```
 */
export async function* transcode(
  file: Blob,
  options: TranscodeOptions = {},
): AsyncGenerator<OutputFile> {
  if (!isTranscodeSupported()) {
    throw new Error(
      "WebCodecs is unavailable in this browser; use mode 'remux' to chunk without re-encoding",
    );
  }

  const {
    ladder = DEFAULT_LADDER,
    segmentDuration = 6,
    prefix = "video",
    readWindow,
    signal,
    onProgress,
  } = options;

  await ensureWasm();
  signal?.throwIfAborted();

  const moov = await readMoov(file);
  const demuxer = new Mp4Demuxer(moov);

  const sourceWidth = demuxer.width;
  const sourceHeight = demuxer.height;
  const sourceTimescale = demuxer.timescale;
  const sourceConfig = demuxer.codecConfig;
  const samples = buildSampleList(demuxer);
  demuxer.free();

  const plan = planLadder(ladder, sourceWidth, sourceHeight);
  const rungs: RungPipeline[] = [];

  try {
    for (const rung of plan) {
      rungs.push(createRung(prefix, rung, segmentDuration));
    }

    // Configure every encoder up front so the first frame can fan out at once.
    for (const rung of rungs) {
      rung.encoder.configure({
        codec: "avc1.42e01e", // Baseline 3.0 — the most broadly decodable profile
        width: rung.width,
        height: rung.height,
        bitrate: rung.bitrate,
        // Force keyframes at segment boundaries so segments stay independent.
        latencyMode: "quality",
        avc: { format: "avc" },
      });
    }

    const decoder = createDecoder(sourceConfig, sourceWidth, sourceHeight);

    let processed = 0;
    let lastKeyframeUs = -Infinity;
    const segmentUs = segmentDuration * 1_000_000;

    const frames: VideoFrame[] = [];
    decoder.decoder.ondequeue = null;

    for await (const item of readSamples(file, samples, { readWindow, signal })) {
      signal?.throwIfAborted();
      // `readSamples` returns the element type it was given, so the decode time
      // travels with each sample.
      const sample = item.sample as SampleLocation & { decodeTime: number };
      const data = item.data;

      const timestampUs = Math.round((sample.decodeTime / sourceTimescale) * 1_000_000);
      decoder.decoder.decode(
        new EncodedVideoChunk({
          type: sample.isSync ? "key" : "delta",
          timestamp: timestampUs,
          duration: Math.round((sample.duration / sourceTimescale) * 1_000_000),
          data,
        }),
      );

      // Hand every decoded frame to each encoder, then release it. A VideoFrame
      // holds GPU/system memory and is not garbage collected.
      for (const frame of decoder.take()) {
        const forceKey = frame.timestamp - lastKeyframeUs >= segmentUs;
        if (forceKey) lastKeyframeUs = frame.timestamp;

        for (const rung of rungs) {
          rung.encoder.encode(frame, { keyFrame: forceKey });
        }
        frame.close();

        processed++;
        for (const rung of rungs) yield* drainRung(rung);

        await applyBackpressure(rungs, signal);
        if (onProgress && processed % 50 === 0) {
          onProgress({ processed, total: samples.length, fraction: processed / samples.length });
        }
      }
      frames.length = 0;
    }

    await decoder.decoder.flush();
    for (const frame of decoder.take()) {
      for (const rung of rungs) rung.encoder.encode(frame, { keyFrame: false });
      frame.close();
    }

    for (const rung of rungs) {
      await rung.encoder.flush();
      rung.segmenter?.finish();
      yield* drainRung(rung);

      if (rung.segmenter) {
        yield {
          name: rung.segmenter.playlistName(),
          blob: new Blob([rung.segmenter.playlistText()], { type: MIME_MANIFEST }),
          contentType: MIME_MANIFEST,
          isManifest: true,
        };
      }
    }

    onProgress?.({ processed, total: samples.length, fraction: 1 });

    // The master playlist references every rung and is what a player loads.
    yield {
      name: `${prefix}_master.m3u8`,
      blob: new Blob([buildMaster(prefix, rungs)], { type: MIME_MANIFEST }),
      contentType: MIME_MANIFEST,
      isManifest: true,
    };
  } finally {
    for (const rung of rungs) {
      try {
        if (rung.encoder.state !== "closed") rung.encoder.close();
      } catch {
        // Already closed.
      }
      rung.segmenter?.free();
    }
  }
}

/**
 * Package raw frames into an HLS ladder, without a source file.
 *
 * Useful when frames come from somewhere other than a video file — a canvas
 * animation, a `MediaStreamTrackProcessor`, screen capture — and it is the
 * encode half of {@link transcode} exposed on its own.
 *
 * Each frame is closed after encoding, since a `VideoFrame` holds
 * GPU/system memory that garbage collection will not reclaim.
 *
 * @example
 * ```ts
 * for await (const out of packageFrames(canvasFrames(), {
 *   ladder: [{ height: 360, bitrate: 800_000 }],
 * })) { … }
 * ```
 */
export async function* packageFrames(
  frames: AsyncIterable<VideoFrame> | Iterable<VideoFrame>,
  options: TranscodeOptions & { sourceWidth?: number; sourceHeight?: number } = {},
): AsyncGenerator<OutputFile> {
  if (!isTranscodeSupported()) {
    throw new Error("WebCodecs is unavailable in this browser");
  }

  const { ladder = DEFAULT_LADDER, segmentDuration = 6, prefix = "video", signal, onProgress } =
    options;

  await ensureWasm();

  const rungs: RungPipeline[] = [];
  let configured = false;
  let processed = 0;
  let lastKeyframeUs = -Infinity;
  const segmentUs = segmentDuration * 1_000_000;

  try {
    for await (const frame of frames as AsyncIterable<VideoFrame>) {
      try {
        signal?.throwIfAborted();

        // The ladder depends on the source size, which the first frame reveals.
        if (!configured) {
          const width = options.sourceWidth ?? frame.displayWidth;
          const height = options.sourceHeight ?? frame.displayHeight;
          for (const spec of planLadder(ladder, width, height)) {
            const rung = createRung(prefix, spec, segmentDuration);
            rung.encoder.configure({
              codec: "avc1.42e01e",
              width: spec.width,
              height: spec.height,
              bitrate: spec.bitrate,
              latencyMode: "quality",
              avc: { format: "avc" },
            });
            rungs.push(rung);
          }
          configured = true;
        }

        const forceKey = frame.timestamp - lastKeyframeUs >= segmentUs;
        if (forceKey) lastKeyframeUs = frame.timestamp;

        for (const rung of rungs) rung.encoder.encode(frame, { keyFrame: forceKey });
      } finally {
        frame.close();
      }

      processed++;
      for (const rung of rungs) yield* drainRung(rung);
      await applyBackpressure(rungs, signal);
      onProgress?.({ processed, total: processed, fraction: 0 });
    }

    for (const rung of rungs) {
      await rung.encoder.flush();
      rung.segmenter?.finish();
      yield* drainRung(rung);

      if (rung.segmenter) {
        yield {
          name: rung.segmenter.playlistName(),
          blob: new Blob([rung.segmenter.playlistText()], { type: MIME_MANIFEST }),
          contentType: MIME_MANIFEST,
          isManifest: true,
        };
      }
    }

    if (rungs.length > 0) {
      yield {
        name: `${prefix}_master.m3u8`,
        blob: new Blob([buildMaster(prefix, rungs)], { type: MIME_MANIFEST }),
        contentType: MIME_MANIFEST,
        isManifest: true,
      };
    }
    onProgress?.({ processed, total: processed, fraction: 1 });
  } finally {
    for (const rung of rungs) {
      try {
        if (rung.encoder.state !== "closed") rung.encoder.close();
      } catch {
        // Already closed.
      }
      rung.segmenter?.free();
    }
  }
}

/** Create one rung's encoder and the segmenter it will feed. */
function createRung(
  prefix: string,
  spec: { width: number; height: number; bitrate: number },
  segmentDuration: number,
): RungPipeline {
  const rung: RungPipeline = {
    name: `${prefix}_${spec.height}p`,
    width: spec.width,
    height: spec.height,
    bitrate: spec.bitrate,
    pending: [],
    encoder: undefined as unknown as VideoEncoder,
  };

  rung.encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      // The encoder reports its avcC with the first chunk, so the segmenter
      // cannot be created any earlier than this.
      if (!rung.segmenter) {
        const description = metadata?.decoderConfig?.description;
        if (!description) {
          rung.error = new Error(`Encoder for ${rung.name} produced no decoder configuration`);
          return;
        }
        rung.segmenter = new Fmp4Segmenter(
          rung.name,
          TIMESCALE,
          rung.width,
          rung.height,
          new Uint8Array(description as ArrayBuffer),
          segmentDuration,
        );
        rung.pending.push({
          name: rung.segmenter.initName(),
          blob: new Blob([rung.segmenter.initSegment() as BlobPart], { type: MIME_SEGMENT }),
          contentType: MIME_SEGMENT,
          isManifest: false,
        });
      }

      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      try {
        rung.segmenter.pushSample(data, chunk.duration ?? 0, chunk.type === "key", 0);
      } catch (error) {
        rung.error = error instanceof Error ? error : new Error(String(error));
      }
    },
    error: (error) => {
      rung.error = error instanceof Error ? error : new Error(String(error));
    },
  });

  return rung;
}

/** Wrap a `VideoDecoder` with a simple output buffer. */
function createDecoder(codecConfig: Uint8Array, width: number, height: number) {
  const output: VideoFrame[] = [];
  const decoder = new VideoDecoder({
    output: (frame) => output.push(frame),
    error: (error) => {
      throw error;
    },
  });
  decoder.configure({
    codec: "avc1.42e01e",
    description: codecConfig,
    codedWidth: width,
    codedHeight: height,
  });
  return {
    decoder,
    take(): VideoFrame[] {
      return output.splice(0, output.length);
    },
  };
}

/** Yield any output a rung has ready, surfacing encoder errors. */
function* drainRung(rung: RungPipeline): Generator<OutputFile> {
  if (rung.error) throw rung.error;

  yield* rung.pending.splice(0, rung.pending.length);

  const segmenter = rung.segmenter;
  if (!segmenter) return;

  for (;;) {
    const segment = segmenter.takeSegment();
    if (!segment) return;
    try {
      yield {
        name: segmenter.segmentName(segment.index),
        blob: new Blob([segment.data as BlobPart], { type: MIME_SEGMENT }),
        contentType: MIME_SEGMENT,
        isManifest: false,
      };
    } finally {
      segment.free();
    }
  }
}

/**
 * Wait until encoders have drained enough to accept more work.
 *
 * Without this the decoder outruns the encoders and queued frames grow without
 * bound — the failure mode that kills a tab on a long video.
 */
async function applyBackpressure(rungs: RungPipeline[], signal?: AbortSignal): Promise<void> {
  while (rungs.some((r) => r.encoder.encodeQueueSize > MAX_QUEUED_FRAMES)) {
    signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Build the master playlist listing every rung. */
function buildMaster(prefix: string, rungs: RungPipeline[]): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  // Highest bandwidth first: players use the first entry as their initial pick.
  for (const rung of [...rungs].sort((a, b) => b.bitrate - a.bitrate)) {
    if (!rung.segmenter) continue;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${rung.bitrate},RESOLUTION=${rung.width}x${rung.height},CODECS="avc1.42e01e"`,
      rung.segmenter.playlistName(),
    );
  }
  void prefix;
  return `${lines.join("\n")}\n`;
}

/** Sample locations, with decode times accumulated for WebCodecs timestamps. */
function buildSampleList(demuxer: Mp4Demuxer): (SampleLocation & { decodeTime: number })[] {
  const offsets = demuxer.sampleOffsets();
  const sizes = demuxer.sampleSizes();
  const durations = demuxer.sampleDurations();
  const sync = demuxer.sampleSyncFlags();
  const cts = demuxer.sampleCompositionOffsets();

  const out: (SampleLocation & { decodeTime: number })[] = new Array(offsets.length);
  let decodeTime = 0;
  for (let i = 0; i < offsets.length; i++) {
    out[i] = {
      offset: offsets[i]!,
      size: sizes[i]!,
      duration: durations[i]!,
      isSync: sync[i] === 1,
      compositionOffset: cts[i]!,
      decodeTime,
    };
    decodeTime += durations[i]!;
  }
  return out;
}
