/**
 * M1 acceptance: validate our fMP4 output against an *independent* parser.
 *
 * The Rust tests check the muxer against our own understanding of ISO-BMFF.
 * These check it against mp4box.js — a widely used, separately written
 * implementation — so a misreading of the spec shows up here rather than in a
 * browser that silently refuses to play.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createFile, MP4BoxBuffer } from "mp4box";
import { beforeAll, describe, expect, it } from "vitest";

import init, { Fmp4Segmenter } from "./wasm/bitrate_core.js";

/** A valid avcC record for H.264 Baseline 3.1. */
const AVCC = new Uint8Array([
  0x01, 0x42, 0xc0, 0x1f, 0xff, 0xe1, 0x00, 0x09, 0x67, 0x42, 0xc0, 0x1f, 0x8c, 0x8d, 0x40, 0x50,
  0x1e, 0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
]);

const TIMESCALE = 90_000;
const FRAME = 3_000; // 30 fps

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL("./wasm/bitrate_core_bg.wasm", import.meta.url));
  await init({ module_or_path: await readFile(wasmPath) });
});

/** mp4box.js requires each appended buffer to carry its byte offset. */
function withFileStart(bytes: Uint8Array, fileStart: number): MP4BoxBuffer {
  return MP4BoxBuffer.fromArrayBuffer(bytes.slice().buffer as ArrayBuffer, fileStart);
}

/** Produce a complete rendition: init segment plus every media segment. */
function renditionOf(targetSeconds: number, frames: number, gop: number) {
  const seg = new Fmp4Segmenter("720p", TIMESCALE, 1280, 720, AVCC, targetSeconds);
  const initSegment = seg.initSegment();

  for (let i = 0; i < frames; i++) {
    seg.pushSample(new Uint8Array(120).fill(i % 251), FRAME, i % gop === 0, 0);
  }
  seg.finish();

  const segments: { data: Uint8Array; duration: number; index: number }[] = [];
  for (;;) {
    const s = seg.takeSegment();
    if (!s) break;
    segments.push({ data: s.data, duration: s.duration, index: s.index });
  }
  return { initSegment, segments, playlist: seg.playlistText() };
}

/**
 * Feed bytes to mp4box.js and return the movie info once everything is parsed.
 *
 * `onReady` fires as soon as the `moov` is seen — i.e. after the init segment,
 * when no samples exist yet — so per-sample figures must be read from
 * `getInfo()` after every fragment has been appended.
 */
function parseWithMp4Box(buffers: Uint8Array[]): Record<string, unknown> {
  const file = createFile();
  let error: unknown = null;
  let sawMoov = false;
  file.onError = (e: unknown) => {
    error = e;
  };
  file.onReady = () => {
    sawMoov = true;
  };

  let offset = 0;
  for (const b of buffers) {
    file.appendBuffer(withFileStart(b, offset));
    offset += b.byteLength;
  }
  file.flush();

  if (error !== null) throw new Error(`mp4box rejected the stream: ${String(error)}`);
  if (!sawMoov) throw new Error("mp4box never found a moov — the init segment is malformed");
  return file.getInfo() as unknown as Record<string, unknown>;
}

describe("fMP4 output validated by mp4box.js", () => {
  it("parses the init segment and reports a fragmented AVC video track", () => {
    const { initSegment } = renditionOf(1, 60, 30);
    const info = (parseWithMp4Box([initSegment])) as {
      isFragmented: boolean;
      tracks: { codec: string; video?: { width: number; height: number }; timescale: number }[];
    };

    expect(info.isFragmented).toBe(true);
    expect(info.tracks).toHaveLength(1);

    const track = info.tracks[0]!;
    // A wrong avcC would surface here as a missing or malformed codec string.
    expect(track.codec).toMatch(/^avc1\./);
    expect(track.timescale).toBe(TIMESCALE);
    expect(track.video?.width).toBe(1280);
    expect(track.video?.height).toBe(720);
  });

  it("accepts init + media segments as a complete, parseable stream", () => {
    const { initSegment, segments } = renditionOf(1, 120, 30);
    expect(segments.length).toBe(4);

    const info = (parseWithMp4Box([initSegment, ...segments.map((s) => s.data)])) as {
      tracks: { nb_samples: number }[];
    };

    // Every pushed frame must be visible to the parser — a bad trun would drop
    // samples or overcount them.
    expect(info.tracks[0]!.nb_samples).toBe(120);
  });

  it("reports the correct duration across segments", () => {
    const { initSegment, segments } = renditionOf(1, 120, 30);
    const info = (parseWithMp4Box([initSegment, ...segments.map((s) => s.data)])) as {
      tracks: { samples_duration: number; timescale: number }[];
    };

    const track = info.tracks[0]!;
    expect(track.samples_duration / track.timescale).toBeCloseTo(4.0, 6);
  });

  it("extracts samples with byte-accurate sizes", async () => {
    const { initSegment, segments } = renditionOf(1, 60, 30);

    const sizes = await new Promise<number[]>((resolve, reject) => {
      const file = createFile();
      const collected: number[] = [];
      file.onError = (e: unknown) => reject(new Error(String(e)));
      file.onReady = (info: { tracks: { id: number }[] }) => {
        file.setExtractionOptions(info.tracks[0]!.id, null, { nbSamples: 60 });
        file.onSamples = (_id: number, _user: unknown, samples: { size: number }[]) => {
          collected.push(...samples.map((s) => s.size));
          if (collected.length >= 60) resolve(collected);
        };
        file.start();
      };

      let offset = 0;
      for (const b of [initSegment, ...segments.map((s) => s.data)]) {
        file.appendBuffer(withFileStart(b, offset));
        offset += b.byteLength;
      }
      file.flush();
      setTimeout(() => reject(new Error("no samples extracted")), 3000);
    });

    expect(sizes).toHaveLength(60);
    // Every sample we pushed was 120 bytes; a wrong data_offset would corrupt these.
    expect(sizes.every((s) => s === 120)).toBe(true);
  });

  it("produces segments that each parse on their own after the init segment", () => {
    const { initSegment, segments } = renditionOf(1, 120, 30);

    // Seeking works by fetching one segment; each must be independently usable.
    for (const seg of segments) {
      const info = (parseWithMp4Box([initSegment, seg.data])) as {
        tracks: { nb_samples: number }[];
      };
      expect(info.tracks[0]!.nb_samples).toBe(30);
    }
  });
});

describe("playlist matches the segments produced", () => {
  it("lists every segment with its real duration", () => {
    const { segments, playlist } = renditionOf(1, 120, 30);

    expect(playlist).toContain('#EXT-X-MAP:URI="720p_init.mp4"');
    expect(playlist).toContain("#EXT-X-ENDLIST");
    expect(playlist.match(/#EXTINF/g)).toHaveLength(segments.length);

    for (const seg of segments) {
      const name = `720p_${String(seg.index).padStart(5, "0")}.m4s`;
      expect(playlist).toContain(name);
    }
  });

  it("declares a target duration no smaller than any segment", () => {
    const { segments, playlist } = renditionOf(2, 120, 30);
    const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(playlist)?.[1]);
    const longest = Math.max(...segments.map((s) => s.duration));
    // A target below the real maximum is a spec violation players may reject.
    expect(target).toBeGreaterThanOrEqual(Math.ceil(longest));
  });
});

describe("segmenter input validation surfaces as JS errors", () => {
  it.each([
    ["zero timescale", () => new Fmp4Segmenter("a", 0, 640, 480, AVCC, 6)],
    ["zero width", () => new Fmp4Segmenter("a", TIMESCALE, 0, 480, AVCC, 6)],
    ["absurd dimensions", () => new Fmp4Segmenter("a", TIMESCALE, 20000, 480, AVCC, 6)],
    ["empty avcC", () => new Fmp4Segmenter("a", TIMESCALE, 640, 480, new Uint8Array(), 6)],
    ["non-finite target", () => new Fmp4Segmenter("a", TIMESCALE, 640, 480, AVCC, Number.NaN)],
  ])("rejects %s", (_label, make) => {
    expect(make).toThrow();
  });

  it("rejects an empty sample without corrupting the segmenter", () => {
    const seg = new Fmp4Segmenter("a", TIMESCALE, 640, 480, AVCC, 6);
    expect(() => seg.pushSample(new Uint8Array(), FRAME, true, 0)).toThrow();
    // The segmenter must remain usable after a rejected sample.
    expect(() => seg.pushSample(new Uint8Array([1, 2, 3]), FRAME, true, 0)).not.toThrow();
  });
});
