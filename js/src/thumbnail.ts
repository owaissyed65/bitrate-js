/**
 * Poster frames and scrub-bar sprite sheets.
 *
 * Every upload UI needs a still to show before the video plays, and the usual
 * answer is a round trip to a server with ffmpeg on it. The frames are already
 * here: the file is indexed, and WebCodecs can decode one.
 *
 * The cost is a run-up. A poster at 0:30 cannot be decoded on its own — an
 * inter frame refers to frames before it — so decoding starts at the keyframe
 * at or before the target and discards what comes out early. That is usually a
 * fraction of a second of work, and it is why this reads a few hundred kilobytes
 * rather than the whole file.
 *
 * Requires WebCodecs, the same as {@link transcode}. Check
 * {@link isThumbnailSupported} where a browser might not have it.
 */

import { readFragments, readMoov, readSamples, type SampleLocation } from "./mp4-source.js";
import { codecStringFromAvcC, syncSampleAtOrBefore } from "./transcode.js";
import { ensureWasm } from "./wasm-loader.js";
import { Mp4Demuxer } from "./wasm/bitrate_core.js";

/** Whether this browser can decode a frame to an image. */
export function isThumbnailSupported(): boolean {
  return (
    typeof globalThis.VideoDecoder === "function" &&
    (typeof globalThis.OffscreenCanvas === "function" || typeof document !== "undefined")
  );
}

export interface PosterOptions {
  /**
   * Where to take the frame, in seconds. Default `0.1` — a *fraction*, not a
   * time, when `fraction` is true.
   */
  atSeconds?: number;
  /**
   * Take the frame this far through the video instead, 0–1.
   *
   * Usually better than a fixed time: many videos open on black, a fade or a
   * slate, so 10% in is a more representative still than 0:00.
   */
  atFraction?: number;
  /** Longest edge of the output, preserving aspect. Default 640. */
  maxWidth?: number;
  /** Output type. Default `"image/webp"`, which is far smaller than JPEG. */
  type?: "image/webp" | "image/jpeg" | "image/png";
  /** 0–1. Default 0.82. Ignored for PNG. */
  quality?: number;
  signal?: AbortSignal | undefined;
}

export interface Poster {
  blob: Blob;
  width: number;
  height: number;
  /** The timestamp actually captured, which lands on the nearest decodable frame. */
  atSeconds: number;
}

export interface SpriteOptions extends Omit<PosterOptions, "atSeconds" | "atFraction"> {
  /** How many stills to take, spread evenly. Default 10. */
  count?: number;
  /** Tiles per row. Default: a roughly square grid. */
  columns?: number;
}

export interface Sprite extends Poster {
  /** Tile size within the sheet. */
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  /** The timestamp each tile was taken at, in order. */
  times: number[];
}

/** A canvas that works on a worker thread as well as a document. */
function makeCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas produced no image"))),
      type,
      quality,
    );
  });
}

/**
 * Dimensions that fit inside `maxWidth`, preserving aspect.
 *
 *  Exported for tests.
 */
export function fit(width: number, height: number, maxWidth: number) {
  if (width <= maxWidth) return { width, height };
  const scale = maxWidth / width;
  return { width: maxWidth, height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Where a sprite sheet's stills come from, and how they are arranged.
 *
 * Targets sit at the *middle* of each slice rather than its edge. The first and
 * last frames of a video are the least representative of it — a fade from black
 * and a fade to it — so `(i + 0.5) / count` gives a more useful strip than
 * `i / count` would.
 *
 * @internal Exported for tests.
 */
export function spriteLayout(
  count: number,
  duration: number,
  columns?: number,
): { targets: number[]; columns: number; rows: number } {
  const across = columns ?? Math.ceil(Math.sqrt(count));
  return {
    targets: Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count),
    columns: across,
    rows: Math.ceil(count / across),
  };
}

/**
 * Decode the frames nearest each of `targets` (seconds), in one pass.
 *
 * Targets are visited in order and share a decoder, so a sprite sheet of ten
 * stills is not ten separate seeks with ten run-ups.
 */
async function decodeAt(
  file: Blob,
  targets: readonly number[],
  signal: AbortSignal | undefined,
  onFrame: (frame: VideoFrame, target: number, index: number) => void,
): Promise<void> {
  await ensureWasm();
  signal?.throwIfAborted();

  const moov = await readMoov(file);
  const demuxer = new Mp4Demuxer(moov);

  try {
    if (demuxer.isFragmented) {
      for await (const fragment of readFragments(file, { signal })) {
        demuxer.addFragment(fragment.bytes, fragment.offset);
      }
    }

    const timescale = demuxer.timescale || 1;
    const config = demuxer.codecConfig;
    const width = demuxer.width;
    const height = demuxer.height;

    const offsets = demuxer.sampleOffsets();
    const sizes = demuxer.sampleSizes();
    const durations = demuxer.sampleDurations();
    const sync = demuxer.sampleSyncFlags();
    const cts = demuxer.sampleCompositionOffsets();

    const samples: (SampleLocation & { decodeTime: number })[] = [];
    let decodeTime = 0;
    for (let i = 0; i < offsets.length; i++) {
      samples.push({
        offset: Number(offsets[i]),
        size: sizes[i]!,
        duration: durations[i]!,
        isSync: sync[i] === 1,
        compositionOffset: cts[i] ?? 0,
        decodeTime,
      });
      decodeTime += durations[i]!;
    }
    if (samples.length === 0) throw new Error("This file declares no video samples.");

    demuxer.free();

    let failure: Error | null = null;
    const ready: VideoFrame[] = [];
    const decoder = new VideoDecoder({
      output: (frame) => ready.push(frame),
      error: (error) => {
        failure = error instanceof Error ? error : new Error(String(error));
      },
    });
    decoder.configure({
      codec: codecStringFromAvcC(config),
      description: config,
      codedWidth: width,
      codedHeight: height,
    });

    try {
      for (let t = 0; t < targets.length; t++) {
        signal?.throwIfAborted();
        const targetUs = Math.max(0, targets[t]!) * 1_000_000;

        // Start at the keyframe at or before the target; anything else is
        // either an error or garbage.
        const start = syncSampleAtOrBefore(samples, timescale, targetUs);
        const slice = samples.slice(start);

        // Feed the whole run-up, then decide. Choosing frames as they arrive
        // does not work: a decoder delivers them well after the samples that
        // produced them, so an early frame is often the only one available when
        // the samples run out — which is how every tile of a sprite ended up
        // being frame zero. Decode past the target, flush, then pick.
        for await (const item of readSamples(file, slice, { signal })) {
          if (failure) throw failure;
          const sample = item.sample as SampleLocation & { decodeTime: number };
          const timestampUs = Math.round((sample.decodeTime / timescale) * 1_000_000);

          decoder.decode(
            new EncodedVideoChunk({
              type: sample.isSync ? "key" : "delta",
              timestamp: timestampUs,
              duration: Math.round((sample.duration / timescale) * 1_000_000),
              data: item.data,
            }),
          );

          // Decode strictly past the target: with B-frames, presentation order
          // is not decode order, so the frame wanted may follow a later sample.
          if (timestampUs > targetUs) break;
        }

        await decoder.flush();
        if (failure) throw failure;

        // The frame to keep is the latest at or before the target; if the
        // target sits before the first frame, the earliest one.
        const decoded = ready.splice(0, ready.length);
        let captured: VideoFrame | null = null;
        for (const frame of decoded) {
          if (frame.timestamp <= targetUs) {
            if (!captured || captured.timestamp > targetUs || frame.timestamp > captured.timestamp) {
              captured = frame;
            }
          } else if (!captured) {
            captured = frame;
          }
        }
        for (const frame of decoded) if (frame !== captured) frame.close();

        if (!captured) throw new Error(`No frame could be decoded near ${targets[t]!.toFixed(2)}s`);

        try {
          onFrame(captured, targets[t]!, t);
        } finally {
          captured.close();
        }

      }
    } finally {
      for (const frame of ready) frame.close();
      try {
        if (decoder.state !== "closed") decoder.close();
      } catch {
        // Already closed.
      }
    }
  } finally {
    try {
      demuxer.free();
    } catch {
      // Already freed above on the happy path.
    }
  }
}

/**
 * A single still from `file`, as an image blob.
 *
 * @example
 * ```ts
 * const poster = await posterFrame(file, { atFraction: 0.1 });
 * img.src = URL.createObjectURL(poster.blob);
 * ```
 */
export async function posterFrame(file: Blob, options: PosterOptions = {}): Promise<Poster> {
  const { maxWidth = 640, type = "image/webp", quality = 0.82, signal } = options;

  let target = options.atSeconds ?? 0;
  if (options.atFraction !== undefined) {
    // Needs the duration, which means reading the header first.
    const { inspect } = await import("./remux.js");
    const info = await inspect(file);
    target = Math.max(0, info.duration * Math.min(Math.max(options.atFraction, 0), 1));
  } else if (options.atSeconds === undefined) {
    // Many videos open on black, a fade or a slate, so a moment in beats 0:00.
    const { inspect } = await import("./remux.js");
    const info = await inspect(file);
    target = info.duration * 0.1;
  }

  // The frame is closed as soon as the callback returns, so it has to be drawn
  // synchronously; only the canvas outlives it. Encoding to a blob is async and
  // happens afterwards, against pixels that have already been copied.
  type Drawn = {
    canvas: OffscreenCanvas | HTMLCanvasElement;
    width: number;
    height: number;
    atSeconds: number;
  };
  let drawn: Drawn | null = null;

  await decodeAt(file, [target], signal, (frame) => {
    const size = fit(frame.displayWidth, frame.displayHeight, maxWidth);
    const canvas = makeCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error("could not get a 2D canvas context");
    ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, size.width, size.height);

    drawn = { canvas, ...size, atSeconds: frame.timestamp / 1_000_000 };
  });

  if (!drawn) throw new Error("no frame was produced");
  const result: Drawn = drawn;

  return {
    blob: await canvasToBlob(result.canvas, type, quality),
    width: result.width,
    height: result.height,
    atSeconds: result.atSeconds,
  };
}

/**
 * A grid of stills spread across the video, as one image.
 *
 * This is what a player shows when you drag along the scrub bar. One sheet is
 * far cheaper to serve than a hundred separate images, and it is the reason
 * players can preview instantly.
 *
 * @example
 * ```ts
 * const sheet = await thumbnailSprite(file, { count: 20, maxWidth: 160 });
 * // sheet.columns x sheet.rows tiles of sheet.tileWidth x sheet.tileHeight
 * ```
 */
export async function thumbnailSprite(file: Blob, options: SpriteOptions = {}): Promise<Sprite> {
  const { count = 10, maxWidth = 160, type = "image/webp", quality = 0.75, signal } = options;
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");

  const { inspect } = await import("./remux.js");
  const info = await inspect(file);
  const duration = info.duration || 0;

  const { targets, columns, rows } = spriteLayout(count, duration, options.columns);

  const tile = fit(info.width, info.height, maxWidth);
  const canvas = makeCanvas(tile.width * columns, tile.height * rows);
  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("could not get a 2D canvas context");

  const times: number[] = [];

  await decodeAt(file, targets, signal, (frame, _target, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    ctx.drawImage(
      frame as unknown as CanvasImageSource,
      column * tile.width,
      row * tile.height,
      tile.width,
      tile.height,
    );
    times.push(frame.timestamp / 1_000_000);
  });

  return {
    blob: await canvasToBlob(canvas, type, quality),
    width: tile.width * columns,
    height: tile.height * rows,
    tileWidth: tile.width,
    tileHeight: tile.height,
    columns,
    rows,
    times,
    atSeconds: times[0] ?? 0,
  };
}
