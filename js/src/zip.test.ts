/**
 * ZIP writer tests.
 *
 * A malformed archive is worse than no archive — it looks fine until someone
 * double-clicks it. So the output is checked structurally here, and unpacked
 * with a real unzip implementation (Node's `zlib`-independent path is not
 * available, so the central directory is parsed and each entry verified
 * against its stored CRC).
 */

import { describe, expect, it } from "vitest";

import { createZip, crc32 } from "./zip.js";

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const text = (s: string) => new TextEncoder().encode(s);

/** Minimal reader: parse the central directory and extract every entry. */
async function unzip(blob: Blob): Promise<Map<string, Uint8Array>> {
  const bytes = await bytesOf(blob);
  const view = new DataView(bytes.buffer);

  // The end-of-central-directory record is at the tail.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x0605_4b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("no end-of-central-directory record");

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);

  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x0201_4b50) throw new Error("bad central directory entry");

    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));

    // Follow the pointer into the local header and read the data after it.
    if (view.getUint32(localOffset, true) !== 0x0403_4b50) throw new Error("bad local header");
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(dataStart, dataStart + size);

    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    out.set(name, data);

    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("crc32", () => {
  it.each([
    ["", 0x0000_0000],
    ["a", 0xe8b7_be43],
    ["abc", 0x3524_41c2],
    ["123456789", 0xcbf4_3926],
  ])("matches the known value for %j", (input, expected) => {
    expect(crc32(text(input))).toBe(expected);
  });
});

describe("archive structure", () => {
  it("starts with a local file header and ends with the central directory record", async () => {
    const zip = await createZip([{ name: "a.txt", data: text("hello") }]);
    const bytes = await bytesOf(zip);
    const view = new DataView(bytes.buffer);

    expect(view.getUint32(0, true)).toBe(0x0403_4b50);
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x0605_4b50);
  });

  it("declares the right entry count", async () => {
    const zip = await createZip([
      { name: "a.txt", data: text("one") },
      { name: "b.txt", data: text("two") },
      { name: "c.txt", data: text("three") },
    ]);
    const bytes = await bytesOf(zip);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(bytes.length - 22 + 10, true)).toBe(3);
  });

  it("stores rather than deflates, since the payload is already compressed", async () => {
    const zip = await createZip([{ name: "a.bin", data: new Uint8Array(64).fill(7) }]);
    const view = new DataView((await bytesOf(zip)).buffer);
    expect(view.getUint16(8, true)).toBe(0); // compression method 0 = stored
  });

  it("has the right content type for a download", async () => {
    const zip = await createZip([{ name: "a.txt", data: text("x") }]);
    expect(zip.type).toBe("application/zip");
  });
});

describe("round trip", () => {
  it("recovers every file byte-for-byte", async () => {
    const entries = [
      { name: "master.m3u8", data: text("#EXTM3U\n#EXT-X-VERSION:7\n") },
      { name: "720p_init.mp4", data: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]) },
      { name: "720p_00000.m4s", data: new Uint8Array(4096).map((_, i) => i & 0xff) },
    ];

    const unpacked = await unzip(await createZip(entries));

    expect([...unpacked.keys()].sort()).toEqual([
      "720p_00000.m4s",
      "720p_init.mp4",
      "master.m3u8",
    ]);
    for (const entry of entries) {
      expect(unpacked.get(entry.name), entry.name).toEqual(entry.data);
    }
  });

  it("accepts Blobs as well as byte arrays", async () => {
    const unpacked = await unzip(
      await createZip([{ name: "a.txt", data: new Blob(["from a blob"]) }]),
    );
    expect(new TextDecoder().decode(unpacked.get("a.txt"))).toBe("from a blob");
  });

  it("handles an empty file", async () => {
    const unpacked = await unzip(await createZip([{ name: "empty.bin", data: new Uint8Array() }]));
    expect(unpacked.get("empty.bin")).toEqual(new Uint8Array());
  });

  it("keeps folder paths", async () => {
    const unpacked = await unzip(
      await createZip([{ name: "hls/720p/seg0.m4s", data: text("data") }]),
    );
    expect(unpacked.has("hls/720p/seg0.m4s")).toBe(true);
  });

  it("survives a realistic number of segments", async () => {
    // A 10-minute video at 6s segments is 100 files.
    const entries = Array.from({ length: 100 }, (_, i) => ({
      name: `720p_${String(i).padStart(5, "0")}.m4s`,
      data: new Uint8Array(512).fill(i & 0xff),
    }));
    const unpacked = await unzip(await createZip(entries));
    expect(unpacked.size).toBe(100);
    expect(unpacked.get("720p_00099.m4s")![0]).toBe(99);
  });
});

describe("safety and limits", () => {
  it("strips path traversal from entry names", async () => {
    // An archive that writes outside its folder on extraction is a classic
    // vulnerability ("zip slip").
    const unpacked = await unzip(
      await createZip([{ name: "../../etc/passwd", data: text("nope") }]),
    );
    const names = [...unpacked.keys()];
    expect(names).toEqual(["etc/passwd"]);
    expect(names[0]).not.toContain("..");
  });

  it("normalises backslashes", async () => {
    const unpacked = await unzip(await createZip([{ name: "a\\b\\c.txt", data: text("x") }]));
    expect([...unpacked.keys()]).toEqual(["a/b/c.txt"]);
  });

  it("rejects a name that sanitizes to nothing", async () => {
    await expect(createZip([{ name: "../..", data: text("x") }])).rejects.toThrow(/Unsafe/);
  });

  it("rejects an empty archive", async () => {
    await expect(createZip([])).rejects.toThrow(/empty/);
  });
});
