/**
 * Audio support: a source with sound must come out with sound.
 *
 * The pipeline copies audio frames verbatim, muxes them as a second track in
 * the same segments as the video, and keeps the two timelines aligned. All
 * three are checked here, and mp4box.js is used as an independent judge of the
 * resulting container.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createFile, MP4BoxBuffer } from "mp4box";
import { beforeAll, describe, expect, it } from "vitest";

import { inspect, remux, type OutputFile } from "./remux.js";
import { AAC_FRAME_SAMPLES, makeMp4Blob } from "./testing/make-mp4.js";
import { ensureWasm } from "./wasm-loader.js";

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL("./wasm/bitrate_core_bg.wasm", import.meta.url));
  await ensureWasm(await readFile(wasmPath));
});

const bytesOf = async (f: OutputFile) => new Uint8Array(await f.blob.arrayBuffer());

async function remuxAll(blob: Blob, options = {}): Promise<OutputFile[]> {
  const out: OutputFile[] = [];
  for await (const file of remux(blob, options)) out.push(file);
  return out;
}

/**
 * A 4-second source: 120 video frames at 30fps and 172 AAC frames at 44.1kHz
 * (172 × 1024 / 44100 ≈ 3.99s), so the two tracks cover the same span.
 */
function sourceWithAudio(frameCount = 120, gop = 30) {
  const seconds = frameCount / 30;
  const audioFrames = Math.round((seconds * 44_100) / AAC_FRAME_SAMPLES);
  return makeMp4Blob({ frameCount, gop, audioFrames, samplesPerChunk: 30 });
}

// ---- box helpers ----------------------------------------------------------

function boxesOf(buf: Uint8Array): { kind: string; payload: Uint8Array }[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: { kind: string; payload: Uint8Array }[] = [];
  let at = 0;
  while (at + 8 <= buf.byteLength) {
    const size = view.getUint32(at);
    if (size < 8) break;
    const kind = String.fromCharCode(
      view.getUint8(at + 4), view.getUint8(at + 5),
      view.getUint8(at + 6), view.getUint8(at + 7),
    );
    out.push({ kind, payload: buf.subarray(at + 8, Math.min(at + size, buf.byteLength)) });
    at += size;
  }
  return out;
}

function child(buf: Uint8Array, kind: string): Uint8Array {
  const found = boxesOf(buf).find((b) => b.kind === kind);
  if (!found) throw new Error(`box '${kind}' not found`);
  return found.payload;
}

const be32 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at);
const be64 = (b: Uint8Array, at: number) =>
  Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at));

/** The `traf` payloads of a segment, in order (video then audio). */
const trafs = (segment: Uint8Array) =>
  boxesOf(child(segment, "moof")).filter((b) => b.kind === "traf").map((b) => b.payload);

// ---- detection ------------------------------------------------------------

describe("detecting audio", () => {
  it("reports an audio track when the source has one", async () => {
    const { blob } = sourceWithAudio();
    const info = await inspect(blob);
    expect(info.hasAudio).toBe(true);
    expect(info.audioTimescale).toBe(44_100);
    expect(info.audioSampleCount).toBeGreaterThan(100);
  });

  it("reports a silent source as silent", async () => {
    const { blob } = makeMp4Blob({ frameCount: 30, gop: 30 });
    const info = await inspect(blob);
    expect(info.hasAudio).toBe(false);
    expect(info.audioSampleCount).toBe(0);
  });
});

// ---- output structure -----------------------------------------------------

describe("output carries both tracks", () => {
  it("declares two tracks in the init segment", async () => {
    const { blob } = sourceWithAudio();
    const files = await remuxAll(blob, { segmentDuration: 1 });
    const moov = child(await bytesOf(files[0]!), "moov");

    expect(boxesOf(moov).filter((b) => b.kind === "trak")).toHaveLength(2);
    // Without a trex per track, players reject the fragments.
    expect(boxesOf(child(moov, "mvex")).filter((b) => b.kind === "trex")).toHaveLength(2);
  });

  it("preserves the source mp4a sample entry, esds included", async () => {
    const { blob } = sourceWithAudio();
    const files = await remuxAll(blob, { segmentDuration: 1 });
    const moov = child(await bytesOf(files[0]!), "moov");
    const audioTrak = boxesOf(moov).filter((b) => b.kind === "trak")[1]!.payload;

    const stsd = child(child(child(child(audioTrak, "mdia"), "minf"), "stbl"), "stsd");
    const entry = boxesOf(stsd.subarray(8))[0]!;
    expect(entry.kind).toBe("mp4a");
    // The decoder cannot initialize without this.
    expect(boxesOf(entry.payload.subarray(28)).some((b) => b.kind === "esds")).toBe(true);
  });

  it("puts both tracks in every media segment", async () => {
    const { blob } = sourceWithAudio();
    const files = await remuxAll(blob, { segmentDuration: 1 });
    const segments = files.filter((f) => f.name.endsWith(".m4s"));
    expect(segments.length).toBeGreaterThan(1);

    for (const seg of segments) {
      const runs = trafs(await bytesOf(seg));
      expect(runs, seg.name).toHaveLength(2);
      expect(be32(child(runs[0]!, "tfhd"), 4)).toBe(1); // video
      expect(be32(child(runs[1]!, "tfhd"), 4)).toBe(2); // audio
    }
  });

  it("keeps a silent source single-track", async () => {
    const { blob } = makeMp4Blob({ frameCount: 60, gop: 30 });
    const files = await remuxAll(blob, { segmentDuration: 1 });
    const moov = child(await bytesOf(files[0]!), "moov");
    expect(boxesOf(moov).filter((b) => b.kind === "trak")).toHaveLength(1);
    expect(trafs(await bytesOf(files[1]!))).toHaveLength(1);
  });
});

// ---- fidelity -------------------------------------------------------------

describe("audio fidelity", () => {
  it("reproduces every audio frame byte-for-byte", async () => {
    const source = sourceWithAudio();
    const files = await remuxAll(source.blob, { segmentDuration: 1 });

    // Each segment's mdat is video bytes then audio bytes; recover the audio
    // half using the video run's total size.
    const recovered: number[] = [];
    for (const seg of files.filter((f) => f.name.endsWith(".m4s"))) {
      const data = await bytesOf(seg);
      const mdat = child(data, "mdat");
      const runs = trafs(data);
      const videoBytes = sumTrunSizes(runs[0]!);
      recovered.push(...Array.from(mdat.subarray(videoBytes)));
    }

    const expected = source.audioPayloads.flatMap((p) => Array.from(p));
    expect(recovered).toEqual(expected);
  });

  it("loses no audio frames across the whole file", async () => {
    const source = sourceWithAudio();
    const files = await remuxAll(source.blob, { segmentDuration: 1 });

    let count = 0;
    for (const seg of files.filter((f) => f.name.endsWith(".m4s"))) {
      count += be32(child(trafs(await bytesOf(seg))[1]!, "trun"), 4);
    }
    expect(count).toBe(source.audioPayloads.length);
  });

  it("advances the audio timeline in the audio timescale", async () => {
    const { blob } = sourceWithAudio();
    const files = await remuxAll(blob, { segmentDuration: 1 });
    const segments = files.filter((f) => f.name.endsWith(".m4s"));

    let expectedTicks = 0;
    for (const seg of segments) {
      const runs = trafs(await bytesOf(seg));
      const tfdt = child(runs[1]!, "tfdt");
      // A restarted or video-scaled tfdt would desynchronise the audio.
      expect(be64(tfdt, 4), seg.name).toBe(expectedTicks);
      expectedTicks += be32(child(runs[1]!, "trun"), 4) * AAC_FRAME_SAMPLES;
    }
  });

  it("keeps audio and video within a segment of each other", async () => {
    const { blob } = sourceWithAudio();
    const files = await remuxAll(blob, { segmentDuration: 1 });

    for (const seg of files.filter((f) => f.name.endsWith(".m4s"))) {
      const runs = trafs(await bytesOf(seg));
      const videoSeconds = be64(child(runs[0]!, "tfdt"), 4) / 90_000;
      const audioSeconds = be64(child(runs[1]!, "tfdt"), 4) / 44_100;
      // Drift here is exactly what makes lips stop matching speech.
      expect(Math.abs(videoSeconds - audioSeconds), seg.name).toBeLessThan(0.1);
    }
  });
});

/** Total of a `trun`'s per-sample sizes. */
function sumTrunSizes(traf: Uint8Array): number {
  const trun = child(traf, "trun");
  const count = be32(trun, 4);
  let total = 0;
  // FullBox(4) + sample_count(4) + data_offset(4), then 16 bytes per sample.
  for (let i = 0; i < count; i++) total += be32(trun, 12 + i * 16 + 4);
  return total;
}

// ---- independent validation ----------------------------------------------

describe("validated by mp4box.js", () => {
  it("parses as two tracks with every sample present", async () => {
    const source = sourceWithAudio();
    const files = await remuxAll(source.blob, { segmentDuration: 1 });

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
    for (const f of files.filter((x) => !x.isManifest)) {
      const b = await bytesOf(f);
      file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(b.slice().buffer as ArrayBuffer, offset));
      offset += b.byteLength;
    }
    file.flush();

    expect(error).toBeNull();
    expect(ready).toBe(true);

    const info = file.getInfo() as unknown as {
      isFragmented: boolean;
      tracks: { codec: string; nb_samples: number; type?: string; audio?: unknown }[];
      videoTracks?: unknown[];
      audioTracks?: unknown[];
    };

    expect(info.tracks).toHaveLength(2);
    expect(info.videoTracks).toHaveLength(1);
    expect(info.audioTracks).toHaveLength(1);

    const video = info.tracks.find((t) => t.codec.startsWith("avc1"))!;
    const audio = info.tracks.find((t) => t.codec.startsWith("mp4a"))!;
    expect(video.nb_samples).toBe(120);
    expect(audio.nb_samples).toBe(source.audioPayloads.length);
  });
});

// ---- resume ---------------------------------------------------------------

describe("resume with audio", () => {
  it("continues both tracks from the checkpoint", async () => {
    const source = sourceWithAudio(300, 30);

    const whole = await remuxAll(source.blob, { prefix: "a", segmentDuration: 1 });
    const wholeSegments = whole.filter((f) => f.name.endsWith(".m4s"));

    // Stop after four confirmed segments, as a closed tab would.
    const completed: {
      duration: number;
      samplesProcessed: number;
      audioSamplesProcessed: number;
    }[] = [];
    const partial: OutputFile[] = [];
    for await (const f of remux(source.blob, {
      prefix: "a",
      segmentDuration: 1,
      onSegment: (info) => completed.push(info),
    })) {
      partial.push(f);
      if (completed.length >= 4) break;
    }

    const resumed: OutputFile[] = [];
    for await (const f of remux(source.blob, {
      prefix: "a",
      segmentDuration: 1,
      resume: {
        completedSegmentDurations: completed.map((c) => c.duration),
        samplesProcessed: completed.at(-1)!.samplesProcessed,
        audioSamplesProcessed: completed.at(-1)!.audioSamplesProcessed,
      },
    })) {
      resumed.push(f);
    }

    const stitched = [
      ...partial.filter((f) => f.name.endsWith(".m4s")).slice(0, completed.length),
      ...resumed.filter((f) => f.name.endsWith(".m4s")),
    ];
    expect(stitched.map((f) => f.name)).toEqual(wholeSegments.map((f) => f.name));

    // Audio must be skipped by time, not by frame count — the tracks have
    // different rates, so a naive skip would drop or duplicate sound.
    for (let i = 0; i < wholeSegments.length; i++) {
      expect(await bytesOf(stitched[i]!), stitched[i]!.name).toEqual(
        await bytesOf(wholeSegments[i]!),
      );
    }
  });
});

describe("fragmented sources", () => {
  /**
   * Our own output is a fragmented MP4, so feeding it back in exercises exactly
   * what a user hits with a fragmented source file — and the expected result is
   * known precisely, because the same pipeline produced it.
   */
  async function refragment(frameCount: number, gop: number, segmentDuration: number) {
    const source = sourceWithAudio(frameCount, gop);
    const files = await remuxAll(source.blob, { segmentDuration });

    const parts: BlobPart[] = [];
    for (const f of files.filter((x) => !x.isManifest)) parts.push(await f.blob.arrayBuffer());
    return { source, fragmented: new Blob(parts, { type: "video/mp4" }) };
  }

  it("reads the samples out of moof boxes", async () => {
    const { source, fragmented } = await refragment(120, 30, 2);
    const info = await inspect(fragmented);

    // Every frame the original had must be recovered from the fragments.
    expect(info.sampleCount).toBe(120);
    expect(info.width).toBe(1280);
    expect(info.height).toBe(720);
    expect(info.duration).toBeCloseTo(4.0, 2);
    expect(info.hasAudio).toBe(true);
    expect(info.audioSampleCount).toBe(source.audioPayloads.length);
  });

  it("packages a fragmented source into playable HLS", async () => {
    const { fragmented } = await refragment(120, 30, 2);
    const files = await remuxAll(fragmented, { prefix: "refrag", segmentDuration: 1 });

    expect(files.filter((f) => f.name.endsWith(".m4s")).length).toBeGreaterThan(1);
    const playlist = await files.find((f) => f.isManifest)!.blob.text();
    expect(playlist).toContain("#EXT-X-ENDLIST");
  });

  it("preserves frame bytes through a fragmented round trip", async () => {
    const source = sourceWithAudio(90, 30);

    // Package once, feed the result back, package again: the frames must
    // survive both passes untouched.
    const first = await remuxAll(source.blob, { segmentDuration: 3 });
    const parts: BlobPart[] = [];
    for (const f of first.filter((x) => !x.isManifest)) parts.push(await f.blob.arrayBuffer());

    const second = await remuxAll(new Blob(parts), { segmentDuration: 3 });

    const recovered: number[] = [];
    for (const seg of second.filter((f) => f.name.endsWith(".m4s"))) {
      const data = await bytesOf(seg);
      const mdat = child(data, "mdat");
      const runs = trafs(data);
      const videoBytes = sumTrunSizes(runs[0]!);
      recovered.push(...Array.from(mdat.subarray(0, videoBytes)));
    }

    expect(recovered).toEqual(source.samplePayloads.flatMap((p) => Array.from(p)));
  });

  it("keeps keyframe positions, so segments still start on one", async () => {
    const { fragmented } = await refragment(120, 30, 2);
    const files = await remuxAll(fragmented, { segmentDuration: 1 });

    for (const seg of files.filter((f) => f.name.endsWith(".m4s"))) {
      const trun = child(trafs(await bytesOf(seg))[0]!, "trun");
      // First sample flags sit 8 bytes into the first entry.
      expect(be32(trun, 12 + 8), seg.name).toBe(0x0200_0000);
    }
  });

  it("reports a fragmented file that carries no fragments", async () => {
    // Just the init segment: a complete moov that declares fragmentation, with
    // no moof boxes behind it. Saying "no samples" beats reporting 0.0s.
    const source = sourceWithAudio(60, 30);
    const files = await remuxAll(source.blob, { segmentDuration: 2 });
    const initOnly = files[0]!.blob;

    await expect(inspect(initOnly)).rejects.toThrow(/no 'moof' boxes|no samples/i);
  });
});
