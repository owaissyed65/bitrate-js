import { playlistReferences, rewritePlaylistUris } from "bitrate-js";
import { useRef, useState } from "react";

import { HlsPlayer } from "./HlsPlayer";

/**
 * Play any HLS URL, and say why when it will not play.
 *
 * The failure that costs the most time is a playlist whose segment URIs cannot
 * be resolved from where the playlist itself lives: the player loads the
 * playlist, every segment 404s, and it simply stalls with no useful error. That
 * is checked here before playback is attempted, and repaired where possible.
 */

interface Check {
  label: string;
  detail: string;
  state: "ok" | "warn" | "err";
}

/** Appwrite-style URL: `…/files/<id>/view?project=…`. */
const APPWRITE_VIEW = /^(.*\/files\/)[^/]+(\/view.*)$/;

export function PlayUrlPanel() {
  const [url, setUrl] = useState("");
  const [checks, setChecks] = useState<Check[]>([]);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revoke = useRef<(() => void) | null>(null);

  async function load() {
    setBusy(true);
    setChecks([]);
    setPlayUrl(null);
    revoke.current?.();

    const found: Check[] = [];
    const add = (c: Check) => {
      found.push(c);
      setChecks([...found]);
    };

    try {
      const target = url.trim();
      if (!target) return;

      // 1. Can the playlist itself be fetched?
      let res: Response;
      try {
        res = await fetch(target);
      } catch (error) {
        add({
          label: "Fetch the playlist",
          detail:
            "Blocked before a response arrived — almost always CORS. The storage must allow GET from this origin.",
          state: "err",
        });
        void error;
        return;
      }

      if (!res.ok) {
        add({
          label: "Fetch the playlist",
          detail: `${res.status} ${res.statusText}. Check the URL and that the file is readable.`,
          state: "err",
        });
        return;
      }
      add({ label: "Fetch the playlist", detail: `${res.status} OK`, state: "ok" });

      const text = await res.text();
      if (!text.startsWith("#EXTM3U")) {
        add({
          label: "Looks like a playlist",
          detail: "The response does not begin with #EXTM3U, so this is not an HLS playlist.",
          state: "err",
        });
        return;
      }
      add({
        label: "Looks like a playlist",
        detail: `${text.split("\n").length} lines, ${text.length} bytes`,
        state: "ok",
      });

      // 2. What does it reference, and can those be reached from here?
      const refs = playlistReferences(text);
      const relative = refs.filter((r) => !/^https?:\/\//i.test(r));
      add({
        label: "References",
        detail: `${refs.length} files — ${relative.length} relative, ${refs.length - relative.length} absolute`,
        state: "ok",
      });

      let playable = text;

      if (relative.length > 0) {
        // Relative URIs resolve against the playlist's own URL. That is correct
        // for path-based storage and wrong for storage addressed by id.
        const appwrite = APPWRITE_VIEW.exec(target);
        if (appwrite) {
          const [, prefix, suffix] = appwrite;
          playable = rewritePlaylistUris(text, (name) =>
            /^https?:\/\//i.test(name) ? undefined : `${prefix}${name}${suffix}`,
          );
          add({
            label: "Repaired the URIs",
            detail:
              "This storage addresses files by id, so relative references would 404. They have been pointed at absolute URLs for this session — re-upload with rewritePlaylistUris to fix it at the source.",
            state: "warn",
          });
        } else {
          const probe = new URL(relative[0]!, target).href;
          const ok = await fetch(probe, { method: "GET", headers: { Range: "bytes=0-1" } })
            .then((r) => r.ok)
            .catch(() => false);
          add({
            label: "Relative references resolve",
            detail: ok
              ? "The first segment was reachable next to the playlist."
              : `Could not reach ${probe} — segments are not where the playlist expects them.`,
            state: ok ? "ok" : "err",
          });
          if (!ok) return;
        }
      }

      // 3. Hand the (possibly repaired) playlist to the player.
      const blob = new Blob([playable], { type: "application/vnd.apple.mpegurl" });
      const objectUrl = URL.createObjectURL(blob);
      revoke.current = () => URL.revokeObjectURL(objectUrl);
      setPlayUrl(objectUrl);
      add({ label: "Handed to the player", detail: "Watch below.", state: "ok" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <h2>Play an HLS URL</h2>
        <p className="lede">
          Paste the <code>.m3u8</code> from your storage. It is fetched, checked, and played —
          and if it cannot play, the reason is named rather than left as a stalled player.
        </p>

        <div className="row">
          <input
            className="mono"
            style={{
              flex: 1,
              minWidth: 280,
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border-bright)",
              borderRadius: 8,
              padding: "0.45rem 0.6rem",
              fontSize: "0.82rem",
            }}
            placeholder="https://…/files/video.m3u8/view?project=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load();
            }}
          />
          <button onClick={() => void load()} disabled={busy || !url.trim()}>
            {busy ? "Checking…" : "Play"}
          </button>
        </div>

        {checks.length > 0 && (
          <div className="jobs" style={{ marginTop: "1rem" }}>
            {checks.map((check, i) => (
              <div
                key={i}
                className={`job ${check.state === "err" ? "failed" : check.state === "ok" ? "done" : ""}`}
              >
                <div className="job-head">
                  <span
                    style={{
                      width: 20,
                      textAlign: "center",
                      color:
                        check.state === "ok"
                          ? "var(--ok)"
                          : check.state === "err"
                            ? "var(--err)"
                            : "var(--warn)",
                    }}
                  >
                    {check.state === "ok" ? "✓" : check.state === "err" ? "✕" : "!"}
                  </span>
                  <span className="job-name">{check.label}</span>
                </div>
                <div
                  style={{ color: "var(--muted)", fontSize: "0.83rem", paddingLeft: "1.75rem" }}
                >
                  {check.detail}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {playUrl && (
        <section className="card">
          <h2>Playback</h2>
          <HlsPlayer src={playUrl} />
        </section>
      )}

      <section className="card">
        <h2>Embedding it in your own app</h2>
        <p className="lede">
          One URL is all a player needs. Everything else is referenced from the playlist.
        </p>

        <pre>{`import Hls from "hls.js";

const video = document.querySelector("video");
const src = "https://…/video.m3u8";

if (Hls.isSupported()) {
  const hls = new Hls();
  hls.loadSource(src);
  hls.attachMedia(video);
} else {
  // Safari and iOS play HLS natively.
  video.src = src;
}`}</pre>

        <p className="note" style={{ marginTop: "0.9rem" }}>
          <strong>React:</strong> do the same in a <code>useEffect</code>, and call{" "}
          <code>hls.destroy()</code> in its cleanup so switching videos does not leak players.
        </p>

        <p className="note warn" style={{ marginTop: "0.7rem" }}>
          <strong>The two things that break playback</strong>
          <br />
          <strong>1. CORS.</strong> A player fetches every segment itself, so the storage must
          allow <code>GET</code> from your site's origin — not just from where you uploaded.
          <br />
          <strong>2. Unresolvable segment URIs.</strong> Relative references need the segments to
          sit beside the playlist. Storage addressed by id needs absolute URLs written in.
        </p>
      </section>
    </>
  );
}
