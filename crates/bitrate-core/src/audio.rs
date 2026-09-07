//! AAC configuration: reading it from a source, and writing it for output.
//!
//! Remuxing copies an audio sample entry verbatim and never needs to understand
//! it. Transcoding cannot: the decoder needs the source's
//! `AudioSpecificConfig`, and the re-encoded output needs a *new* sample entry
//! built around whatever the encoder produced.
//!
//! Both live in an `esds` box, whose contents are MPEG-4 descriptors — nested,
//! tagged, and with variable-length sizes.

use wasm_bindgen::prelude::*;

use crate::demux::reader::{find, Reader};
use crate::mux::boxes::BoxWriter;

/// MPEG-4 descriptor tags.
const TAG_ES: u8 = 0x03;
const TAG_DECODER_CONFIG: u8 = 0x04;
const TAG_DECODER_SPECIFIC: u8 = 0x05;
const TAG_SL_CONFIG: u8 = 0x06;

/// Object type: MPEG-4 audio.
const OBJECT_TYPE_AAC: u8 = 0x40;
/// Stream type 5 (audio), upstream 0, reserved bit set.
const STREAM_TYPE_AUDIO: u8 = 0x15;

/// An `AudioSpecificConfig` is a handful of bytes; anything larger is wrong.
const MAX_ASC: usize = 64;

/// What an audio track needs in order to be decoded or re-described.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AacConfig {
    /// Sampling rate in Hz.
    pub sample_rate: u32,
    /// Channel count: 1 for mono, 2 for stereo.
    pub channels: u16,
    /// The `AudioSpecificConfig`, which WebCodecs takes as its `description`.
    pub specific_config: Vec<u8>,
}

/// Read a descriptor's length, which is 7 bits per byte with a continuation bit.
fn descriptor_length(r: &mut Reader<'_>) -> Option<usize> {
    let mut length = 0usize;
    // At most four bytes, per the specification.
    for _ in 0..4 {
        let byte = r.u8()?;
        length = (length << 7) | usize::from(byte & 0x7f);
        if byte & 0x80 == 0 {
            return Some(length);
        }
    }
    Some(length)
}

/// Find a descriptor by tag at the current position, returning its payload.
fn descriptor<'a>(r: &mut Reader<'a>, tag: u8) -> Option<&'a [u8]> {
    let found = r.u8()?;
    if found != tag {
        return None;
    }
    let length = descriptor_length(r)?;
    r.take(length)
}

/// Extract the AAC configuration from a `mp4a` sample entry.
///
/// The entry is an `AudioSampleEntry` — a fixed preamble carrying channel count
/// and sample rate — followed by an `esds` box holding the descriptors.
pub fn parse_mp4a(sample_entry: &[u8]) -> Option<AacConfig> {
    // Skip the box header to reach the AudioSampleEntry fields.
    let mut r = Reader::new(sample_entry.get(8..)?);
    r.skip(6)?; // reserved
    r.u16()?; // data_reference_index
    r.skip(8)?; // version, revision, vendor
    let channels = r.u16()?;
    r.u16()?; // sample size
    r.u16()?; // pre_defined
    r.u16()?; // reserved
    // Sample rate is 16.16 fixed point; the fraction is always zero here.
    let sample_rate = u32::from(r.u16()?);
    r.u16()?;

    let esds = find(r.rest(), b"esds")?;
    let mut e = Reader::new(esds);
    e.version_flags()?;

    let es = descriptor(&mut e, TAG_ES)?;
    let mut es_reader = Reader::new(es);
    es_reader.u16()?; // ES_ID
    let flags = es_reader.u8()?;
    // Optional fields the flags may introduce, in order.
    if flags & 0x80 != 0 {
        es_reader.u16()?; // dependsOn_ES_ID
    }
    if flags & 0x40 != 0 {
        let len = usize::from(es_reader.u8()?);
        es_reader.skip(len)?; // URL
    }
    if flags & 0x20 != 0 {
        es_reader.u16()?; // OCR_ES_Id
    }

    let config = descriptor(&mut es_reader, TAG_DECODER_CONFIG)?;
    let mut c = Reader::new(config);
    c.u8()?; // objectTypeIndication
    c.u8()?; // streamType
    c.skip(3)?; // bufferSizeDB
    c.u32()?; // maxBitrate
    c.u32()?; // avgBitrate

    let specific = descriptor(&mut c, TAG_DECODER_SPECIFIC)?;
    if specific.is_empty() || specific.len() > MAX_ASC {
        return None;
    }

    Some(AacConfig {
        sample_rate,
        channels,
        specific_config: specific.to_vec(),
    })
}

/// Write a descriptor length using the 7-bits-per-byte encoding.
fn write_length(w: &mut BoxWriter, length: usize) {
    if length < 0x80 {
        w.u8(length as u8);
        return;
    }
    // The four-byte form, which every demuxer accepts.
    w.u8(0x80 | ((length >> 21) & 0x7f) as u8);
    w.u8(0x80 | ((length >> 14) & 0x7f) as u8);
    w.u8(0x80 | ((length >> 7) & 0x7f) as u8);
    w.u8((length & 0x7f) as u8);
}

/// Build a complete `mp4a` sample entry for re-encoded AAC.
///
/// Remuxing copies the source's entry; transcoding has no entry to copy, so one
/// is constructed around the encoder's `AudioSpecificConfig`.
pub fn build_mp4a(config: &AacConfig, bitrate: u32) -> Vec<u8> {
    // Innermost first, since each descriptor's length covers what it contains.
    let mut specific = BoxWriter::with_capacity(config.specific_config.len() + 8);
    specific.u8(TAG_DECODER_SPECIFIC);
    write_length(&mut specific, config.specific_config.len());
    specific.bytes(&config.specific_config);
    let specific = specific.into_bytes();

    let mut decoder_config = BoxWriter::with_capacity(specific.len() + 24);
    decoder_config
        .u8(OBJECT_TYPE_AAC)
        .u8(STREAM_TYPE_AUDIO)
        .u8(0)
        .u16(0) // bufferSizeDB
        .u32(bitrate) // maxBitrate
        .u32(bitrate); // avgBitrate
    decoder_config.bytes(&specific);
    let decoder_config = decoder_config.into_bytes();

    let mut es = BoxWriter::with_capacity(decoder_config.len() + 24);
    es.u16(0).u8(0); // ES_ID, flags
    es.u8(TAG_DECODER_CONFIG);
    write_length(&mut es, decoder_config.len());
    es.bytes(&decoder_config);
    // SLConfigDescriptor: predefined "MP4" signalling.
    es.u8(TAG_SL_CONFIG);
    write_length(&mut es, 1);
    es.u8(0x02);
    let es = es.into_bytes();

    let mut w = BoxWriter::with_capacity(es.len() + 64);
    w.boxed(b"mp4a", |w| {
        w.zeros(6) // reserved
            .u16(1) // data_reference_index
            .zeros(8) // version, revision, vendor
            .u16(config.channels)
            .u16(16) // sample size
            .u16(0) // pre_defined
            .u16(0) // reserved
            // 16.16 fixed point; rates above 65535 cannot be expressed here,
            // which no AAC profile uses anyway.
            .u16(config.sample_rate.min(0xffff) as u16)
            .u16(0);

        w.full_boxed(b"esds", 0, 0, |w| {
            w.u8(TAG_ES);
            write_length(w, es.len());
            w.bytes(&es);
        });
    });
    w.into_bytes()
}

#[cfg(test)]
mod tests;

/// Build an `mp4a` sample entry for re-encoded AAC, for `Fmp4Segmenter.setAudio`.
///
/// Transcoding has no source entry to copy: the encoder reports an
/// `AudioSpecificConfig` and nothing else, so the entry that describes the
/// output track has to be constructed around it.
#[wasm_bindgen]
#[allow(clippy::needless_pass_by_value)]
pub fn build_audio_sample_entry(
    sample_rate: u32,
    channels: u16,
    specific_config: &[u8],
    bitrate: u32,
) -> Result<Vec<u8>, JsError> {
    if sample_rate == 0 || channels == 0 || channels > 64 {
        return Err(JsError::new("sample_rate and channels must be plausible"));
    }
    if specific_config.is_empty() || specific_config.len() > MAX_ASC {
        return Err(JsError::new("AudioSpecificConfig is empty or implausibly large"));
    }

    Ok(build_mp4a(
        &AacConfig {
            sample_rate,
            channels,
            specific_config: specific_config.to_vec(),
        },
        bitrate.max(1),
    ))
}
