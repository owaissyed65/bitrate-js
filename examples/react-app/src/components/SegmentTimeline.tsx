import { formatBytes } from "../lib/format";

export interface SegmentInfo {
  name: string;
  index: number;
  /** Seconds. */
  duration: number;
  bytes: number;
  /** Start time on the timeline, in seconds. */
  start: number;
}

interface Props {
  segments: SegmentInfo[];
  /** Current playback position, to highlight the segment being played. */
  currentTime?: number;
  onSeek?: (seconds: number) => void;
}

/**
 * The segments as blocks on a timeline.
 *
 * This is the point of chunking made visible: each block is one independently
 * fetchable file, and clicking one seeks straight to it — which is exactly what
 * a player does when a viewer drags the scrubber.
 */
export function SegmentTimeline({ segments, currentTime = 0, onSeek }: Props) {
  if (segments.length === 0) {
    return (
      <div className="timeline">
        <div className="timeline-empty">Segments appear here as they are produced.</div>
      </div>
    );
  }

  const active = segments.findIndex(
    (s) => currentTime >= s.start && currentTime < s.start + s.duration,
  );

  return (
    <div className="timeline">
      {segments.map((segment, i) => (
        <button
          key={segment.name}
          className={`seg${i === active ? " active" : ""}`}
          style={{
            // Width tracks duration, so an uneven final segment is visible.
            flexBasis: `${Math.max(46, segment.duration * 22)}px`,
          }}
          title={`${segment.name}\n${segment.duration.toFixed(2)}s · ${formatBytes(segment.bytes)}\nstarts at ${segment.start.toFixed(1)}s`}
          onClick={() => onSeek?.(segment.start + 0.05)}
        >
          <b>{segment.index}</b>
          <em>{segment.duration.toFixed(1)}s</em>
        </button>
      ))}
    </div>
  );
}
