/**
 * Playlist URI rewriting.
 *
 * These exist because relative URIs silently fail on id-addressed storage: the
 * playlist loads, every segment 404s, and the player just stalls. Getting the
 * rewrite wrong reproduces exactly that, so both forms a playlist uses to name
 * a file are covered.
 */

import { describe, expect, it } from "vitest";

import { playlistReferences, rewritePlaylistUris } from "./playlist.js";

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="job_1_init.mp4"
#EXTINF:6.000000,
job_1_00000.m4s
#EXTINF:6.000000,
job_1_00001.m4s
#EXT-X-ENDLIST
`;

const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.4d0028"
out_1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.4d001f"
out_720p.m3u8
`;

/** Stand-in for Appwrite's id-addressed view URLs. */
const appwriteUrl = (name: string) => `https://cloud.example/v1/files/${name}/view?project=p1`;

describe("rewriting a media playlist", () => {
  it("replaces the init segment named in an attribute", () => {
    const out = rewritePlaylistUris(MEDIA_PLAYLIST, appwriteUrl);
    expect(out).toContain(`#EXT-X-MAP:URI="${appwriteUrl("job_1_init.mp4")}"`);
    expect(out).not.toContain('URI="job_1_init.mp4"');
  });

  it("replaces every bare segment line", () => {
    const out = rewritePlaylistUris(MEDIA_PLAYLIST, appwriteUrl);
    expect(out).toContain(appwriteUrl("job_1_00000.m4s"));
    expect(out).toContain(appwriteUrl("job_1_00001.m4s"));
  });

  it("leaves tags untouched", () => {
    const out = rewritePlaylistUris(MEDIA_PLAYLIST, appwriteUrl);
    for (const tag of [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:6",
      "#EXTINF:6.000000,",
      "#EXT-X-ENDLIST",
    ]) {
      expect(out, tag).toContain(tag);
    }
  });

  it("keeps the line count, so durations still pair with their segments", () => {
    const out = rewritePlaylistUris(MEDIA_PLAYLIST, appwriteUrl);
    expect(out.split("\n")).toHaveLength(MEDIA_PLAYLIST.split("\n").length);
  });

  it("leaves a name alone when the resolver returns undefined", () => {
    // A partially uploaded set should not produce a half-broken playlist.
    const out = rewritePlaylistUris(MEDIA_PLAYLIST, (name) =>
      name === "job_1_00000.m4s" ? appwriteUrl(name) : undefined,
    );
    expect(out).toContain(appwriteUrl("job_1_00000.m4s"));
    expect(out).toContain("job_1_00001.m4s");
    expect(out).toContain('URI="job_1_init.mp4"');
  });
});

describe("rewriting a master playlist", () => {
  it("replaces the rendition playlists it points at", () => {
    const out = rewritePlaylistUris(MASTER_PLAYLIST, appwriteUrl);
    expect(out).toContain(appwriteUrl("out_1080p.m3u8"));
    expect(out).toContain(appwriteUrl("out_720p.m3u8"));
  });

  it("does not disturb the stream attributes", () => {
    const out = rewritePlaylistUris(MASTER_PLAYLIST, appwriteUrl);
    // CODECS also contains quotes; only URI attributes may be touched.
    expect(out).toContain('CODECS="avc1.4d0028"');
    expect(out).toContain("BANDWIDTH=5000000,RESOLUTION=1920x1080");
  });
});

describe("finding what a playlist references", () => {
  it("lists the init segment and every media segment in order", () => {
    expect(playlistReferences(MEDIA_PLAYLIST)).toEqual([
      "job_1_init.mp4",
      "job_1_00000.m4s",
      "job_1_00001.m4s",
    ]);
  });

  it("lists the renditions of a master playlist", () => {
    expect(playlistReferences(MASTER_PLAYLIST)).toEqual(["out_1080p.m3u8", "out_720p.m3u8"]);
  });

  it("returns nothing for a playlist with no files yet", () => {
    expect(playlistReferences("#EXTM3U\n#EXT-X-VERSION:7\n")).toEqual([]);
  });
});

describe("edge cases", () => {
  it("handles an empty playlist", () => {
    expect(rewritePlaylistUris("", appwriteUrl)).toBe("");
  });

  it("tolerates carriage returns", () => {
    const crlf = "#EXTM3U\r\n#EXTINF:6,\r\nseg.m4s\r\n";
    const out = rewritePlaylistUris(crlf, appwriteUrl);
    expect(out).toContain(appwriteUrl("seg.m4s"));
  });

  it("handles several URI attributes on one line", () => {
    const line = '#EXT-X-MEDIA:TYPE=AUDIO,URI="a.m3u8"\n#EXT-X-MAP:URI="b.mp4"';
    const out = rewritePlaylistUris(line, appwriteUrl);
    expect(out).toContain(appwriteUrl("a.m3u8"));
    expect(out).toContain(appwriteUrl("b.mp4"));
  });

  it("is idempotent when the resolver already sees absolute URLs", () => {
    const once = rewritePlaylistUris(MEDIA_PLAYLIST, appwriteUrl);
    const twice = rewritePlaylistUris(once, (name) =>
      name.startsWith("http") ? undefined : appwriteUrl(name),
    );
    expect(twice).toBe(once);
  });
});
