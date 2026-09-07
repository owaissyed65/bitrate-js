import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";

import { formatDuration } from "../lib/format";

interface Level {
  index: number;
  height: number;
  bitrate: number;
}

interface Props {
  /** Playlist URL — a blob: URL in this demo. */
  src: string | null;
  /** Called on time updates, so a timeline can highlight the current segment. */
  onTime?: (seconds: number) => void;
  /** Exposes a seek function to the parent. */
  seekRef?: React.MutableRefObject<((seconds: number) => void) | null>;
}

/**
 * Plays HLS and surfaces what the player is actually doing — which rendition is
 * active, what it switched to, and how much is buffered. That is the visible
 * proof that adaptive bitrate is working, rather than a claim in a log.
 */
export function HlsPlayer({ src, onTime, seekRef }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [current, setCurrent] = useState(-1);
  const [auto, setAuto] = useState(true);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    if (seekRef) {
      seekRef.current = (seconds: number) => {
        if (video.current) video.current.currentTime = seconds;
      };
    }
  }, [seekRef]);

  useEffect(() => {
    const el = video.current;
    if (!el || !src) return;

    setError(null);
    setLevels([]);
    setCurrent(-1);
    setStatus("loading…");

    // Safari plays HLS natively and needs no library.
    if (!Hls.isSupported()) {
      el.src = src;
      setStatus("native HLS");
      return () => {
        el.removeAttribute("src");
      };
    }

    const hls = new Hls({ enableWorker: true });
    hlsRef.current = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      setLevels(
        data.levels.map((l, index) => ({
          index,
          height: l.height,
          bitrate: l.bitrate,
        })),
      );
      setStatus(`${data.levels.length} rendition${data.levels.length === 1 ? "" : "s"}`);
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => setCurrent(data.level));
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) setError(`${data.type}: ${data.details}`);
    });

    hls.loadSource(src);
    hls.attachMedia(el);

    return () => {
      hls.destroy();
      hlsRef.current = null;
    };
  }, [src]);

  const chooseLevel = (index: number) => {
    setAuto(index === -1);
    if (hlsRef.current) hlsRef.current.currentLevel = index;
  };

  if (!src) {
    return <div className="empty">Package a video to play it here.</div>;
  }

  return (
    <div>
      <video
        ref={video}
        controls
        muted
        playsInline
        onTimeUpdate={(e) => onTime?.(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />

      <div className="row" style={{ marginTop: "0.75rem" }}>
        <span className="chip">
          duration <strong>{formatDuration(duration)}</strong>
        </span>
        {status && <span className="chip">{status}</span>}

        {levels.length > 1 && (
          <>
            <span className="chip">
              playing{" "}
              <strong>
                {current >= 0 ? `${levels[current]?.height ?? "?"}p` : "…"}
                {auto ? " (auto)" : ""}
              </strong>
            </span>
            <div className="spacer" />
            <span style={{ color: "var(--dim)", fontSize: "0.8rem" }}>quality</span>
            <button
              className={`small ${auto ? "" : "ghost"}`}
              onClick={() => chooseLevel(-1)}
              title="Let the player adapt to bandwidth"
            >
              Auto
            </button>
            {levels.map((level) => (
              <button
                key={level.index}
                className={`small ${!auto && current === level.index ? "" : "ghost"}`}
                onClick={() => chooseLevel(level.index)}
              >
                {level.height}p
              </button>
            ))}
          </>
        )}
      </div>

      {error && (
        <p className="note err" style={{ marginTop: "0.75rem" }}>
          {error}
          {/(appendFailed|bufferAppend|parsing)/i.test(error) && (
            <>
              {" "}
              — a generated sample carries synthetic frames that a decoder rejects. Use a real
              recording to see playback.
            </>
          )}
        </p>
      )}
    </div>
  );
}
