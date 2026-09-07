/** Small formatting helpers shared across the showcase. */

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${seconds.toFixed(1)}s`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Colourise a playlist so its structure is readable at a glance. */
export function highlightPlaylist(text: string): { kind: "tag" | "uri" | "plain"; text: string }[] {
  return text.split("\n").map((line) => {
    if (line.startsWith("#")) return { kind: "tag" as const, text: line };
    if (line.trim() === "") return { kind: "plain" as const, text: line };
    return { kind: "uri" as const, text: line };
  });
}
