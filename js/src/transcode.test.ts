/**
 * Transcode internals that do not need WebCodecs.
 *
 * These exist because a real bug shipped here and no test could have caught it:
 * `transcode()` needs `VideoEncoder`, which Node does not have, so the whole
 * module was uncovered. A ladder upload to Appwrite hung — no error, no output,
 * no completion — because the backpressure loop waited for an encoder queue to
 * drain after the encoder had already died. The loop and the master playlist
 * are pulled out far enough to be exercised with plain objects.
 */

import { describe, expect, it } from "vitest";

import {
  applyBackpressure,
  buildMaster,
  type BackpressureRung,
  type MasterVariant,
} from "./transcode.js";

function rung(over: Partial<BackpressureRung> = {}): BackpressureRung {
  return {
    name: "video_1080p",
    width: 1920,
    height: 1080,
    bitrate: 5_000_000,
    encoder: { encodeQueueSize: 0, state: "configured" },
    ...over,
  };
}

describe("backpressure", () => {
  it("returns immediately when no encoder is behind", async () => {
    await expect(applyBackpressure([rung()])).resolves.toBeUndefined();
  });

  it("waits while an encoder is behind, then continues when it drains", async () => {
    const r = rung({ encoder: { encodeQueueSize: 99, state: "configured" } });
    const waiting = applyBackpressure([r]);

    // Nothing should have settled yet.
    let settled = false;
    void waiting.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    r.encoder.encodeQueueSize = 0;
    await expect(waiting).resolves.toBeUndefined();
  });

  it("throws the encoder's own error instead of waiting forever", async () => {
    // The regression: the queue of a failed encoder never drains, so a loop
    // that only watches encodeQueueSize spins until the tab is closed.
    const boom = new Error("Encoding error: too many concurrent encoders");
    const r = rung({ encoder: { encodeQueueSize: 99, state: "closed" }, error: boom });

    await expect(applyBackpressure([r])).rejects.toThrow(boom);
  });

  it("reports a closed encoder that never delivered an error", async () => {
    const r = rung({ encoder: { encodeQueueSize: 99, state: "closed" } });

    // The message has to name the rung and the bitrate: with a ladder, one
    // rung failing while the others are fine is the common case.
    await expect(applyBackpressure([r])).rejects.toThrow(/video_1080p.*1920x1080.*5000 kbps/s);
  });

  it("fails on a dead rung even when another rung is healthy", async () => {
    const healthy = rung({ name: "video_480p", encoder: { encodeQueueSize: 0, state: "configured" } });
    const dead = rung({ encoder: { encodeQueueSize: 99, state: "closed" } });

    await expect(applyBackpressure([healthy, dead])).rejects.toThrow(/video_1080p/);
  });

  it("still honours an abort", async () => {
    const controller = new AbortController();
    const r = rung({ encoder: { encodeQueueSize: 99, state: "configured" } });
    const waiting = applyBackpressure([r], controller.signal);

    controller.abort();
    await expect(waiting).rejects.toThrow();
  });
});

describe("master playlist", () => {
  function variant(over: Partial<MasterVariant> = {}): MasterVariant {
    return {
      bitrate: 5_000_000,
      width: 1920,
      height: 1080,
      codec: "avc1.4d0028",
      audioSampleEntry: null,
      segmenter: { playlistName: () => "video_1080p.m3u8" },
      ...over,
    };
  }

  it("advertises the codec the encoder was configured with", () => {
    // The regression: `avc1.42e01e` (Baseline 3.0) was hardcoded for every
    // rung. That level cannot express 1080p, so the master described a stream
    // that cannot exist and a strict player may refuse the variant outright.
    const master = buildMaster("video", [variant()]);
    expect(master).toContain('CODECS="avc1.4d0028"');
    expect(master).not.toContain("42e01e");
  });

  it("declares AAC as well when the rung carries audio", () => {
    const master = buildMaster("video", [variant({ audioSampleEntry: new Uint8Array([1, 2, 3]) })]);
    expect(master).toContain('CODECS="avc1.4d0028,mp4a.40.2"');
  });

  it("orders variants highest bandwidth first", () => {
    const master = buildMaster("video", [
      variant({ bitrate: 1_200_000, height: 480, width: 854, segmenter: { playlistName: () => "video_480p.m3u8" } }),
      variant({ bitrate: 5_000_000 }),
    ]);
    // Players take the first entry as their initial pick.
    expect(master.indexOf("video_1080p.m3u8")).toBeLessThan(master.indexOf("video_480p.m3u8"));
  });

  it("skips a rung that produced nothing", () => {
    const master = buildMaster("video", [variant({ segmenter: undefined })]);
    expect(master).not.toContain("EXT-X-STREAM-INF");
  });

  it("carries the resolution and bandwidth a player needs to choose", () => {
    const master = buildMaster("video", [variant()]);
    expect(master).toContain("BANDWIDTH=5000000");
    expect(master).toContain("RESOLUTION=1920x1080");
    expect(master.startsWith("#EXTM3U")).toBe(true);
  });
});
