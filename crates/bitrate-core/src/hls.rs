//! HLS manifest generation — see PLAN.md §3c.
//!
//! Two playlist kinds:
//!   * **media playlist** (`1080p.m3u8`) — one rung's segments in order.
//!   * **master playlist** (`master.m3u8`) — the ROOT file, listing the rungs.
//!
//! Segment URIs are always **relative**, so uploaded output plays from any storage
//! base URL without rewriting (PLAN.md §3a).

use wasm_bindgen::prelude::*;

/// HLS protocol version. 7 is the floor for fMP4 (`EXT-X-MAP`) segments.
const HLS_VERSION: u8 = 7;

/// Builds a media playlist for one rendition (one rung of the ABR ladder).
#[wasm_bindgen]
pub struct MediaPlaylist {
    target_duration: u32,
    init_uri: Option<String>,
    segments: Vec<(String, f64)>,
    ended: bool,
}

#[wasm_bindgen]
impl MediaPlaylist {
    /// Create a playlist whose segments are at most `target_duration` seconds long.
    #[wasm_bindgen(constructor)]
    pub fn new(target_duration: u32) -> MediaPlaylist {
        MediaPlaylist {
            target_duration: target_duration.max(1),
            init_uri: None,
            segments: Vec::new(),
            ended: false,
        }
    }

    /// Set the fMP4 init segment (`EXT-X-MAP`), e.g. `1080p_init.mp4`.
    #[wasm_bindgen(js_name = setInit)]
    pub fn set_init(&mut self, uri: &str) {
        self.init_uri = Some(crate::sanitize_key(uri));
    }

    /// Append one media segment with its exact duration in seconds.
    #[wasm_bindgen(js_name = addSegment)]
    pub fn add_segment(&mut self, uri: &str, duration: f64) {
        // Guard against NaN/inf/negative durations from a malformed source.
        let duration = if duration.is_finite() && duration > 0.0 {
            duration
        } else {
            0.0
        };
        self.segments.push((crate::sanitize_key(uri), duration));
    }

    /// Mark the stream complete (writes `EXT-X-ENDLIST`).
    #[wasm_bindgen(js_name = finish)]
    pub fn finish(&mut self) {
        self.ended = true;
    }

    /// Render the `.m3u8` text.
    #[wasm_bindgen(js_name = toText)]
    pub fn to_text(&self) -> String {
        let mut s = String::from("#EXTM3U\n");
        s.push_str(&format!("#EXT-X-VERSION:{HLS_VERSION}\n"));
        s.push_str(&format!("#EXT-X-TARGETDURATION:{}\n", self.target_duration));
        s.push_str("#EXT-X-MEDIA-SEQUENCE:0\n");
        s.push_str("#EXT-X-PLAYLIST-TYPE:VOD\n");

        if let Some(init) = &self.init_uri {
            s.push_str(&format!("#EXT-X-MAP:URI=\"{init}\"\n"));
        }
        for (uri, dur) in &self.segments {
            s.push_str(&format!("#EXTINF:{dur:.6},\n{uri}\n"));
        }
        if self.ended {
            s.push_str("#EXT-X-ENDLIST\n");
        }
        s
    }
}

/// One rung of the ABR ladder, as referenced by the master playlist.
pub struct Rung {
    /// Relative URI of the rung's media playlist, e.g. `1080p.m3u8`.
    pub uri: String,
    /// Peak bandwidth in bits per second.
    pub bandwidth: u32,
    /// Encoded width in pixels.
    pub width: u32,
    /// Encoded height in pixels.
    pub height: u32,
    /// RFC 6381 codec string, e.g. `avc1.640028`.
    pub codecs: String,
}

/// Render the master playlist (`master.m3u8`) — the ROOT file handed to a player.
///
/// Rungs are emitted highest-bandwidth-first, which players use as the initial pick.
pub fn master_playlist(rungs: &[Rung]) -> String {
    let mut ordered: Vec<&Rung> = rungs.iter().collect();
    ordered.sort_by(|a, b| b.bandwidth.cmp(&a.bandwidth));

    let mut s = String::from("#EXTM3U\n");
    s.push_str(&format!("#EXT-X-VERSION:{HLS_VERSION}\n"));
    for r in ordered {
        s.push_str(&format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={}x{},CODECS=\"{}\"\n{}\n",
            r.bandwidth, r.width, r.height, r.codecs, r.uri
        ));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::{master_playlist, MediaPlaylist, Rung};

    #[test]
    fn media_playlist_shape() {
        let mut p = MediaPlaylist::new(6);
        p.set_init("1080p_init.mp4");
        p.add_segment("1080p_00000.m4s", 6.0);
        p.add_segment("1080p_00001.m4s", 5.5);
        p.finish();

        let t = p.to_text();
        assert!(t.starts_with("#EXTM3U\n"));
        assert!(t.contains("#EXT-X-VERSION:7"));
        assert!(t.contains("#EXT-X-TARGETDURATION:6"));
        assert!(t.contains("#EXT-X-MAP:URI=\"1080p_init.mp4\""));
        assert!(t.contains("#EXTINF:6.000000,\n1080p_00000.m4s"));
        assert!(t.trim_end().ends_with("#EXT-X-ENDLIST"));
    }

    #[test]
    fn rejects_nonfinite_durations() {
        let mut p = MediaPlaylist::new(6);
        p.add_segment("a.m4s", f64::NAN);
        p.add_segment("b.m4s", -3.0);
        let t = p.to_text();
        assert!(t.contains("#EXTINF:0.000000,\na.m4s"));
        assert!(t.contains("#EXTINF:0.000000,\nb.m4s"));
    }

    #[test]
    fn segment_uris_are_sanitized() {
        let mut p = MediaPlaylist::new(6);
        p.add_segment("../../evil.m4s", 6.0);
        assert!(!p.to_text().contains(".."));
    }

    #[test]
    fn master_is_sorted_desc_by_bandwidth() {
        let rungs = vec![
            Rung { uri: "480p.m3u8".into(),  bandwidth: 1_200_000, width: 854,  height: 480,  codecs: "avc1.4d401f".into() },
            Rung { uri: "1080p.m3u8".into(), bandwidth: 5_000_000, width: 1920, height: 1080, codecs: "avc1.640028".into() },
            Rung { uri: "720p.m3u8".into(),  bandwidth: 2_800_000, width: 1280, height: 720,  codecs: "avc1.4d401f".into() },
        ];
        let t = master_playlist(&rungs);
        let pos = |n: &str| t.find(n).unwrap_or(usize::MAX);
        assert!(pos("1080p.m3u8") < pos("720p.m3u8"));
        assert!(pos("720p.m3u8") < pos("480p.m3u8"));
        assert!(t.contains("RESOLUTION=1920x1080"));
    }
}
