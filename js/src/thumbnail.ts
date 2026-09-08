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
import {
  applyDecoderBackpressure,
  codecStringFromAvcC,
  syncSampleAtOrBefore,
} from "./transcode.js";
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
 * Decode the frame nearest each of `targets` (seconds).
 *
 * Targets must be sorted. One decode pass answers all of them.
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

    /**
     * One forward pass over the video, settling each target as it goes by.
     *
     * The obvious implementation — seek to each target in turn, decoding from
     * the keyframe before it — is quadratic on the sources that matter. Long
     * screen recordings often carry very few keyframes, so "the keyframe before
     * 2:48" can be the one at 0:00; an eight-tile sheet then decodes the whole
     * film eight times over. On a three-minute 1080p capture that is tens of
     * thousands of frames and the tab appears to hang.
     *
     * Targets arrive sorted, so a single pass answers all of them: keep the
     * latest frame at or before the current target, and the moment a frame
     * overshoots, that keeper *is* the answer.
     *
     * Only one frame is ever alive. A 2032x1080 `VideoFrame` holds around 3 MB
     * of GPU-backed memory that garbage collection will not reclaim, so holding
     * a run-up's worth is how a tab runs out of memory rather than finishing.
     */
    const state: { at: number; best: VideoFrame | null } = { at: 0, best: null };

    /** Whether every target has been answered, so decoding can stop. */
    const finished = () => state.at >= targets.length;

    const consider = (frame: VideoFrame) => {
      // Settle every target this frame has moved past.
      while (state.at < targets.length && frame.timestamp > targets[state.at]! * 1_000_000) {
        const keeper = state.best;
        // With no earlier frame — a target before the first decoded frame —
        // this one is the closest there is.
        onFrame(keeper ?? frame, targets[state.at]!, state.at);
        if (keeper) {
          keeper.close();
          state.best = null;
        }
        state.at++;
      }

      if (finished()) {
        frame.close();
        return;
      }

      // Still short of the current target, so this is the best answer so far.
      state.best?.close();
      state.best = frame;
    };

    /** Answer any targets left over once the source runs out. */
    const settleRemaining = () => {
      const keeper = state.best;
      state.best = null;
      while (state.at < targets.length) {
        if (!keeper) {
          throw new Error(`No frame could be decoded near ${targets[state.at]!.toFixed(2)}s`);
        }
        onFrame(keeper, targets[state.at]!, state.at);
        state.at++;
      }
      keeper?.close();
    };

    const decoder = new VideoDecoder({
      output: consider,
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
      // Decoding may only begin at a sync sample: an inter frame refers to
      // frames before it. Everything decoded before the first target is thrown
      // away by `consider`, which is the unavoidable cost of seeking.
      const first = Math.max(0, targets[0] ?? 0) * 1_000_000;
      const slice = samples.slice(syncSampleAtOrBefore(samples, timescale, first));

      for await (const item of readSamples(file, slice, { signal })) {
        if (failure) throw failure;
        if (finished()) break;

        const sample = item.sample as SampleLocation & { decodeTime: number };
        decoder.decode(
          new EncodedVideoChunk({
            type: sample.isSync ? "key" : "delta",
            timestamp: Math.round((sample.decodeTime / timescale) * 1_000_000),
            duration: Math.round((sample.duration / timescale) * 1_000_000),
            data: item.data,
          }),
        );

        // Wait for the decoder rather than racing ahead of it. Reading a file is
        // far faster than decoding it, so without this the queue grows for the
        // whole pass and every frame lands at once on flush.
        await applyDecoderBackpressure({ decoder, failure }, signal);
      }

      await decoder.flush();
      if (failure) throw failure;

      // The last target has no frame after it to trigger the settle.
      settleRemaining();
    } finally {
      state.best?.close();
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
