//! Tests for the `moof` parser.
//!
//! Fragments are built here by hand because the field layout is flag-driven:
//! almost everything in `tfhd` and `trun` is optional, and getting the presence
//! order wrong silently misreads every sample after it.

use super::{parse_moof, parse_trex, TrackDefaults};

// ---- builders -------------------------------------------------------------

fn bx(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut v = ((8 + payload.len()) as u32).to_be_bytes().to_vec();
    v.extend_from_slice(kind);
    v.extend_from_slice(payload);
    v
}

fn full(kind: &[u8; 4], version: u8, flags: u32, payload: &[u8]) -> Vec<u8> {
    let mut body = vec![
        version,
        ((flags >> 16) & 0xff) as u8,
        ((flags >> 8) & 0xff) as u8,
        (flags & 0xff) as u8,
    ];
    body.extend_from_slice(payload);
    bx(kind, &body)
}

fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.iter().flatten().copied().collect()
}

fn u32b(v: u32) -> Vec<u8> {
    v.to_be_bytes().to_vec()
}

/// A `tfhd` carrying only `default-base-is-moof` and a track id.
fn tfhd_basic(track_id: u32) -> Vec<u8> {
    full(b"tfhd", 0, 0x02_0000, &u32b(track_id))
}

/// A `tfhd` that also supplies default duration, size and flags.
fn tfhd_with_defaults(track_id: u32, duration: u32, size: u32, flags: u32) -> Vec<u8> {
    let mut p = u32b(track_id);
    p.extend(u32b(duration));
    p.extend(u32b(size));
    p.extend(u32b(flags));
    // 0x020000 | 0x8 | 0x10 | 0x20
    full(b"tfhd", 0, 0x02_0038, &p)
}

/// A `trun` listing per-sample duration, size and flags.
fn trun_full(data_offset: i32, samples: &[(u32, u32, u32)]) -> Vec<u8> {
    let mut p = u32b(samples.len() as u32);
    p.extend(data_offset.to_be_bytes());
    for (duration, size, flags) in samples {
        p.extend(u32b(*duration));
        p.extend(u32b(*size));
        p.extend(u32b(*flags));
    }
    // data-offset | duration | size | flags
    full(b"trun", 0, 0x00_0701, &p)
}

/// A `trun` with sizes only, leaning on `tfhd`/`trex` for the rest.
fn trun_sizes_only(data_offset: i32, sizes: &[u32]) -> Vec<u8> {
    let mut p = u32b(sizes.len() as u32);
    p.extend(data_offset.to_be_bytes());
    for size in sizes {
        p.extend(u32b(*size));
    }
    // data-offset | size
    full(b"trun", 0, 0x00_0201, &p)
}

fn moof(children: Vec<Vec<u8>>) -> Vec<u8> {
    // The parser is handed the payload, so the header is not included here.
    cat(&children)
}

const SYNC: u32 = 0x0200_0000;
const NON_SYNC: u32 = 0x0101_0000;

// ---- trex -----------------------------------------------------------------

#[test]
fn reads_trex_defaults_for_every_track() {
    let mut trex1 = u32b(1);
    trex1.extend(u32b(1)); // sample_description_index
    trex1.extend(u32b(3000)); // duration
    trex1.extend(u32b(500)); // size
    trex1.extend(u32b(0)); // flags

    let mut trex2 = u32b(2);
    trex2.extend(u32b(1));
    trex2.extend(u32b(1024));
    trex2.extend(u32b(200));
    trex2.extend(u32b(0));

    let mvex = bx(
        b"mvex",
        &cat(&[full(b"trex", 0, 0, &trex1), full(b"trex", 0, 0, &trex2)]),
    );

    let defaults = parse_trex(&mvex);
    assert_eq!(defaults.len(), 2);
    assert_eq!(defaults[0], TrackDefaults { track_id: 1, duration: 3000, size: 500, flags: 0 });
    assert_eq!(defaults[1].track_id, 2);
    assert_eq!(defaults[1].duration, 1024);
}

#[test]
fn a_moov_without_mvex_has_no_defaults() {
    assert!(parse_trex(&bx(b"moov", b"")).is_empty());
}

// ---- offsets --------------------------------------------------------------

#[test]
fn sample_offsets_are_relative_to_the_moof() {
    // default-base-is-moof is what lets a fragment be served standalone.
    let fragment = moof(vec![bx(
        b"traf",
        &cat(&[
            tfhd_basic(1),
            trun_full(120, &[(3000, 100, SYNC), (3000, 150, NON_SYNC)]),
        ]),
    )]);

    let runs = parse_moof(&fragment, 10_000, &[]);
    assert_eq!(runs.len(), 1);
    let samples = &runs[0].samples;

    // 10000 (moof start) + 120 (data offset), then sizes accumulate.
    assert_eq!(samples[0].offset, 10_120);
    assert_eq!(samples[1].offset, 10_220);
    assert_eq!(samples[1].size, 150);
}

#[test]
fn an_explicit_base_data_offset_wins_over_the_moof_position() {
    let mut p = u32b(1);
    p.extend(900_000u64.to_be_bytes()); // base_data_offset
    // base-data-offset-present | default-base-is-moof
    let tfhd = full(b"tfhd", 0, 0x02_0001, &p);

    let fragment = moof(vec![bx(
        b"traf",
        &cat(&[tfhd, trun_full(0, &[(3000, 50, SYNC)])]),
    )]);

    let runs = parse_moof(&fragment, 10_000, &[]);
    assert_eq!(runs[0].samples[0].offset, 900_000);
}

#[test]
fn each_trun_restarts_from_the_base_rather_than_continuing() {
    // A second run's data_offset is measured from the base, not from where the
    // previous run happened to end.
    let fragment = moof(vec![bx(
        b"traf",
        &cat(&[
            tfhd_basic(1),
            trun_full(100, &[(3000, 40, SYNC)]),
            trun_full(500, &[(3000, 60, NON_SYNC)]),
        ]),
    )]);

    let samples = &parse_moof(&fragment, 0, &[])[0].samples;
    assert_eq!(samples[0].offset, 100);
    assert_eq!(samples[1].offset, 500, "not 140");
}

// ---- defaults -------------------------------------------------------------

#[test]
fn missing_fields_fall_back_to_the_tfhd_defaults() {
    let fragment = moof(vec![bx(
        b"traf",
        &cat(&[
            tfhd_with_defaults(1, 3000, 0, NON_SYNC),
            trun_sizes_only(0, &[100, 120, 90]),
        ]),
    )]);

    let samples = &parse_moof(&fragment, 0, &[])[0].samples;
    assert_eq!(samples.len(), 3);
    assert!(samples.iter().all(|s| s.duration == 3000));
    assert!(samples.iter().all(|s| !s.is_sync), "tfhd default flags apply");
}

#[test]
fn missing_fields_fall_back_to_trex_when_the_fragment_omits_them() {
    let defaults = [TrackDefaults { track_id: 1, duration: 1024, size: 200, flags: 0 }];

    // Only a trun with sizes; duration and flags must come from trex.
    let fragment = moof(vec![bx(
        b"traf",
        &cat(&[tfhd_basic(1), trun_sizes_only(0, &[10, 20])]),
    )]);

    let samples = &parse_moof(&fragment, 0, &defaults)[0].samples;
    assert!(samples.iter().all(|s| s.duration == 1024));
    // trex flags of 0 mean the non-sync bit is clear, so these are sync samples.
    assert!(samples.iter().all(|s| s.is_sync));
}

#[test]
fn a_tfhd_default_overrides_the_trex_default() {
    let defaults = [TrackDefaults { track_id: 1, duration: 1024, size: 200, flags: 0 }];
    let fragment = moof(vec![bx(
        b"traf",
        &cat(&[
            tfhd_with_defaults(1, 3000, 0, 0),
            trun_sizes_only(0, &[10]),
        ]),
    )]);

    assert_eq!(parse_moof(&fragment, 0, &defaults)[0].samples[0].duration, 3000);
}

// ---- sync flags -----------------------------------------------------------

#[test]
fn the_non_sync_bit_decides_whether_a_sample_is_a_keyframe() {
    let fragment = moof(vec![bx(
        b"traf",
        &cat(&[
            tfhd_basic(1),
            trun_full(0, &[(3000, 10, SYNC), (3000, 10, NON_SYNC), (3000, 10, SYNC)]),
        ]),
    )]);

    let sync: Vec<bool> = parse_moof(&fragment, 0, &[])[0]
        .samples
        .iter()
        .map(|s| s.is_sync)
        .collect();
    assert_eq!(sync, vec![true, false, true]);
}

#[test]
fn first_sample_flags_apply_only_to_the_first_sample() {
    // The common shape: a fragment starting with a keyframe, the rest not.
    let mut p = u32b(3);
    p.extend(0i32.to_be_bytes()); // data offset
    p.extend(SYNC.to_be_bytes()); // first_sample_flags
    for _ in 0..3 {
        p.extend(u32b(20)); // size only
    }
    // data-offset | first-sample-flags | size
    let trun = full(b"trun", 0, 0x00_0205, &p);

    let fragment = moof(vec![bx(
        b"traf",
        &cat(&[tfhd_with_defaults(1, 3000, 0, NON_SYNC), trun]),
    )]);

    let sync: Vec<bool> = parse_moof(&fragment, 0, &[])[0]
        .samples
        .iter()
        .map(|s| s.is_sync)
        .collect();
    assert_eq!(sync, vec![true, false, false]);
}

// ---- multiple tracks ------------------------------------------------------

#[test]
fn separates_the_tracks_within_one_fragment() {
    let fragment = moof(vec![
        bx(
            b"traf",
            &cat(&[tfhd_basic(1), trun_full(200, &[(3000, 100, SYNC)])]),
        ),
        bx(
            b"traf",
            &cat(&[tfhd_basic(2), trun_full(300, &[(1024, 50, SYNC), (1024, 50, SYNC)])]),
        ),
    ]);

    let runs = parse_moof(&fragment, 0, &[]);
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].track_id, 1);
    assert_eq!(runs[0].samples.len(), 1);
    assert_eq!(runs[1].track_id, 2);
    assert_eq!(runs[1].samples.len(), 2);
    assert_eq!(runs[1].samples[1].offset, 350);
}

// ---- malformed input ------------------------------------------------------

#[test]
fn a_traf_without_samples_is_skipped_rather_than_reported() {
    let fragment = moof(vec![bx(b"traf", &tfhd_basic(1))]);
    assert!(parse_moof(&fragment, 0, &[]).is_empty());
}

#[test]
fn a_truncated_trun_keeps_the_samples_it_could_read() {
    // Claims four samples but only supplies two.
    let mut p = u32b(4);
    p.extend(0i32.to_be_bytes());
    p.extend(u32b(10));
    p.extend(u32b(20));
    let trun = full(b"trun", 0, 0x00_0201, &p);

    let fragment = moof(vec![bx(b"traf", &cat(&[tfhd_basic(1), trun]))]);
    let samples = &parse_moof(&fragment, 0, &[])[0].samples;
    assert_eq!(samples.len(), 2, "reads what is there without panicking");
}

#[test]
fn random_bytes_do_not_panic() {
    let mut seed = 0x9e37_79b9u32;
    for _ in 0..200 {
        let mut buf = Vec::with_capacity(128);
        for _ in 0..128 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            buf.push((seed >> 24) as u8);
        }
        let _ = parse_moof(&buf, 0, &[]);
        let _ = parse_trex(&buf);
    }
}

#[test]
fn an_empty_fragment_yields_nothing() {
    assert!(parse_moof(&[], 0, &[]).is_empty());
}
