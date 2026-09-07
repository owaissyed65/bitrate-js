//! fMP4 initialization segment: `ftyp` + `moov`.
//!
//! This is the "header" a player loads once per rendition (referenced by
//! `EXT-X-MAP` in the media playlist). It declares the track and its codec but
//! contains no media samples — sample tables are deliberately empty because
//! every sample is described later, per fragment, in `trun`.

use super::boxes::BoxWriter;
use super::{AudioTrackConfig, TrackConfig};

/// Track ids. Video is 1, audio is 2 when present.
pub(super) const TRACK_ID: u32 = 1;
pub(super) const AUDIO_TRACK_ID: u32 = 2;

/// Build the initialization segment for `cfg`, optionally with an audio track.
pub(super) fn build(cfg: &TrackConfig, audio: Option<&AudioTrackConfig>) -> Vec<u8> {
    let mut w = BoxWriter::with_capacity(1536);
    ftyp(&mut w);
    moov(&mut w, cfg, audio);
    w.into_bytes()
}

/// File type box. `iso6` is the baseline for fMP4; `cmfc` advertises CMAF
/// conformance so the same segments can also serve DASH (PLAN.md §3c).
fn ftyp(w: &mut BoxWriter) {
    w.boxed(b"ftyp", |w| {
        w.bytes(b"iso6").u32(1);
        w.bytes(b"iso6")
            .bytes(b"cmfc")
            .bytes(b"dash")
            .bytes(b"mp41");
    });
}

fn moov(w: &mut BoxWriter, cfg: &TrackConfig, audio: Option<&AudioTrackConfig>) {
    w.boxed(b"moov", |w| {
        mvhd(w, cfg, audio.is_some());
        trak(w, cfg);
        if let Some(audio) = audio {
            audio_trak(w, audio);
        }
        mvex(w, audio.is_some());
    });
}

/// Movie header. `duration` is 0 because a fragmented file's length is not
/// known up front.
fn mvhd(w: &mut BoxWriter, cfg: &TrackConfig, has_audio: bool) {
    let next_track_id = if has_audio {
        AUDIO_TRACK_ID + 1
    } else {
        TRACK_ID + 1
    };
    w.full_boxed(b"mvhd", 0, 0, |w| {
        w.u32(0) // creation_time
            .u32(0) // modification_time
            .u32(cfg.timescale)
            .u32(0) // duration (unknown / fragmented)
            .u32(0x0001_0000) // rate 1.0
            .i16(0x0100) // volume 1.0
            .u16(0) // reserved
            .u32(0)
            .u32(0) // reserved
            .unity_matrix()
            .zeros(24) // pre_defined[6]
            .u32(next_track_id);
    });
}

fn trak(w: &mut BoxWriter, cfg: &TrackConfig) {
    w.boxed(b"trak", |w| {
        tkhd(w, cfg);
        mdia(w, cfg);
    });
}

/// Track header. Flags 0x7 = enabled | in_movie | in_preview.
fn tkhd(w: &mut BoxWriter, cfg: &TrackConfig) {
    w.full_boxed(b"tkhd", 0, 0x7, |w| {
        w.u32(0) // creation_time
            .u32(0) // modification_time
            .u32(TRACK_ID)
            .u32(0) // reserved
            .u32(0) // duration
            .u32(0)
            .u32(0) // reserved
            .i16(0) // layer
            .i16(0) // alternate_group
            .i16(0) // volume (0 for video)
            .u16(0) // reserved
            .unity_matrix()
            // Display size as 16.16 fixed point.
            .u32(u32::from(cfg.width) << 16)
            .u32(u32::from(cfg.height) << 16);
    });
}

fn mdia(w: &mut BoxWriter, cfg: &TrackConfig) {
    w.boxed(b"mdia", |w| {
        mdhd(w, cfg);
        hdlr(w);
        minf(w, cfg);
    });
}

fn mdhd(w: &mut BoxWriter, cfg: &TrackConfig) {
    w.full_boxed(b"mdhd", 0, 0, |w| {
        w.u32(0) // creation_time
            .u32(0) // modification_time
            .u32(cfg.timescale)
            .u32(0) // duration
            .u16(0x55c4) // language: 'und', packed 5-bit ISO-639-2
            .u16(0); // pre_defined
    });
}

/// Handler reference — declares this as a video track.
fn hdlr(w: &mut BoxWriter) {
    w.full_boxed(b"hdlr", 0, 0, |w| {
        w.u32(0) // pre_defined
            .bytes(b"vide")
            .u32(0)
            .u32(0)
            .u32(0) // reserved
            .bytes(b"VideoHandler\0");
    });
}

fn minf(w: &mut BoxWriter, cfg: &TrackConfig) {
    w.boxed(b"minf", |w| {
        // Video media header. Flags must be 1.
        w.full_boxed(b"vmhd", 0, 1, |w| {
            w.u16(0) // graphicsmode
                .u16(0)
                .u16(0)
                .u16(0); // opcolor
        });
        dinf(w);
        stbl(w, cfg);
    });
}

/// Data information. A single self-contained `url ` entry (flags = 1) means
/// media lives in this same file rather than an external URL.
fn dinf(w: &mut BoxWriter) {
    w.boxed(b"dinf", |w| {
        w.full_boxed(b"dref", 0, 0, |w| {
            w.u32(1); // entry_count
            w.full_boxed(b"url ", 0, 1, |_| {});
        });
    });
}

/// Sample table. For fragmented MP4 every table except `stsd` is empty — the
/// per-sample data lives in each fragment's `trun`.
fn stbl(w: &mut BoxWriter, cfg: &TrackConfig) {
    w.boxed(b"stbl", |w| {
        w.full_boxed(b"stsd", 0, 0, |w| {
            w.u32(1); // entry_count
            avc1(w, cfg);
        });
        w.full_boxed(b"stts", 0, 0, |w| {
            w.u32(0);
        });
        w.full_boxed(b"stsc", 0, 0, |w| {
            w.u32(0);
        });
        w.full_boxed(b"stsz", 0, 0, |w| {
            w.u32(0).u32(0); // sample_size, sample_count
        });
        w.full_boxed(b"stco", 0, 0, |w| {
            w.u32(0);
        });
    });
}

/// AVC visual sample entry, carrying the `avcC` decoder configuration record
/// that WebCodecs hands us as the encoder's `description`.
fn avc1(w: &mut BoxWriter, cfg: &TrackConfig) {
    w.boxed(b"avc1", |w| {
        w.zeros(6) // reserved
            .u16(1) // data_reference_index
            .u16(0) // pre_defined
            .u16(0) // reserved
            .zeros(12) // pre_defined[3]
            .u16(cfg.width)
            .u16(cfg.height)
            .u32(0x0048_0000) // horizresolution 72 dpi
            .u32(0x0048_0000) // vertresolution 72 dpi
            .u32(0) // reserved
            .u16(1) // frame_count
            .zeros(32) // compressorname (length-prefixed, left blank)
            .u16(0x0018) // depth
            .i16(-1); // pre_defined
        w.boxed(b"avcC", |w| {
            w.bytes(&cfg.codec_config);
        });
    });
}

/// Movie extends — required for fragmented MP4; its presence tells a player
/// that fragments follow. One `trex` per track.
fn mvex(w: &mut BoxWriter, has_audio: bool) {
    w.boxed(b"mvex", |w| {
        trex(w, TRACK_ID);
        if has_audio {
            trex(w, AUDIO_TRACK_ID);
        }
    });
}

fn trex(w: &mut BoxWriter, track_id: u32) {
    w.full_boxed(b"trex", 0, 0, |w| {
        w.u32(track_id)
            .u32(1) // default_sample_description_index
            .u32(0) // default_sample_duration
            .u32(0) // default_sample_size
            .u32(0); // default_sample_flags
    });
}

// ---- audio track ----------------------------------------------------------

/// Build the audio `trak`.
///
/// The codec sample entry is embedded verbatim from the source, so sample rate,
/// channel layout and decoder configuration are preserved exactly.
fn audio_trak(w: &mut BoxWriter, cfg: &AudioTrackConfig) {
    w.boxed(b"trak", |w| {
        audio_tkhd(w);
        w.boxed(b"mdia", |w| {
            audio_mdhd(w, cfg);
            audio_hdlr(w);
            w.boxed(b"minf", |w| {
                // Sound media header; balance 0 = centred.
                w.full_boxed(b"smhd", 0, 0, |w| {
                    w.i16(0).u16(0);
                });
                dinf(w);
                audio_stbl(w, cfg);
            });
        });
    });
}

/// Audio `tkhd`: volume is full, and the display matrix/size are irrelevant.
fn audio_tkhd(w: &mut BoxWriter) {
    w.full_boxed(b"tkhd", 0, 0x7, |w| {
        w.u32(0)
            .u32(0)
            .u32(AUDIO_TRACK_ID)
            .u32(0) // reserved
            .u32(0) // duration
            .u32(0)
            .u32(0) // reserved
            .i16(0) // layer
            .i16(1) // alternate_group — audio tracks are alternatives of each other
            .i16(0x0100) // volume 1.0
            .u16(0) // reserved
            .unity_matrix()
            .u32(0) // width
            .u32(0); // height
    });
}

fn audio_mdhd(w: &mut BoxWriter, cfg: &AudioTrackConfig) {
    w.full_boxed(b"mdhd", 0, 0, |w| {
        w.u32(0)
            .u32(0)
            .u32(cfg.timescale)
            .u32(0) // duration
            .u16(0x55c4) // 'und'
            .u16(0);
    });
}

fn audio_hdlr(w: &mut BoxWriter) {
    w.full_boxed(b"hdlr", 0, 0, |w| {
        w.u32(0)
            .bytes(b"soun")
            .u32(0)
            .u32(0)
            .u32(0)
            .bytes(b"SoundHandler\0");
    });
}

/// Audio sample table — empty like the video one, save for `stsd`.
fn audio_stbl(w: &mut BoxWriter, cfg: &AudioTrackConfig) {
    w.boxed(b"stbl", |w| {
        w.full_boxed(b"stsd", 0, 0, |w| {
            w.u32(1); // entry_count

            // The complete sample entry box, copied from the source.
            w.bytes(&cfg.sample_entry);
        });
        w.full_boxed(b"stts", 0, 0, |w| {
            w.u32(0);
        });
        w.full_boxed(b"stsc", 0, 0, |w| {
            w.u32(0);
        });
        w.full_boxed(b"stsz", 0, 0, |w| {
            w.u32(0).u32(0);
        });
        w.full_boxed(b"stco", 0, 0, |w| {
            w.u32(0);
        });
    });
}
