/**
 * Thumbnail geometry and frame selection.
 *
 * Decoding needs WebCodecs, which Node does not have, so the parts that can be
 * tested here are the ones that decide *what* to capture and *where* to put it.
 * The rest is verified in a browser against a real recording.
 */

import { describe, expect, it } from "vitest";

import { fit, isThumbnailSupported, spriteLayout } from "./thumbnail.js";

describe("fitting a frame to a maximum width", () => {
  it("leaves a frame that already fits alone", () => {
    expect(fit(320, 180, 640)).toEqual({ width: 320, height: 180 });
  });

  it("scales down and preserves the aspect ratio", () => {
    expect(fit(1920, 1080, 640)).toEqual({ width: 640, height: 360 });
  });

  it("never returns a zero height for an extreme aspect", () => {
    // A 4000x9 banner scaled to 160 wide rounds to 0 without a floor, and a
    // zero-height canvas throws.
    expect(fit(4000, 9, 160).height).toBeGreaterThanOrEqual(1);
  });

  it("keeps the ratio within a rounding error", () => {
    const out = fit(1440, 1080, 500);
    expect(Math.abs(out.width / out.height - 1440 / 1080)).toBeLessThan(0.01);
  });
});

describe("laying out a sprite sheet", () => {
  it("takes stills from the middle of each slice, not the edges", () => {
    // The first and last frames of a video are the least representative — a
    // fade from black, a fade to it — so a strip built on i/count opens on
    // exactly the frame nobody wants.
    const { targets } = spriteLayout(4, 100);
    expect(targets).toEqual([12.5, 37.5, 62.5, 87.5]);
    expect(targets[0]).toBeGreaterThan(0);
    expect(targets[targets.length - 1]).toBeLessThan(100);
  });

  it("produces exactly the number of stills asked for", () => {
    for (const count of [1, 2, 5, 10, 24]) {
      expect(spriteLayout(count, 60).targets, `count ${count}`).toHaveLength(count);
    }
  });

  it("spreads them evenly", () => {
    const { targets } = spriteLayout(5, 50);
    const gaps = targets.slice(1).map((t, i) => t - targets[i]!);
    for (const gap of gaps) expect(gap).toBeCloseTo(10, 6);
  });

  it("defaults to a roughly square grid", () => {
    expect(spriteLayout(9, 10)).toMatchObject({ columns: 3, rows: 3 });
    expect(spriteLayout(10, 10)).toMatchObject({ columns: 4, rows: 3 });
  });

  it("honours an explicit column count", () => {
    expect(spriteLayout(10, 10, 5)).toMatchObject({ columns: 5, rows: 2 });
    expect(spriteLayout(7, 10, 1)).toMatchObject({ columns: 1, rows: 7 });
  });

  it("leaves room for every tile when the grid is not full", () => {
    // 7 tiles in a 3-wide grid needs 3 rows, not 2 — the last row is partly
    // empty, and a sheet sized for 2 would crop the final tile.
    const { columns, rows } = spriteLayout(7, 10, 3);
    expect(columns * rows).toBeGreaterThanOrEqual(7);
    expect(rows).toBe(3);
  });

  it("handles a zero-duration source without producing NaN", () => {
    const { targets } = spriteLayout(3, 0);
    expect(targets.every((t) => Number.isFinite(t))).toBe(true);
  });
});

describe("capability detection", () => {
  it("reports unsupported where there is no WebCodecs", () => {
    // Node has neither VideoDecoder nor a canvas, so callers get a clear false
    // rather than a crash deep inside a decode.
    expect(isThumbnailSupported()).toBe(false);
  });
});
