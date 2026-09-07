//! fMP4 (CMAF) muxer — turns encoded video samples into HLS media segments.
//!
//! The JS side supplies already-encoded samples (from WebCodecs, or read
//! straight out of a source file in remux mode); this module packages them into
//! `.m4s` segments plus the `.m3u8` that indexes them.
//!
//! Segments always begin on a keyframe, which is what makes each one
//! independently decodable and therefore seekable.

pub(crate) mod boxes;
mod fragment;
mod init;

use wasm_bindgen::prelude::*;

use crate::hls::MediaPlaylist;

/// Upper bounds on untrusted input (SECURITY.md §7). These are generous for
/// real media but stop a malformed or hostile source from exhausting memory.
const MAX_DIMENSION: u16 = 16_384;
const MAX_CODEC_CONFIG: usize = 4_096;
const MAX_SAMPLE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SAMPLES_PER_SEGMENT: usize = 100_000;
const MAX_SAMPLE_ENTRY: usize = 64 * 1024;

/// Why a segmenter rejected its input.
///
/// A plain Rust error rather than `JsError`, so validation stays testable on the
/// host and the crate remains usable outside WASM. It is converted at the
/// boundary by the `#[wasm_bindgen]` wrappers below.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MuxError {
    /// `timescale` was zero.
    ZeroTimescale,
    /// Width or height was zero or implausibly large.
    BadDimensions,
    /// The `avcC` record was empty or implausibly large.
    BadCodecConfig,
    /// `target_seconds` was not a positive, finite number.
    BadTargetDuration,
    /// A sample had no data.
    EmptySample,
    /// A sample exceeded [`MAX_SAMPLE_BYTES`].
    SampleTooLarge,
    /// A segment exceeded [`MAX_SAMPLES_PER_SEGMENT`] without a keyframe.
    SegmentTooLong,
    /// `restore_segment` was called after sample pushing had begun.
    RestoreAfterSamples,
    /// A restored segment's duration was negative or non-finite.
    BadRestoreDuration,
    /// `set_audio` was called after packaging had begun.
    AudioAfterStart,
    /// The audio sample entry was missing or implausibly sized.
    BadAudioConfig,
    /// An audio sample was pushed without an audio track configured.
    NoAudioTrack,
}

impl core::fmt::Display for MuxError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let msg = match self {
            Self::ZeroTimescale => "timescale must be greater than zero",
            Self::BadDimensions => "width and height must be within 1..=16384",
            Self::BadCodecConfig => "codec_config (avcC) is empty or implausibly large",
            Self::BadTargetDuration => "target_seconds must be a positive, finite number",
            Self::EmptySample => "sample data is empty",
            Self::SampleTooLarge => "sample exceeds the maximum allowed size",
            Self::SegmentTooLong => {
                "segment exceeded the maximum sample count; is the source missing keyframes?"
            }
            Self::RestoreAfterSamples => {
                "restoreSegment must be called before any sample is pushed"
            }
            Self::BadRestoreDuration => "restored segment duration must be finite and non-negative",
            Self::AudioAfterStart => "setAudio must be called before packaging begins",
            Self::BadAudioConfig => "audio sample entry is missing or implausibly large",
            Self::NoAudioTrack => "pushAudioSample requires setAudio to have been called",
        };
        f.write_str(msg)
    }
}

/// Audio parameters, fixed for the life of a rendition.
pub struct AudioTrackConfig {
    /// Track timescale — usually the sample rate.
    pub timescale: u32,
    /// The complete codec sample entry box (`mp4a` + `esds`, or equivalent),
    /// copied verbatim from the source so nothing is lost in translation.
    pub sample_entry: Vec<u8>,
}

/// Track-level parameters, fixed for the life of a rendition.
pub struct TrackConfig {
    /// Timescale in units per second (e.g. 90_000, or 1_000_000 to match
    /// WebCodecs' microsecond timestamps).
    pub timescale: u32,
    pub width: u16,
    pub height: u16,
    /// The `avcC` decoder configuration record — WebCodecs exposes this as the
    /// encoder's `description`.
    pub codec_config: Vec<u8>,
}

/// One encoded frame.
pub struct Sample {
    pub data: Vec<u8>,
    /// Decode duration in timescale units.
    pub duration: u32,
    /// True for a keyframe (random access point).
    pub is_sync: bool,
    /// Composition (presentation) offset from decode time; non-zero with B-frames.
    pub composition_offset: i32,
}

/// A finished media segment, ready to name, upload and index.
#[wasm_bindgen]
pub struct Segment {
    data: Vec<u8>,
    duration: f64,
    index: u32,
}

#[wasm_bindgen]
impl Segment {
    /// The `.m4s` bytes.
    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Vec<u8> {
        self.data.clone()
    }

    /// Segment duration in seconds, as written to `#EXTINF`.
    #[wasm_bindgen(getter)]
    pub fn duration(&self) -> f64 {
        self.duration
    }

    /// Zero-based segment index, used to build the file name.
    #[wasm_bindgen(getter)]
    pub fn index(&self) -> u32 {
        self.index
    }
}

/// Accumulates samples and emits fMP4 segments on keyframe boundaries.
#[wasm_bindgen]
pub struct Fmp4Segmenter {
    config: TrackConfig,
    /// Target segment length, in timescale units.
    target: u64,
    /// Base name for produced files, e.g. `720p`.
    prefix: String,

    pending: Vec<Sample>,
    pending_duration: u64,

    next_index: u32,
    base_decode_time: u64,

    /// Audio track, when the source has one.
    audio: Option<AudioTrackConfig>,
    pending_audio: Vec<Sample>,
    audio_base_decode_time: u64,

    ready: Vec<Segment>,
    playlist: MediaPlaylist,
}

impl Fmp4Segmenter {
    /// Create a segmenter for one rendition.
    ///
    /// `target_seconds` is a *minimum*: a segment closes at the first keyframe
    /// at or after that point, because segments must start on a keyframe.
    ///
    /// Returns an error rather than panicking on invalid input — a panic in
    /// WASM would abort the caller's page (SECURITY.md §3).
    pub fn try_new(
        prefix: &str,
        timescale: u32,
        width: u16,
        height: u16,
        codec_config: &[u8],
        target_seconds: f64,
    ) -> Result<Fmp4Segmenter, MuxError> {
        if timescale == 0 {
            return Err(MuxError::ZeroTimescale);
        }
        if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
            return Err(MuxError::BadDimensions);
        }
        if codec_config.is_empty() || codec_config.len() > MAX_CODEC_CONFIG {
            return Err(MuxError::BadCodecConfig);
        }
        if !target_seconds.is_finite() || target_seconds <= 0.0 {
            return Err(MuxError::BadTargetDuration);
        }

        // Saturating cast: `target_seconds` is already known finite and positive.
        let target = (target_seconds * f64::from(timescale)).round().max(1.0) as u64;

        Ok(Fmp4Segmenter {
            config: TrackConfig {
                timescale,
                width,
                height,
                codec_config: codec_config.to_vec(),
            },
            target,
            prefix: crate::sanitize_key(prefix),
            pending: Vec::new(),
            pending_duration: 0,
            next_index: 0,
            base_decode_time: 0,
            audio: None,
            pending_audio: Vec::new(),
            audio_base_decode_time: 0,
            ready: Vec::new(),
            playlist: MediaPlaylist::new(target_seconds.ceil() as u32),
        })
    }

    /// Add an audio track, to be muxed into the same segments as the video.
    ///
    /// Must be called before the init segment is produced, since it changes the
    /// `moov`. `sample_entry` is the complete codec sample entry box taken from
    /// the source.
    pub fn try_set_audio(&mut self, timescale: u32, sample_entry: &[u8]) -> Result<(), MuxError> {
        if self.next_index > 0 || !self.pending.is_empty() {
            return Err(MuxError::AudioAfterStart);
        }
        if timescale == 0 {
            return Err(MuxError::ZeroTimescale);
        }
        if sample_entry.len() < 8 || sample_entry.len() > MAX_SAMPLE_ENTRY {
            return Err(MuxError::BadAudioConfig);
        }
        self.audio = Some(AudioTrackConfig {
            timescale,
            sample_entry: sample_entry.to_vec(),
        });
        Ok(())
    }

    /// Add one encoded audio frame, in decode order.
    ///
    /// Audio is buffered alongside video and flushed into whichever segment the
    /// video boundary closes, so both tracks stay aligned.
    pub fn add_audio_sample(&mut self, data: &[u8], duration: u32) -> Result<(), MuxError> {
        if self.audio.is_none() {
            return Err(MuxError::NoAudioTrack);
        }
        if data.is_empty() {
            return Err(MuxError::EmptySample);
        }
        if data.len() > MAX_SAMPLE_BYTES {
            return Err(MuxError::SampleTooLarge);
        }
        if self.pending_audio.len() >= MAX_SAMPLES_PER_SEGMENT {
            return Err(MuxError::SegmentTooLong);
        }

        self.pending_audio.push(Sample {
            data: data.to_vec(),
            duration,
            // Every audio frame is independently decodable.
            is_sync: true,
            composition_offset: 0,
        });
        Ok(())
    }

    /// Add one encoded frame, in decode order.
    pub fn add_sample(
        &mut self,
        data: &[u8],
        duration: u32,
        is_sync: bool,
        composition_offset: i32,
    ) -> Result<(), MuxError> {
        if data.is_empty() {
            return Err(MuxError::EmptySample);
        }
        if data.len() > MAX_SAMPLE_BYTES {
            return Err(MuxError::SampleTooLarge);
        }
        if self.pending.len() >= MAX_SAMPLES_PER_SEGMENT {
            return Err(MuxError::SegmentTooLong);
        }

        // Close the current segment *before* this keyframe so the next segment
        // starts with it and remains independently decodable.
        if is_sync && !self.pending.is_empty() && self.pending_duration >= self.target {
            self.close_segment();
        }

        self.pending_duration += u64::from(duration);
        self.pending.push(Sample {
            data: data.to_vec(),
            duration,
            is_sync,
            composition_offset,
        });
        Ok(())
    }

    /// Set where the audio timeline resumes, in audio timescale ticks.
    ///
    /// A resumed run cannot derive this from segment durations: the number of
    /// audio frames in a segment is not a clean function of its length, so the
    /// exact tick count from the interrupted run must be carried across or the
    /// audio `tfdt` drifts and playback desynchronises.
    pub fn try_restore_audio_time(&mut self, ticks: f64) -> Result<(), MuxError> {
        if self.audio.is_none() {
            return Err(MuxError::NoAudioTrack);
        }
        if !ticks.is_finite() || ticks < 0.0 {
            return Err(MuxError::BadRestoreDuration);
        }
        self.audio_base_decode_time = ticks as u64;
        Ok(())
    }

    /// Re-register a segment produced before an interruption.
    /// See [`Fmp4Segmenter::restore_segment`].
    pub fn try_restore_segment(&mut self, duration: f64) -> Result<(), MuxError> {
        if !self.pending.is_empty() {
            return Err(MuxError::RestoreAfterSamples);
        }
        if !duration.is_finite() || duration < 0.0 {
            return Err(MuxError::BadRestoreDuration);
        }

        let index = self.next_index;
        self.playlist
            .add_segment(&self.segment_name(index), duration);

        // Advance the timeline so the next segment's tfdt continues correctly.
        let ticks = (duration * f64::from(self.config.timescale))
            .round()
            .max(0.0) as u64;
        self.base_decode_time = self.base_decode_time.saturating_add(ticks);
        self.next_index += 1;
        Ok(())
    }
}

#[wasm_bindgen]
impl Fmp4Segmenter {
    /// Create a segmenter for one rendition. See [`Fmp4Segmenter::try_new`].
    #[wasm_bindgen(constructor)]
    pub fn new(
        prefix: &str,
        timescale: u32,
        width: u16,
        height: u16,
        codec_config: &[u8],
        target_seconds: f64,
    ) -> Result<Fmp4Segmenter, JsError> {
        Self::try_new(prefix, timescale, width, height, codec_config, target_seconds)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Add one encoded frame, in decode order.
    ///
    /// A segment is closed just before a keyframe once the target length is
    /// reached, so callers should drain with [`Self::take_segment`] as they go
    /// rather than accumulating everything in memory (PLAN.md §3d).
    #[wasm_bindgen(js_name = pushSample)]
    pub fn push_sample(
        &mut self,
        data: &[u8],
        duration: u32,
        is_sync: bool,
        composition_offset: i32,
    ) -> Result<(), JsError> {
        self.add_sample(data, duration, is_sync, composition_offset)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Add an audio track to be muxed alongside the video.
    /// See [`Fmp4Segmenter::try_set_audio`].
    #[wasm_bindgen(js_name = setAudio)]
    pub fn set_audio(&mut self, timescale: u32, sample_entry: &[u8]) -> Result<(), JsError> {
        self.try_set_audio(timescale, sample_entry)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Add one encoded audio frame, in decode order.
    /// See [`Fmp4Segmenter::add_audio_sample`].
    #[wasm_bindgen(js_name = pushAudioSample)]
    pub fn push_audio_sample(&mut self, data: &[u8], duration: u32) -> Result<(), JsError> {
        self.add_audio_sample(data, duration)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Whether an audio track is configured.
    #[wasm_bindgen(getter, js_name = hasAudio)]
    pub fn has_audio(&self) -> bool {
        self.audio.is_some()
    }

    /// The initialization segment (`<prefix>_init.mp4`). Constant for the
    /// rendition; upload once, before any media segment.
    #[wasm_bindgen(js_name = initSegment)]
    pub fn init_segment(&mut self) -> Vec<u8> {
        self.playlist.set_init(&self.init_name());
        init::build(&self.config, self.audio.as_ref())
    }

    /// File name of the init segment.
    #[wasm_bindgen(js_name = initName)]
    pub fn init_name(&self) -> String {
        format!("{}_init.mp4", self.prefix)
    }

    /// Re-register a segment produced before an interruption.
    ///
    /// Resuming needs the playlist to list every segment, and the timeline to
    /// continue where it stopped — so a resumed run replays the durations of
    /// the segments it already has before pushing new samples (PLAN.md §3e).
    ///
    /// Call once per completed segment, in order, before the first
    /// [`Self::push_sample`].
    #[wasm_bindgen(js_name = restoreSegment)]
    pub fn restore_segment(&mut self, duration: f64) -> Result<(), JsError> {
        self.try_restore_segment(duration)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Set where the audio timeline resumes.
    /// See [`Fmp4Segmenter::try_restore_audio_time`].
    #[wasm_bindgen(js_name = restoreAudioTime)]
    pub fn restore_audio_time(&mut self, ticks: f64) -> Result<(), JsError> {
        self.try_restore_audio_time(ticks)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Index the next produced segment will be given.
    #[wasm_bindgen(getter, js_name = nextSegmentIndex)]
    pub fn next_segment_index(&self) -> u32 {
        self.next_index
    }

    /// Close any partial segment and mark the playlist complete. Call once the
    /// source is exhausted.
    #[wasm_bindgen(js_name = finish)]
    pub fn finish(&mut self) {
        if !self.pending.is_empty() {
            self.close_segment();
        }
        self.playlist.finish();
    }

    /// Number of finished segments waiting to be taken.
    #[wasm_bindgen(js_name = pendingSegments)]
    pub fn pending_segments(&self) -> usize {
        self.ready.len()
    }

    /// Remove and return the oldest finished segment, if any.
    #[wasm_bindgen(js_name = takeSegment)]
    pub fn take_segment(&mut self) -> Option<Segment> {
        if self.ready.is_empty() {
            None
        } else {
            Some(self.ready.remove(0))
        }
    }

    /// File name for the segment at `index`.
    #[wasm_bindgen(js_name = segmentName)]
    pub fn segment_name(&self, index: u32) -> String {
        format!("{}_{index:05}.m4s", self.prefix)
    }

    /// The media playlist (`<prefix>.m3u8`) covering every segment emitted so far.
    #[wasm_bindgen(js_name = playlistText)]
    pub fn playlist_text(&self) -> String {
        self.playlist.to_text()
    }

    /// File name of the media playlist.
    #[wasm_bindgen(js_name = playlistName)]
    pub fn playlist_name(&self) -> String {
        format!("{}.m3u8", self.prefix)
    }
}

impl Fmp4Segmenter {
    /// Package the buffered samples into a segment and index it.
    ///
    /// Audio buffered since the last boundary goes into the same segment, so
    /// both tracks advance together and a seek lands on matching audio.
    fn close_segment(&mut self) {
        let samples = std::mem::take(&mut self.pending);
        let ticks = std::mem::take(&mut self.pending_duration);
        let audio_samples = std::mem::take(&mut self.pending_audio);
        if samples.is_empty() {
            // Keep any audio for the next segment rather than dropping it.
            self.pending_audio = audio_samples;
            return;
        }

        let audio_ticks: u64 = audio_samples.iter().map(|s| u64::from(s.duration)).sum();
        let audio_run = self.audio.as_ref().map(|_| fragment::TrackRun {
            track_id: fragment::AUDIO_TRACK,
            base_decode_time: self.audio_base_decode_time,
            samples: &audio_samples,
        });

        let index = self.next_index;
        // Fragment sequence numbers are 1-based.
        let data = fragment::build(
            index + 1,
            fragment::TrackRun {
                track_id: fragment::VIDEO_TRACK,
                base_decode_time: self.base_decode_time,
                samples: &samples,
            },
            audio_run,
        );
        let duration = ticks as f64 / f64::from(self.config.timescale);

        self.playlist
            .add_segment(&self.segment_name(index), duration);
        self.ready.push(Segment {
            data,
            duration,
            index,
        });

        self.base_decode_time += ticks;
        self.audio_base_decode_time += audio_ticks;
        self.next_index += 1;
    }
}

#[cfg(test)]
mod tests;
