/**
 * Builds progressive (non-fragmented) MP4 files for tests.
 *
 * The demuxer's job is to read files like these — written by cameras, phones
 * and editors — so tests need real ones. Sample payloads are filled with a
 * deterministic pattern so byte-accuracy can be asserted after a remux.
 */

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v);
  return b;
}

function u16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v);
  return b;
}

function i32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v);
  return b;
}

function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `size + type + payload` */
function box(kind: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(8 + body.length), ascii(kind), body]);
}

/** A FullBox: version and 24-bit flags precede the payload. */
function fullBox(kind: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(
    kind,
    new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]),
    ...payload,
  );
}

const UNITY_MATRIX = concat([
  i32(0x00010000), i32(0), i32(0),
  i32(0), i32(0x00010000), i32(0),
  i32(0), i32(0), i32(0x40000000),
]);

/** A syntactically valid avcC record (H.264 Baseline 3.1). */
export const TEST_AVCC = new Uint8Array([
  0x01, 0x42, 0xc0, 0x1f, 0xff, 0xe1, 0x00, 0x09, 0x67, 0x42, 0xc0, 0x1f, 0x8c, 0x8d, 0x40, 0x50,
  0x1e, 0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
]);

export interface MakeMp4Options {
  frameCount: number;
  /** Keyframe every `gop` frames. */
  gop: number;
  width?: number;
  height?: number;
  timescale?: number;
  /** Per-frame duration in timescale units. */
  frameDuration?: number;
  /** Samples per chunk; controls how offsets are laid out. */
  samplesPerChunk?: number;
  /** Use `co64` (64-bit offsets) instead of `stco`. */
  use64BitOffsets?: boolean;
  /** Emit a `ctts` box with this constant composition offset. */
  compositionOffset?: number;
  /** Place `moov` after `mdat`, as non-faststart writers do. */
  moovAtEnd?: boolean;
}

export interface MadeMp4 {
  bytes: Uint8Array;
  /** The payload of each frame, in order — for byte-accuracy assertions. */
  samplePayloads: Uint8Array[];
  sampleSizes: number[];
  syncFlags: boolean[];
}

/** Deterministic, size-varying payload for frame `i`. */
function samplePayload(i: number): Uint8Array {
  const size = 100 + (i % 13) * 7;
  const data = new Uint8Array(size);
  for (let k = 0; k < size; k++) data[k] = (i * 31 + k) & 0xff;
  return data;
}

/** Build a progressive MP4 containing a single H.264 video track. */
export function makeMp4(options: MakeMp4Options): MadeMp4 {
  const {
    frameCount,
    gop,
    width = 1280,
    height = 720,
    timescale = 90_000,
    frameDuration = 3_000,
    samplesPerChunk = 1,
    use64BitOffsets = false,
    compositionOffset,
    moovAtEnd = false,
  } = options;

  const samplePayloads = Array.from({ length: frameCount }, (_, i) => samplePayload(i));
  const sampleSizes = samplePayloads.map((p) => p.length);
  const syncFlags = Array.from({ length: frameCount }, (_, i) => i % gop === 0);

  const mdatBody = concat(samplePayloads);
  const chunkCount = Math.ceil(frameCount / samplesPerChunk);

  // Chunk offsets are absolute file positions, so the moov must be built twice:
  // once to learn its length, then again with the real offsets patched in.
  const build = (mdatDataStart: number): Uint8Array => {
    const chunkOffsets: number[] = [];
    let running = mdatDataStart;
    for (let c = 0; c < chunkCount; c++) {
      chunkOffsets.push(running);
      for (let s = c * samplesPerChunk; s < Math.min((c + 1) * samplesPerChunk, frameCount); s++) {
        running += sampleSizes[s]!;
      }
    }

    const avc1 = box(
      "avc1",
      new Uint8Array(24), // reserved / data_reference_index / pre_defined
      u16(width),
      u16(height),
      u32(0x00480000), // horizresolution
      u32(0x00480000), // vertresolution
      u32(0), // reserved
      u16(1), // frame_count
      new Uint8Array(32), // compressorname
      u16(0x0018), // depth
      new Uint8Array([0xff, 0xff]), // pre_defined = -1
      box("avcC", TEST_AVCC),
    );

    const stsc = fullBox(
      "stsc",
      0,
      0,
      u32(1),
      u32(1), // first_chunk
      u32(samplesPerChunk),
      u32(1), // sample_description_index
    );

    const chunkOffsetBox = use64BitOffsets
      ? fullBox(
          "co64",
          0,
          0,
          u32(chunkOffsets.length),
          ...chunkOffsets.map((o) => {
            const b = new Uint8Array(8);
            new DataView(b.buffer).setBigUint64(0, BigInt(o));
            return b;
          }),
        )
      : fullBox("stco", 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map(u32));

    const syncSamples = syncFlags
      .map((isSync, i) => (isSync ? i + 1 : 0))
      .filter((n) => n > 0);

    const stblChildren: Uint8Array[] = [
      fullBox("stsd", 0, 0, u32(1), avc1),
      fullBox("stts", 0, 0, u32(1), u32(frameCount), u32(frameDuration)),
      stsc,
      fullBox("stsz", 0, 0, u32(0), u32(frameCount), ...sampleSizes.map(u32)),
      chunkOffsetBox,
    ];
    // Omit stss when every frame is a keyframe — that is what real encoders do,
    // and it exercises the "no stss means all sync" path.
    if (syncSamples.length !== frameCount) {
      stblChildren.push(fullBox("stss", 0, 0, u32(syncSamples.length), ...syncSamples.map(u32)));
    }
    if (compositionOffset !== undefined) {
      stblChildren.push(
        fullBox("ctts", 1, 0, u32(1), u32(frameCount), i32(compositionOffset)),
      );
    }

    const stbl = box("stbl", ...stblChildren);
    const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
    const minf = box("minf", fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)), dinf, stbl);

    const mdhd = fullBox(
      "mdhd", 0, 0,
      u32(0), u32(0), u32(timescale), u32(frameCount * frameDuration),
      u16(0x55c4), u16(0),
    );
    const hdlr = fullBox(
      "hdlr", 0, 0,
      u32(0), ascii("vide"), u32(0), u32(0), u32(0), ascii("VideoHandler\0"),
    );
    const mdia = box("mdia", mdhd, hdlr, minf);

    const tkhd = fullBox(
      "tkhd", 0, 7,
      u32(0), u32(0), u32(1), u32(0), u32(frameCount * frameDuration),
      u32(0), u32(0), u16(0), u16(0), u16(0), u16(0),
      UNITY_MATRIX, u32(width << 16), u32(height << 16),
    );
    const trak = box("trak", tkhd, mdia);

    const mvhd = fullBox(
      "mvhd", 0, 0,
      u32(0), u32(0), u32(timescale), u32(frameCount * frameDuration),
      u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
      UNITY_MATRIX, new Uint8Array(24), u32(2),
    );

    return box("moov", mvhd, trak);
  };

  const ftyp = box("ftyp", ascii("isom"), u32(512), ascii("isom"), ascii("mp41"));

  // First pass: measure. The moov's length does not depend on the offset
  // *values*, only their count, so a second pass with real offsets is exact.
  const probe = build(0);

  let mdatDataStart: number;
  if (moovAtEnd) {
    mdatDataStart = ftyp.length + 8; // ftyp, then mdat header
  } else {
    mdatDataStart = ftyp.length + probe.length + 8;
  }

  const moov = build(mdatDataStart);
  if (moov.length !== probe.length) {
    throw new Error("moov length changed between passes; offsets would be wrong");
  }

  const mdat = box("mdat", mdatBody);
  const bytes = moovAtEnd ? concat([ftyp, mdat, moov]) : concat([ftyp, moov, mdat]);

  return { bytes, samplePayloads, sampleSizes, syncFlags };
}

/** Convenience: the built file as a `Blob`, as a browser would supply it. */
export function makeMp4Blob(options: MakeMp4Options): { blob: Blob } & MadeMp4 {
  const made = makeMp4(options);
  return { ...made, blob: new Blob([made.bytes as BlobPart], { type: "video/mp4" }) };
}
