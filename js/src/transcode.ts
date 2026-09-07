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
import { readFragments, readMoov, readSamples, type SampleLocation } from "./mp4-source.js";
import type { OutputFile } from "./remux.js";
import { ensureWasm } from "./wasm-loader.js";
import { build_audio_sample_entry, Fmp4Segmenter, Mp4Demuxer } from "./wasm/bitrate_core.js";

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
  /**
   * Re-encode the source audio and mux it into every rendition. Default `true`.
   *
   * Audio is decoded and encoded once and shared across rungs — re-encoding
   * identical audio per rung would be pure waste.
   */
  audio?: boolean;
  /** AAC bitrate when re-encoding audio. Default 128 kbps. */
  audioBitrate?: number;

  /**
   * Which H.264 profile to prefer.
   *
   * Each is tried in turn against `isConfigSupported`, so an unavailable
   * preference falls back rather than failing.
   *
   * - `"main"` (default) — the broadly decodable middle ground.
   * - `"high"` — better compression at the same bitrate; universal on anything
   *   modern, but not on very old hardware decoders.
   * - `"baseline"` — the most compatible and the least efficient. Worth it only
   *   for genuinely old targets.
   */
  profile?: "main" | "high" | "baseline";

  /**
   * Whether to insist on a hardware encoder.
   *
   * `"prefer-hardware"` is dramatically faster where it exists. Software
   * encoding of a long video in a tab is rarely practical, so
   * `"prefer-software"` is mostly a debugging tool.
   */
  hardwareAcceleration?: HardwareAcceleration;

  /**
   * `"quality"` (default) spends more time per frame. `"realtime"` is faster
   * and looks worse at the same bitrate — reasonable when the user is waiting.
   */
  latencyMode?: LatencyMode;

  /**
   * Allow rungs taller than the source. Default `false`.
   *
   * Upscaling costs encoding time and storage and adds no detail, so rungs
   * above the source are normally dropped. Enable it only if a fixed set of
   * renditions matters more than not wasting the work.
   */
  allowUpscale?: boolean;
}

/**
 * Ready-made ladders.
 *
 * A ladder is a trade between how many renditions you store and how well
 * playback adapts. Rungs above the source are dropped, so a preset can be
 * handed any source without checking it first.
 */
export const LADDERS = {
  /** One rung. Cheapest to produce and store; no adaptation. */
  single: [{ height: 720, bitrate: 2_800_000 }],

  /** Phone-friendly: small files, quick to encode, tolerant of poor networks. */
  mobile: [
    { height: 720, bitrate: 2_000_000 },
    { height: 480, bitrate: 900_000 },
    { height: 360, bitrate: 500_000 },
  ],

  /** The usual default: covers desktop down to mobile data. */
  standard: [
    { height: 1080, bitrate: 5_000_000 },
    { height: 720, bitrate: 2_800_000 },
    { height: 480, bitrate: 1_200_000 },
  ],

  /** Adds a low rung for genuinely bad connections. */
  wide: [
    { height: 1080, bitrate: 5_000_000 },
    { height: 720, bitrate: 2_800_000 },
    { height: 480, bitrate: 1_200_000 },
    { height: 360, bitrate: 600_000 },
  ],

  /** For 4K sources. Expensive to encode — expect real time. */
  uhd: [
    { height: 2160, bitrate: 16_000_000 },
    { height: 1440, bitrate: 10_000_000 },
    { height: 1080, bitrate: 5_000_000 },
    { height: 720, bitrate: 2_800_000 },
  ],
} satisfies Record<string, Rung[]>;

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
 * The RFC 6381 codec string for a source, read from its `avcC` record.
 *
 * A hardcoded string cannot work: `avc1.42e01e` is Baseline level 3.0, which
 * tops out around 720×480. Configuring a decoder with it for a 1080p High
 * profile source fails and closes the codec, and the first symptom is an
 * unrelated-looking error from a later `flush()`.
 *
 * Bytes 1–3 of `avcC` are exactly profile, constraint flags and level.
 */
export function codecStringFromAvcC(avcc: Uint8Array): string {
  if (avcc.length < 4) {
    throw new Error("avcC record is too short to name a codec");
  }
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `avc1.${hex(avcc[1]!)}${hex(avcc[2]!)}${hex(avcc[3]!)}`;
}

/**
 * The lowest H.264 level that can carry `width`x`height` at `fps`.
 *
 * Levels cap macroblocks per second and per frame; encoding 1080p at level 3.0
 * is simply not expressible, so the level must scale with the rung.
 */
export function levelForFrame(width: number, height: number, fps = 30): number {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const perSecond = macroblocks * fps;

  // (level byte, max macroblocks/frame, max macroblocks/second)
  const levels: [number, number, number][] = [
    [0x1e, 1_620, 40_500], // 3.0  — 720x480
    [0x1f, 3_600, 108_000], // 3.1 — 1280x720
    [0x20, 5_120, 216_000], // 3.2
    [0x28, 8_192, 245_760], // 4.0 — 1920x1080
    [0x29, 8_192, 245_760], // 4.1
    [0x2a, 8_704, 522_240], // 4.2 — 1080p60
    [0x32, 22_080, 589_824], // 5.0 — 2560x1920
    [0x33, 36_864, 983_040], // 5.1 — 4096x2048
    [0x34, 36_864, 2_073_600], // 5.2
  ];

  for (const [level, maxFrame, maxRate] of levels) {
    if (macroblocks <= maxFrame && perSecond <= maxRate) return level;
  }
  return 0x34;
}

/**
 * Choose an encoder configuration this browser will actually accept.
 *
 * Profiles and levels vary by platform and by hardware encoder, so candidates
 * are checked with `isConfigSupported` rather than assumed. Main is tried
 * first for broad playback compatibility, then High, then Baseline.
 */
async function resolveEncoderConfig(
  width: number,
  height: number,
  bitrate: number,
  framerate: number,
  options: {
    profile?: "main" | "high" | "baseline";
    hardwareAcceleration?: HardwareAcceleration;
    latencyMode?: LatencyMode;
  } = {},
): Promise<VideoEncoderConfig> {
  const level = levelForFrame(width, height, framerate).toString(16).padStart(2, "0");

  // Profile is the first two bytes of the codec string.
  const byProfile = { main: "4d00", high: "6400", baseline: "4200" } as const;
  const preferred = byProfile[options.profile ?? "main"];
  // The preference first, then the rest as fallbacks: a preference that this
  // browser cannot honour should degrade rather than fail.
  const order = [preferred, ...Object.values(byProfile).filter((p) => p !== preferred)];

  const attempted: string[] = [];
  for (const prefix of order) {
    const codec = `avc1.${prefix}${level}`;
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate,
      latencyMode: options.latencyMode ?? "quality",
      avc: { format: "avc" },
      ...(options.hardwareAcceleration
        ? { hardwareAcceleration: options.hardwareAcceleration }
        : {}),
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return (support.config as VideoEncoderConfig) ?? config;
      attempted.push(codec);
    } catch {
      attempted.push(codec);
    }
  }

  throw new Error(
    `This browser cannot encode ${width}x${height} H.264 (tried ${attempted.join(", ")}). ` +
      `Use mode "remux" to chunk without re-encoding, or choose a smaller ladder.`,
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
  allowUpscale = false,
): { width: number; height: number; bitrate: number }[] {
  const usable = allowUpscale ? [...ladder] : ladder.filter((r) => r.height <= sourceHeight);
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

/** Default AAC bitrate when re-encoding audio. */
const DEFAULT_AUDIO_BITRATE = 128_000;

/**
 * Re-encodes the source audio and hands the result to a rung's segmenter.
 *
 * Audio is decoded and encoded **once**, not once per rung: the same AAC
 * stream is muxed into every rendition, because there is no reason to re-encode
 * identical audio three times. Video is what differs between rungs.
 */
class AudioPipeline {
  readonly #decoder: AudioDecoder;
  readonly #encoder: AudioEncoder;
  /** Encoded frames, waiting to be attached to the rungs. */
  readonly #encoded: { data: Uint8Array; duration: number }[] = [];

  #sampleEntry: Uint8Array | null = null;
  #error: Error | null = null;
  #sampleRate = 0;
  #channels = 0;

  private constructor(decoder: AudioDecoder, encoder: AudioEncoder) {
    this.#decoder = decoder;
    this.#encoder = encoder;
  }

  /**
   * Build a pipeline for a source's audio track, or `null` when the browser
   * cannot handle it — a silent result beats failing the whole job.
   */
  static async create(
    specificConfig: Uint8Array,
    sampleRate: number,
    channels: number,
    bitrate: number,
  ): Promise<AudioPipeline | null> {
    if (typeof AudioDecoder !== "function" || typeof AudioEncoder !== "function") return null;
    if (specificConfig.length === 0 || sampleRate === 0 || channels === 0) return null;

    // The AAC profile lives in the top 5 bits of the config.
    const objectType = specificConfig[0]! >> 3;
    const decoderConfig: AudioDecoderConfig = {
      codec: `mp4a.40.${objectType || 2}`,
      sampleRate,
      numberOfChannels: channels,
      description: specificConfig,
    };
    const encoderConfig: AudioEncoderConfig = {
      codec: "mp4a.40.2", // AAC-LC: the broadly decodable choice
      sampleRate,
      numberOfChannels: channels,
      bitrate,
    };

    try {
      const [decodable, encodable] = await Promise.all([
        AudioDecoder.isConfigSupported(decoderConfig),
        AudioEncoder.isConfigSupported(encoderConfig),
      ]);
      if (!decodable.supported || !encodable.supported) return null;
    } catch {
      return null;
    }

    let pipeline: AudioPipeline;

    const decoder = new AudioDecoder({
      output: (frame) => {
        try {
          pipeline.#encoder.encode(frame);
        } finally {
          // AudioData holds memory that is not garbage collected.
          frame.close();
        }
      },
      error: (error) => {
        pipeline.#error = error instanceof Error ? error : new Error(String(error));
      },
    });

    const encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        // The encoder reports its AudioSpecificConfig with the first chunk, so
        // the output sample entry cannot be built any earlier.
        if (!pipeline.#sampleEntry) {
          const description = metadata?.decoderConfig?.description;
          if (description) {
            try {
              pipeline.#sampleEntry = build_audio_sample_entry(
                pipeline.#sampleRate,
                pipeline.#channels,
                new Uint8Array(description as ArrayBuffer),
                bitrate,
              );
            } catch (error) {
              pipeline.#error = error instanceof Error ? error : new Error(String(error));
              return;
            }
          }
        }

        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        // Durations are in microseconds; the track runs at the sample rate.
        const duration = Math.round(((chunk.duration ?? 0) / 1_000_000) * pipeline.#sampleRate);
        pipeline.#encoded.push({ data, duration });
      },
      error: (error) => {
        pipeline.#error = error instanceof Error ? error : new Error(String(error));
      },
    });

    pipeline = new AudioPipeline(decoder, encoder);
    pipeline.#sampleRate = sampleRate;
    pipeline.#channels = channels;

    decoder.configure(decoderConfig);
    encoder.configure(encoderConfig);
    return pipeline;
  }

  /** The output track's sample entry, once the encoder has revealed it. */
  get sampleEntry(): Uint8Array | null {
    return this.#sampleEntry;
  }

  get sampleRate(): number {
    return this.#sampleRate;
  }

  get error(): Error | null {
    return this.#error;
  }

  /** Feed one encoded frame from the source. */
  decode(data: Uint8Array, timestampUs: number, durationUs: number): void {
    if (this.#error) throw this.#error;
    this.#decoder.decode(
      new EncodedAudioChunk({ type: "key", timestamp: timestampUs, duration: durationUs, data }),
    );
  }

  /** Take everything encoded so far. */
  take(): { data: Uint8Array; duration: number }[] {
    if (this.#error) throw this.#error;
    return this.#encoded.splice(0, this.#encoded.length);
  }

  /** True while the encoder is behind, so the caller can wait. */
  get busy(): boolean {
    return this.#decoder.decodeQueueSize > MAX_QUEUED_FRAMES;
  }

  async flush(): Promise<void> {
    await this.#decoder.flush();
    await this.#encoder.flush();
    if (this.#error) throw this.#error;
  }

  close(): void {
    try {
      if (this.#decoder.state !== "closed") this.#decoder.close();
    } catch {
      // Already closed.
    }
    try {
      if (this.#encoder.state !== "closed") this.#encoder.close();
    } catch {
      // Already closed.
    }
  }
}

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
  /**
   * The codec string the encoder was actually configured with.
   *
   * The master playlist has to advertise this rather than a fixed value: a
   * player reads CODECS to decide whether it can play a variant at all, and
   * claiming Baseline 3.0 for a 1080p rung describes something that cannot
   * exist. Set once the encoder is configured.
   */
  codec?: string;
  /** The re-encoded audio track description, when there is audio. */
  audioSampleEntry: Uint8Array | null;
  /** The audio track timescale, which is its sample rate. */
  audioTimescale: number;
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
    audio: wantAudio = true,
    audioBitrate = DEFAULT_AUDIO_BITRATE,
    profile,
    hardwareAcceleration,
    latencyMode,
    allowUpscale = false,
  } = options;

  await ensureWasm();
  signal?.throwIfAborted();

  const moov = await readMoov(file);
  const demuxer = new Mp4Demuxer(moov);

  // Fragmented sources keep their samples in moof boxes.
  if (demuxer.isFragmented) {
    for await (const fragment of readFragments(file, { signal })) {
      demuxer.addFragment(fragment.bytes, fragment.offset);
    }
  }

  const sourceWidth = demuxer.width;
  const sourceHeight = demuxer.height;
  const sourceTimescale = demuxer.timescale;
  const sourceConfig = demuxer.codecConfig;
  const samples = buildSampleList(demuxer);

  // Audio, when the source has it and the caller wants it kept.
  const hasAudio = wantAudio && demuxer.hasAudio;
  const audioSamples = hasAudio ? buildAudioSampleList(demuxer) : [];
  const audioTimescale = demuxer.audioTimescale;
  const audioSpecificConfig = hasAudio ? demuxer.audioSpecificConfig : new Uint8Array();
  const audioSampleRate = demuxer.audioSampleRate || audioTimescale;
  const audioChannels = demuxer.audioChannels;

  demuxer.free();

  if (samples.length === 0) {
    demuxer.free();
    throw new Error(
      "This file declares no video samples in its sample tables. It is most likely a " +
        "fragmented MP4, which is not supported yet.",
    );
  }

  // Frame rate drives the H.264 level, so derive it rather than assuming 30.
  const totalTicks = samples.reduce((t, s) => t + s.duration, 0);
  const framerate =
    totalTicks > 0 ? Math.round(samples.length / (totalTicks / sourceTimescale)) || 30 : 30;

  const plan = planLadder(ladder, sourceWidth, sourceHeight, allowUpscale);
  const rungs: RungPipeline[] = [];
  let audioPipeline: AudioPipeline | null = null;

  try {
    // Resolve every encoder configuration before creating anything, so an
    // unsupported ladder fails with a clear message instead of surfacing later
    // as an error from a closed codec.
    const configs = await Promise.all(
      plan.map((rung) =>
        resolveEncoderConfig(rung.width, rung.height, rung.bitrate, framerate, {
          ...(profile ? { profile } : {}),
          ...(hardwareAcceleration ? { hardwareAcceleration } : {}),
          ...(latencyMode ? { latencyMode } : {}),
        }),
      ),
    );

    // Set the audio up first: its sample entry has to exist before any
    // segmenter is created, since it changes the init segment's moov.
    if (hasAudio && audioSamples.length > 0) {
      audioPipeline = await AudioPipeline.create(
        audioSpecificConfig,
        audioSampleRate,
        audioChannels,
        audioBitrate,
      );

      if (audioPipeline) {
        // Audio is re-encoded in one pass before the video, for two reasons:
        // the encoder only reveals its AudioSpecificConfig once it has produced
        // a chunk, and that config has to exist before any segmenter is created
        // because it changes the init segment. Encoded AAC is small next to the
        // video, so holding it is cheap.
        for await (const item of readSamples(file, audioSamples, { readWindow, signal })) {
          const sample = item.sample as SampleLocation & { decodeTime: number };
          audioPipeline.decode(
            item.data,
            Math.round((sample.decodeTime / audioTimescale) * 1_000_000),
            Math.round((sample.duration / audioTimescale) * 1_000_000),
          );
          while (audioPipeline.busy) {
            signal?.throwIfAborted();
            // Same hazard as the video backpressure loop: a decoder that has
            // failed is closed and will never drain, so the wait has to end on
            // the error rather than spin on a queue that cannot move. This loop
            // runs before any video work, so hanging here produces no output at
            // all — the worst-looking failure of the three.
            if (audioPipeline.error) throw audioPipeline.error;
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
        await audioPipeline.flush();
      }
    }

    /** Every re-encoded audio frame, with the time it starts at. */
    const audioTrack: { data: Uint8Array; duration: number; startSeconds: number }[] = [];
    if (audioPipeline) {
      const rate = audioPipeline.sampleRate || 1;
      let ticks = 0;
      for (const frame of audioPipeline.take()) {
        audioTrack.push({ ...frame, startSeconds: ticks / rate });
        ticks += frame.duration;
      }
    }
    const audioEntry = audioPipeline?.sampleEntry ?? null;
    const outputAudioRate = audioPipeline?.sampleRate ?? 0;

    for (const rung of plan) {
      rungs.push(createRung(prefix, rung, segmentDuration, audioEntry, outputAudioRate));
    }
    for (let i = 0; i < rungs.length; i++) {
      rungs[i]!.encoder.configure(configs[i]!);
      rungs[i]!.codec = configs[i]!.codec;
    }

    // How much of the audio each rung has been given so far. The same frames go
    // to every rendition — re-encoding identical audio per rung is pure waste.
    let audioPushed = 0;

    /** Give every rung the audio up to `seconds`. */
    const advanceAudio = (seconds: number) => {
      // A rung's segmenter does not exist until its video encoder has produced
      // a chunk, since the segmenter needs the encoder's avcC. Hold the audio
      // until then rather than consuming it into nothing — the frames still
      // belong to the first segment when it is eventually created.
      const ready = rungs.filter((r) => r.segmenter?.hasAudio);
      if (ready.length === 0) return;

      while (audioPushed < audioTrack.length && audioTrack[audioPushed]!.startSeconds <= seconds) {
        const frame = audioTrack[audioPushed]!;
        for (const rung of ready) {
          rung.segmenter!.pushAudioSample(frame.data, frame.duration);
        }
        audioPushed++;
      }
    };

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
        // Keep the audio level with the video, so a segment closing here
        // carries the sound that belongs to it.
        advanceAudio(frame.timestamp / 1_000_000);
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
    if (decoder.failure) throw decoder.failure;
    for (const frame of decoder.take()) {
      for (const rung of rungs) rung.encoder.encode(frame, { keyFrame: false });
      frame.close();
    }

    // Flush every encoder before touching the audio. A rung's segmenter is
    // created by its encoder's *output callback*, which is asynchronous — on a
    // short video none of them may exist yet, and audio handed over before then
    // would have nowhere to go.
    for (const rung of rungs) {
      // A codec that already failed is closed, and flushing it throws an
      // unhelpful "closed codec" error that hides the real cause. Report what
      // actually went wrong instead.
      if (rung.error) throw rung.error;
      if (rung.encoder.state === "closed") {
        throw new Error(
          `The encoder for ${rung.name} closed before finishing. The browser likely rejected ` +
            `${rung.width}x${rung.height} at this bitrate.`,
        );
      }
      await rung.encoder.flush();
    }

    // Now every segmenter exists, so any audio past the last video frame — or
    // all of it, on a video too short for the callbacks to have fired earlier —
    // can be handed over.
    advanceAudio(Number.POSITIVE_INFINITY);

    for (const rung of rungs) {
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
            // Resolve rather than assume: the level must match the resolution,
            // and available profiles vary by platform.
            const config = await resolveEncoderConfig(spec.width, spec.height, spec.bitrate, 30);
            const rung = createRung(prefix, spec, segmentDuration);
            rung.encoder.configure(config);
            rung.codec = config.codec;
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
      if (rung.error) throw rung.error;
      if (rung.encoder.state === "closed") {
        throw new Error(`The encoder for ${rung.name} closed before finishing.`);
      }

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

/**
 * Create one rung's encoder and the segmenter it will feed.
 *
 * `audioSampleEntry` describes the re-encoded audio track, when there is one.
 * It must be known here because it changes the init segment's `moov`, which is
 * written the moment the segmenter is created.
 */
function createRung(
  prefix: string,
  spec: { width: number; height: number; bitrate: number },
  segmentDuration: number,
  audioSampleEntry: Uint8Array | null = null,
  audioTimescale = 0,
): RungPipeline {
  const rung: RungPipeline = {
    name: `${prefix}_${spec.height}p`,
    width: spec.width,
    height: spec.height,
    bitrate: spec.bitrate,
    pending: [],
    encoder: undefined as unknown as VideoEncoder,
    audioSampleEntry,
    audioTimescale,
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
        // Audio must be declared before the init segment is produced.
        if (rung.audioSampleEntry && rung.audioTimescale > 0) {
          rung.segmenter.setAudio(rung.audioTimescale, rung.audioSampleEntry);
        }
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
  let failure: Error | null = null;

  const decoder = new VideoDecoder({
    output: (frame) => output.push(frame),
    // Throwing from this callback would surface far from the cause; record it
    // and let the caller report it against the sample that triggered it.
    error: (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
    },
  });

  // Read the profile and level from the source rather than assuming them.
  decoder.configure({
    codec: codecStringFromAvcC(codecConfig),
    description: codecConfig,
    codedWidth: width,
    codedHeight: height,
  });

  return {
    decoder,
    take(): VideoFrame[] {
      if (failure) throw failure;
      return output.splice(0, output.length);
    },
    get failure(): Error | null {
      return failure;
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
/**
 * The part of a rung backpressure needs, so the loop can be tested without a
 * real `VideoEncoder` — which is the reason the hang above shipped: WebCodecs
 * does not exist in Node, so nothing here was covered.
 *
 * @internal
 */
export interface BackpressureRung {
  name: string;
  width: number;
  height: number;
  bitrate: number;
  error?: Error | undefined;
  encoder: { encodeQueueSize: number; state: string };
}

/** @internal Exported for tests. */
export async function applyBackpressure(
  rungs: BackpressureRung[],
  signal?: AbortSignal,
): Promise<void> {
  while (rungs.some((r) => r.encoder.encodeQueueSize > MAX_QUEUED_FRAMES)) {
    signal?.throwIfAborted();

    // A dead encoder never drains its queue, so waiting for it is waiting
    // forever. WebCodecs reports the failure through the error callback and
    // closes the codec; without this the whole job hangs with no error and no
    // output, which is indistinguishable to a user from "it is still working".
    for (const rung of rungs) {
      if (rung.error) throw rung.error;
      if (rung.encoder.state === "closed") {
        throw new Error(
          `The encoder for ${rung.name} closed while encoding. The browser likely rejected ` +
            `${rung.width}x${rung.height} at ${Math.round(rung.bitrate / 1000)} kbps — ` +
            `try a shorter ladder, such as LADDERS.single.`,
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Build the master playlist listing every rung. */
/** What the master playlist needs from a rung. @internal */
export interface MasterVariant {
  bitrate: number;
  width: number;
  height: number;
  codec?: string | undefined;
  audioSampleEntry: Uint8Array | null;
  segmenter?: { playlistName(): string } | undefined;
}

/** @internal Exported for tests. */
export function buildMaster(prefix: string, rungs: MasterVariant[]): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  // Highest bandwidth first: players use the first entry as their initial pick.
  for (const rung of [...rungs].sort((a, b) => b.bitrate - a.bitrate)) {
    if (!rung.segmenter) continue;

    // The rung's own codec string, not a fixed one. `mp4a.40.2` is AAC-LC,
    // which is what the audio pipeline encodes; a variant carrying audio must
    // declare it or a player may set up only a video track.
    const codecs = [rung.codec ?? "avc1.4d401f"];
    if (rung.audioSampleEntry) codecs.push("mp4a.40.2");

    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${rung.bitrate},RESOLUTION=${rung.width}x${rung.height},CODECS="${codecs.join(",")}"`,
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

/** The audio track's sample locations, with decode times accumulated. */
function buildAudioSampleList(demuxer: Mp4Demuxer): (SampleLocation & { decodeTime: number })[] {
  const offsets = demuxer.audioSampleOffsets();
  const sizes = demuxer.audioSampleSizes();
  const durations = demuxer.audioSampleDurations();

  const out: (SampleLocation & { decodeTime: number })[] = new Array(offsets.length);
  let decodeTime = 0;
  for (let i = 0; i < offsets.length; i++) {
    out[i] = {
      offset: offsets[i]!,
      size: sizes[i]!,
      duration: durations[i]!,
      // Every audio frame is independently decodable.
      isSync: true,
      compositionOffset: 0,
      decodeTime,
    };
    decodeTime += durations[i]!;
  }
  return out;
}
