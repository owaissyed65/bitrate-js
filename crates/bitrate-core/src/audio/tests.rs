//! AAC configuration tests.
//!
//! The descriptors in an `esds` are nested and length-prefixed, so an error in
//! one length silently corrupts everything after it. Building and parsing are
//! therefore checked against each other, and against a hand-built entry of the
//! shape a real encoder writes.

use super::{build_mp4a, parse_mp4a, AacConfig};

/// A two-byte AudioSpecificConfig: AAC-LC, 44.1 kHz, stereo.
const ASC_STEREO_44K: &[u8] = &[0x12, 0x10];

fn config() -> AacConfig {
    AacConfig {
        sample_rate: 44_100,
        channels: 2,
        specific_config: ASC_STEREO_44K.to_vec(),
    }
}

// ---- round trip -----------------------------------------------------------

#[test]
fn what_is_written_can_be_read_back() {
    let entry = build_mp4a(&config(), 128_000);
    assert_eq!(parse_mp4a(&entry), Some(config()));
}

#[test]
fn survives_a_mono_track() {
    let mono = AacConfig {
        sample_rate: 22_050,
        channels: 1,
        specific_config: vec![0x15, 0x88],
    };
    assert_eq!(parse_mp4a(&build_mp4a(&mono, 64_000)), Some(mono));
}

#[test]
fn survives_a_longer_specific_config() {
    // HE-AAC configs carry extension data and run longer.
    let long = AacConfig {
        sample_rate: 48_000,
        channels: 2,
        specific_config: vec![0x2b, 0x8a, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00],
    };
    assert_eq!(parse_mp4a(&build_mp4a(&long, 96_000)), Some(long));
}

// ---- structure ------------------------------------------------------------

#[test]
fn the_entry_is_a_well_formed_mp4a_box() {
    let entry = build_mp4a(&config(), 128_000);

    let size = u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]) as usize;
    assert_eq!(size, entry.len(), "box size must match its contents");
    assert_eq!(&entry[4..8], b"mp4a");
}

#[test]
fn channel_count_and_sample_rate_sit_where_a_demuxer_looks() {
    let entry = build_mp4a(&config(), 128_000);
    // AudioSampleEntry: 8 header + 6 reserved + 2 index + 8 vendor = 24.
    assert_eq!(u16::from_be_bytes([entry[24], entry[25]]), 2, "channels");
    // …then sample size, pre_defined, reserved, before the 16.16 rate.
    assert_eq!(u16::from_be_bytes([entry[32], entry[33]]), 44_100, "sample rate");
}

#[test]
fn the_entry_contains_an_esds() {
    let entry = build_mp4a(&config(), 128_000);
    let has_esds = entry.windows(4).any(|w| w == b"esds");
    assert!(has_esds, "without esds a decoder cannot initialise");
}

#[test]
fn the_specific_config_appears_verbatim() {
    let entry = build_mp4a(&config(), 128_000);
    let found = entry
        .windows(ASC_STEREO_44K.len())
        .any(|w| w == ASC_STEREO_44K);
    assert!(found, "the AudioSpecificConfig must survive unaltered");
}

#[test]
fn the_bitrate_is_recorded() {
    let entry = build_mp4a(&config(), 128_000);
    let bytes = 128_000u32.to_be_bytes();
    assert!(entry.windows(4).any(|w| w == bytes), "bitrate should appear in the descriptor");
}

// ---- parsing real-world shapes -------------------------------------------

/// Build an `mp4a` the way a typical encoder writes it, to check the parser
/// against something this module did not produce.
fn handwritten_mp4a() -> Vec<u8> {
    let mut esds_payload = vec![0u8, 0, 0, 0]; // version + flags

    // ES_Descriptor
    esds_payload.extend([0x03, 0x19]);
    esds_payload.extend([0x00, 0x01, 0x00]); // ES_ID, flags

    // DecoderConfigDescriptor
    esds_payload.extend([0x04, 0x11]);
    esds_payload.extend([0x40, 0x15]); // AAC, audio
    esds_payload.extend([0x00, 0x00, 0x00]); // bufferSizeDB
    esds_payload.extend(0x0001_f400u32.to_be_bytes()); // maxBitrate
    esds_payload.extend(0x0001_f400u32.to_be_bytes()); // avgBitrate

    // DecoderSpecificInfo
    esds_payload.extend([0x05, 0x02]);
    esds_payload.extend(ASC_STEREO_44K);
    // SLConfigDescriptor
    esds_payload.extend([0x06, 0x01, 0x02]);

    let mut esds = ((8 + esds_payload.len()) as u32).to_be_bytes().to_vec();
    esds.extend_from_slice(b"esds");
    esds.extend_from_slice(&esds_payload);

    let mut body = vec![0u8; 6];
    body.extend(1u16.to_be_bytes()); // data_reference_index
    body.extend([0u8; 8]);
    body.extend(2u16.to_be_bytes()); // channels
    body.extend(16u16.to_be_bytes()); // sample size
    body.extend([0u8; 4]); // pre_defined, reserved
    body.extend(44_100u16.to_be_bytes());
    body.extend([0u8; 2]);
    body.extend_from_slice(&esds);

    let mut entry = ((8 + body.len()) as u32).to_be_bytes().to_vec();
    entry.extend_from_slice(b"mp4a");
    entry.extend_from_slice(&body);
    entry
}

#[test]
fn parses_an_entry_this_module_did_not_write() {
    assert_eq!(parse_mp4a(&handwritten_mp4a()), Some(config()));
}

// ---- malformed input ------------------------------------------------------

#[test]
fn refuses_an_entry_with_no_esds() {
    let mut body = vec![0u8; 28];
    body.extend(44_100u16.to_be_bytes());
    body.extend([0u8; 2]);
    let mut entry = ((8 + body.len()) as u32).to_be_bytes().to_vec();
    entry.extend_from_slice(b"mp4a");
    entry.extend_from_slice(&body);

    assert_eq!(parse_mp4a(&entry), None);
}

#[test]
fn refuses_a_truncated_entry() {
    let full = build_mp4a(&config(), 128_000);
    for cut in 0..full.len() {
        // None of these may panic; most should simply fail to parse.
        let _ = parse_mp4a(&full[..cut]);
    }
    assert_eq!(parse_mp4a(&full[..20]), None);
}

#[test]
fn random_bytes_do_not_panic() {
    let mut seed = 0x2545_f491u32;
    for _ in 0..200 {
        let mut buf = Vec::with_capacity(96);
        for _ in 0..96 {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            buf.push((seed >> 20) as u8);
        }
        let _ = parse_mp4a(&buf);
    }
}

#[test]
fn an_empty_entry_is_refused() {
    assert_eq!(parse_mp4a(&[]), None);
}
