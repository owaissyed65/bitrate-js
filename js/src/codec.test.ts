/**
 * Codec string selection.
 *
 * These exist because a hardcoded `avc1.42e01e` (Baseline level 3.0) was used
 * for every source and every rung. That level cannot express 1080p, so a real
 * 1920x1080 file closed the codec on configure and only surfaced later as
 * "Cannot call 'flush' on a closed codec" — an error naming neither the cause
 * nor the file.
 */

import { describe, expect, it } from "vitest";

import { codecStringFromAvcC, LADDERS, levelForFrame, planLadder } from "./transcode.js";

/** Build an avcC header with the given profile, constraints and level. */
function avcC(profile: number, constraints: number, level: number): Uint8Array {
  return new Uint8Array([0x01, profile, constraints, level, 0xff, 0xe1]);
}

describe("reading the codec string from a source", () => {
  it.each([
    ["Baseline 3.0", 0x42, 0xe0, 0x1e, "avc1.42e01e"],
    ["Main 3.1", 0x4d, 0x40, 0x1f, "avc1.4d401f"],
    ["High 4.0", 0x64, 0x00, 0x28, "avc1.640028"],
    ["High 5.1", 0x64, 0x00, 0x33, "avc1.640033"],
  ])("reads %s", (_label, profile, constraints, level, expected) => {
    expect(codecStringFromAvcC(avcC(profile, constraints, level))).toBe(expected);
  });

  it("pads single-digit bytes so the string stays 6 hex digits", () => {
    expect(codecStringFromAvcC(avcC(0x42, 0x00, 0x0a))).toBe("avc1.42000a");
  });

  it("rejects a truncated record instead of producing a nonsense codec", () => {
    expect(() => codecStringFromAvcC(new Uint8Array([1, 2]))).toThrow(/too short/);
  });
});

describe("choosing a level for a frame size", () => {
  it("picks a level that can actually carry the resolution", () => {
    // The regression: 1080p must not resolve to level 3.0 (0x1e).
    expect(levelForFrame(1920, 1080, 24)).toBeGreaterThanOrEqual(0x28);
    expect(levelForFrame(1920, 1080, 30)).toBeGreaterThanOrEqual(0x28);
  });

  it.each([
    [640, 480, 30, 0x1e],
    [1280, 720, 30, 0x1f],
    [1920, 1080, 30, 0x28],
    [3840, 2160, 30, 0x33],
  ])("%ix%i @%ifps needs at least level 0x%s", (width, height, fps, minimum) => {
    expect(levelForFrame(width, height, fps)).toBeGreaterThanOrEqual(minimum);
  });

  it("raises the level for a higher frame rate at the same size", () => {
    // 1080p60 exceeds level 4.0's macroblock rate even though the frame fits.
    expect(levelForFrame(1920, 1080, 60)).toBeGreaterThan(levelForFrame(1920, 1080, 24));
  });

  it("never exceeds the highest level it knows", () => {
    expect(levelForFrame(7680, 4320, 60)).toBeLessThanOrEqual(0x34);
  });
});

describe("planning a ladder for a real source", () => {
  it("keeps every rung for a 1080p source", () => {
    const plan = planLadder(
      [
        { height: 1080, bitrate: 5_000_000 },
        { height: 720, bitrate: 2_800_000 },
        { height: 480, bitrate: 1_200_000 },
      ],
      1920,
      1080,
    );
    expect(plan.map((r) => `${r.width}x${r.height}`)).toEqual([
      "1920x1080",
      "1280x720",
      "854x480",
    ]);
  });

  it("drops rungs that would upscale", () => {
    const plan = planLadder(
      [
        { height: 1080, bitrate: 5_000_000 },
        { height: 480, bitrate: 1_200_000 },
      ],
      854,
      480,
    );
    // Upscaling costs time and storage and adds no quality.
    expect(plan).toHaveLength(1);
    expect(plan[0]!.height).toBe(480);
  });

  it("falls back to the source size when every rung is too tall", () => {
    const plan = planLadder([{ height: 1080, bitrate: 5_000_000 }], 640, 360);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.height).toBe(360);
  });

  it("keeps dimensions even, as 4:2:0 chroma requires", () => {
    const plan = planLadder([{ height: 721, bitrate: 1_000_000 }], 1921, 1081);
    for (const rung of plan) {
      expect(rung.width % 2, `width ${rung.width}`).toBe(0);
      expect(rung.height % 2, `height ${rung.height}`).toBe(0);
    }
  });

  it("preserves the aspect ratio", () => {
    const plan = planLadder([{ height: 720, bitrate: 2_800_000 }], 1920, 1080);
    const rung = plan[0]!;
    expect(Math.abs(rung.width / rung.height - 1920 / 1080)).toBeLessThan(0.01);
  });
});

describe("ladder presets", () => {
  it("offers a preset for each common shape", () => {
    expect(Object.keys(LADDERS).sort()).toEqual(["mobile", "single", "standard", "uhd", "wide"]);
  });

  it("orders every preset from highest to lowest quality", () => {
    for (const [name, ladder] of Object.entries(LADDERS)) {
      const heights = ladder.map((r) => r.height);
      expect([...heights].sort((a, b) => b - a), name).toEqual(heights);
      // Bitrate should fall with resolution, or the ladder makes no sense.
      const rates = ladder.map((r) => r.bitrate);
      expect([...rates].sort((a, b) => b - a), name).toEqual(rates);
    }
  });

  it("can be handed any source, since taller rungs are dropped", () => {
    // A 480p phone clip against the 4K preset should still produce something.
    const plan = planLadder(LADDERS.uhd, 854, 480);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((r) => r.height <= 480)).toBe(true);
  });

  it("keeps the rungs a source can actually fill", () => {
    const plan = planLadder(LADDERS.standard, 1920, 1080);
    expect(plan.map((r) => r.height)).toEqual([1080, 720, 480]);
  });
});

describe("upscaling", () => {
  it("is refused by default", () => {
    const plan = planLadder(LADDERS.standard, 854, 480);
    expect(plan.every((r) => r.height <= 480)).toBe(true);
  });

  it("can be allowed when a fixed set of renditions matters more", () => {
    const plan = planLadder(LADDERS.standard, 854, 480, true);
    expect(plan.map((r) => r.height)).toEqual([1080, 720, 480]);
  });
});
