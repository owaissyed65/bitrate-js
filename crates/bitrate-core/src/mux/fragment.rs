//! fMP4 media segment: `styp` + `moof` + `mdat`.
//!
//! Each segment is independently decodable (it starts at a keyframe), which is
//! what lets a player seek by jumping straight to one segment instead of
//! downloading everything before it.
//!
//! When the source has audio, a segment carries both tracks: two `traf` boxes
//! describing them, and a single `mdat` holding video samples followed by audio
//! samples. Keeping both in one segment means one request per time range and
//! keeps audio and video in lockstep.

use super::boxes::BoxWriter;
use super::init::{AUDIO_TRACK_ID, TRACK_ID};
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

/// One track's contribution to a segment.
pub(super) struct TrackRun<'a> {
    pub track_id: u32,
    /// Decode time of this run's first sample, in that track's timescale.
    pub base_decode_time: u64,
    pub samples: &'a [Sample],
}

/// Build one media segment from the given track runs.
///
/// * `sequence_number` — 1-based fragment counter (`mfhd`).
/// * `video` — always present; its keyframe defines the segment boundary.
/// * `audio` — the audio covering the same time range, when the source has any.
pub(super) fn build(
    sequence_number: u32,
    video: TrackRun<'_>,
    audio: Option<TrackRun<'_>>,
) -> Vec<u8> {
    let media_len: usize = video.samples.iter().map(|s| s.data.len()).sum::<usize>()
        + audio.as_ref().map_or(0, |a| a.samples.iter().map(|s| s.data.len()).sum());
    let sample_count = video.samples.len() + audio.as_ref().map_or(0, |a| a.samples.len());

    let mut w = BoxWriter::with_capacity(media_len + 512 + sample_count * 16);

    styp(&mut w);

    // Each `trun`'s data_offset is measured from the start of the moof but is
    // not known until the moof is complete, so record where to patch them.
    let moof_start = w.len();
    let offsets = moof(&mut w, sequence_number, &video, audio.as_ref());
    let moof_len = w.len() - moof_start;

    // Video data begins after the moof and the 8-byte mdat header; audio
    // follows the video bytes.
    let video_bytes: usize = video.samples.iter().map(|s| s.data.len()).sum();
    let video_offset = u32::try_from(moof_len + 8).unwrap_or(u32::MAX);
    w.patch_u32_at(offsets.video, video_offset);
    if let Some(audio_offset_pos) = offsets.audio {
        let audio_offset = u32::try_from(moof_len + 8 + video_bytes).unwrap_or(u32::MAX);
        w.patch_u32_at(audio_offset_pos, audio_offset);
    }

    mdat(&mut w, &video, audio.as_ref());
    w.into_bytes()
}

/// Where each track's `data_offset` field sits, for back-patching.
struct DataOffsets {
    video: usize,
    audio: Option<usize>,
}

/// Segment type box. `msdh` marks a media segment; including it makes the
/// segment self-describing for CMAF/DASH consumers.
fn styp(w: &mut BoxWriter) {
    w.boxed(b"styp", |w| {
        w.bytes(b"msdh").u32(0);
        w.bytes(b"msdh").bytes(b"msix").bytes(b"cmfs");
    });
}

/// Write the `moof`, returning where each track's `data_offset` must be patched.
fn moof(
    w: &mut BoxWriter,
    sequence_number: u32,
    video: &TrackRun<'_>,
    audio: Option<&TrackRun<'_>>,
) -> DataOffsets {
    let open = w.begin(b"moof");

    w.full_boxed(b"mfhd", 0, 0, |w| {
        w.u32(sequence_number);
    });

    let video_offset = traf(w, video);
    let audio_offset = audio.map(|a| traf(w, a));

    w.end(open);
    DataOffsets {
        video: video_offset,
        audio: audio_offset,
    }
}

/// Write one track fragment, returning the offset of its `data_offset` field.
fn traf(w: &mut BoxWriter, run: &TrackRun<'_>) -> usize {
    let open = w.begin(b"traf");

    w.full_boxed(b"tfhd", 0, TFHD_DEFAULT_BASE_IS_MOOF, |w| {
        w.u32(run.track_id);
    });

    // Version 1 carries a 64-bit decode time, so long videos cannot overflow.
    w.full_boxed(b"tfdt", 1, 0, |w| {
        w.u64(run.base_decode_time);
    });

    let data_offset_pos = trun(w, run.samples);

    w.end(open);
    data_offset_pos
}

/// Track fragment run — describes every sample in this track's part of the
/// segment. Returns the offset of the `data_offset` field for later patching.
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

/// Media data box — video samples then audio samples, each in decode order.
/// The order here must match the `data_offset` arithmetic above.
fn mdat(w: &mut BoxWriter, video: &TrackRun<'_>, audio: Option<&TrackRun<'_>>) {
    w.boxed(b"mdat", |w| {
        for s in video.samples {
            w.bytes(&s.data);
        }
        if let Some(audio) = audio {
            for s in audio.samples {
                w.bytes(&s.data);
            }
        }
    });
}

/// Track ids, re-exported so the segmenter can build runs.
pub(super) const VIDEO_TRACK: u32 = TRACK_ID;
pub(super) const AUDIO_TRACK: u32 = AUDIO_TRACK_ID;
