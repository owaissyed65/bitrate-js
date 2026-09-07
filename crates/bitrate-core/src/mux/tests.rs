//! Structural tests for the fMP4 muxer.
//!
//! These parse the bytes back out rather than comparing against a golden blob,
//! so a failure points at the specific box that is wrong.

use super::{Fmp4Segmenter, Sample, Segment};

// ---- minimal ISO-BMFF reader, for assertions only -------------------------

/// Split a buffer into its top-level boxes as `(type, payload)` pairs.
fn boxes(buf: &[u8]) -> Vec<(String, &[u8])> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at + 8 <= buf.len() {
        let size = u32::from_be_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]) as usize;
        let kind = String::from_utf8_lossy(&buf[at + 4..at + 8]).into_owned();
        assert!(size >= 8, "box {kind} has bogus size {size}");
        let end = (at + size).min(buf.len());
        out.push((kind, &buf[at + 8..end]));
        at += size;
    }
    assert_eq!(at, buf.len(), "trailing bytes after last box");
    out
}

/// Payload of the first child box named `kind`.
fn child<'a>(payload: &'a [u8], kind: &str) -> &'a [u8] {
    boxes(payload)
        .into_iter()
        .find(|(k, _)| k == kind)
        .unwrap_or_else(|| panic!("missing box `{kind}`"))
        .1
}

/// Walk a `/`-separated path of container boxes.
fn path<'a>(buf: &'a [u8], p: &str) -> &'a [u8] {
    p.split('/').fold(buf, |acc, k| child(acc, k))
}

fn has(payload: &[u8], kind: &str) -> bool {
    boxes(payload).iter().any(|(k, _)| k == kind)
}

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn be16(b: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([b[at], b[at + 1]])
}

fn be64(b: &[u8], at: usize) -> u64 {
    u64::from_be_bytes(b[at..at + 8].try_into().expect("8 bytes"))
}

// ---- fixtures -------------------------------------------------------------

/// A plausible `avcC` record (Baseline 3.1) — contents are opaque to the muxer.
const AVCC: &[u8] = &[
    0x01, 0x42, 0xc0, 0x1f, 0xff, 0xe1, 0x00, 0x09, 0x67, 0x42, 0xc0, 0x1f, 0x8c, 0x8d, 0x40, 0x50,
    0x1e, 0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
];

const TIMESCALE: u32 = 90_000;
/// 30 fps at a 90 kHz timescale.
const FRAME: u32 = 3_000;

fn segmenter(target_seconds: f64) -> Fmp4Segmenter {
    Fmp4Segmenter::try_new("720p", TIMESCALE, 1280, 720, AVCC, target_seconds)
        .unwrap_or_else(|_| panic!("valid config should construct"))
}

/// Push `count` frames, marking a keyframe every `gop` frames.
fn push_frames(s: &mut Fmp4Segmenter, count: usize, gop: usize) {
    for i in 0..count {
        let payload = vec![0xa5u8; 100 + i % 7];
        s.add_sample(&payload, FRAME, i % gop == 0, 0)
            .unwrap_or_else(|_| panic!("push_sample should accept a valid frame"));
    }
}

// ---- init segment ---------------------------------------------------------

#[test]
fn init_segment_has_ftyp_then_moov() {
    let mut s = segmenter(6.0);
    let init = s.init_segment();
    let top = boxes(&init);
    assert_eq!(top.len(), 2);
    assert_eq!(top[0].0, "ftyp");
    assert_eq!(top[1].0, "moov");
}

#[test]
fn init_segment_declares_cmaf_brands() {
    let mut s = segmenter(6.0);
    let init = s.init_segment();
    let ftyp = child(&init, "ftyp");
    assert_eq!(&ftyp[0..4], b"iso6", "major brand");
    // Compatible brands must advertise CMAF so the same output can serve DASH.
    let brands: Vec<&[u8]> = ftyp[8..].chunks(4).collect();
    assert!(brands.contains(&b"cmfc".as_slice()));
}

#[test]
fn moov_contains_the_full_track_hierarchy() {
    let mut s = segmenter(6.0);
    let init = s.init_segment();
    let moov = child(&init, "moov");

    assert!(has(moov, "mvhd"));
    assert!(has(moov, "trak"));
    // mvex is what tells a player fragments follow; without it playback fails.
    assert!(has(moov, "mvex"));
    assert!(has(child(moov, "mvex"), "trex"));

    let minf = path(&init, "moov/trak/mdia/minf");
    assert!(has(minf, "vmhd"));
    assert!(has(minf, "dinf"));
    assert!(has(minf, "stbl"));
}

#[test]
fn sample_tables_are_empty_for_fragmented_output() {
    let mut s = segmenter(6.0);
    let init = s.init_segment();
    let stbl = path(&init, "moov/trak/mdia/minf/stbl");

    // Every table but stsd must be empty; samples are described per-fragment.
    assert_eq!(be32(child(stbl, "stts"), 4), 0, "stts entry_count");
    assert_eq!(be32(child(stbl, "stsc"), 4), 0, "stsc entry_count");
    assert_eq!(be32(child(stbl, "stco"), 4), 0, "stco entry_count");
    let stsz = child(stbl, "stsz");
    assert_eq!(be32(stsz, 4), 0, "stsz sample_size");
    assert_eq!(be32(stsz, 8), 0, "stsz sample_count");
}

#[test]
fn avc1_carries_dimensions_and_the_avcc_record() {
    let mut s = segmenter(6.0);
    let init = s.init_segment();
    let stsd = path(&init, "moov/trak/mdia/minf/stbl/stsd");

    // stsd is a FullBox with an entry_count before its child boxes.
    assert_eq!(be32(stsd, 4), 1, "one sample entry");
    let avc1 = child(&stsd[8..], "avc1");

    // VisualSampleEntry: width/height sit 24 bytes into the payload.
    assert_eq!(be16(avc1, 24), 1280, "width");
    assert_eq!(be16(avc1, 26), 720, "height");

    // The avcC record must round-trip byte-for-byte or the decoder cannot init.
    let avcc = child(&avc1[78..], "avcC");
    assert_eq!(avcc, AVCC);
}

#[test]
fn tkhd_encodes_dimensions_as_16_16_fixed_point() {
    let mut s = segmenter(6.0);
    let init = s.init_segment();
    let tkhd = path(&init, "moov/trak/tkhd");
    // v0 payload: 4 ver/flags + 3*4 + 4 reserved + 4 duration + 8 reserved
    // + 2+2+2+2 + 36 matrix = 76, then width/height.
    assert_eq!(be32(tkhd, 76), 1280 << 16, "width 16.16");
    assert_eq!(be32(tkhd, 80), 720 << 16, "height 16.16");
}

// ---- media segments -------------------------------------------------------

#[test]
fn segment_has_styp_moof_mdat_in_order() {
    let mut s = segmenter(1.0);
    push_frames(&mut s, 60, 30); // 2s, keyframes at 0 and 30
    s.finish();

    let seg = s.take_segment().expect("a segment should be ready");
    let top = boxes(&seg.data);
    assert_eq!(
        top.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
        vec!["styp", "moof", "mdat"]
    );
}

#[test]
fn moof_contains_mfhd_and_traf_with_tfhd_tfdt_trun() {
    let mut s = segmenter(1.0);
    push_frames(&mut s, 60, 30);
    s.finish();

    let seg = s.take_segment().expect("segment");
    let moof = child(&seg.data, "moof");
    assert!(has(moof, "mfhd"));
    let traf = child(moof, "traf");
    assert!(has(traf, "tfhd"));
    assert!(has(traf, "tfdt"));
    assert!(has(traf, "trun"));
}

#[test]
fn tfhd_sets_default_base_is_moof() {
    let mut s = segmenter(1.0);
    push_frames(&mut s, 60, 30);
    s.finish();

    let seg = s.take_segment().expect("segment");
    let tfhd = path(&seg.data, "moof/traf/tfhd");
    // Flags occupy bytes 1..4 of a FullBox payload. Without 0x020000 a segment
    // served standalone cannot locate its own sample data.
    let flags = u32::from_be_bytes([0, tfhd[1], tfhd[2], tfhd[3]]);
    assert_eq!(flags & 0x02_0000, 0x02_0000, "default-base-is-moof");
}

#[test]
fn trun_data_offset_points_at_the_first_sample_byte() {
    let mut s = segmenter(1.0);
    push_frames(&mut s, 60, 30);
    s.finish();

    let seg = s.take_segment().expect("segment");
    let data = &seg.data;

    let styp_size = be32(data, 0) as usize;
    let moof_size = be32(data, styp_size) as usize;

    let trun = path(data, "moof/traf/trun");
    // FullBox(4) + sample_count(4), then data_offset.
    let data_offset = be32(trun, 8) as usize;

    // data_offset is relative to the start of the moof.
    let absolute = styp_size + data_offset;
    let mdat_start = styp_size + moof_size;
    assert_eq!(absolute, mdat_start + 8, "sample data must begin just past the mdat header");
}

#[test]
fn mdat_holds_every_sample_concatenated_in_order() {
    let mut s = segmenter(10.0);
    let payloads: Vec<Vec<u8>> = (0..5).map(|i| vec![i as u8; 10 + i]).collect();
    for (i, p) in payloads.iter().enumerate() {
        s.add_sample(p, FRAME, i == 0, 0).expect("push");
    }
    s.finish();

    let seg = s.take_segment().expect("segment");
    let mdat = child(&seg.data, "mdat");
    let expected: Vec<u8> = payloads.concat();
    assert_eq!(mdat, expected.as_slice());
}

#[test]
fn trun_records_size_duration_and_sync_flag_per_sample() {
    let mut s = segmenter(10.0);
    s.add_sample(&[1u8; 40], FRAME, true, 0).expect("push");
    s.add_sample(&[2u8; 55], FRAME, false, 7).expect("push");
    s.finish();

    let seg = s.take_segment().expect("segment");
    let trun = path(&seg.data, "moof/traf/trun");
    assert_eq!(be32(trun, 4), 2, "sample_count");

    // Entries start after FullBox(4) + sample_count(4) + data_offset(4).
    let first = 12;
    assert_eq!(be32(trun, first), FRAME, "duration");
    assert_eq!(be32(trun, first + 4), 40, "size");
    assert_eq!(be32(trun, first + 8), 0x0200_0000, "keyframe flags");
    assert_eq!(be32(trun, first + 12) as i32, 0, "cts offset");

    let second = first + 16;
    assert_eq!(be32(trun, second + 4), 55, "size");
    assert_eq!(be32(trun, second + 8), 0x0101_0000, "non-sync flags");
    assert_eq!(be32(trun, second + 12) as i32, 7, "cts offset");
}

// ---- segmentation behaviour ----------------------------------------------

#[test]
fn segments_split_at_keyframes_once_the_target_is_reached() {
    let mut s = segmenter(1.0); // 1s target = 30 frames
    push_frames(&mut s, 120, 30); // 4s, keyframes every 1s
    s.finish();

    assert_eq!(s.pending_segments(), 4, "one segment per GOP");
    for _ in 0..4 {
        let seg = s.take_segment().expect("segment");
        assert!((seg.duration - 1.0).abs() < 1e-9, "each segment is 1s");
    }
}

#[test]
fn a_segment_never_starts_on_a_non_keyframe() {
    let mut s = segmenter(1.0);
    push_frames(&mut s, 120, 30);
    s.finish();

    while let Some(seg) = s.take_segment() {
        let trun = path(&seg.data, "moof/traf/trun");
        let first_flags = be32(trun, 12 + 8);
        assert_eq!(first_flags, 0x0200_0000, "first sample must be a keyframe");
    }
}

#[test]
fn sparse_keyframes_produce_longer_segments_not_broken_ones() {
    // Target 1s but keyframes only every 4s: segments must stretch, never split
    // mid-GOP, or they would not be independently decodable.
    let mut s = segmenter(1.0);
    push_frames(&mut s, 240, 120);
    s.finish();

    assert_eq!(s.pending_segments(), 2);
    let seg = s.take_segment().expect("segment");
    assert!((seg.duration - 4.0).abs() < 1e-9);
}

#[test]
fn tfdt_base_decode_time_accumulates_across_segments() {
    let mut s = segmenter(1.0);
    push_frames(&mut s, 90, 30); // 3 segments of 1s
    s.finish();

    let mut expected = 0u64;
    while let Some(seg) = s.take_segment() {
        let tfdt = path(&seg.data, "moof/traf/tfdt");
        assert_eq!(tfdt[0], 1, "tfdt must be version 1 (64-bit)");
        assert_eq!(be64(tfdt, 4), expected, "baseMediaDecodeTime");
        expected += u64::from(TIMESCALE);
    }
}

#[test]
fn mfhd_sequence_numbers_are_one_based_and_consecutive() {
    let mut s = segmenter(1.0);
    push_frames(&mut s, 90, 30);
    s.finish();

    let mut expected = 1u32;
    while let Some(seg) = s.take_segment() {
        let mfhd = path(&seg.data, "moof/mfhd");
        assert_eq!(be32(mfhd, 4), expected);
        expected += 1;
    }
}

#[test]
fn finish_flushes_a_partial_trailing_segment() {
    let mut s = segmenter(10.0);
    push_frames(&mut s, 15, 30); // half a second, well under target
    assert_eq!(s.pending_segments(), 0, "nothing closed yet");
    s.finish();
    assert_eq!(s.pending_segments(), 1, "the tail must not be dropped");
}

#[test]
fn finish_on_an_empty_segmenter_is_a_no_op() {
    let mut s = segmenter(6.0);
    s.finish();
    assert_eq!(s.pending_segments(), 0);
    assert!(s.playlist_text().contains("#EXT-X-ENDLIST"));
}

// ---- playlist integration -------------------------------------------------

#[test]
fn playlist_indexes_every_segment_with_the_init_map() {
    let mut s = segmenter(1.0);
    let _ = s.init_segment();
    push_frames(&mut s, 90, 30);
    s.finish();

    let m3u8 = s.playlist_text();
    assert!(m3u8.contains(r#"#EXT-X-MAP:URI="720p_init.mp4""#));
    assert!(m3u8.contains("720p_00000.m4s"));
    assert!(m3u8.contains("720p_00001.m4s"));
    assert!(m3u8.contains("720p_00002.m4s"));
    assert!(m3u8.contains("#EXT-X-ENDLIST"));
    assert_eq!(m3u8.matches("#EXTINF").count(), 3);
}

#[test]
fn names_are_zero_padded_and_prefixed() {
    let s = segmenter(6.0);
    assert_eq!(s.segment_name(0), "720p_00000.m4s");
    assert_eq!(s.segment_name(42), "720p_00042.m4s");
    assert_eq!(s.init_name(), "720p_init.mp4");
    assert_eq!(s.playlist_name(), "720p.m3u8");
}

#[test]
fn prefix_is_sanitized_against_path_traversal() {
    let s = Fmp4Segmenter::try_new("../../evil", TIMESCALE, 640, 480, AVCC, 6.0)
        .unwrap_or_else(|_| panic!("should construct"));
    assert!(!s.segment_name(0).contains(".."));
    assert!(!s.segment_name(0).contains('/'));
}

// ---- input validation -----------------------------------------------------

#[test]
fn rejects_invalid_track_configuration() {
    assert!(Fmp4Segmenter::try_new("a", 0, 640, 480, AVCC, 6.0).is_err(), "zero timescale");
    assert!(Fmp4Segmenter::try_new("a", TIMESCALE, 0, 480, AVCC, 6.0).is_err(), "zero width");
    assert!(Fmp4Segmenter::try_new("a", TIMESCALE, 640, 0, AVCC, 6.0).is_err(), "zero height");
    assert!(
        Fmp4Segmenter::try_new("a", TIMESCALE, 20_000, 480, AVCC, 6.0).is_err(),
        "absurd width"
    );
    assert!(Fmp4Segmenter::try_new("a", TIMESCALE, 640, 480, &[], 6.0).is_err(), "empty avcC");
    assert!(
        Fmp4Segmenter::try_new("a", TIMESCALE, 640, 480, &vec![0u8; 8192], 6.0).is_err(),
        "oversized avcC"
    );
}

#[test]
fn rejects_invalid_target_duration() {
    for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(
            Fmp4Segmenter::try_new("a", TIMESCALE, 640, 480, AVCC, bad).is_err(),
            "target {bad} must be rejected"
        );
    }
}

#[test]
fn rejects_empty_and_oversized_samples() {
    let mut s = segmenter(6.0);
    assert!(s.add_sample(&[], FRAME, true, 0).is_err(), "empty sample");
    assert!(s.add_sample(&[1, 2, 3], FRAME, true, 0).is_ok());
}

#[test]
fn zero_duration_samples_do_not_break_segmentation() {
    // A malformed source can report zero durations; we must still terminate.
    let mut s = segmenter(1.0);
    for i in 0..10 {
        s.add_sample(&[7u8; 10], 0, i % 5 == 0, 0).expect("push");
    }
    s.finish();
    assert_eq!(s.pending_segments(), 1, "all samples land in one segment");
    let seg = s.take_segment().expect("segment");
    assert_eq!(seg.duration, 0.0);
}

// ---- Sample struct sanity -------------------------------------------------

#[test]
fn sample_fields_are_carried_through() {
    let s = Sample {
        data: vec![1, 2, 3],
        duration: 100,
        is_sync: true,
        composition_offset: -5,
    };
    assert_eq!(s.data.len(), 3);
    assert_eq!(s.duration, 100);
    assert!(s.is_sync);
    assert_eq!(s.composition_offset, -5);
}

// ---- resume ---------------------------------------------------------------

#[test]
fn restored_segments_appear_in_the_playlist() {
    let mut s = segmenter(1.0);
    let _ = s.init_segment();
    // Pretend segments 0 and 1 were produced before an interruption.
    s.try_restore_segment(1.0).expect("restore");
    s.try_restore_segment(1.0).expect("restore");

    push_frames(&mut s, 30, 30);
    s.finish();

    let m3u8 = s.playlist_text();
    assert!(m3u8.contains("720p_00000.m4s"), "restored segment 0");
    assert!(m3u8.contains("720p_00001.m4s"), "restored segment 1");
    assert!(m3u8.contains("720p_00002.m4s"), "newly produced segment 2");
    assert_eq!(m3u8.matches("#EXTINF").count(), 3);
}

#[test]
fn resumed_segments_continue_the_numbering() {
    let mut s = segmenter(1.0);
    s.try_restore_segment(1.0).expect("restore");
    s.try_restore_segment(1.0).expect("restore");
    assert_eq!(s.next_segment_index(), 2);

    push_frames(&mut s, 30, 30);
    s.finish();

    let seg = s.take_segment().expect("segment");
    assert_eq!(seg.index, 2, "numbering must not restart");
}

#[test]
fn resumed_segments_continue_the_decode_timeline() {
    // A resumed segment whose tfdt restarted at zero would make the player
    // seek to the wrong place.
    let mut s = segmenter(1.0);
    s.try_restore_segment(2.0).expect("restore");
    push_frames(&mut s, 30, 30);
    s.finish();

    let seg = s.take_segment().expect("segment");
    let tfdt = path(&seg.data, "moof/traf/tfdt");
    assert_eq!(be64(tfdt, 4), 2 * u64::from(TIMESCALE), "timeline continues");
}

#[test]
fn restore_is_rejected_once_samples_have_been_pushed() {
    let mut s = segmenter(1.0);
    s.add_sample(&[1, 2, 3], FRAME, true, 0).expect("push");
    assert!(s.try_restore_segment(1.0).is_err());
}

#[test]
fn restore_rejects_a_nonsensical_duration() {
    let mut s = segmenter(1.0);
    assert!(s.try_restore_segment(f64::NAN).is_err());
    assert!(s.try_restore_segment(-1.0).is_err());
}

// ---- audio ----------------------------------------------------------------

/// A minimal but structurally valid `mp4a` sample entry.
fn mp4a_entry() -> Vec<u8> {
    let mut p = vec![0u8; 6];
    p.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    p.extend_from_slice(&[0u8; 8]);
    p.extend_from_slice(&2u16.to_be_bytes()); // channels
    p.extend_from_slice(&16u16.to_be_bytes()); // sample size
    p.extend_from_slice(&[0u8; 4]);
    p.extend_from_slice(&(44_100u32 << 16).to_be_bytes());
    let mut out = ((8 + p.len()) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(b"mp4a");
    out.extend_from_slice(&p);
    out
}

const AUDIO_TIMESCALE: u32 = 44_100;
/// One AAC frame is 1024 samples.
const AUDIO_FRAME: u32 = 1024;

fn segmenter_with_audio(target_seconds: f64) -> Fmp4Segmenter {
    let mut s = segmenter(target_seconds);
    s.try_set_audio(AUDIO_TIMESCALE, &mp4a_entry())
        .unwrap_or_else(|_| panic!("audio config should be accepted"));
    s
}

/// The payloads of the `traf` boxes in a segment, in order.
fn trafs(segment: &[u8]) -> Vec<&[u8]> {
    boxes(child(segment, "moof"))
        .into_iter()
        .filter(|(k, _)| k == "traf")
        .map(|(_, payload)| payload)
        .collect()
}

#[test]
fn init_segment_gains_a_second_track_when_audio_is_configured() {
    let mut s = segmenter_with_audio(6.0);
    let init = s.init_segment();
    let moov = child(&init, "moov");

    let count = boxes(moov).iter().filter(|(k, _)| k == "trak").count();
    assert_eq!(count, 2, "video and audio");

    // One trex per track, or a player will not accept the fragments.
    let mvex = child(moov, "mvex");
    assert_eq!(boxes(mvex).iter().filter(|(k, _)| k == "trex").count(), 2);
}

#[test]
fn the_audio_track_declares_a_sound_handler_and_smhd() {
    let mut s = segmenter_with_audio(6.0);
    let init = s.init_segment();
    let moov = child(&init, "moov");
    let audio_trak = boxes(moov)
        .into_iter()
        .filter(|(k, _)| k == "trak")
        .nth(1)
        .expect("audio trak")
        .1;

    let mdia = child(audio_trak, "mdia");
    let hdlr = child(mdia, "hdlr");
    // FullBox payload: version/flags(4) + pre_defined(4), then handler_type.
    assert_eq!(&hdlr[8..12], b"soun");

    let minf = child(mdia, "minf");
    assert!(has(minf, "smhd"), "audio needs a sound media header, not vmhd");
    assert!(!has(minf, "vmhd"));
}

#[test]
fn the_audio_sample_entry_is_embedded_verbatim() {
    let mut s = segmenter_with_audio(6.0);
    let init = s.init_segment();
    let moov = child(&init, "moov");
    let audio_trak = boxes(moov)
        .into_iter()
        .filter(|(k, _)| k == "trak")
        .nth(1)
        .expect("audio")
        .1;
    let stsd = path(audio_trak, "mdia/minf/stbl/stsd");

    assert_eq!(be32(stsd, 4), 1, "one entry");
    // Byte-for-byte: anything else risks losing the decoder configuration.
    assert_eq!(&stsd[8..], mp4a_entry().as_slice());
}

#[test]
fn without_audio_the_init_segment_is_unchanged() {
    let mut s = segmenter(6.0);
    let init = s.init_segment();
    let moov = child(&init, "moov");
    assert_eq!(boxes(moov).iter().filter(|(k, _)| k == "trak").count(), 1);
    assert_eq!(
        boxes(child(moov, "mvex"))
            .iter()
            .filter(|(k, _)| k == "trex")
            .count(),
        1
    );
}

#[test]
fn segments_carry_both_tracks() {
    let mut s = segmenter_with_audio(1.0);
    let _ = s.init_segment();
    for i in 0..60 {
        s.add_sample(&[0xaa; 100], FRAME, i % 30 == 0, 0)
            .expect("video");
        s.add_audio_sample(&[0xbb; 40], AUDIO_FRAME).expect("audio");
    }
    s.finish();

    let seg = s.take_segment().expect("segment");
    let runs = trafs(&seg.data);
    assert_eq!(runs.len(), 2, "one traf per track");

    // Track ids must be 1 (video) then 2 (audio).
    assert_eq!(be32(child(runs[0], "tfhd"), 4), 1);
    assert_eq!(be32(child(runs[1], "tfhd"), 4), 2);
}

#[test]
fn audio_and_video_bytes_are_laid_out_where_their_offsets_claim() {
    let mut s = segmenter_with_audio(10.0);
    s.add_sample(&[0x11; 60], FRAME, true, 0).expect("video");
    s.add_sample(&[0x22; 70], FRAME, false, 0).expect("video");
    s.add_audio_sample(&[0x33; 40], AUDIO_FRAME).expect("audio");
    s.add_audio_sample(&[0x44; 50], AUDIO_FRAME).expect("audio");
    s.finish();

    let seg = s.take_segment().expect("segment");
    let data = &seg.data;
    let styp_size = be32(data, 0) as usize;
    let moof_size = be32(data, styp_size) as usize;
    let mdat_data = styp_size + moof_size + 8;

    let runs = trafs(data);

    // Video data starts immediately after the mdat header...
    let video_offset = be32(child(runs[0], "trun"), 8) as usize;
    assert_eq!(styp_size + video_offset, mdat_data);

    // ...and audio follows the 130 bytes of video.
    let audio_offset = be32(child(runs[1], "trun"), 8) as usize;
    assert_eq!(styp_size + audio_offset, mdat_data + 130);

    // Confirm the bytes really are in that order.
    let mdat = child(data, "mdat");
    assert!(mdat[0..60].iter().all(|&b| b == 0x11));
    assert!(mdat[60..130].iter().all(|&b| b == 0x22));
    assert!(mdat[130..170].iter().all(|&b| b == 0x33));
    assert!(mdat[170..220].iter().all(|&b| b == 0x44));
}

#[test]
fn every_audio_sample_is_marked_as_a_sync_sample() {
    let mut s = segmenter_with_audio(10.0);
    s.add_sample(&[1; 10], FRAME, true, 0).expect("video");
    s.add_audio_sample(&[2; 10], AUDIO_FRAME).expect("audio");
    s.finish();

    let seg = s.take_segment().expect("segment");
    let trun = child(trafs(&seg.data)[1], "trun");
    assert_eq!(be32(trun, 12 + 8), 0x0200_0000, "audio frames are all keyframes");
}

#[test]
fn audio_timeline_advances_in_its_own_timescale() {
    let mut s = segmenter_with_audio(1.0);
    // 1s of video per segment; 30 audio frames of 1024 samples per segment.
    for i in 0..60 {
        s.add_sample(&[0xaa; 50], FRAME, i % 30 == 0, 0)
            .expect("video");
        s.add_audio_sample(&[0xbb; 20], AUDIO_FRAME).expect("audio");
    }
    s.finish();

    let first = s.take_segment().expect("first");
    let second = s.take_segment().expect("second");

    let audio_tfdt = |seg: &Segment| be64(child(trafs(&seg.data)[1], "tfdt"), 4);
    let video_tfdt = |seg: &Segment| be64(child(trafs(&seg.data)[0], "tfdt"), 4);

    assert_eq!(audio_tfdt(&first), 0, "audio starts at zero");
    // 30 frames x 1024 samples - in audio ticks, not video ticks.
    assert_eq!(audio_tfdt(&second), 30 * u64::from(AUDIO_FRAME));
    assert_eq!(video_tfdt(&second), u64::from(TIMESCALE), "video uses its own timescale");
}

#[test]
fn audio_arriving_before_the_first_video_frame_is_not_dropped() {
    // Sources often start audio slightly before video.
    let mut s = segmenter_with_audio(10.0);
    s.add_audio_sample(&[7; 30], AUDIO_FRAME).expect("audio");
    s.add_audio_sample(&[7; 30], AUDIO_FRAME).expect("audio");
    s.add_sample(&[1; 20], FRAME, true, 0).expect("video");
    s.finish();

    let seg = s.take_segment().expect("segment");
    assert_eq!(be32(child(trafs(&seg.data)[1], "trun"), 4), 2, "both audio frames kept");
}

#[test]
fn audio_configuration_is_rejected_once_packaging_has_started() {
    let mut s = segmenter(1.0);
    s.add_sample(&[1; 10], FRAME, true, 0).expect("video");
    // Changing the moov mid-stream would invalidate the init segment already sent.
    assert!(s.try_set_audio(AUDIO_TIMESCALE, &mp4a_entry()).is_err());
}

#[test]
fn invalid_audio_configuration_is_rejected() {
    let mut s = segmenter(6.0);
    assert!(s.try_set_audio(0, &mp4a_entry()).is_err(), "zero timescale");
    assert!(s.try_set_audio(AUDIO_TIMESCALE, &[]).is_err(), "empty entry");
    assert!(s.try_set_audio(AUDIO_TIMESCALE, &[1, 2, 3]).is_err(), "too short for a box");
}

#[test]
fn audio_samples_are_refused_without_an_audio_track() {
    let mut s = segmenter(6.0);
    assert!(s.add_audio_sample(&[1, 2, 3], AUDIO_FRAME).is_err());
}

#[test]
fn has_audio_reports_the_configuration() {
    assert!(!segmenter(6.0).has_audio());
    assert!(segmenter_with_audio(6.0).has_audio());
}
