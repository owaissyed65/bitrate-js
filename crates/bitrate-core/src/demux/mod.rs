//! Demuxing — reading an existing container to find its encoded frames.
//!
//! Only the `moov` box is parsed here. It yields a *sample index* describing
//! where every frame lives in the file; the JS side then reads those byte
//! ranges lazily, which is what allows a 1 GB source to be processed at flat
//! memory (PLAN.md §3d).

mod mp4;
mod reader;

use wasm_bindgen::prelude::*;

pub use mp4::{AudioTrack, DemuxError, Movie, SampleRef, VideoTrack};

/// Reads an MP4 `moov` box and exposes its sample index to JS.
///
/// Per-sample data is exposed as parallel typed arrays rather than an array of
/// objects: a two-hour video has ~200k samples, and crossing the WASM boundary
/// once per sample would dominate the runtime.
#[wasm_bindgen]
pub struct Mp4Demuxer {
    track: VideoTrack,
    audio: Option<AudioTrack>,
}

#[wasm_bindgen]
impl Mp4Demuxer {
    /// Parse a `moov` payload (the box contents, without its 8-byte header).
    #[wasm_bindgen(constructor)]
    pub fn new(moov: &[u8]) -> Result<Mp4Demuxer, JsError> {
        mp4::parse_moov(moov)
            .map(|movie| Mp4Demuxer {
                track: movie.video,
                audio: movie.audio,
            })
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Track timescale, in units per second.
    #[wasm_bindgen(getter)]
    pub fn timescale(&self) -> u32 {
        self.track.timescale
    }

    /// Coded width in pixels.
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u16 {
        self.track.width
    }

    /// Coded height in pixels.
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u16 {
        self.track.height
    }

    /// The `avcC` record, ready to hand to `Fmp4Segmenter`.
    #[wasm_bindgen(getter, js_name = codecConfig)]
    pub fn codec_config(&self) -> Vec<u8> {
        self.track.codec_config.clone()
    }

    /// Number of frames in the track.
    #[wasm_bindgen(getter, js_name = sampleCount)]
    pub fn sample_count(&self) -> usize {
        self.track.samples.len()
    }

    /// Total track duration in seconds.
    #[wasm_bindgen(getter)]
    pub fn duration(&self) -> f64 {
        let ticks: u64 = self.track.samples.iter().map(|s| u64::from(s.duration)).sum();
        ticks as f64 / f64::from(self.track.timescale.max(1))
    }

    /// Byte offset of each sample in the source file.
    ///
    /// `f64` rather than `u64` because JS numbers are doubles; offsets stay
    /// exact well past any real file size.
    #[wasm_bindgen(js_name = sampleOffsets)]
    pub fn sample_offsets(&self) -> Vec<f64> {
        self.track.samples.iter().map(|s| s.offset as f64).collect()
    }

    /// Byte length of each sample.
    #[wasm_bindgen(js_name = sampleSizes)]
    pub fn sample_sizes(&self) -> Vec<u32> {
        self.track.samples.iter().map(|s| s.size).collect()
    }

    /// Decode duration of each sample, in timescale units.
    #[wasm_bindgen(js_name = sampleDurations)]
    pub fn sample_durations(&self) -> Vec<u32> {
        self.track.samples.iter().map(|s| s.duration).collect()
    }

    /// `1` for a keyframe, `0` otherwise.
    #[wasm_bindgen(js_name = sampleSyncFlags)]
    pub fn sample_sync_flags(&self) -> Vec<u8> {
        self.track.samples.iter().map(|s| u8::from(s.is_sync)).collect()
    }

    /// Composition offset of each sample.
    #[wasm_bindgen(js_name = sampleCompositionOffsets)]
    pub fn sample_composition_offsets(&self) -> Vec<i32> {
        self.track.samples.iter().map(|s| s.composition_offset).collect()
    }

    // ---- audio track ------------------------------------------------------

    /// Whether the source carries an audio track.
    #[wasm_bindgen(getter, js_name = hasAudio)]
    pub fn has_audio(&self) -> bool {
        self.audio.is_some()
    }

    /// Audio timescale — usually the sample rate. Zero when there is no audio.
    #[wasm_bindgen(getter, js_name = audioTimescale)]
    pub fn audio_timescale(&self) -> u32 {
        self.audio.as_ref().map_or(0, |a| a.timescale)
    }

    /// The audio codec sample entry, ready to hand to `Fmp4Segmenter.setAudio`.
    #[wasm_bindgen(getter, js_name = audioSampleEntry)]
    pub fn audio_sample_entry(&self) -> Vec<u8> {
        self.audio.as_ref().map(|a| a.sample_entry.clone()).unwrap_or_default()
    }

    /// Number of audio frames.
    #[wasm_bindgen(getter, js_name = audioSampleCount)]
    pub fn audio_sample_count(&self) -> usize {
        self.audio.as_ref().map_or(0, |a| a.samples.len())
    }

    /// Byte offset of each audio frame in the source file.
    #[wasm_bindgen(js_name = audioSampleOffsets)]
    pub fn audio_sample_offsets(&self) -> Vec<f64> {
        self.audio
            .as_ref()
            .map(|a| a.samples.iter().map(|s| s.offset as f64).collect())
            .unwrap_or_default()
    }

    /// Byte length of each audio frame.
    #[wasm_bindgen(js_name = audioSampleSizes)]
    pub fn audio_sample_sizes(&self) -> Vec<u32> {
        self.audio
            .as_ref()
            .map(|a| a.samples.iter().map(|s| s.size).collect())
            .unwrap_or_default()
    }

    /// Duration of each audio frame, in the audio timescale.
    #[wasm_bindgen(js_name = audioSampleDurations)]
    pub fn audio_sample_durations(&self) -> Vec<u32> {
        self.audio
            .as_ref()
            .map(|a| a.samples.iter().map(|s| s.duration).collect())
            .unwrap_or_default()
    }
}

impl Mp4Demuxer {
    /// The parsed video track, for Rust callers.
    pub fn track(&self) -> &VideoTrack {
        &self.track
    }

    /// The parsed audio track, for Rust callers.
    pub fn audio_track(&self) -> Option<&AudioTrack> {
        self.audio.as_ref()
    }
}
