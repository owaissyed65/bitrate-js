/**
 * Streaming reader for a source MP4.
 *
 * A `Blob`/`File` is a handle to bytes on disk, not bytes in memory. Everything
 * here reads through `Blob.slice`, so peak memory depends on the read-ahead
 * window rather than the file size — which is what makes a 1 GB (or 20 GB)
 * source workable in a tab (PLAN.md §3d).
 *
 * Never call `file.arrayBuffer()` on a source file.
 */

/** Refuse absurd headers rather than allocating on a hostile size field. */
const MAX_MOOV_BYTES = 256 * 1024 * 1024;

/** How many bytes of adjacent samples to coalesce into one read. */
const DEFAULT_READ_WINDOW = 4 * 1024 * 1024;

export interface BoxLocation {
  kind: string;
  /** Offset of the box header. */
  start: number;
  /** Total box size including the header. */
  size: number;
  /** Offset of the payload (past the header). */
  payloadStart: number;
  payloadSize: number;
}

/**
 * Walk the file's top-level boxes without reading their contents.
 *
 * Only 8–16 byte headers are fetched, so this is cheap even when `moov` sits at
 * the end of the file (the common case for files not written with faststart).
 */
export async function topLevelBoxes(file: Blob): Promise<BoxLocation[]> {
  const found: BoxLocation[] = [];
  let offset = 0;

  while (offset + 8 <= file.size) {
    const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    if (head.byteLength < 8) break;

    const size32 = head.getUint32(0);
    const kind = String.fromCharCode(
      head.getUint8(4),
      head.getUint8(5),
      head.getUint8(6),
      head.getUint8(7),
    );

    let size: number;
    let headerLen = 8;
    if (size32 === 0) {
      // Runs to end of file.
      size = file.size - offset;
    } else if (size32 === 1) {
      if (head.byteLength < 16) break;
      // 64-bit largesize. Beyond 2^53 is not representable, and no real file
      // gets there, so bail rather than silently truncating.
      const large = head.getBigUint64(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
      headerLen = 16;
    } else {
      size = size32;
    }

    if (size < headerLen || offset + size > file.size) break;

    found.push({
      kind,
      start: offset,
      size,
      payloadStart: offset + headerLen,
      payloadSize: size - headerLen,
    });
    offset += size;
  }

  return found;
}

/**
 * Read the `moov` payload, wherever it sits in the file.
 *
 * @throws if the file has no `moov`, or one too large to be plausible.
 */
export async function readMoov(file: Blob): Promise<Uint8Array> {
  const boxes = await topLevelBoxes(file);
  const moov = boxes.find((b) => b.kind === "moov");

  if (!moov) {
    const kinds = boxes.map((b) => b.kind).join(", ") || "none";
    throw new Error(`No 'moov' box found — not a valid MP4. Top-level boxes: ${kinds}`);
  }
  if (moov.payloadSize > MAX_MOOV_BYTES) {
    throw new Error(`'moov' box is implausibly large (${moov.payloadSize} bytes); refusing to read`);
  }

  const slice = file.slice(moov.payloadStart, moov.payloadStart + moov.payloadSize);
  return new Uint8Array(await slice.arrayBuffer());
}

/** Cap on a single `moof`, so a hostile size field cannot force a huge read. */
const MAX_MOOF_BYTES = 32 * 1024 * 1024;

/**
 * Read every `moof` box in the file, in order.
 *
 * Fragmented sources keep their per-sample data in a `moof` before each `mdat`.
 * Only the `moof` boxes are read — they are small next to the media, so this
 * walks a multi-gigabyte file while touching only a few megabytes.
 */
export async function* readFragments(
  file: Blob,
  options: { signal?: AbortSignal | undefined } = {},
): AsyncGenerator<{ offset: number; bytes: Uint8Array }> {
  for (const box of await topLevelBoxes(file)) {
    options.signal?.throwIfAborted();
    if (box.kind !== "moof") continue;

    if (box.size > MAX_MOOF_BYTES) {
      throw new Error(`A 'moof' box at offset ${box.start} is implausibly large (${box.size} bytes)`);
    }
    const slice = file.slice(box.start, box.start + box.size);
    // Offsets inside a fragment are measured from where its header starts, so
    // the header is included rather than skipped.
    yield { offset: box.start, bytes: new Uint8Array(await slice.arrayBuffer()) };
  }
}

/** One frame's location in the source file. */
export interface SampleLocation {
  offset: number;
  size: number;
  duration: number;
  isSync: boolean;
  compositionOffset: number;
}

/**
 * Read samples lazily, coalescing adjacent ones into windowed reads.
 *
 * Samples within a chunk are contiguous, so reading them one slice at a time
 * would issue thousands of tiny reads. This batches them up to `readWindow`
 * bytes while never holding more than one window in memory.
 */
export async function* readSamples(
  file: Blob,
  samples: readonly SampleLocation[],
  // `| undefined` is explicit so callers can forward optional fields directly
  // under `exactOptionalPropertyTypes`.
  options: { readWindow?: number | undefined; signal?: AbortSignal | undefined } = {},
): AsyncGenerator<{ sample: SampleLocation; data: Uint8Array }> {
  const readWindow = options.readWindow ?? DEFAULT_READ_WINDOW;

  let i = 0;
  while (i < samples.length) {
    options.signal?.throwIfAborted();

    const first = samples[i]!;
    // Grow the window across samples that are physically contiguous.
    let end = first.offset + first.size;
    let j = i + 1;
    while (j < samples.length) {
      const next = samples[j]!;
      if (next.offset !== end) break; // a gap: stop the batch here
      if (next.offset + next.size - first.offset > readWindow) break;
      end = next.offset + next.size;
      j++;
    }

    if (end > file.size) {
      throw new Error(
        `Sample range ${first.offset}..${end} extends past the end of the file (${file.size} bytes); the source is truncated or its tables are wrong`,
      );
    }

    const buffer = new Uint8Array(await file.slice(first.offset, end).arrayBuffer());
    for (let k = i; k < j; k++) {
      // Checked per sample, not just per batch: one window can hold thousands
      // of samples, and a caller that aborts should not wait for all of them.
      options.signal?.throwIfAborted();
      const s = samples[k]!;
      const from = s.offset - first.offset;
      yield { sample: s, data: buffer.subarray(from, from + s.size) };
    }
    i = j;
  }
}
