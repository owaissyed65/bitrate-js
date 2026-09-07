//! MP4 (`moov`) sample-table parser.
//!
//! Produces a *sample index* — for each frame: where it lives in the file, how
//! big it is, how long it lasts, and whether it is a keyframe. The JS side then
//! reads only those byte ranges, so a 1 GB source never enters memory at once
//! (PLAN.md §3d).

use super::reader::{boxes, find, find_path, Reader};

/// Caps on untrusted input (SECURITY.md §7). Generous for real media: 5M
/// samples is roughly 46 hours at 30 fps.
const MAX_SAMPLES: usize = 5_000_000;
const MAX_CHUNKS: usize = 5_000_000;
const MAX_CODEC_CONFIG: usize = 4_096;

/// Why a source file could not be understood.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DemuxError {
    /// No `moov` box was present in the bytes supplied.
    NoMoov,
    /// The file contains no H.264 video track we can handle.
    NoVideoTrack,
    /// A required box was missing or truncated.
    MalformedBox(&'static str),
    /// The file declares more samples or chunks than we will process.
    TooLarge,
    /// The sample tables disagree with each other.
    InconsistentTables,
}

impl core::fmt::Display for DemuxError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::NoMoov => f.write_str("no moov box found; is this an MP4?"),
            Self::NoVideoTrack => f.write_str("no supported H.264 video track found"),
            Self::MalformedBox(b) => write!(f, "malformed or truncated `{b}` box"),
            Self::TooLarge => f.write_str("file declares more samples than this build will process"),
            Self::InconsistentTables => f.write_str("sample tables are inconsistent"),
        }
    }
}

/// Where one encoded frame lives in the source file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SampleRef {
    /// Absolute byte offset in the source file.
    pub offset: u64,
    /// Byte length of the encoded frame.
    pub size: u32,
    /// Decode duration in track timescale units.
    pub duration: u32,
    /// True for a keyframe (random access point).
    pub is_sync: bool,
    /// Composition offset from decode time; non-zero with B-frames.
    pub composition_offset: i32,
}

/// A parsed H.264 video track.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoTrack {
    /// Track timescale, in units per second.
    pub timescale: u32,
    /// Coded width in pixels.
    pub width: u16,
    /// Coded height in pixels.
    pub height: u16,
    /// The `avcC` decoder configuration record, passed straight to the muxer.
    pub codec_config: Vec<u8>,
    /// Every frame in the track, in decode order.
    pub samples: Vec<SampleRef>,
}

/// Parse a `moov` payload and return its first usable H.264 video track.
pub fn parse_moov(moov: &[u8]) -> Result<VideoTrack, DemuxError> {
    for b in boxes(moov) {
        if !b.is(b"trak") {
            continue;
        }
        match parse_trak(b.payload) {
            Ok(track) => return Ok(track),
            // Skip audio/subtitle/unsupported tracks and keep looking.
            Err(DemuxError::NoVideoTrack) => continue,
            Err(e) => return Err(e),
        }
    }
    Err(DemuxError::NoVideoTrack)
}

fn parse_trak(trak: &[u8]) -> Result<VideoTrack, DemuxError> {
    let mdia = find(trak, b"mdia").ok_or(DemuxError::MalformedBox("mdia"))?;

    if !is_video_handler(mdia) {
        return Err(DemuxError::NoVideoTrack);
    }

    let timescale = parse_mdhd(find(mdia, b"mdhd").ok_or(DemuxError::MalformedBox("mdhd"))?)?;
    if timescale == 0 {
        return Err(DemuxError::MalformedBox("mdhd"));
    }

    let stbl = find_path(mdia, &[b"minf", b"stbl"]).ok_or(DemuxError::MalformedBox("stbl"))?;
    let visual = parse_stsd(find(stbl, b"stsd").ok_or(DemuxError::MalformedBox("stsd"))?)?;

    let sizes = parse_stsz(find(stbl, b"stsz").ok_or(DemuxError::MalformedBox("stsz"))?)?;
    let durations = parse_stts(find(stbl, b"stts").ok_or(DemuxError::MalformedBox("stts"))?)?;
    let chunk_offsets = parse_chunk_offsets(stbl)?;
    let stsc = parse_stsc(find(stbl, b"stsc").ok_or(DemuxError::MalformedBox("stsc"))?)?;
    let sync = find(stbl, b"stss").map(parse_stss).transpose()?;
    let cts = find(stbl, b"ctts").map(parse_ctts).transpose()?;

    let samples = build_index(&sizes, &durations, &chunk_offsets, &stsc, sync.as_deref(), cts.as_deref())?;

    Ok(VideoTrack {
        timescale,
        width: visual.width,
        height: visual.height,
        codec_config: visual.codec_config,
        samples,
    })
}

fn is_video_handler(mdia: &[u8]) -> bool {
    let Some(hdlr) = find(mdia, b"hdlr") else {
        return false;
    };
    let mut r = Reader::new(hdlr);
    if r.version_flags().is_none() || r.u32().is_none() {
        return false;
    }
    r.fourcc().map(|k| &k == b"vide").unwrap_or(false)
}

fn parse_mdhd(mdhd: &[u8]) -> Result<u32, DemuxError> {
    let mut r = Reader::new(mdhd);
    let (version, _) = r.version_flags().ok_or(DemuxError::MalformedBox("mdhd"))?;
    // v1 uses 64-bit creation/modification times.
    let skip = if version == 1 { 16 } else { 8 };
    r.skip(skip).ok_or(DemuxError::MalformedBox("mdhd"))?;
    r.u32().ok_or(DemuxError::MalformedBox("mdhd"))
}

struct VisualEntry {
    width: u16,
    height: u16,
    codec_config: Vec<u8>,
}

fn parse_stsd(stsd: &[u8]) -> Result<VisualEntry, DemuxError> {
    let mut r = Reader::new(stsd);
    r.version_flags().ok_or(DemuxError::MalformedBox("stsd"))?;
    r.u32().ok_or(DemuxError::MalformedBox("stsd"))?; // entry_count

    for entry in boxes(r.rest()) {
        // `avc3` carries parameter sets in-band but is otherwise identical here.
        if !entry.is(b"avc1") && !entry.is(b"avc3") {
            continue;
        }
        let mut e = Reader::new(entry.payload);
        // VisualSampleEntry preamble before width/height.
        e.skip(24).ok_or(DemuxError::MalformedBox("avc1"))?;
        let width = e.u16().ok_or(DemuxError::MalformedBox("avc1"))?;
        let height = e.u16().ok_or(DemuxError::MalformedBox("avc1"))?;
        // resolutions, reserved, frame_count, compressorname, depth, pre_defined
        e.skip(50).ok_or(DemuxError::MalformedBox("avc1"))?;

        let avcc = find(e.rest(), b"avcC").ok_or(DemuxError::MalformedBox("avcC"))?;
        if avcc.is_empty() || avcc.len() > MAX_CODEC_CONFIG {
            return Err(DemuxError::MalformedBox("avcC"));
        }
        return Ok(VisualEntry {
            width,
            height,
            codec_config: avcc.to_vec(),
        });
    }
    Err(DemuxError::NoVideoTrack)
}

/// Sample sizes. A non-zero `sample_size` means every sample is that size.
fn parse_stsz(stsz: &[u8]) -> Result<Vec<u32>, DemuxError> {
    let mut r = Reader::new(stsz);
    r.version_flags().ok_or(DemuxError::MalformedBox("stsz"))?;
    let uniform = r.u32().ok_or(DemuxError::MalformedBox("stsz"))?;
    let count = r.u32().ok_or(DemuxError::MalformedBox("stsz"))? as usize;

    if count > MAX_SAMPLES {
        return Err(DemuxError::TooLarge);
    }
    if uniform != 0 {
        return Ok(vec![uniform; count]);
    }
    // Only allocate what the buffer can actually contain.
    if r.remaining() < count.saturating_mul(4) {
        return Err(DemuxError::MalformedBox("stsz"));
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(r.u32().ok_or(DemuxError::MalformedBox("stsz"))?);
    }
    Ok(out)
}

/// Time-to-sample, expanded to one duration per sample.
fn parse_stts(stts: &[u8]) -> Result<Vec<u32>, DemuxError> {
    let mut r = Reader::new(stts);
    r.version_flags().ok_or(DemuxError::MalformedBox("stts"))?;
    let entries = r.u32().ok_or(DemuxError::MalformedBox("stts"))? as usize;
    if r.remaining() < entries.saturating_mul(8) {
        return Err(DemuxError::MalformedBox("stts"));
    }

    let mut out: Vec<u32> = Vec::new();
    for _ in 0..entries {
        let count = r.u32().ok_or(DemuxError::MalformedBox("stts"))? as usize;
        let delta = r.u32().ok_or(DemuxError::MalformedBox("stts"))?;
        if out.len().saturating_add(count) > MAX_SAMPLES {
            return Err(DemuxError::TooLarge);
        }
        out.extend(core::iter::repeat(delta).take(count));
    }
    Ok(out)
}

/// Composition offsets, expanded to one per sample.
fn parse_ctts(ctts: &[u8]) -> Result<Vec<i32>, DemuxError> {
    let mut r = Reader::new(ctts);
    let (version, _) = r.version_flags().ok_or(DemuxError::MalformedBox("ctts"))?;
    let entries = r.u32().ok_or(DemuxError::MalformedBox("ctts"))? as usize;
    if r.remaining() < entries.saturating_mul(8) {
        return Err(DemuxError::MalformedBox("ctts"));
    }

    let mut out: Vec<i32> = Vec::new();
    for _ in 0..entries {
        let count = r.u32().ok_or(DemuxError::MalformedBox("ctts"))? as usize;
        // v0 offsets are unsigned, v1 signed; both fit i32 for sane media.
        let offset = if version == 0 {
            i32::try_from(r.u32().ok_or(DemuxError::MalformedBox("ctts"))?).unwrap_or(i32::MAX)
        } else {
            r.i32().ok_or(DemuxError::MalformedBox("ctts"))?
        };
        if out.len().saturating_add(count) > MAX_SAMPLES {
            return Err(DemuxError::TooLarge);
        }
        out.extend(core::iter::repeat(offset).take(count));
    }
    Ok(out)
}

/// Sync sample table: 1-based sample numbers that are keyframes.
fn parse_stss(stss: &[u8]) -> Result<Vec<u32>, DemuxError> {
    let mut r = Reader::new(stss);
    r.version_flags().ok_or(DemuxError::MalformedBox("stss"))?;
    let count = r.u32().ok_or(DemuxError::MalformedBox("stss"))? as usize;
    if count > MAX_SAMPLES || r.remaining() < count.saturating_mul(4) {
        return Err(DemuxError::MalformedBox("stss"));
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(r.u32().ok_or(DemuxError::MalformedBox("stss"))?);
    }
    Ok(out)
}

/// One sample-to-chunk mapping entry.
struct StscEntry {
    first_chunk: u32,
    samples_per_chunk: u32,
}

fn parse_stsc(stsc: &[u8]) -> Result<Vec<StscEntry>, DemuxError> {
    let mut r = Reader::new(stsc);
    r.version_flags().ok_or(DemuxError::MalformedBox("stsc"))?;
    let count = r.u32().ok_or(DemuxError::MalformedBox("stsc"))? as usize;
    if r.remaining() < count.saturating_mul(12) {
        return Err(DemuxError::MalformedBox("stsc"));
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let first_chunk = r.u32().ok_or(DemuxError::MalformedBox("stsc"))?;
        let samples_per_chunk = r.u32().ok_or(DemuxError::MalformedBox("stsc"))?;
        r.u32().ok_or(DemuxError::MalformedBox("stsc"))?; // sample_description_index
        out.push(StscEntry {
            first_chunk,
            samples_per_chunk,
        });
    }
    Ok(out)
}

/// Chunk offsets from `stco` (32-bit) or `co64` (64-bit, for files > 4 GiB).
fn parse_chunk_offsets(stbl: &[u8]) -> Result<Vec<u64>, DemuxError> {
    if let Some(co64) = find(stbl, b"co64") {
        let mut r = Reader::new(co64);
        r.version_flags().ok_or(DemuxError::MalformedBox("co64"))?;
        let count = r.u32().ok_or(DemuxError::MalformedBox("co64"))? as usize;
        if count > MAX_CHUNKS || r.remaining() < count.saturating_mul(8) {
            return Err(DemuxError::MalformedBox("co64"));
        }
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            out.push(r.u64().ok_or(DemuxError::MalformedBox("co64"))?);
        }
        return Ok(out);
    }

    let stco = find(stbl, b"stco").ok_or(DemuxError::MalformedBox("stco"))?;
    let mut r = Reader::new(stco);
    r.version_flags().ok_or(DemuxError::MalformedBox("stco"))?;
    let count = r.u32().ok_or(DemuxError::MalformedBox("stco"))? as usize;
    if count > MAX_CHUNKS || r.remaining() < count.saturating_mul(4) {
        return Err(DemuxError::MalformedBox("stco"));
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(u64::from(r.u32().ok_or(DemuxError::MalformedBox("stco"))?));
    }
    Ok(out)
}

/// Combine the tables into a flat, per-sample index.
///
/// Samples are laid out consecutively within each chunk, so a sample's offset
/// is its chunk's offset plus the sizes of the samples before it in that chunk.
fn build_index(
    sizes: &[u32],
    durations: &[u32],
    chunk_offsets: &[u64],
    stsc: &[StscEntry],
    sync: Option<&[u32]>,
    cts: Option<&[i32]>,
) -> Result<Vec<SampleRef>, DemuxError> {
    if sizes.is_empty() {
        return Ok(Vec::new());
    }
    if stsc.is_empty() || chunk_offsets.is_empty() {
        return Err(DemuxError::InconsistentTables);
    }

    let mut samples: Vec<SampleRef> = Vec::with_capacity(sizes.len());
    let mut sample_idx = 0usize;

    for (chunk_idx, &chunk_offset) in chunk_offsets.iter().enumerate() {
        if sample_idx >= sizes.len() {
            break;
        }
        let per_chunk = samples_in_chunk(stsc, chunk_idx)?;
        let mut offset = chunk_offset;

        for _ in 0..per_chunk {
            let Some(&size) = sizes.get(sample_idx) else {
                break; // tables disagree; keep what parsed cleanly
            };
            samples.push(SampleRef {
                offset,
                size,
                // A missing stts entry means the source is malformed; treat the
                // sample as zero-length rather than dropping it.
                duration: durations.get(sample_idx).copied().unwrap_or(0),
                // With no stss box every sample is a sync sample.
                is_sync: match sync {
                    None => true,
                    Some(list) => list.binary_search(&(sample_idx as u32 + 1)).is_ok(),
                },
                composition_offset: cts.and_then(|c| c.get(sample_idx).copied()).unwrap_or(0),
            });
            offset = offset.saturating_add(u64::from(size));
            sample_idx += 1;
        }
    }

    if samples.is_empty() {
        return Err(DemuxError::InconsistentTables);
    }
    Ok(samples)
}

/// How many samples live in chunk `chunk_idx` (0-based), per the `stsc` runs.
///
/// `stsc` is run-length encoded: an entry applies from its `first_chunk` until
/// the next entry's `first_chunk`.
fn samples_in_chunk(stsc: &[StscEntry], chunk_idx: usize) -> Result<u32, DemuxError> {
    let chunk_no = u32::try_from(chunk_idx.saturating_add(1)).map_err(|_| DemuxError::TooLarge)?;
    let mut current = None;
    for entry in stsc {
        if entry.first_chunk <= chunk_no {
            current = Some(entry.samples_per_chunk);
        } else {
            break;
        }
    }
    current.ok_or(DemuxError::InconsistentTables)
}

#[cfg(test)]
mod tests;
