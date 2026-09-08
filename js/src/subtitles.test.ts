/**
 * Subtitle sidecars.
 *
 * All of this is text, so unlike most of the packager it can be checked
 * properly without a browser — which matters, because every failure mode here
 * is silent. A player given a malformed subtitle playlist shows an empty menu
 * or no cues, and reports nothing at all.
 */

import { describe, expect, it } from "vitest";

import { attachSubtitles, srtToVtt, subtitleFiles, type SubtitleTrack } from "./subtitles.js";

const SRT = `1
00:00:01,500 --> 00:00:04,000
Hello there.

2
00:00:05,250 --> 00:00:08,100
The second line.
`;

const track = (over: Partial<SubtitleTrack> = {}): SubtitleTrack => ({
  language: "en",
  name: "English",
  content: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n",
  ...over,
});

describe("converting SubRip to WebVTT", () => {
  it("adds the WEBVTT header, without which nothing plays", () => {
    expect(srtToVtt(SRT).startsWith("WEBVTT\n\n")).toBe(true);
  });

  it("changes the comma before milliseconds to a full stop", () => {
    // The one difference that matters between the two formats. A player given
    // SubRip timings shows no cues and says nothing about why.
    const vtt = srtToVtt(SRT);
    expect(vtt).toContain("00:00:01.500 --> 00:00:04.000");
    expect(vtt).toContain("00:00:05.250 --> 00:00:08.100");
    expect(vtt).not.toContain(",500");
  });

  it("keeps the cue text intact", () => {
    const vtt = srtToVtt(SRT);
    expect(vtt).toContain("Hello there.");
    expect(vtt).toContain("The second line.");
  });

  it("normalises Windows line endings", () => {
    expect(srtToVtt(SRT.replace(/\n/g, "\r\n"))).not.toContain("\r");
  });

  it("strips a byte-order mark, which otherwise breaks the header", () => {
    // A BOM before WEBVTT makes the file unrecognisable to a player.
    const vtt = srtToVtt("﻿" + SRT);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
  });

  it("leaves a comma inside cue text alone", () => {
    const out = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\nWell, hello.\n");
    expect(out).toContain("Well, hello.");
    expect(out).toContain("00:00:01.000");
  });
});

describe("the files a subtitle track produces", () => {
  it("emits the cues and a playlist for each track", async () => {
    const files = await subtitleFiles([track(), track({ language: "es", name: "Español" })], {
      prefix: "lesson",
      duration: 120,
    });

    expect(files.map((f) => f.name)).toEqual([
      "lesson_sub_en.vtt",
      "lesson_sub_en.m3u8",
      "lesson_sub_es.vtt",
      "lesson_sub_es.m3u8",
    ]);
  });

  it("serves the cues as text/vtt, not text/plain", async () => {
    // As text/plain the cues fetch fine and the player shows nothing.
    const [cues] = await subtitleFiles([track()], { duration: 60 });
    expect(cues!.contentType).toBe("text/vtt");
    expect(cues!.blob.type).toBe("text/vtt");
  });

  it("converts a SubRip track on the way through", async () => {
    const [cues] = await subtitleFiles([track({ content: SRT })], { duration: 60 });
    const text = await cues!.blob.text();
    expect(text.startsWith("WEBVTT")).toBe(true);
    expect(text).toContain("00:00:01.500");
  });

  it("accepts a Blob as well as a string", async () => {
    const blob = new Blob([SRT], { type: "text/plain" });
    const [cues] = await subtitleFiles([track({ content: blob })], { duration: 60 });
    expect(await cues!.blob.text()).toContain("00:00:01.500");
  });

  it("writes a playlist a player will accept", async () => {
    const files = await subtitleFiles([track()], { prefix: "v", duration: 92.5 });
    const playlist = await files[1]!.blob.text();

    expect(playlist).toContain("#EXTM3U");
    expect(playlist).toContain("#EXT-X-TARGETDURATION:93");
    expect(playlist).toContain("#EXTINF:92.500,");
    expect(playlist).toContain("v_sub_en.vtt");
    // Without ENDLIST a player treats it as live and waits for more.
    expect(playlist).toContain("#EXT-X-ENDLIST");
    expect(files[1]!.isManifest).toBe(true);
  });

  it("refuses a duration it cannot write an EXTINF from", async () => {
    await expect(subtitleFiles([track()], { duration: 0 })).rejects.toThrow(/duration/);
    await expect(subtitleFiles([track()], { duration: NaN })).rejects.toThrow(/duration/);
  });

  it("keeps a caller-supplied language tag out of the file path", async () => {
    // Language tags reach file names, and these are caller input.
    const [cues] = await subtitleFiles([track({ language: "../../etc/passwd" })], {
      duration: 10,
    });
    expect(cues!.name).not.toContain("/");
    expect(cues!.name).not.toContain("..");
  });
});

describe("attaching tracks to a master playlist", () => {
  const master = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.4d0028"',
    "video_1080p.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.4d001f"',
    "video_720p.m3u8",
    "",
  ].join("\n");

  it("declares each track before the first variant", () => {
    const out = attachSubtitles(master, [track()], { prefix: "video" });
    expect(out.indexOf("#EXT-X-MEDIA:")).toBeLessThan(out.indexOf("#EXT-X-STREAM-INF"));
  });

  it("tags every variant, or the menu comes up empty", () => {
    // Declaring the tracks is not enough: without SUBTITLES on the variants no
    // rendition claims them, and a player shows an empty subtitle menu — which
    // reads as broken cues rather than a broken playlist.
    const out = attachSubtitles(master, [track()], { prefix: "video" });
    const variants = out.split("\n").filter((l) => l.startsWith("#EXT-X-STREAM-INF"));
    expect(variants).toHaveLength(2);
    for (const v of variants) expect(v).toContain('SUBTITLES="subs"');
  });

  it("writes the attributes a player reads", () => {
    const out = attachSubtitles(
      master,
      [track({ language: "es-MX", name: "Español", default: true })],
      { prefix: "video" },
    );
    expect(out).toContain("TYPE=SUBTITLES");
    expect(out).toContain('GROUP-ID="subs"');
    expect(out).toContain('NAME="Español"');
    expect(out).toContain('LANGUAGE="es-MX"');
    expect(out).toContain("DEFAULT=YES");
    expect(out).toContain('URI="video_sub_es-MX.m3u8"');
  });

  it("defaults AUTOSELECT to yes and DEFAULT to no", () => {
    const out = attachSubtitles(master, [track()], { prefix: "video" });
    expect(out).toContain("AUTOSELECT=YES");
    expect(out).toContain("DEFAULT=NO");
  });

  it("marks forced narrative tracks", () => {
    const out = attachSubtitles(master, [track({ forced: true })], { prefix: "video" });
    expect(out).toContain("FORCED=YES");
  });

  it("handles several tracks", () => {
    const out = attachSubtitles(
      master,
      [track(), track({ language: "fr", name: "Français" })],
      { prefix: "video" },
    );
    expect(out.split("\n").filter((l) => l.startsWith("#EXT-X-MEDIA:"))).toHaveLength(2);
  });

  it("does not tag a variant twice", () => {
    // A duplicate attribute makes the line invalid.
    const once = attachSubtitles(master, [track()], { prefix: "video" });
    const twice = attachSubtitles(once, [track()], { prefix: "video" });
    for (const line of twice.split("\n").filter((l) => l.startsWith("#EXT-X-STREAM-INF"))) {
      expect(line.match(/SUBTITLES=/g)).toHaveLength(1);
    }
  });

  it("returns the master untouched when there are no tracks", () => {
    expect(attachSubtitles(master, [])).toBe(master);
  });

  it("uses a custom group id throughout", () => {
    const out = attachSubtitles(master, [track()], { prefix: "video", groupId: "captions" });
    expect(out).toContain('GROUP-ID="captions"');
    expect(out).toContain('SUBTITLES="captions"');
    expect(out).not.toContain('"subs"');
  });

  it("keeps the playlist parseable — every variant still names its playlist", () => {
    const out = attachSubtitles(master, [track()], { prefix: "video" });
    const lines = out.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith("#EXT-X-STREAM-INF")) {
        expect(lines[i + 1], `line after variant ${i}`).toMatch(/\.m3u8$/);
      }
    }
  });
});
