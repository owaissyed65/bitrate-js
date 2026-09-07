import { useEffect, useState } from "react";

import { formatBytes, highlightPlaylist } from "../lib/format";
import { downloadAsZip, downloadEach, type PackagedFile } from "../lib/playable";

interface Props {
  files: PackagedFile[];
}

function kindOf(name: string): string {
  if (name.endsWith(".m3u8")) return name.includes("master") ? "master playlist" : "playlist";
  if (name.includes("_init.")) return "init segment";
  return "segment";
}

/** The produced files, with any playlist viewable in place. */
export function OutputFiles({ files }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [zipping, setZipping] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);

  async function saveZip() {
    setZipping(true);
    setZipError(null);
    try {
      await downloadAsZip(files);
    } catch (e) {
      // A ZIP cannot describe more than 4 GiB; say so and offer the fallback.
      setZipError(e instanceof Error ? e.message : String(e));
    } finally {
      setZipping(false);
    }
  }

  const playlists = files.filter((f) => f.name.endsWith(".m3u8"));

  useEffect(() => {
    // Default to the master playlist — the file you would hand to a player.
    if (!selected && playlists.length > 0) {
      setSelected((playlists.find((p) => p.name.includes("master")) ?? playlists[0]!).name);
    }
  }, [playlists, selected]);

  useEffect(() => {
    const file = files.find((f) => f.name === selected);
    if (!file) return;
    let cancelled = false;
    void file.blob.text().then((t) => {
      if (!cancelled) setText(t);
    });
    return () => {
      cancelled = true;
    };
  }, [selected, files]);

  if (files.length === 0) {
    return <div className="empty">No output yet.</div>;
  }

  const total = files.reduce((sum, f) => sum + f.blob.size, 0);

  return (
    <div className="grid-2">
      <div>
        <div className="row" style={{ marginBottom: "0.6rem" }}>
          <span className="chip">
            <strong>{files.length}</strong> files
          </span>
          <span className="chip">
            <strong>{formatBytes(total)}</strong> total
          </span>
          <div className="spacer" />
          <button className="small" disabled={zipping} onClick={() => void saveZip()}>
            {zipping ? "Zipping…" : "Download .zip"}
          </button>
          <button
            className="ghost small"
            onClick={() => downloadEach(files)}
            title="Save each file separately instead"
          >
            Separate files
          </button>
        </div>

        {zipError && (
          <p className="note err" style={{ marginBottom: "0.6rem" }}>
            {zipError}
          </p>
        )}

        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Kind</th>
                <th className="num">Size</th>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => {
                const isPlaylist = file.name.endsWith(".m3u8");
                return (
                  <tr key={file.name}>
                    <td>
                      {isPlaylist ? (
                        <button
                          className="ghost small mono"
                          onClick={() => setSelected(file.name)}
                          style={{
                            padding: "0.15rem 0.4rem",
                            borderColor:
                              selected === file.name ? "var(--accent)" : "var(--border-bright)",
                          }}
                        >
                          {file.name}
                        </button>
                      ) : (
                        <span className="mono">{file.name}</span>
                      )}
                    </td>
                    <td style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                      {kindOf(file.name)}
                    </td>
                    <td className="num">{formatBytes(file.blob.size)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <p className="lede" style={{ marginBottom: "0.5rem" }}>
          {selected ? (
            <>
              <span className="mono">{selected}</span> — segment URIs are relative, so this plays
              from any storage without rewriting.
            </>
          ) : (
            "Select a playlist to view it."
          )}
        </p>
        <pre>
          {highlightPlaylist(text).map((line, i) => (
            <span key={i} className={line.kind === "plain" ? undefined : line.kind}>
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}
