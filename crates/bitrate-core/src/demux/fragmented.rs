//! Reading samples from `moof` boxes — fragmented MP4 input.
//!
//! A fragmented file's `moov` describes the tracks but declares no samples: its
//! sample tables are empty and the real per-sample data lives in a `moof` before
//! each `mdat`. Files written for streaming, by many phones, and by anything
//! that had to start writing before it knew the final length are shaped this way.
//!
//! Only the `moof` boxes are parsed here. They are small next to the media, so
//! the JS side can walk the file's top-level boxes and hand over each `moof`
//! without ever reading an `mdat` (PLAN.md §3d).

use super::mp4::SampleRef;
use super::reader::{boxes, Reader};

/// `tfhd` flags.
const TFHD_BASE_DATA_OFFSET: u32 = 0x00_0001;
const TFHD_SAMPLE_DESCRIPTION_INDEX: u32 = 0x00_0002;
const TFHD_DEFAULT_SAMPLE_DURATION: u32 = 0x00_0008;
const TFHD_DEFAULT_SAMPLE_SIZE: u32 = 0x00_0010;
const TFHD_DEFAULT_SAMPLE_FLAGS: u32 = 0x00_0020;
const TFHD_DEFAULT_BASE_IS_MOOF: u32 = 0x02_0000;

/// `trun` flags.
const TRUN_DATA_OFFSET: u32 = 0x00_0001;
const TRUN_FIRST_SAMPLE_FLAGS: u32 = 0x00_0004;
const TRUN_SAMPLE_DURATION: u32 = 0x00_0100;
const TRUN_SAMPLE_SIZE: u32 = 0x00_0200;
const TRUN_SAMPLE_FLAGS: u32 = 0x00_0400;
const TRUN_SAMPLE_CTS: u32 = 0x00_0800;

/// Set in a sample's flags when it is *not* a random access point.
const SAMPLE_IS_NON_SYNC: u32 = 0x0001_0000;

/// Per-track defaults from `mvex`/`trex`, used when a fragment omits them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TrackDefaults {
    /// Which track these defaults apply to.
    pub track_id: u32,
    /// Default sample duration, in the track timescale.
    pub duration: u32,
    /// Default sample size in bytes.
    pub size: u32,
    /// Default sample flags, including the non-sync bit.
    pub flags: u32,
}

/// Read the `trex` defaults for every track declared in a `moov`.
pub fn parse_trex(moov: &[u8]) -> Vec<TrackDefaults> {
    let Some(mvex) = super::reader::find(moov, b"mvex") else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in boxes(mvex) {
        if !entry.is(b"trex") {
            continue;
        }
        let mut r = Reader::new(entry.payload);
        if r.version_flags().is_none() {
            continue;
        }
        let (Some(track_id), Some(_desc), Some(duration), Some(size), Some(flags)) =
            (r.u32(), r.u32(), r.u32(), r.u32(), r.u32())
        else {
            continue;
        };
        out.push(TrackDefaults {
            track_id,
            duration,
            size,
            flags,
        });
    }
    out
}

/// Samples belonging to one track within one fragment.
pub struct FragmentSamples {
    /// The track these samples belong to.
    pub track_id: u32,
    /// The samples this fragment contributes, in decode order.
    pub samples: Vec<SampleRef>,
}

/// Parse one `moof` into its per-track samples.
///
/// `moof_offset` is where the `moof` box starts in the file, which most files
/// use as the base for their sample offsets (`default-base-is-moof`).
pub fn parse_moof(
    moof: &[u8],
    moof_offset: u64,
    defaults: &[TrackDefaults],
) -> Vec<FragmentSamples> {
    let mut out = Vec::new();

    for traf in boxes(moof) {
        if !traf.is(b"traf") {
            continue;
        }
        if let Some(samples) = parse_traf(traf.payload, moof_offset, defaults) {
            out.push(samples);
        }
    }
    out
}

fn parse_traf(
    traf: &[u8],
    moof_offset: u64,
    defaults: &[TrackDefaults],
) -> Option<FragmentSamples> {
    let tfhd = super::reader::find(traf, b"tfhd")?;
    let header = parse_tfhd(tfhd)?;

    // Fall back to this track's `trex` values for anything the fragment omits.
    let track_default = defaults
        .iter()
        .find(|d| d.track_id == header.track_id)
        .copied()
        .unwrap_or_default();

    let default_duration = header.default_duration.unwrap_or(track_default.duration);
    let default_size = header.default_size.unwrap_or(track_default.size);
    let default_flags = header.default_flags.unwrap_or(track_default.flags);

    // Where this track's sample data starts. `default-base-is-moof` — by far the
    // most common — makes offsets relative to the moof, which is what lets a
    // fragment be served on its own.
    let base = if let Some(explicit) = header.base_data_offset {
        explicit
    } else if header.default_base_is_moof {
        moof_offset
    } else {
        // Without either flag the base is the start of the enclosing moof for
        // the first track; treating every track that way is the pragmatic
        // reading, and files relying on anything else are vanishingly rare.
        moof_offset
    };

    let mut samples = Vec::new();
    let mut cursor = base;

    for run in boxes(traf) {
        if !run.is(b"trun") {
            continue;
        }
        let mut r = Reader::new(run.payload);
        let (version, flags) = match r.version_flags() {
            Some(v) => v,
            None => continue,
        };
        let count = match r.u32() {
            Some(c) => c as usize,
            None => continue,
        };

        // A trun's data offset restarts from the base rather than continuing
        // from the previous run.
        if flags & TRUN_DATA_OFFSET != 0 {
            match r.i32() {
                Some(offset) => cursor = base.saturating_add_signed(i64::from(offset)),
                None => continue,
            }
        }

        let first_sample_flags = if flags & TRUN_FIRST_SAMPLE_FLAGS != 0 {
            r.u32()
        } else {
            None
        };

        for index in 0..count {
            let duration = if flags & TRUN_SAMPLE_DURATION != 0 {
                match r.u32() {
                    Some(v) => v,
                    None => break,
                }
            } else {
                default_duration
            };

            let size = if flags & TRUN_SAMPLE_SIZE != 0 {
                match r.u32() {
                    Some(v) => v,
                    None => break,
                }
            } else {
                default_size
            };

            let sample_flags = if flags & TRUN_SAMPLE_FLAGS != 0 {
                match r.u32() {
                    Some(v) => v,
                    None => break,
                }
            } else if index == 0 {
                first_sample_flags.unwrap_or(default_flags)
            } else {
                default_flags
            };

            let composition_offset = if flags & TRUN_SAMPLE_CTS != 0 {
                // v0 offsets are unsigned, v1 signed; both fit i32 for real media.
                match if version == 0 {
                    r.u32().map(|v| i32::try_from(v).unwrap_or(i32::MAX))
                } else {
                    r.i32()
                } {
                    Some(v) => v,
                    None => break,
                }
            } else {
                0
            };

            samples.push(SampleRef {
                offset: cursor,
                size,
                duration,
                is_sync: sample_flags & SAMPLE_IS_NON_SYNC == 0,
                composition_offset,
            });
            cursor = cursor.saturating_add(u64::from(size));
        }
    }

    if samples.is_empty() {
        return None;
    }
    Some(FragmentSamples {
        track_id: header.track_id,
        samples,
    })
}

struct TfhdHeader {
    track_id: u32,
    base_data_offset: Option<u64>,
    default_duration: Option<u32>,
    default_size: Option<u32>,
    default_flags: Option<u32>,
    default_base_is_moof: bool,
}

fn parse_tfhd(tfhd: &[u8]) -> Option<TfhdHeader> {
    let mut r = Reader::new(tfhd);
    let (_version, flags) = r.version_flags()?;
    let track_id = r.u32()?;

    // Optional fields appear in flag order.
    let base_data_offset = if flags & TFHD_BASE_DATA_OFFSET != 0 {
        Some(r.u64()?)
    } else {
        None
    };
    if flags & TFHD_SAMPLE_DESCRIPTION_INDEX != 0 {
        r.u32()?;
    }
    let default_duration = if flags & TFHD_DEFAULT_SAMPLE_DURATION != 0 {
        Some(r.u32()?)
    } else {
        None
    };
    let default_size = if flags & TFHD_DEFAULT_SAMPLE_SIZE != 0 {
        Some(r.u32()?)
    } else {
        None
    };
    let default_flags = if flags & TFHD_DEFAULT_SAMPLE_FLAGS != 0 {
        Some(r.u32()?)
    } else {
        None
    };

    Some(TfhdHeader {
        track_id,
        base_data_offset,
        default_duration,
        default_size,
        default_flags,
        default_base_is_moof: flags & TFHD_DEFAULT_BASE_IS_MOOF != 0,
    })
}

#[cfg(test)]
mod tests;
