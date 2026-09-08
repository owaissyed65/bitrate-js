import {
  inspect,
  remux,
  transcode,
  transcodeInWorker,
  isWorkerTranscodeSupported,
  posterFrame,
  thumbnailSprite,
  isThumbnailSupported,
  LADDERS,
  isTranscodeSupported,
} from "bitrate-js";

import { LadderPicker, type LadderName } from "./LadderPicker";
import type { SourceInfo } from "bitrate-js";
import { useRef, useState } from "react";

import { formatBytes, formatDuration, formatMs } from "../lib/format";
import { entryPlaylist, toPlayable, type PackagedFile } from "../lib/playable";
import { Dropzone } from "./Dropzone";
import { HlsPlayer } from "./HlsPlayer";
import { OutputFiles } from "./OutputFiles";
import { SegmentTimeline, type SegmentInfo } from "./SegmentTimeline";

type Mode = "remux" | "transcode";

/**
 * Pick a video, package it, watch the segments appear, then play the result.
 *
 * The same panel covers both modes so the difference is visible: remux finishes
 * in milliseconds and keeps one rendition, transcode takes real time and
 * produces a ladder you can switch between in the player.
 */
export function PackagePanel() {
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<SourceInfo | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("remux");
  const [ladderName, setLadderName] = useState<LadderName>("standard");
  // The worker keeps the tab usable while every frame is re-encoded.
  const [useWorker, setUseWorker] = useState(true);

  const [poster, setPoster] = useState<{ url: string; at: number; bytes: number } | null>(null);
  const [sprite, setSprite] = useState<{ url: string; bytes: number; times: number[]; columns: number } | null>(null);
  const [stillsBusy, setStillsBusy] = useState(false);
  const [stillsError, setStillsError] = useState<string | null>(null);
  const [segmentDuration, setSegmentDuration] = useState(6);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [files, setFiles] = useState<PackagedFile[]>([]);
  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const seek = useRef<((s: number) => void) | null>(null);
  const revoke = useRef<(() => void) | null>(null);

  async function choose(picked: File) {
    setFile(picked);
    setInfo(null);
    setInspectError(null);
    setFiles([]);
    setSegments([]);
    setPlayUrl(null);
    setElapsed(null);
    setError(null);

    setSourceUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(picked);
    });

    setPoster((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return null;
    });
    setSprite((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return null;
    });
    setStillsError(null);

    try {
      setInfo(await inspect(picked));
    } catch (e) {
      setInspectError(e instanceof Error ? e.message : String(e));
      return;
    }

    void makeStills(picked);
  }

  /**
   * A poster and a scrub-bar sheet, taken as soon as a file is chosen.
   *
   * This is what an upload form actually needs first — something to show while
   * the packaging runs — and it costs a few hundred kilobytes of reading rather
   * than a round trip to a server with ffmpeg on it.
   */
  async function makeStills(picked: File) {
    if (!isThumbnailSupported()) {
      setStillsError("This browser has no WebCodecs, so stills cannot be decoded here.");
      return;
    }

    setStillsBusy(true);
    try {
      const shot = await posterFrame(picked, { atFraction: 0.1, maxWidth: 480 });
      setPoster({
        url: URL.createObjectURL(shot.blob),
        at: shot.atSeconds,
        bytes: shot.blob.size,
      });

      const sheet = await thumbnailSprite(picked, { count: 8, maxWidth: 160 });
      setSprite({
        url: URL.createObjectURL(sheet.blob),
        bytes: sheet.blob.size,
        times: sheet.times,
        columns: sheet.columns,
      });
    } catch (e) {
      setStillsError(e instanceof Error ? e.message : String(e));
    } finally {
      setStillsBusy(false);
    }
  }

  async function run() {
    if (!file) return;

    setRunning(true);
    setProgress(0);
    setError(null);
    setFiles([]);
    setSegments([]);
    setPlayUrl(null);
    revoke.current?.();

    const produced: PackagedFile[] = [];
    const timeline: SegmentInfo[] = [];
    let start = 0;
    const began = performance.now();

    try {
      const stream =
        mode === "remux"
          ? remux(file, { prefix: "out", segmentDuration, onProgress: (p) => setProgress(p.fraction) })
          : (useWorker && isWorkerTranscodeSupported() ? transcodeInWorker : transcode)(file, {
              prefix: "out",
              segmentDuration,
              ladder: LADDERS[ladderName],
              onProgress: (p) => setProgress(p.fraction),
            });

      for await (const item of stream) {
        produced.push(item);
        setFiles([...produced]);

        // Build the timeline from the first rendition only, so a ladder does
        // not stack several renditions of the same moment on top of each other.
        if (item.name.endsWith(".m4s") && !item.isManifest) {
          const rendition = item.name.replace(/_\d+\.m4s$/, "");
          const first = timeline[0]?.name.replace(/_\d+\.m4s$/, "");
          if (!first || rendition === first) {
            const index = timeline.length;
            const duration = segmentDuration;
            timeline.push({
              name: item.name,
              index,
              duration,
              bytes: item.blob.size,
              start,
            });
            start += duration;
            setSegments([...timeline]);
          }
        }
      }

      setProgress(1);
      setElapsed(performance.now() - began);

      const entry = entryPlaylist(produced);
      if (entry) {
        const playable = await toPlayable(produced, entry);
        revoke.current = playable.revoke;
        setPlayUrl(playable.url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const transcodeUnavailable = mode === "transcode" && !isTranscodeSupported();

  return (
    <>
      <section className="card">
        <h2>1 · Choose a video</h2>
        <p className="lede">
          Everything runs in this tab. Nothing is uploaded, and the file is read in slices, so
          size is not a problem.
        </p>

        {!file && <Dropzone onFiles={(f) => void choose(f[0]!)} />}

        {file && (
          <div className="grid-2">
            <div>
              {sourceUrl && <video src={sourceUrl} controls muted playsInline />}
              <div className="row" style={{ marginTop: "0.7rem" }}>
                <button className="ghost small" onClick={() => setFile(null)}>
                  Choose another
                </button>
              </div>
            </div>

            <div>
              <div className="chips" style={{ marginBottom: "0.8rem" }}>
                <span className="chip mono">{file.name}</span>
                <span className="chip">
                  <strong>{formatBytes(file.size)}</strong>
                </span>
              </div>

              {inspectError && (
                <p className="note err">
                  {inspectError}
                  {/fragmented/i.test(inspectError) && (
                    <>
                      <br />
                      Convert it first: <code>ffmpeg -i in.mp4 -c copy out.mp4</code>
                    </>
                  )}
                </p>
              )}

              {info && (
                <div className="stats">
                  <div className="stat">
                    <span>Resolution</span>
                    <strong>
                      {info.width}×{info.height}
                    </strong>
                  </div>
                  <div className="stat">
                    <span>Duration</span>
                    <strong>{formatDuration(info.duration)}</strong>
                  </div>
                  <div className="stat">
                    <span>Frames</span>
                    <strong>{info.sampleCount.toLocaleString()}</strong>
                  </div>
                  <div className="stat">
                    <span>Audio</span>
                    <strong style={{ color: info.hasAudio ? "var(--ok)" : "var(--dim)" }}>
                      {info.hasAudio ? `${(info.audioTimescale / 1000).toFixed(1)} kHz` : "none"}
                    </strong>
                  </div>
                </div>
              )}

              {info?.hasAudio && (
                <p className="note ok" style={{ marginTop: "0.8rem" }}>
                  {info.audioSampleCount.toLocaleString()} audio frames will be carried through
                  untouched, muxed as a second track.
                </p>
              )}

              {/* Stills, taken from the file itself — no server, no ffmpeg. */}
              {(stillsBusy || poster || stillsError) && (
                <div style={{ marginTop: "1rem" }}>
                  <h3 style={{ fontSize: "0.92rem", margin: "0 0 0.15rem" }}>Stills</h3>
                  <p style={{ color: "var(--muted)", fontSize: "0.82rem", margin: "0 0 0.6rem" }}>
                    Decoded here from a few hundred kilobytes of the file, not the whole thing.
                  </p>

                  {stillsBusy && !poster && (
                    <p className="note">Decoding a frame…</p>
                  )}
                  {stillsError && <p className="note err">{stillsError}</p>}

                  {poster && (
                    <>
                      <img
                        src={poster.url}
                        alt={`Poster frame at ${poster.at.toFixed(2)} seconds`}
                        style={{
                          maxWidth: "100%",
                          borderRadius: "8px",
                          border: "1px solid var(--border)",
                          display: "block",
                        }}
                      />
                      <p
                        className="mono"
                        style={{ color: "var(--dim)", fontSize: "0.76rem", margin: "0.35rem 0 0" }}
                      >
                        poster · {poster.at.toFixed(2)}s · {formatBytes(poster.bytes)} webp
                      </p>
                    </>
                  )}

                  {sprite && (
                    <div style={{ marginTop: "0.9rem" }}>
                      <img
                        src={sprite.url}
                        alt={`Sprite sheet of ${sprite.times.length} stills`}
                        style={{
                          maxWidth: "100%",
                          borderRadius: "8px",
                          border: "1px solid var(--border)",
                          display: "block",
                        }}
                      />
                      <p
                        className="mono"
                        style={{ color: "var(--dim)", fontSize: "0.76rem", margin: "0.35rem 0 0" }}
                      >
                        scrub sheet · {sprite.times.length} tiles across {sprite.columns} ·{" "}
                        {formatBytes(sprite.bytes)}
                      </p>
                      <p className="note" style={{ marginTop: "0.5rem" }}>
                        This is what a player shows when you drag along the scrub bar. One sheet is
                        far cheaper to serve than {sprite.times.length} separate images.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>2 · Package it</h2>
        <p className="lede">
          <strong>Remux</strong> chunks the existing video without re-encoding — near-instant, and
          it needs no WebCodecs. <strong>Transcode</strong> re-encodes into several bitrates so a
          player can adapt.
        </p>

        <div className="row">
          <button
            className={mode === "remux" ? "" : "ghost"}
            onClick={() => setMode("remux")}
            disabled={running}
          >
            Remux
          </button>
          <button
            className={mode === "transcode" ? "" : "ghost"}
            onClick={() => setMode("transcode")}
            disabled={running}
          >
            Transcode to ladder
          </button>

          <span style={{ color: "var(--dim)", fontSize: "0.85rem", marginLeft: "0.5rem" }}>
            segment
          </span>
          <input
            type="number"
            min={1}
            max={30}
            value={segmentDuration}
            disabled={running}
            onChange={(e) => setSegmentDuration(Number(e.target.value) || 6)}
          />
          <span style={{ color: "var(--dim)", fontSize: "0.85rem" }}>s</span>

          <div className="spacer" />
          <button onClick={() => void run()} disabled={!file || running || !!inspectError}>
            {running ? "Packaging…" : "Package"}
          </button>
        </div>

        {transcodeUnavailable && (
          <p className="note warn" style={{ marginTop: "0.8rem" }}>
            This browser has no WebCodecs, so transcoding is unavailable. Remux still works.
          </p>
        )}

        {mode === "transcode" && (
          <div style={{ marginTop: "0.9rem" }}>
            <LadderPicker
              value={ladderName}
              onChange={setLadderName}
              disabled={running}
              sourceWidth={info?.width}
              sourceHeight={info?.height}
            />
            <div className="row" style={{ marginTop: "0.6rem" }}>
              <label className="chip" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={useWorker}
                  disabled={running || !isWorkerTranscodeSupported()}
                  onChange={(e) => setUseWorker(e.target.checked)}
                />{" "}
                run on a worker thread
              </label>
              <span style={{ color: "var(--dim)", fontSize: "0.82rem" }}>
                {useWorker
                  ? "the tab stays usable, and a backgrounded tab is not throttled"
                  : "encodes on the main thread — the page will stutter on a long video"}
              </span>
            </div>

            {info && (
              <p className="note" style={{ marginTop: "0.6rem" }}>
                Rungs above a {info.height}p source are dropped rather than upscaled — upscaling
                costs encoding time and storage and adds no detail.
              </p>
            )}
          </div>
        )}

        {(running || elapsed !== null) && (
          <div style={{ marginTop: "1rem" }}>
            <div className={`bar${!running && !error ? " done" : ""}${error ? " err" : ""}`}>
              <i style={{ width: `${progress * 100}%` }} />
            </div>
            <div className="stats" style={{ marginTop: "0.9rem" }}>
              <div className="stat">
                <span>Segments</span>
                <strong>{files.filter((f) => f.name.endsWith(".m4s")).length}</strong>
              </div>
              <div className="stat">
                <span>Output</span>
                <strong>{formatBytes(files.reduce((s, f) => s + f.blob.size, 0))}</strong>
              </div>
              <div className="stat">
                <span>Time</span>
                <strong>{elapsed === null ? "…" : formatMs(elapsed)}</strong>
              </div>
              {file && elapsed !== null && (
                <div className="stat">
                  <span>Speed</span>
                  <strong>{(file.size / 1024 / 1024 / (elapsed / 1000)).toFixed(0)} MB/s</strong>
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <p className="note err" style={{ marginTop: "0.9rem" }}>
            {error}
          </p>
        )}
      </section>

      {segments.length > 0 && (
        <section className="card">
          <h2>3 · The segments</h2>
          <p className="lede">
            Each block is one independently fetchable file. Click one to seek there — that is
            exactly what a player does when a viewer drags the scrubber.
          </p>
          <SegmentTimeline
            segments={segments}
            currentTime={currentTime}
            onSeek={(s) => seek.current?.(s)}
          />
        </section>
      )}

      {files.length > 0 && (
        <>
          <section className="card">
            <h2>4 · Play the result</h2>
            <p className="lede">
              The packaged output played back through hls.js, straight from memory.
            </p>
            <HlsPlayer src={playUrl} onTime={setCurrentTime} seekRef={seek} />
          </section>

          <section className="card">
            <h2>5 · What was produced</h2>
            <OutputFiles files={files} />
          </section>
        </>
      )}
    </>
  );
}
