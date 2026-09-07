//! Tests for the MP4 sample-table parser.
//!
//! `moov` boxes are built here by hand so each table can be exercised —
//! including the malformed shapes a hostile file would use.

use super::{parse_moov, DemuxError, VideoTrack};

/// Most tests care only about the video track; audio has its own section below.
fn parse_video(moov: &[u8]) -> Result<VideoTrack, DemuxError> {
    parse_moov(moov).map(|m| m.video)
}

// ---- builders -------------------------------------------------------------

fn bx(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut v = ((8 + payload.len()) as u32).to_be_bytes().to_vec();
    v.extend_from_slice(kind);
    v.extend_from_slice(payload);
    v
}

/// A FullBox: version/flags then payload.
fn full(kind: &[u8; 4], version: u8, payload: &[u8]) -> Vec<u8> {
    let mut body = vec![version, 0, 0, 0];
    body.extend_from_slice(payload);
    bx(kind, &body)
}

fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.iter().flatten().copied().collect()
}

const AVCC: &[u8] = &[0x01, 0x42, 0xc0, 0x1f, 0xff, 0xe1, 0x00, 0x02, 0x67, 0x42];

fn mdhd(timescale: u32) -> Vec<u8> {
    let mut p = vec![];
    p.extend_from_slice(&0u32.to_be_bytes()); // creation
    p.extend_from_slice(&0u32.to_be_bytes()); // modification
    p.extend_from_slice(&timescale.to_be_bytes());
    p.extend_from_slice(&0u32.to_be_bytes()); // duration
    p.extend_from_slice(&0u16.to_be_bytes()); // language
    p.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    full(b"mdhd", 0, &p)
}

fn hdlr(handler: &[u8; 4]) -> Vec<u8> {
    let mut p = vec![];
    p.extend_from_slice(&0u32.to_be_bytes()); // pre_defined
    p.extend_from_slice(handler);
    p.extend_from_slice(&[0u8; 12]); // reserved
    p.extend_from_slice(b"H\0");
    full(b"hdlr", 0, &p)
}

fn avc1(width: u16, height: u16, avcc: &[u8]) -> Vec<u8> {
    let mut p = vec![0u8; 24]; // reserved/data_ref/pre_defined preamble
    p.extend_from_slice(&width.to_be_bytes());
    p.extend_from_slice(&height.to_be_bytes());
    p.extend_from_slice(&[0u8; 50]); // resolutions..pre_defined
    p.extend_from_slice(&bx(b"avcC", avcc));
    bx(b"avc1", &p)
}

fn stsd(entry: &[u8]) -> Vec<u8> {
    let mut p = 1u32.to_be_bytes().to_vec(); // entry_count
    p.extend_from_slice(entry);
    full(b"stsd", 0, &p)
}

/// `stsz` with explicit per-sample sizes.
fn stsz(sizes: &[u32]) -> Vec<u8> {
    let mut p = 0u32.to_be_bytes().to_vec(); // sample_size = 0 => table follows
    p.extend_from_slice(&(sizes.len() as u32).to_be_bytes());
    for s in sizes {
        p.extend_from_slice(&s.to_be_bytes());
    }
    full(b"stsz", 0, &p)
}

/// `stsz` where every sample shares one size.
fn stsz_uniform(size: u32, count: u32) -> Vec<u8> {
    let mut p = size.to_be_bytes().to_vec();
    p.extend_from_slice(&count.to_be_bytes());
    full(b"stsz", 0, &p)
}

fn stts(runs: &[(u32, u32)]) -> Vec<u8> {
    let mut p = (runs.len() as u32).to_be_bytes().to_vec();
    for (count, delta) in runs {
        p.extend_from_slice(&count.to_be_bytes());
        p.extend_from_slice(&delta.to_be_bytes());
    }
    full(b"stts", 0, &p)
}

fn ctts(version: u8, runs: &[(u32, i32)]) -> Vec<u8> {
    let mut p = (runs.len() as u32).to_be_bytes().to_vec();
    for (count, offset) in runs {
        p.extend_from_slice(&count.to_be_bytes());
        p.extend_from_slice(&offset.to_be_bytes());
    }
    full(b"ctts", version, &p)
}

fn stsc(entries: &[(u32, u32)]) -> Vec<u8> {
    let mut p = (entries.len() as u32).to_be_bytes().to_vec();
    for (first_chunk, per_chunk) in entries {
        p.extend_from_slice(&first_chunk.to_be_bytes());
        p.extend_from_slice(&per_chunk.to_be_bytes());
        p.extend_from_slice(&1u32.to_be_bytes()); // sample_description_index
    }
    full(b"stsc", 0, &p)
}

fn stco(offsets: &[u32]) -> Vec<u8> {
    let mut p = (offsets.len() as u32).to_be_bytes().to_vec();
    for o in offsets {
        p.extend_from_slice(&o.to_be_bytes());
    }
    full(b"stco", 0, &p)
}

fn co64(offsets: &[u64]) -> Vec<u8> {
    let mut p = (offsets.len() as u32).to_be_bytes().to_vec();
    for o in offsets {
        p.extend_from_slice(&o.to_be_bytes());
    }
    full(b"co64", 0, &p)
}

fn stss(numbers: &[u32]) -> Vec<u8> {
    let mut p = (numbers.len() as u32).to_be_bytes().to_vec();
    for n in numbers {
        p.extend_from_slice(&n.to_be_bytes());
    }
    full(b"stss", 0, &p)
}

/// Assemble a `moov` payload around the supplied `stbl` children.
fn moov_with(handler: &[u8; 4], timescale: u32, stbl_children: Vec<Vec<u8>>) -> Vec<u8> {
    let stbl = bx(b"stbl", &cat(&stbl_children));
    let minf = bx(b"minf", &stbl);
    let mdia = bx(b"mdia", &cat(&[mdhd(timescale), hdlr(handler), minf]));
    // `moov` payload only — parse_moov takes contents, not the header.
    bx(b"trak", &mdia)
}

/// The common case: one video track, `n` samples in one chunk.
fn simple_moov(n: usize) -> Vec<u8> {
    let sizes: Vec<u32> = (0..n).map(|i| 100 + i as u32).collect();
    moov_with(
        b"vide",
        90_000,
        vec![
            stsd(&avc1(1280, 720, AVCC)),
            stsz(&sizes),
            stts(&[(n as u32, 3000)]),
            stsc(&[(1, n as u32)]),
            stco(&[1000]),
        ],
    )
}

// ---- happy path -----------------------------------------------------------

#[test]
fn parses_track_configuration() {
    let track = parse_video(&simple_moov(4)).expect("should parse");
    assert_eq!(track.timescale, 90_000);
    assert_eq!(track.width, 1280);
    assert_eq!(track.height, 720);
    assert_eq!(track.codec_config, AVCC);
}

#[test]
fn computes_sample_offsets_by_accumulating_sizes_within_a_chunk() {
    let track = parse_video(&simple_moov(4)).expect("parse");
    assert_eq!(track.samples.len(), 4);

    // Sizes are 100,101,102,103 starting at chunk offset 1000.
    assert_eq!(track.samples[0].offset, 1000);
    assert_eq!(track.samples[1].offset, 1100);
    assert_eq!(track.samples[2].offset, 1201);
    assert_eq!(track.samples[3].offset, 1303);
    assert_eq!(track.samples[3].size, 103);
}

#[test]
fn expands_stts_runs_into_per_sample_durations() {
    let moov = moov_with(
        b"vide",
        1000,
        vec![
            stsd(&avc1(640, 480, AVCC)),
            stsz_uniform(10, 5),
            stts(&[(2, 100), (3, 200)]),
            stsc(&[(1, 5)]),
            stco(&[0]),
        ],
    );
    let track = parse_video(&moov).expect("parse");
    let durations: Vec<u32> = track.samples.iter().map(|s| s.duration).collect();
    assert_eq!(durations, vec![100, 100, 200, 200, 200]);
}

#[test]
fn spreads_samples_across_chunks_per_stsc() {
    // 3 chunks: 2 samples, 2 samples, then 1 (last run repeats).
    let moov = moov_with(
        b"vide",
        1000,
        vec![
            stsd(&avc1(640, 480, AVCC)),
            stsz_uniform(50, 5),
            stts(&[(5, 100)]),
            stsc(&[(1, 2), (3, 1)]),
            stco(&[10_000, 20_000, 30_000]),
        ],
    );
    let track = parse_video(&moov).expect("parse");
    let offsets: Vec<u64> = track.samples.iter().map(|s| s.offset).collect();
    assert_eq!(offsets, vec![10_000, 10_050, 20_000, 20_050, 30_000]);
}

#[test]
fn without_stss_every_sample_is_a_keyframe() {
    let track = parse_video(&simple_moov(3)).expect("parse");
    assert!(track.samples.iter().all(|s| s.is_sync));
}

#[test]
fn stss_marks_only_the_listed_samples_as_keyframes() {
    let moov = moov_with(
        b"vide",
        1000,
        vec![
            stsd(&avc1(640, 480, AVCC)),
            stsz_uniform(10, 6),
            stts(&[(6, 100)]),
            stsc(&[(1, 6)]),
            stco(&[0]),
            stss(&[1, 4]), // 1-based
        ],
    );
    let track = parse_video(&moov).expect("parse");
    let sync: Vec<bool> = track.samples.iter().map(|s| s.is_sync).collect();
    assert_eq!(sync, vec![true, false, false, true, false, false]);
}

#[test]
fn reads_composition_offsets_for_b_frames() {
    let moov = moov_with(
        b"vide",
        1000,
        vec![
            stsd(&avc1(640, 480, AVCC)),
            stsz_uniform(10, 3),
            stts(&[(3, 100)]),
            ctts(1, &[(1, 0), (1, -50), (1, 200)]),
            stsc(&[(1, 3)]),
            stco(&[0]),
        ],
    );
    let track = parse_video(&moov).expect("parse");
    let cts: Vec<i32> = track.samples.iter().map(|s| s.composition_offset).collect();
    assert_eq!(cts, vec![0, -50, 200]);
}

#[test]
fn supports_co64_for_large_files() {
    let big = 5_000_000_000u64; // beyond the 32-bit stco range
    let moov = moov_with(
        b"vide",
        1000,
        vec![
            stsd(&avc1(640, 480, AVCC)),
            stsz_uniform(10, 2),
            stts(&[(2, 100)]),
            stsc(&[(1, 2)]),
            co64(&[big]),
        ],
    );
    let track = parse_video(&moov).expect("parse");
    assert_eq!(track.samples[0].offset, big);
    assert_eq!(track.samples[1].offset, big + 10);
}

#[test]
fn uniform_stsz_applies_one_size_to_every_sample() {
    let moov = moov_with(
        b"vide",
        1000,
        vec![
            stsd(&avc1(640, 480, AVCC)),
            stsz_uniform(42, 4),
            stts(&[(4, 100)]),
            stsc(&[(1, 4)]),
            stco(&[0]),
        ],
    );
    let track = parse_video(&moov).expect("parse");
    assert!(track.samples.iter().all(|s| s.size == 42));
    assert_eq!(track.samples[3].offset, 126);
}

#[test]
fn skips_non_video_tracks_and_finds_the_video_one() {
    let audio = moov_with(b"soun", 48_000, vec![stsd(&avc1(0, 0, AVCC))]);
    let video = simple_moov(2);
    let moov = cat(&[audio, video]);
    let track = parse_video(&moov).expect("should find the video track");
    assert_eq!(track.width, 1280);
    assert_eq!(track.samples.len(), 2);
}

// ---- malformed input ------------------------------------------------------

#[test]
fn reports_missing_video_track() {
    let audio = moov_with(b"soun", 48_000, vec![stsd(&avc1(0, 0, AVCC))]);
    assert_eq!(parse_video(&audio), Err(DemuxError::NoVideoTrack));
    assert_eq!(parse_video(&[]), Err(DemuxError::NoVideoTrack));
}

#[test]
fn reports_missing_tables_instead_of_panicking() {
    // stbl present but with no stsz.
    let moov = moov_with(
        b"vide",
        1000,
        vec![stsd(&avc1(640, 480, AVCC)), stts(&[(1, 100)]), stsc(&[(1, 1)]), stco(&[0])],
    );
    assert_eq!(parse_video(&moov), Err(DemuxError::MalformedBox("stsz")));
}

#[test]
fn rejects_a_stsz_claiming_more_samples_than_the_box_holds() {
    // Declares 1000 samples but supplies no table bytes.
    let mut p = 0u32.to_be_bytes().to_vec();
    p.extend_from_slice(&1000u32.to_be_bytes());
    let bad_stsz = full(b"stsz", 0, &p);

    let moov = moov_with(
        b"vide",
        1000,
        vec![stsd(&avc1(640, 480, AVCC)), bad_stsz, stts(&[(1, 100)]), stsc(&[(1, 1)]), stco(&[0])],
    );
    assert_eq!(parse_video(&moov), Err(DemuxError::MalformedBox("stsz")));
}

#[test]
fn rejects_an_absurd_sample_count() {
    let mut p = 4u32.to_be_bytes().to_vec(); // uniform size
    p.extend_from_slice(&u32::MAX.to_be_bytes()); // ~4.3 billion samples
    let bomb = full(b"stsz", 0, &p);

    let moov = moov_with(
        b"vide",
        1000,
        vec![stsd(&avc1(640, 480, AVCC)), bomb, stts(&[(1, 100)]), stsc(&[(1, 1)]), stco(&[0])],
    );
    assert_eq!(parse_video(&moov), Err(DemuxError::TooLarge));
}

#[test]
fn rejects_an_stts_run_that_would_explode_memory() {
    let moov = moov_with(
        b"vide",
        1000,
        vec![
            stsd(&avc1(640, 480, AVCC)),
            stsz_uniform(10, 1),
            stts(&[(u32::MAX, 100)]),
            stsc(&[(1, 1)]),
            stco(&[0]),
        ],
    );
    assert_eq!(parse_video(&moov), Err(DemuxError::TooLarge));
}

#[test]
fn rejects_missing_chunk_offsets() {
    let moov = moov_with(
        b"vide",
        1000,
        vec![stsd(&avc1(640, 480, AVCC)), stsz_uniform(10, 1), stts(&[(1, 100)]), stsc(&[(1, 1)])],
    );
    assert_eq!(parse_video(&moov), Err(DemuxError::MalformedBox("stco")));
}

#[test]
fn rejects_a_track_with_no_avcc() {
    let mut p = vec![0u8; 24];
    p.extend_from_slice(&640u16.to_be_bytes());
    p.extend_from_slice(&480u16.to_be_bytes());
    p.extend_from_slice(&[0u8; 50]);
    let no_avcc = bx(b"avc1", &p);

    let moov = moov_with(
        b"vide",
        1000,
        vec![stsd(&no_avcc), stsz_uniform(10, 1), stts(&[(1, 100)]), stsc(&[(1, 1)]), stco(&[0])],
    );
    assert_eq!(parse_video(&moov), Err(DemuxError::MalformedBox("avcC")));
}

#[test]
fn rejects_zero_timescale() {
    let moov = moov_with(
        b"vide",
        0,
        vec![stsd(&avc1(640, 480, AVCC)), stsz_uniform(10, 1), stts(&[(1, 100)]), stsc(&[(1, 1)]), stco(&[0])],
    );
    assert_eq!(parse_video(&moov), Err(DemuxError::MalformedBox("mdhd")));
}

#[test]
fn empty_stsc_is_reported_not_panicked() {
    let moov = moov_with(
        b"vide",
        1000,
        vec![stsd(&avc1(640, 480, AVCC)), stsz_uniform(10, 2), stts(&[(2, 100)]), stsc(&[]), stco(&[0])],
    );
    assert_eq!(parse_video(&moov), Err(DemuxError::InconsistentTables));
}

#[test]
fn truncated_moov_does_not_panic() {
    // Feed progressively truncated prefixes of a valid moov; none may panic.
    let full_moov = simple_moov(4);
    for cut in 0..full_moov.len() {
        let prefix = full_moov.get(..cut).unwrap_or(&[]);
        let _ = parse_video(prefix);
    }
}

#[test]
fn random_bytes_do_not_panic() {
    // A cheap smoke test for hostile input; cargo-fuzz covers this properly.
    let mut seed = 0x1234_5678u32;
    for _ in 0..200 {
        let mut buf = Vec::with_capacity(256);
        for _ in 0..256 {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            buf.push((seed >> 16) as u8);
        }
        let _ = parse_video(&buf);
    }
}

// ---- audio track ----------------------------------------------------------

/// A minimal `mp4a` sample entry with an `esds`, as an AAC source would carry.
fn mp4a(channels: u16, sample_rate: u32) -> Vec<u8> {
    let mut p = vec![0u8; 6]; // reserved
    p.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    p.extend_from_slice(&[0u8; 8]); // version/revision/vendor
    p.extend_from_slice(&channels.to_be_bytes());
    p.extend_from_slice(&16u16.to_be_bytes()); // samplesize
    p.extend_from_slice(&[0u8; 4]); // pre_defined + reserved
    p.extend_from_slice(&(sample_rate << 16).to_be_bytes()); // 16.16 fixed
    // A small, well-formed esds carrying an AudioSpecificConfig.
    p.extend_from_slice(&full(
        b"esds",
        0,
        &[0x03, 0x0d, 0x00, 0x01, 0x00, 0x04, 0x05, 0x40, 0x15, 0x00, 0x00, 0x00, 0x05, 0x02, 0x12, 0x10],
    ));
    bx(b"mp4a", &p)
}

/// A `trak` for audio with `n` frames of 1024 samples each.
fn audio_trak(n: usize, timescale: u32) -> Vec<u8> {
    moov_with(
        b"soun",
        timescale,
        vec![
            stsd(&mp4a(2, timescale)),
            stsz_uniform(200, n as u32),
            stts(&[(n as u32, 1024)]),
            stsc(&[(1, n as u32)]),
            stco(&[500_000]),
        ],
    )
}

#[test]
fn finds_the_audio_track_alongside_video() {
    let moov = cat(&[simple_moov(4), audio_trak(10, 44_100)]);
    let movie = parse_moov(&moov).expect("parse");

    assert_eq!(movie.video.samples.len(), 4);
    let audio = movie.audio.expect("audio track should be found");
    assert_eq!(audio.timescale, 44_100);
    assert_eq!(audio.samples.len(), 10);
}

#[test]
fn audio_is_found_regardless_of_track_order() {
    // Many encoders write audio first.
    let moov = cat(&[audio_trak(6, 48_000), simple_moov(3)]);
    let movie = parse_moov(&moov).expect("parse");
    assert_eq!(movie.video.samples.len(), 3);
    assert_eq!(movie.audio.expect("audio").samples.len(), 6);
}

#[test]
fn audio_sample_entry_is_copied_verbatim() {
    let entry = mp4a(2, 44_100);
    let moov = cat(&[simple_moov(2), audio_trak(4, 44_100)]);
    let audio = parse_moov(&moov).expect("parse").audio.expect("audio");

    // Byte-for-byte: the esds must survive so the decoder can initialize.
    assert_eq!(audio.sample_entry, entry);
    assert_eq!(&audio.sample_entry[4..8], b"mp4a");
}

#[test]
fn audio_sample_offsets_and_durations_are_indexed() {
    let moov = cat(&[simple_moov(2), audio_trak(3, 44_100)]);
    let audio = parse_moov(&moov).expect("parse").audio.expect("audio");

    let offsets: Vec<u64> = audio.samples.iter().map(|s| s.offset).collect();
    assert_eq!(offsets, vec![500_000, 500_200, 500_400]);
    assert!(audio.samples.iter().all(|s| s.duration == 1024));
    // Every audio frame is independently decodable.
    assert!(audio.samples.iter().all(|s| s.is_sync));
}

#[test]
fn a_silent_source_parses_with_no_audio() {
    let movie = parse_moov(&simple_moov(4)).expect("parse");
    assert!(movie.audio.is_none());
}

#[test]
fn a_broken_audio_track_does_not_sink_the_video() {
    // Audio trak missing its stsz: the video must still package, silently.
    let broken = moov_with(
        b"soun",
        44_100,
        vec![stsd(&mp4a(2, 44_100)), stts(&[(1, 1024)]), stsc(&[(1, 1)]), stco(&[0])],
    );
    let movie = parse_moov(&cat(&[simple_moov(3), broken])).expect("video should still parse");
    assert_eq!(movie.video.samples.len(), 3);
    assert!(movie.audio.is_none(), "unusable audio is dropped, not fatal");
}

#[test]
fn only_the_first_audio_track_is_used() {
    // Commentary or alternate-language tracks must not be mistaken for the main one.
    let moov = cat(&[simple_moov(2), audio_trak(5, 44_100), audio_trak(9, 48_000)]);
    let audio = parse_moov(&moov).expect("parse").audio.expect("audio");
    assert_eq!(audio.timescale, 44_100);
    assert_eq!(audio.samples.len(), 5);
}

#[test]
fn a_source_with_only_audio_is_rejected() {
    let moov = audio_trak(4, 44_100);
    assert_eq!(parse_moov(&moov), Err(DemuxError::NoVideoTrack));
}

// ---- fragmented and empty sources ----------------------------------------

/// A `moov` whose sample tables are empty, as a fragmented file writes it.
fn fragmented_moov(with_mvex: bool) -> Vec<u8> {
    let trak = moov_with(
        b"vide",
        90_000,
        vec![
            stsd(&avc1(1920, 1080, AVCC)),
            stsz_uniform(0, 0),
            stts(&[]),
            stsc(&[]),
            stco(&[]),
        ],
    );
    if with_mvex {
        // mvex is what marks a file as fragmented.
        let trex = full(b"trex", 0, &[0; 20]);
        cat(&[trak, bx(b"mvex", &trex)])
    } else {
        trak
    }
}

#[test]
fn a_fragmented_mp4_is_named_rather_than_silently_empty() {
    // Previously this parsed "successfully" with zero samples, so the caller
    // saw a 0.0s video and no explanation.
    assert_eq!(parse_moov(&fragmented_moov(true)), Err(DemuxError::FragmentedMp4));
}

#[test]
fn a_track_with_no_samples_is_reported() {
    assert_eq!(parse_moov(&fragmented_moov(false)), Err(DemuxError::EmptyTrack));
}

#[test]
fn a_normal_file_is_not_mistaken_for_fragmented() {
    assert!(parse_moov(&simple_moov(4)).is_ok());
}
