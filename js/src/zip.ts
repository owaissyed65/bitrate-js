/**
 * A minimal ZIP writer, so a whole HLS output can be saved as one file.
 *
 * Entries are **stored, not deflated**. HLS output is already-compressed video
 * and a `.m3u8` is a few hundred bytes, so deflating would burn CPU for
 * essentially nothing — and storing keeps this small enough to have no
 * dependencies.
 *
 * Separate entry point (`bitrate-js/zip`) so it costs nothing unless imported.
 */

/** One file to place in the archive. */
export interface ZipEntry {
  /** Path inside the archive. Forward slashes make folders. */
  name: string;
  data: Blob | Uint8Array;
}

/** ZIP's 32-bit size fields cannot describe anything at or beyond 4 GiB. */
const MAX_ZIP_SIZE = 0xffff_ffff;

const LOCAL_HEADER = 0x0403_4b50;
const CENTRAL_HEADER = 0x0201_4b50;
const END_OF_CENTRAL = 0x0605_4b50;

/** CRC-32 table, built once on first use. */
let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32 of `bytes`, as ZIP requires for every entry. */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffff_ffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** Little-endian writer for the fixed-size ZIP records. */
class Writer {
  readonly bytes: Uint8Array;
  private view: DataView;
  private at = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  u16(value: number): this {
    this.view.setUint16(this.at, value, true);
    this.at += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.at, value >>> 0, true);
    this.at += 4;
    return this;
  }

  raw(value: Uint8Array): this {
    this.bytes.set(value, this.at);
    this.at += value.length;
    return this;
  }
}

/** MS-DOS date and time, which is what ZIP stores. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time:
      (Math.floor(date.getSeconds() / 2) & 0x1f) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((date.getHours() & 0x1f) << 11),
    // ZIP counts years from 1980.
    date:
      (date.getDate() & 0x1f) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      ((Math.max(0, date.getFullYear() - 1980) & 0x7f) << 9),
  };
}

/** Strip anything that could escape the archive when it is extracted. */
function safeName(name: string): string {
  const cleaned = name
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("/");
  if (cleaned === "") throw new Error(`Unsafe archive entry name: ${JSON.stringify(name)}`);
  return cleaned;
}

async function toBytes(data: Blob | Uint8Array): Promise<Uint8Array> {
  return data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
}

/**
 * Build a ZIP archive from `entries`.
 *
 * Each entry is read one at a time, so peak memory is roughly the largest
 * single file rather than the whole archive.
 *
 * @throws if the archive would exceed ZIP's 4 GiB limit — ZIP64 is not
 *   implemented, and silently producing a corrupt archive would be worse.
 */
export async function createZip(entries: readonly ZipEntry[]): Promise<Blob> {
  if (entries.length === 0) throw new Error("Cannot create an empty archive");
  if (entries.length > 0xffff) {
    throw new Error(`A ZIP holds at most 65535 entries; got ${entries.length}`);
  }

  const stamp = dosDateTime(new Date());
  const encoder = new TextEncoder();

  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(safeName(entry.name));
    const bytes = await toBytes(entry.data);
    const crc = crc32(bytes);

    if (bytes.length > MAX_ZIP_SIZE) {
      throw new Error(
        `"${entry.name}" is too large for a ZIP archive (${bytes.length} bytes). Save the files individually.`,
      );
    }

    const local = new Writer(30 + name.length)
      .u32(LOCAL_HEADER)
      .u16(20) // version needed
      .u16(0) // flags
      .u16(0) // method: stored
      .u16(stamp.time)
      .u16(stamp.date)
      .u32(crc)
      .u32(bytes.length) // compressed size
      .u32(bytes.length) // uncompressed size
      .u16(name.length)
      .u16(0) // extra length
      .raw(name);

    parts.push(local.bytes as BlobPart, bytes as BlobPart);

    central.push(
      new Writer(46 + name.length)
        .u32(CENTRAL_HEADER)
        .u16(20) // version made by
        .u16(20) // version needed
        .u16(0) // flags
        .u16(0) // method: stored
        .u16(stamp.time)
        .u16(stamp.date)
        .u32(crc)
        .u32(bytes.length)
        .u32(bytes.length)
        .u16(name.length)
        .u16(0) // extra
        .u16(0) // comment
        .u16(0) // disk number
        .u16(0) // internal attributes
        .u32(0) // external attributes
        .u32(offset) // offset of the local header
        .raw(name).bytes,
    );

    offset += local.bytes.length + bytes.length;
    if (offset > MAX_ZIP_SIZE) {
      throw new Error(
        "This output is larger than 4 GiB, which a plain ZIP cannot describe. Save the files individually.",
      );
    }
  }

  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  parts.push(...(central as BlobPart[]));

  parts.push(
    new Writer(22)
      .u32(END_OF_CENTRAL)
      .u16(0) // this disk
      .u16(0) // disk with the central directory
      .u16(entries.length) // entries on this disk
      .u16(entries.length) // total entries
      .u32(centralSize)
      .u32(offset) // central directory offset
      .u16(0).bytes as BlobPart, // comment length
  );

  return new Blob(parts, { type: "application/zip" });
}

/** Build the archive and hand it to the browser as a download. */
export async function downloadZip(
  entries: readonly ZipEntry[],
  filename = "output.zip",
): Promise<void> {
  const blob = await createZip(entries);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".zip") ? filename : `${filename}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
