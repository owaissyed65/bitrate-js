//! `bitrate-core` — the Rust/WASM core of the `bitrate` npm package.
//!
//! Responsibilities (see PLAN.md §2): demux input containers, mux fMP4 segments, and
//! generate HLS manifests. Encoding/decoding is handled by the browser's WebCodecs API
//! on the JS side — this crate owns the byte/format work.
//!
//! Security: this crate parses attacker-controlled binary (see SECURITY.md §3), so
//! `unsafe` is forbidden and parsers must never panic on malformed input.

#![forbid(unsafe_code)]
// Production code must never panic on malformed input, so panicking operations
// are denied. Tests are exempt: indexing and `expect` make assertions readable,
// and a failing test *should* panic.
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing))]
#![warn(clippy::all, missing_docs)]

use wasm_bindgen::prelude::*;

mod audio;
mod demux;
mod hls;
mod mux;
mod sanitize;

pub use audio::{build_audio_sample_entry, AacConfig};
pub use demux::{AudioTrack, DemuxError, Movie, Mp4Demuxer, SampleRef, TrackDefaults, VideoTrack};
pub use hls::{master_playlist, MediaPlaylist, Rung};
pub use mux::{Fmp4Segmenter, MuxError, Segment};
pub use sanitize::sanitize_key;

/// Crate version, surfaced to JS so the wrapper can assert wasm/JS parity.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// M0 round-trip check: proves JS -> wasm -> JS works for both bytes and strings.
///
/// Returns the checksum of `bytes` so the JS side can verify the buffer crossed intact.
#[wasm_bindgen]
pub fn checksum(bytes: &[u8]) -> u32 {
    // Fletcher-32: cheap, dependency-free, good enough to prove transfer integrity.
    let (mut lo, mut hi) = (0u32, 0u32);
    for &b in bytes {
        lo = (lo + u32::from(b)) % 0xffff;
        hi = (hi + lo) % 0xffff;
    }
    (hi << 16) | lo
}
