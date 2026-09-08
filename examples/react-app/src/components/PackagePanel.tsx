import { inspect, remux, transcode, LADDERS, isTranscodeSupported } from "bitrate-js";

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

    try {
      setInfo(await inspect(picked));
    } catch (e) {
      setInspectError(e instanceof Error ? e.message : String(e));
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
          : transcode(file, {
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
