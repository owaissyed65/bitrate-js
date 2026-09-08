/**
 * Subtitle and caption tracks, as HLS sidecars.
 *
 * Deliberately *not* threaded through the packagers. Subtitles do not come from
 * the video file — they come from a transcription service, a translator, or an
 * `.srt` the user uploaded — so making `remux` and `transcode` take them would
 * push an unrelated concern through both pipelines. These functions compose
 * with either: package as usual, then add the tracks.
 *
 * @example
 * ```ts
 * const files = await subtitleFiles(tracks, { prefix: "video", duration: 754 });
 * const master = attachSubtitles(masterText, tracks, { prefix: "video" });
 * ```
 *
 * What this does **not** do is pull captions out of the video itself. CEA-608
 * and 708 are carried inside the H.264 bitstream's SEI messages, which means
 * parsing NAL units to find them — a different job from anything else here, and
 * not one this can pretend to do.
 */

import { MIME_MANIFEST, MIME_VTT } from "./types.js";
import type { OutputFile } from "./remux.js";

export interface SubtitleTrack {
  /** BCP-47 tag: `"en"`, `"es-MX"`, `"pt-BR"`. */
  language: string;
  /** What the player shows in its menu — "English", "Español". */
  name: string;
  /** WebVTT or SubRip (`.srt`) content. SubRip is converted. */
  content: string | Blob;
  /** Select this track when the player has no better reason to choose. */
  default?: boolean;
  /** Offer it to viewers whose system language matches. Default `true`. */
  autoselect?: boolean;
  /**
   * Forced narrative subtitles — the ones burned in for a scene in another
   * language, shown even when subtitles are off.
   */
  forced?: boolean;
}

export interface SubtitleOptions {
  /** Base name, matching the one the video was packaged with. */
  prefix?: string;
  /**
   * Total duration in seconds, for the `#EXTINF` of the single cue segment.
   *
   * A subtitle rendition is one segment covering the whole programme: the file
   * is a few kilobytes, so splitting it buys nothing and costs a request per
   * chunk.
   */
  duration: number;
  /** Group id used in the master playlist. Default `"subs"`. */
  groupId?: string;
}

/** Whether a blob of text looks like SubRip rather than WebVTT. */
function isSubRip(text: string): boolean {
  return !text.trimStart().startsWith("WEBVTT");
}

/**
 * Convert SubRip (`.srt`) to WebVTT.
 *
 * They are nearly the same format, which is why this is short and why so many
 * people are caught out by the one difference that matters: SubRip separates
 * hours from milliseconds with a comma, WebVTT with a full stop. A player given
 * SubRip timings shows no cues at all and reports nothing.
 */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r\n/g, "\n")
    .replace(/^﻿/, "")
    // 00:00:01,500 --> 00:00:04,000
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{1,3})/g, "$1.$2")
    .trim();

  return `WEBVTT\n\n${body}\n`;
}

/** Read a track's content, converting SubRip if that is what it is. */
async function toVtt(content: string | Blob): Promise<string> {
  const text = typeof content === "string" ? content : await content.text();
  return isSubRip(text) ? srtToVtt(text) : text.replace(/\r\n/g, "\n");
}

/** A safe, stable file stem for a track. */
function stem(prefix: string, track: SubtitleTrack): string {
  // Language tags are caller-supplied and end up in file names, so keep them to
  // what a tag may actually contain.
  const tag = track.language.replace(/[^A-Za-z0-9-]/g, "") || "und";
  return `${prefix}_sub_${tag}`;
}

/** Quote a value for an HLS attribute list. */
function quote(value: string): string {
  return `"${value.replace(/"/g, "")}"`;
}

/**
 * The `.vtt` and its playlist, for every track.
 *
 * Yields two files per track: the cues, and a one-segment media playlist
 * pointing at them.
 */
export async function subtitleFiles(
  tracks: readonly SubtitleTrack[],
  options: SubtitleOptions,
): Promise<OutputFile[]> {
  const { prefix = "video", duration } = options;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("subtitleFiles: `duration` must be the programme length in seconds");
  }

  const files: OutputFile[] = [];

  for (const track of tracks) {
    const base = stem(prefix, track);
    const vtt = await toVtt(track.content);

    files.push({
      name: `${base}.vtt`,
      blob: new Blob([vtt], { type: MIME_VTT }),
      contentType: MIME_VTT,
      isManifest: false,
    });

    // EXT-X-VERSION 3 is enough for a plain WebVTT rendition, and asking for
    // less than the video's version costs nothing here.
    const playlist = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      `#EXT-X-TARGETDURATION:${Math.ceil(duration)}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      `#EXTINF:${duration.toFixed(3)},`,
      `${base}.vtt`,
      "#EXT-X-ENDLIST",
      "",
    ].join("\n");

    files.push({
      name: `${base}.m3u8`,
      blob: new Blob([playlist], { type: MIME_MANIFEST }),
      contentType: MIME_MANIFEST,
      isManifest: true,
    });
  }

  return files;
}

/**
 * Add subtitle tracks to a master playlist.
 *
 * Two things are needed and both are easy to half-do: an `EXT-X-MEDIA` line per
 * track, and a `SUBTITLES` attribute on every variant. Without the second the
 * tracks are declared but no variant claims them, and players show an empty
 * subtitle menu — which looks like the cues failed to load rather than like a
 * playlist mistake.
 */
export function attachSubtitles(
  master: string,
  tracks: readonly SubtitleTrack[],
  options: Omit<SubtitleOptions, "duration"> = {},
): string {
  if (tracks.length === 0) return master;

  const { prefix = "video", groupId = "subs" } = options;

  const media = tracks.map((track) => {
    const attrs = [
      "TYPE=SUBTITLES",
      `GROUP-ID=${quote(groupId)}`,
      `NAME=${quote(track.name)}`,
      `LANGUAGE=${quote(track.language)}`,
      `DEFAULT=${track.default ? "YES" : "NO"}`,
      `AUTOSELECT=${(track.autoselect ?? true) ? "YES" : "NO"}`,
    ];
    if (track.forced) attrs.push("FORCED=YES");
    attrs.push(`URI=${quote(`${stem(prefix, track)}.m3u8`)}`);
    return `#EXT-X-MEDIA:${attrs.join(",")}`;
  });

  const lines = master.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inserted = false;

  for (const line of lines) {
    // Declare the tracks before the first variant, as players expect.
    if (!inserted && line.startsWith("#EXT-X-STREAM-INF")) {
      out.push(...media);
      inserted = true;
    }

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      // Re-tagging an already-tagged variant would produce a duplicate
      // attribute, which is invalid.
      out.push(
        /SUBTITLES=/.test(line) ? line : `${line},SUBTITLES=${quote(groupId)}`,
      );
      continue;
    }

    out.push(line);
  }

  // A master with no variants at all still benefits from the declarations.
  if (!inserted) {
    const end = out.length > 0 && out[out.length - 1] === "" ? out.length - 1 : out.length;
    out.splice(end, 0, ...media);
  }

  return out.join("\n");
}
