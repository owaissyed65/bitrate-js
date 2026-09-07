/**
 * M2 acceptance: end-to-end remux.
 *
 * A real progressive MP4 goes in; seekable HLS comes out. Correctness is
 * checked two ways: the frame bytes must survive the round trip untouched
 * (remux copies, it never re-encodes), and the result must satisfy mp4box.js.
 */

import { createFile, MP4BoxBuffer } from "mp4box";
import { beforeAll, describe, expect, it } from "vitest";

import { inspect, remux, type OutputFile } from "./remux.js";
import { readMoov, topLevelBoxes } from "./mp4-source.js";
import { makeMp4Blob, TEST_AVCC } from "./testing/make-mp4.js";
import { ensureWasm } from "./wasm-loader.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL("./wasm/bitrate_core_bg.wasm", import.meta.url));
  await ensureWasm(await readFile(wasmPath));
});

/** Run a full remux and collect the output. */
async function remuxAll(blob: Blob, options = {}): Promise<OutputFile[]> {
  const out: OutputFile[] = [];
  for await (const file of remux(blob, options)) out.push(file);
  return out;
}

const bytesOf = async (f: OutputFile) => new Uint8Array(await f.blob.arrayBuffer());

describe("source parsing", () => {
  it("locates top-level boxes without reading their contents", async () => {
    const { blob } = makeMp4Blob({ frameCount: 10, gop: 5 });
    const boxes = await topLevelBoxes(blob);
    expect(boxes.map((b) => b.kind)).toEqual(["ftyp", "moov", "mdat"]);
  });

  it("finds moov even when it is written after mdat", async () => {
    // Files not written with "faststart" put moov last; this is common.
    const { blob } = makeMp4Blob({ frameCount: 10, gop: 5, moovAtEnd: true });
    const boxes = await topLevelBoxes(blob);
    expect(boxes.map((b) => b.kind)).toEqual(["ftyp", "mdat", "moov"]);
    await expect(readMoov(blob)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("reports a helpful error for a non-MP4", async () => {
    const junk = new Blob([new Uint8Array(64).fill(7)]);
    await expect(readMoov(junk)).rejects.toThrow(/No 'moov' box found/);
  });

  it("inspect reports the track configuration", async () => {
    const { blob } = makeMp4Blob({ frameCount: 60, gop: 30, width: 640, height: 360 });
    const info = await inspect(blob);
    expect(info).toMatchObject({ width: 640, height: 360, timescale: 90_000, sampleCount: 60 });
    expect(info.duration).toBeCloseTo(2.0, 6);
  });
});

describe("remux output", () => {
  it("emits init segment, media segments, then the playlist", async () => {
    const { blob } = makeMp4Blob({ frameCount: 120, gop: 30 });
    const files = await remuxAll(blob, { prefix: "720p", segmentDuration: 1 });

    expect(files[0]!.name).toBe("720p_init.mp4");
    expect(files.at(-1)!.name).toBe("720p.m3u8");
    expect(files.at(-1)!.isManifest).toBe(true);

    const segments = files.filter((f) => f.name.endsWith(".m4s"));
    expect(segments.map((s) => s.name)).toEqual([
      "720p_00000.m4s",
      "720p_00001.m4s",
      "720p_00002.m4s",
      "720p_00003.m4s",
    ]);
  });

  it("sets the content type each file needs to play", async () => {
    const { blob } = makeMp4Blob({ frameCount: 60, gop: 30 });
    const files = await remuxAll(blob, { segmentDuration: 1 });

    for (const f of files) {
      const expected = f.name.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : "video/mp4";
      expect(f.contentType, f.name).toBe(expected);
      expect(f.blob.type, f.name).toBe(expected);
    }
  });

  it("writes a playlist that indexes every segment", async () => {
    const { blob } = makeMp4Blob({ frameCount: 120, gop: 30 });
    const files = await remuxAll(blob, { prefix: "720p", segmentDuration: 1 });
    const playlist = await files.at(-1)!.blob.text();

    expect(playlist).toContain('#EXT-X-MAP:URI="720p_init.mp4"');
    expect(playlist).toContain("#EXT-X-ENDLIST");
    expect(playlist.match(/#EXTINF/g)).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(playlist).toContain(`720p_0000${i}.m4s`);
    }
  });

  it("carries the source avcC through to the output", async () => {
    const { blob } = makeMp4Blob({ frameCount: 30, gop: 30 });
    const files = await remuxAll(blob);
    const init = await bytesOf(files[0]!);

    // The decoder cannot initialize if this record is altered.
    const needle = TEST_AVCC;
    const haystack = Array.from(init).join(",");
    expect(haystack).toContain(Array.from(needle).join(","));
  });
});

describe("frame bytes survive the round trip", () => {
  it("reproduces every sample byte-for-byte", async () => {
    const source = makeMp4Blob({ frameCount: 90, gop: 30 });
    const files = await remuxAll(source.blob, { segmentDuration: 1 });

    // Concatenated mdat payloads across all segments must equal the input
    // frames in order — remux copies frames, it must never alter them.
    const segments = files.filter((f) => f.name.endsWith(".m4s"));
    const recovered: number[] = [];
    for (const seg of segments) {
      recovered.push(...extractMdat(await bytesOf(seg)));
    }

    const expected = source.samplePayloads.flatMap((p) => Array.from(p));
    expect(recovered).toEqual(expected);
  });

  it("handles multi-sample chunks", async () => {
    const source = makeMp4Blob({ frameCount: 60, gop: 30, samplesPerChunk: 7 });
    const files = await remuxAll(source.blob, { segmentDuration: 1 });
    const recovered: number[] = [];
    for (const seg of files.filter((f) => f.name.endsWith(".m4s"))) {
      recovered.push(...extractMdat(await bytesOf(seg)));
    }
    expect(recovered).toEqual(source.samplePayloads.flatMap((p) => Array.from(p)));
  });

  it("handles 64-bit chunk offsets", async () => {
    const source = makeMp4Blob({ frameCount: 30, gop: 30, use64BitOffsets: true });
    const files = await remuxAll(source.blob, { segmentDuration: 1 });
    const recovered: number[] = [];
    for (const seg of files.filter((f) => f.name.endsWith(".m4s"))) {
      recovered.push(...extractMdat(await bytesOf(seg)));
    }
    expect(recovered).toEqual(source.samplePayloads.flatMap((p) => Array.from(p)));
  });

  it("is unaffected by the read window size", async () => {
    // A tiny window forces many partial reads; output must be identical.
    const source = makeMp4Blob({ frameCount: 40, gop: 20 });
    const big = await remuxAll(source.blob, { segmentDuration: 1 });
    const small = await remuxAll(source.blob, { segmentDuration: 1, readWindow: 64 });

    expect(small.map((f) => f.name)).toEqual(big.map((f) => f.name));
    for (let i = 0; i < big.length; i++) {
      expect(await bytesOf(small[i]!)).toEqual(await bytesOf(big[i]!));
    }
  });
});

describe("output validated by mp4box.js", () => {
  it("parses as a fragmented AVC track with every sample present", async () => {
    const { blob } = makeMp4Blob({ frameCount: 120, gop: 30, width: 640, height: 360 });
    const files = await remuxAll(blob, { segmentDuration: 1 });

    const buffers: Uint8Array[] = [];
    for (const f of files.filter((x) => !x.isManifest)) buffers.push(await bytesOf(f));

    const file = createFile();
    let ready = false;
    let error: unknown = null;
    file.onError = (e: unknown) => {
      error = e;
    };
    file.onReady = () => {
      ready = true;
    };

    let offset = 0;
    for (const b of buffers) {
      file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(b.slice().buffer as ArrayBuffer, offset));
      offset += b.byteLength;
    }
    file.flush();

    expect(error).toBeNull();
    expect(ready).toBe(true);

    const info = file.getInfo() as unknown as {
      isFragmented: boolean;
      tracks: { codec: string; nb_samples: number; video?: { width: number; height: number } }[];
    };
    expect(info.isFragmented).toBe(true);
    expect(info.tracks[0]!.codec).toMatch(/^avc1\./);
    expect(info.tracks[0]!.video?.width).toBe(640);
    expect(info.tracks[0]!.nb_samples).toBe(120);
  });

  it("preserves composition offsets from a source with B-frames", async () => {
    const { blob } = makeMp4Blob({ frameCount: 30, gop: 30, compositionOffset: 3000 });
    const files = await remuxAll(blob, { segmentDuration: 5 });
    const segment = await bytesOf(files.find((f) => f.name.endsWith(".m4s"))!);

    // trun: FullBox(4) + sample_count(4) + data_offset(4), then per-sample
    // duration, size, flags, composition offset.
    const trun = findBox(segment, ["moof", "traf", "trun"]);
    const view = new DataView(trun.buffer, trun.byteOffset, trun.byteLength);
    expect(view.getInt32(12 + 12)).toBe(3000);
  });
});

describe("cancellation and failure", () => {
  it("stops promptly when the signal aborts", async () => {
    const { blob } = makeMp4Blob({ frameCount: 300, gop: 30 });
    const controller = new AbortController();

    const collected: OutputFile[] = [];
    await expect(async () => {
      for await (const f of remux(blob, { segmentDuration: 1, signal: controller.signal })) {
        collected.push(f);
        if (collected.length === 2) controller.abort();
      }
    }).rejects.toThrow();

    // It stopped early rather than running to completion.
    expect(collected.length).toBeLessThan(10);
  });

  it("rejects a truncated file rather than emitting corrupt output", async () => {
    const { bytes } = makeMp4Blob({ frameCount: 60, gop: 30 });
    // Keep the headers, drop most of the media.
    const truncated = new Blob([bytes.slice(0, bytes.length - 2000) as BlobPart]);
    await expect(remuxAll(truncated)).rejects.toThrow();
  });
});

describe("streaming behaviour (what keeps large files viable)", () => {
  /**
   * Wrap a Blob so we can observe when it is read.
   *
   * The flat-memory claim rests on a structural property: output must be
   * produced *while* the source is still being read, never after reading it
   * all. That is deterministic and worth asserting; peak-heap numbers are not.
   */
  function instrument(blob: Blob) {
    const events: string[] = [];
    let bytesRead = 0;
    const proxy = {
      size: blob.size,
      slice(start?: number, end?: number) {
        const part = blob.slice(start, end);
        bytesRead += part.size;
        events.push(`read:${part.size}`);
        return part;
      },
    } as unknown as Blob;
    return { proxy, events, read: () => bytesRead };
  }

  it("emits segments while still reading the source, not after", async () => {
    const { blob } = makeMp4Blob({ frameCount: 600, gop: 30 });
    const { proxy, events } = instrument(blob);

    for await (const file of remux(proxy, { segmentDuration: 1, readWindow: 4096 })) {
      if (file.name.endsWith(".m4s")) events.push(`emit:${file.name}`);
    }

    const firstEmit = events.findIndex((e) => e.startsWith("emit:"));
    const lastRead = events.map((e) => e.startsWith("read:")).lastIndexOf(true);

    expect(firstEmit).toBeGreaterThan(-1);
    // If everything were buffered, every read would precede every emit.
    expect(firstEmit).toBeLessThan(lastRead);
  });

  it("reads little more than the media itself", async () => {
    const source = makeMp4Blob({ frameCount: 600, gop: 30 });
    const { proxy, read } = instrument(source.blob);

    for await (const _ of remux(proxy, { segmentDuration: 2 })) {
      // drain
    }

    const mediaBytes = source.sampleSizes.reduce((a, b) => a + b, 0);
    // Header scanning plus the moov add a little; anything near 2x would mean
    // we are re-reading the file rather than streaming it once.
    expect(read()).toBeGreaterThanOrEqual(mediaBytes);
    expect(read()).toBeLessThan(mediaBytes * 1.5 + 64 * 1024);
  });

  it("handles a long source with many segments", async () => {
    // 6000 frames = 200 seconds at 30 fps, across 34 segments.
    const source = makeMp4Blob({ frameCount: 6000, gop: 30, samplesPerChunk: 30 });
    const files = await remuxAll(source.blob, { segmentDuration: 6 });

    const segments = files.filter((f) => f.name.endsWith(".m4s"));
    expect(segments.length).toBe(34);

    // Nothing may be lost or duplicated over a long run.
    const recovered: number[] = [];
    for (const seg of segments) recovered.push(...extractMdat(await bytesOf(seg)));
    expect(recovered.length).toBe(source.sampleSizes.reduce((a, b) => a + b, 0));
  });
});

// ---- helpers --------------------------------------------------------------

/** Bytes of the `mdat` payload in a segment. */
function extractMdat(segment: Uint8Array): number[] {
  return Array.from(findBox(segment, ["mdat"]));
}

/** Walk a path of nested boxes and return the innermost payload. */
function findBox(buf: Uint8Array, path: string[]): Uint8Array {
  let current = buf;
  for (const want of path) {
    const view = new DataView(current.buffer, current.byteOffset, current.byteLength);
    let at = 0;
    let found: Uint8Array | null = null;
    while (at + 8 <= current.byteLength) {
      const size = view.getUint32(at);
      const kind = String.fromCharCode(
        view.getUint8(at + 4), view.getUint8(at + 5),
        view.getUint8(at + 6), view.getUint8(at + 7),
      );
      if (size < 8) break;
      if (kind === want) {
        found = current.subarray(at + 8, at + size);
        break;
      }
      at += size;
    }
    if (!found) throw new Error(`box '${want}' not found`);
    current = found;
  }
  return current;
}

describe("resume after an interruption", () => {
  /** Package `blob`, stopping after `stopAfter` segments as if the tab closed. */
  async function partialRun(blob: Blob, stopAfter: number) {
    const files: OutputFile[] = [];
    const completed: { index: number; duration: number; samplesProcessed: number }[] = [];

    for await (const f of remux(blob, {
      prefix: "720p",
      segmentDuration: 1,
      onSegment: (info) => completed.push(info),
    })) {
      files.push(f);
      if (completed.length >= stopAfter) break; // simulate the tab closing
    }
    return { files, completed };
  }

  it("produces byte-identical output to an uninterrupted run", async () => {
    const source = makeMp4Blob({ frameCount: 300, gop: 30 });

    const whole = await remuxAll(source.blob, { prefix: "720p", segmentDuration: 1 });

    const { files: partial, completed } = await partialRun(source.blob, 4);
    const resumed: OutputFile[] = [];
    for await (const f of remux(source.blob, {
      prefix: "720p",
      segmentDuration: 1,
      resume: {
        completedSegmentDurations: completed.map((c) => c.duration),
        samplesProcessed: completed.at(-1)!.samplesProcessed,
      },
    })) {
      resumed.push(f);
    }

    // Stitch: only the segments the first run actually *confirmed* (those with
    // an onSegment callback), then everything the resume produced. A segment
    // yielded but not confirmed is exactly the one a crash would have lost, and
    // the resume re-creates it.
    const stitched = [
      ...partial.filter((f) => f.name.endsWith(".m4s")).slice(0, completed.length),
      ...resumed.filter((f) => f.name.endsWith(".m4s")),
    ];
    const expected = whole.filter((f) => f.name.endsWith(".m4s"));

    expect(stitched.map((f) => f.name)).toEqual(expected.map((f) => f.name));
    for (let i = 0; i < expected.length; i++) {
      expect(await bytesOf(stitched[i]!), stitched[i]!.name).toEqual(await bytesOf(expected[i]!));
    }
  });

  it("writes a playlist listing every segment, restored and new alike", async () => {
    const source = makeMp4Blob({ frameCount: 300, gop: 30 });
    const { completed } = await partialRun(source.blob, 4);

    let playlist = "";
    for await (const f of remux(source.blob, {
      prefix: "720p",
      segmentDuration: 1,
      resume: {
        completedSegmentDurations: completed.map((c) => c.duration),
        samplesProcessed: completed.at(-1)!.samplesProcessed,
      },
    })) {
      if (f.isManifest) playlist = await f.blob.text();
    }

    // All ten segments must be indexed, or playback stops at the resume point.
    expect(playlist.match(/#EXTINF/g)).toHaveLength(10);
    expect(playlist).toContain("720p_00000.m4s");
    expect(playlist).toContain("720p_00009.m4s");
    expect(playlist).toContain("#EXT-X-ENDLIST");
  });

  it("does not redo work already completed", async () => {
    const source = makeMp4Blob({ frameCount: 300, gop: 30 });
    const { completed } = await partialRun(source.blob, 5);

    const produced: number[] = [];
    for await (const _ of remux(source.blob, {
      prefix: "720p",
      segmentDuration: 1,
      resume: {
        completedSegmentDurations: completed.map((c) => c.duration),
        samplesProcessed: completed.at(-1)!.samplesProcessed,
      },
      onSegment: ({ index }) => produced.push(index),
    })) {
      // drain
    }

    // Five segments were done; only 5..9 should be produced now.
    expect(produced).toEqual([5, 6, 7, 8, 9]);
  });

  it("resuming from nothing behaves like a fresh run", async () => {
    const source = makeMp4Blob({ frameCount: 60, gop: 30 });
    const fresh = await remuxAll(source.blob, { segmentDuration: 1 });
    const resumed = await remuxAll(source.blob, {
      segmentDuration: 1,
      resume: { completedSegmentDurations: [], samplesProcessed: 0 },
    });

    expect(resumed.map((f) => f.name)).toEqual(fresh.map((f) => f.name));
  });

  it("keeps the decode timeline continuous across the resume point", async () => {
    const source = makeMp4Blob({ frameCount: 120, gop: 30 });
    const { completed } = await partialRun(source.blob, 2);

    let firstResumedSegment: OutputFile | undefined;
    for await (const f of remux(source.blob, {
      prefix: "720p",
      segmentDuration: 1,
      resume: {
        completedSegmentDurations: completed.map((c) => c.duration),
        samplesProcessed: completed.at(-1)!.samplesProcessed,
      },
    })) {
      if (f.name.endsWith(".m4s") && !firstResumedSegment) firstResumedSegment = f;
    }

    // Two 1-second segments preceded it, so tfdt must be 2 * timescale.
    const tfdt = findBox(await bytesOf(firstResumedSegment!), ["moof", "traf", "tfdt"]);
    const view = new DataView(tfdt.buffer, tfdt.byteOffset, tfdt.byteLength);
    expect(Number(view.getBigUint64(4))).toBe(2 * 90_000);
  });
});
