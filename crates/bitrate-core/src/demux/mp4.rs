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
    /// The file is a fragmented MP4; its samples live in `moof` boxes, which
    /// this build does not read.
    FragmentedMp4,
    /// The video track declares no samples.
    EmptyTrack,
}

impl core::fmt::Display for DemuxError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::NoMoov => f.write_str("no moov box found; is this an MP4?"),
            Self::NoVideoTrack => f.write_str("no supported H.264 video track found"),
            Self::MalformedBox(b) => write!(f, "malformed or truncated `{b}` box"),
            Self::TooLarge => f.write_str("file declares more samples than this build will process"),
            Self::InconsistentTables => f.write_str("sample tables are inconsistent"),
            Self::FragmentedMp4 => f.write_str(
                "this is a fragmented MP4 (its moov declares no samples); \
                 fragmented input is not supported yet",
            ),
            Self::EmptyTrack => f.write_str("the video track contains no samples"),
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

/// A parsed audio track.
///
/// The codec's sample entry (`mp4a` and its `esds`, or whatever the source
/// used) is carried through verbatim rather than re-derived. Copying it exactly
/// preserves sample rate, channel layout and decoder configuration, which is
/// both simpler and safer than rebuilding a descriptor we would have to get
/// bit-perfect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioTrack {
    /// Track timescale — usually the sample rate.
    pub timescale: u32,
    /// The complete sample entry box, header included, ready to re-embed.
    pub sample_entry: Vec<u8>,
    /// Every audio frame, in decode order.
    pub samples: Vec<SampleRef>,
}

/// A parsed source: one video track and, when present, one audio track.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Movie {
    /// The H.264 video track. Required — a source without one is rejected.
    pub video: VideoTrack,
    /// `None` for a silent source — packaging then produces video only.
    pub audio: Option<AudioTrack>,
}

/// Parse a `moov` payload into its video track and optional audio track.
pub fn parse_moov(moov: &[u8]) -> Result<Movie, DemuxError> {
    let mut video: Option<VideoTrack> = None;
    let mut audio: Option<AudioTrack> = None;

    for b in boxes(moov) {
        if !b.is(b"trak") {
            continue;
        }
        match handler_of(b.payload) {
            Some(kind) if &kind == b"vide" && video.is_none() => {
                video = Some(parse_video_trak(b.payload)?);
            }
            // A source may carry several audio tracks (commentary, languages);
            // the first is the main one for our purposes.
            Some(kind) if &kind == b"soun" && audio.is_none() => {
                // A malformed audio track should not sink an otherwise fine
                // video: drop it and package silent output instead.
                audio = parse_audio_trak(b.payload).ok();
            }
            _ => {}
        }
    }

    let video = video.ok_or(DemuxError::NoVideoTrack)?;

    // A fragmented file has a `mvex` box and empty sample tables: the samples
    // live in `moof` boxes we do not read. Detected here so the caller gets a
    // straight answer instead of a track that silently reports zero duration.
    if video.samples.is_empty() {
        return Err(if find(moov, b"mvex").is_some() {
            DemuxError::FragmentedMp4
        } else {
            DemuxError::EmptyTrack
        });
    }

    Ok(Movie { video, audio })
}

fn parse_video_trak(trak: &[u8]) -> Result<VideoTrack, DemuxError> {
    let mdia = find(trak, b"mdia").ok_or(DemuxError::MalformedBox("mdia"))?;
    let (timescale, stbl) = track_basics(mdia)?;
    let visual = parse_stsd(find(stbl, b"stsd").ok_or(DemuxError::MalformedBox("stsd"))?)?;
    let samples = sample_index(stbl)?;

    Ok(VideoTrack {
        timescale,
        width: visual.width,
        height: visual.height,
        codec_config: visual.codec_config,
        samples,
    })
}

fn parse_audio_trak(trak: &[u8]) -> Result<AudioTrack, DemuxError> {
    let mdia = find(trak, b"mdia").ok_or(DemuxError::MalformedBox("mdia"))?;
    let (timescale, stbl) = track_basics(mdia)?;
    let sample_entry =
        parse_audio_stsd(find(stbl, b"stsd").ok_or(DemuxError::MalformedBox("stsd"))?)?;
    let samples = sample_index(stbl)?;

    Ok(AudioTrack {
        timescale,
        sample_entry,
        samples,
    })
}

/// Timescale and sample table, common to every track type.
fn track_basics(mdia: &[u8]) -> Result<(u32, &[u8]), DemuxError> {
    let timescale = parse_mdhd(find(mdia, b"mdhd").ok_or(DemuxError::MalformedBox("mdhd"))?)?;
    if timescale == 0 {
        return Err(DemuxError::MalformedBox("mdhd"));
    }
    let stbl = find_path(mdia, &[b"minf", b"stbl"]).ok_or(DemuxError::MalformedBox("stbl"))?;
    Ok((timescale, stbl))
}

/// Build the per-sample index from a track's sample table.
fn sample_index(stbl: &[u8]) -> Result<Vec<SampleRef>, DemuxError> {
    let sizes = parse_stsz(find(stbl, b"stsz").ok_or(DemuxError::MalformedBox("stsz"))?)?;
    let durations = parse_stts(find(stbl, b"stts").ok_or(DemuxError::MalformedBox("stts"))?)?;
    let chunk_offsets = parse_chunk_offsets(stbl)?;
    let stsc = parse_stsc(find(stbl, b"stsc").ok_or(DemuxError::MalformedBox("stsc"))?)?;
    let sync = find(stbl, b"stss").map(parse_stss).transpose()?;
    let cts = find(stbl, b"ctts").map(parse_ctts).transpose()?;

    build_index(&sizes, &durations, &chunk_offsets, &stsc, sync.as_deref(), cts.as_deref())
}

/// The handler type of a track (`vide`, `soun`, …), if it declares one.
fn handler_of(trak: &[u8]) -> Option<[u8; 4]> {
    let mdia = find(trak, b"mdia")?;
    let hdlr = find(mdia, b"hdlr")?;
    let mut r = Reader::new(hdlr);
    r.version_flags()?;
    r.u32()?; // pre_defined
    r.fourcc()
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

/// Largest audio sample entry we will copy, to bound memory on hostile input.
const MAX_SAMPLE_ENTRY: usize = 64 * 1024;

/// Extract an audio track's sample entry as a complete, re-embeddable box.
///
/// The entry is copied byte-for-byte — including `esds`, sample rate and
/// channel count — rather than parsed and rebuilt. Reconstructing an
/// `ES_Descriptor` correctly is fiddly and offers nothing here: for remuxing,
/// an exact copy is both simpler and more faithful.
fn parse_audio_stsd(stsd: &[u8]) -> Result<Vec<u8>, DemuxError> {
    let mut r = Reader::new(stsd);
    r.version_flags().ok_or(DemuxError::MalformedBox("stsd"))?;
    r.u32().ok_or(DemuxError::MalformedBox("stsd"))?; // entry_count

    // The first entry is the one the sample table's description index points at.
    let entry = boxes(r.rest())
        .into_iter()
        .next()
        .ok_or(DemuxError::MalformedBox("stsd"))?;

    if entry.payload.len() > MAX_SAMPLE_ENTRY {
        return Err(DemuxError::MalformedBox("stsd"));
    }

    // Rebuild the box header: `boxes()` hands back payloads only.
    let size = u32::try_from(entry.payload.len().saturating_add(8))
        .map_err(|_| DemuxError::MalformedBox("stsd"))?;
    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(&entry.kind);
    out.extend_from_slice(entry.payload);
    Ok(out)
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
