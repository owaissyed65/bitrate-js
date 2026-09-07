/**
 * M0 acceptance: prove the JS -> WASM -> JS round-trip works for bytes, strings
 * and stateful objects, and that the Rust security invariants hold across the
 * boundary (not just inside Rust).
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import init, {
  MediaPlaylist,
  checksum,
  sanitize_key,
  version,
} from "./wasm/bitrate_core.js";

/** The version Cargo.toml declares, read rather than duplicated. */
function cargoVersion(): string {
  const manifest = readFileSync(
    fileURLToPath(new URL("../../crates/bitrate-core/Cargo.toml", import.meta.url)),
    "utf8",
  );
  const match = /^version\s*=\s*"([^"]+)"/m.exec(manifest);
  if (!match?.[1]) throw new Error("no version in crates/bitrate-core/Cargo.toml");
  return match[1];
}

beforeAll(async () => {
  // wasm-pack's `web` target fetches by URL in a browser; in Node we hand it bytes.
  const wasmPath = fileURLToPath(new URL("./wasm/bitrate_core_bg.wasm", import.meta.url));
  await init({ module_or_path: await readFile(wasmPath) });
});

describe("wasm round-trip", () => {
  it("returns the crate version as a string", () => {
    // Deliberately not pinned to a literal: the point is that the string
    // crosses the boundary intact and reflects Cargo.toml, and pinning it
    // would fail on every release for no reason.
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
    expect(version()).toBe(cargoVersion());
  });

  it("transfers byte buffers intact", () => {
    // Fletcher-32 of "abcde", computed independently of the Rust implementation.
    const bytes = new TextEncoder().encode("abcde");
    let lo = 0;
    let hi = 0;
    for (const b of bytes) {
      lo = (lo + b) % 0xffff;
      hi = (hi + lo) % 0xffff;
    }
    expect(checksum(bytes)).toBe(((hi << 16) | lo) >>> 0);
  });

  it("handles an empty buffer", () => {
    expect(checksum(new Uint8Array())).toBe(0);
  });

  it("handles a large buffer without truncation", () => {
    const big = new Uint8Array(1_000_000).fill(0xab);
    expect(checksum(big)).toBeGreaterThan(0);
  });
});

describe("sanitize_key across the boundary", () => {
  it.each([
    ["../../etc/passwd", "etcpasswd"],
    ["..", "_"],
    ["/absolute", "absolute"],
    ["a/b\\c", "abc"],
    ["1080p_00001.m4s", "1080p_00001.m4s"],
    ["", "_"],
  ])("sanitize_key(%j) === %j", (input, expected) => {
    expect(sanitize_key(input)).toBe(expected);
  });

  it("never emits a traversal sequence", () => {
    for (const evil of ["../x", "..\\x", "....//x", "%2e%2e/x"]) {
      expect(sanitize_key(evil)).not.toContain("..");
      expect(sanitize_key(evil)).not.toContain("/");
    }
  });
});

describe("MediaPlaylist (stateful object across the boundary)", () => {
  it("builds a valid fMP4 media playlist", () => {
    const p = new MediaPlaylist(6);
    p.setInit("1080p_init.mp4");
    p.addSegment("1080p_00000.m4s", 6);
    p.addSegment("1080p_00001.m4s", 5.5);
    p.finish();

    const text = p.toText();
    expect(text.startsWith("#EXTM3U\n")).toBe(true);
    expect(text).toContain("#EXT-X-VERSION:7");
    expect(text).toContain("#EXT-X-TARGETDURATION:6");
    expect(text).toContain('#EXT-X-MAP:URI="1080p_init.mp4"');
    expect(text).toContain("#EXTINF:6.000000,\n1080p_00000.m4s");
    expect(text).toContain("#EXTINF:5.500000,\n1080p_00001.m4s");
    expect(text.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });

  it("omits ENDLIST until finished", () => {
    const p = new MediaPlaylist(6);
    p.addSegment("a.m4s", 6);
    expect(p.toText()).not.toContain("#EXT-X-ENDLIST");
  });

  it("coerces non-finite durations to zero rather than emitting NaN", () => {
    const p = new MediaPlaylist(6);
    p.addSegment("a.m4s", Number.NaN);
    p.addSegment("b.m4s", -3);
    p.addSegment("c.m4s", Number.POSITIVE_INFINITY);
    const text = p.toText();
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("inf");
    expect(text.match(/#EXTINF:0\.000000,/g)).toHaveLength(3);
  });

  it("sanitizes segment URIs supplied from JS", () => {
    const p = new MediaPlaylist(6);
    p.addSegment("../../evil.m4s", 6);
    expect(p.toText()).not.toContain("..");
  });
});
