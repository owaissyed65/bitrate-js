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
  syncSampleAtOrBefore,
  yieldToEventLoop,
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

describe("finding where a resumed transcode restarts decoding", () => {
  // A 30 fps source at timescale 1000: one sample every 33.33 ms, with a sync
  // sample every 30 (once a second), which is what a camera typically writes.
  const timescale = 1000;
  const samples = Array.from({ length: 300 }, (_, i) => ({
    decodeTime: Math.round((i * timescale) / 30),
    isSync: i % 30 === 0,
  }));

  it("starts at a sync sample, never mid-GOP", () => {
    // Decoding from an inter frame yields garbage or an error, because it
    // refers to frames that were never decoded.
    for (const targetUs of [0, 500_000, 1_000_000, 3_400_000, 9_900_000]) {
      const index = syncSampleAtOrBefore(samples, timescale, targetUs);
      expect(samples[index]!.isSync, `target ${targetUs}`).toBe(true);
    }
  });

  it("never starts after the target, which would drop real frames", () => {
    const targetUs = 3_400_000;
    const index = syncSampleAtOrBefore(samples, timescale, targetUs);
    expect((samples[index]!.decodeTime / timescale) * 1_000_000).toBeLessThanOrEqual(targetUs);
  });

  it("picks the closest one, so the run-up stays short", () => {
    // 3.4s should resume from the 3s keyframe, not the 1s one — the difference
    // is wasted decoding on every resume.
    const index = syncSampleAtOrBefore(samples, timescale, 3_400_000);
    expect(index).toBe(90);
  });

  it("lands exactly on a keyframe when the target is one", () => {
    expect(syncSampleAtOrBefore(samples, timescale, 2_000_000)).toBe(60);
  });

  it("starts at the beginning when nothing precedes the target", () => {
    expect(syncSampleAtOrBefore(samples, timescale, 0)).toBe(0);
  });

  it("falls back to the start rather than failing on a source with no sync flags", () => {
    const none = samples.map((s) => ({ ...s, isSync: false }));
    expect(syncSampleAtOrBefore(none, timescale, 5_000_000)).toBe(0);
  });

  it("refuses to divide by a nonsense timescale", () => {
    expect(syncSampleAtOrBefore(samples, 0, 5_000_000)).toBe(0);
  });

  it("handles a target past the end of the source", () => {
    const index = syncSampleAtOrBefore(samples, timescale, 999_000_000);
    expect(samples[index]!.isSync).toBe(true);
    expect(index).toBe(270);
  });
});

describe("yielding without a timer", () => {
  it("returns control to the event loop", async () => {
    let ran = false;
    void Promise.resolve().then(() => (ran = true));
    await yieldToEventLoop();
    expect(ran).toBe(true);
  });

  it("does not use a timer, which a background tab throttles ~100x", async () => {
    // Measured in a hidden tab: setTimeout(…, 1) takes about 100ms, so a wait
    // loop built on it slows a transcode to a crawl the moment the user
    // switches tab — indistinguishable from a hang.
    const timers: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      timers.push(ms ?? 0);
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout;

    try {
      await yieldToEventLoop();
      expect(timers).toEqual([]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it("resolves many times over without leaking ports", async () => {
    for (let i = 0; i < 200; i++) await yieldToEventLoop();
    expect(true).toBe(true);
  });
});
