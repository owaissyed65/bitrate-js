/**
 * Choosing which qualities to produce.
 *
 * Every panel that can transcode needs this, and three hand-rolled copies would
 * drift — which is exactly how the Package tab ended up hardcoding one ladder
 * while the Appwrite tab offered five.
 */

import { LADDERS, planLadder } from "bitrate-js";

export type LadderName = keyof typeof LADDERS;

export const LADDER_NAMES = Object.keys(LADDERS) as LadderName[];

interface Props {
  value: LadderName;
  onChange: (name: LadderName) => void;
  disabled?: boolean;
  /** The source size, so the rungs that will actually be produced can be shown. */
  sourceWidth?: number | undefined;
  sourceHeight?: number | undefined;
}

export function LadderPicker({ value, onChange, disabled, sourceWidth, sourceHeight }: Props) {
  // Ask the library rather than reimplementing its rule. A second copy of
  // "which rungs survive" is a second copy that can disagree — and the preview
  // is the thing people trust before spending minutes on an encode.
  const planned =
    sourceHeight === undefined
      ? null
      : planLadder(LADDERS[value], sourceWidth ?? Math.round((sourceHeight * 16) / 9), sourceHeight);

  const effective = (planned ?? LADDERS[value]).map((r) => `${r.height}p`);
  const dropped = planned ? LADDERS[value].length - planned.length : 0;

  return (
    <div className="row" style={{ gap: "0.4rem" }}>
      <span style={{ color: "var(--dim)", fontSize: "0.82rem" }}>ladder</span>

      {LADDER_NAMES.map((name) => (
        <button
          key={name}
          className={`small ${value === name ? "" : "ghost"}`}
          onClick={() => onChange(name)}
          disabled={disabled}
          title={LADDERS[name].map((r) => `${r.height}p @ ${(r.bitrate / 1e6).toFixed(1)}M`).join("  ·  ")}
        >
          {name}
        </button>
      ))}

      <span className="mono" style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
        {effective.join(" · ")}
        {dropped > 0 && (
          <span style={{ color: "var(--dim)" }}> ({dropped} above the source dropped)</span>
        )}
      </span>
    </div>
  );
}
