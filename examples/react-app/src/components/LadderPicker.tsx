/**
 * Choosing which qualities to produce.
 *
 * Every panel that can transcode needs this, and three hand-rolled copies would
 * drift — which is exactly how the Package tab ended up hardcoding one ladder
 * while the Appwrite tab offered five.
 */

import { LADDERS } from "bitrate-js";

export type LadderName = keyof typeof LADDERS;

export const LADDER_NAMES = Object.keys(LADDERS) as LadderName[];

interface Props {
  value: LadderName;
  onChange: (name: LadderName) => void;
  disabled?: boolean;
  /** The source height, so the rungs that will actually survive can be shown. */
  sourceHeight?: number | undefined;
}

export function LadderPicker({ value, onChange, disabled, sourceHeight }: Props) {
  // Rungs taller than the source are dropped rather than upscaled, so what the
  // user gets is often not what the preset lists. Show the real answer.
  const kept =
    sourceHeight === undefined
      ? LADDERS[value]
      : LADDERS[value].filter((r) => r.height <= sourceHeight);

  const effective = kept.length > 0 ? kept.map((r) => `${r.height}p`) : [`${sourceHeight}p`];

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
        {sourceHeight !== undefined && kept.length < LADDERS[value].length && (
          <span style={{ color: "var(--dim)" }}>
            {" "}
            ({LADDERS[value].length - kept.length} dropped)
          </span>
        )}
      </span>
    </div>
  );
}
