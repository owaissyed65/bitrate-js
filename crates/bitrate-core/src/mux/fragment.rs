//! fMP4 media segment: `styp` + `moof` + `mdat`.
//!
//! Each segment is independently decodable (it starts at a keyframe), which is
//! what lets a player seek by jumping straight to one segment instead of
//! downloading everything before it.

use super::boxes::BoxWriter;
use super::init::TRACK_ID;
use super::Sample;

/// `tfhd` flag: sample offsets are relative to the start of this `moof`.
/// Without it, offsets would be relative to the whole file, which a segment
/// served on its own cannot know.
const TFHD_DEFAULT_BASE_IS_MOOF: u32 = 0x02_0000;

/// `trun` flags for the per-sample fields we always emit.
const TRUN_DATA_OFFSET: u32 = 0x00_0001;
const TRUN_SAMPLE_DURATION: u32 = 0x00_0100;
const TRUN_SAMPLE_SIZE: u32 = 0x00_0200;
const TRUN_SAMPLE_FLAGS: u32 = 0x00_0400;
const TRUN_SAMPLE_CTS: u32 = 0x00_0800;

/// Sample flags marking a sync sample (keyframe): depends-on-nothing.
const FLAG_SYNC: u32 = 0x0200_0000;
/// Sample flags marking a non-sync sample: depends on others, not a random
/// access point.
const FLAG_NON_SYNC: u32 = 0x0101_0000;

/// Build one media segment from `samples`.
///
/// * `sequence_number` — 1-based fragment counter (`mfhd`).
/// * `base_decode_time` — decode time of the first sample, in track timescale
///   units (`tfdt`). This is what keeps segments correctly positioned on the
///   timeline so seeking lands where the player expects.
pub(super) fn build(sequence_number: u32, base_decode_time: u64, samples: &[Sample]) -> Vec<u8> {
    let media_len: usize = samples.iter().map(|s| s.data.len()).sum();
    let mut w = BoxWriter::with_capacity(media_len + 256 + samples.len() * 16);

    styp(&mut w);

    // `trun`'s data_offset is measured from the start of the moof, but is not
    // known until the moof is complete — so record where to patch it.
    let moof_start = w.len();
    let data_offset_pos = moof(&mut w, sequence_number, base_decode_time, samples);
    let moof_len = w.len() - moof_start;

    // Sample data begins after the moof and the 8-byte mdat header.
    let data_offset = u32::try_from(moof_len + 8).unwrap_or(u32::MAX);
    w.patch_u32_at(data_offset_pos, data_offset);

    mdat(&mut w, samples);
    w.into_bytes()
}

/// Segment type box. `msdh` marks a media segment; including it makes the
/// segment self-describing for CMAF/DASH consumers.
fn styp(w: &mut BoxWriter) {
    w.boxed(b"styp", |w| {
        w.bytes(b"msdh").u32(0);
        w.bytes(b"msdh").bytes(b"msix").bytes(b"cmfs");
    });
}

/// Write the `moof`, returning the buffer offset of `trun`'s `data_offset`
/// field so the caller can patch it once the moof size is known.
fn moof(w: &mut BoxWriter, sequence_number: u32, base_decode_time: u64, samples: &[Sample]) -> usize {
    let open = w.begin(b"moof");

    w.full_boxed(b"mfhd", 0, 0, |w| {
        w.u32(sequence_number);
    });

    let traf = w.begin(b"traf");

    w.full_boxed(b"tfhd", 0, TFHD_DEFAULT_BASE_IS_MOOF, |w| {
        w.u32(TRACK_ID);
    });

    // Version 1 carries a 64-bit decode time, so long videos cannot overflow.
    w.full_boxed(b"tfdt", 1, 0, |w| {
        w.u64(base_decode_time);
    });

    let data_offset_pos = trun(w, samples);

    w.end(traf);
    w.end(open);
    data_offset_pos
}

/// Track fragment run — describes every sample in this segment.
///
/// Returns the offset of the `data_offset` field for later patching.
fn trun(w: &mut BoxWriter, samples: &[Sample]) -> usize {
    let flags = TRUN_DATA_OFFSET
        | TRUN_SAMPLE_DURATION
        | TRUN_SAMPLE_SIZE
        | TRUN_SAMPLE_FLAGS
        | TRUN_SAMPLE_CTS;

    // Version 1 makes composition_time_offset signed, which B-frames require.
    let open = w.begin_full(b"trun", 1, flags);

    w.u32(u32::try_from(samples.len()).unwrap_or(u32::MAX));

    let data_offset_pos = w.len();
    w.i32(0); // placeholder, patched once the moof size is known

    for s in samples {
        w.u32(s.duration)
            .u32(u32::try_from(s.data.len()).unwrap_or(u32::MAX))
            .u32(if s.is_sync { FLAG_SYNC } else { FLAG_NON_SYNC })
            .i32(s.composition_offset);
    }

    w.end(open);
    data_offset_pos
}

/// Media data box — the raw encoded samples, concatenated in decode order.
fn mdat(w: &mut BoxWriter, samples: &[Sample]) {
    w.boxed(b"mdat", |w| {
        for s in samples {
            w.bytes(&s.data);
        }
    });
}
