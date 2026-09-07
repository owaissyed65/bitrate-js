import { Account, Client, Permission, Role, Storage } from "appwrite";
import { HlsQueue, rewritePlaylistUris } from "bitrate-js";
import { appwriteAdapter } from "bitrate-js/adapters/appwrite";
import { useEffect, useState } from "react";

import { formatBytes } from "../lib/format";
import { Dropzone } from "./Dropzone";

/**
 * Where the connection settings live.
 *
 * Endpoint, project id and bucket id are **public** identifiers — they ship in
 * every Appwrite client bundle by design. Keeping them in localStorage is
 * therefore fine, and it keeps them out of the repository.
 *
 * An Appwrite **API key** is a different thing entirely: a server-side secret
 * with project-wide scope. It must never reach a browser, and this panel has
 * nowhere to put one.
 */
const STORAGE_KEY = "bitrate.appwrite.settings";

interface Settings {
  endpoint: string;
  projectId: string;
  bucketId: string;
}

const EMPTY: Settings = {
  endpoint: "https://fra.cloud.appwrite.io/v1",
  projectId: "",
  bucketId: "",
};

/**
 * Appwrite Cloud endpoints.
 *
 * Projects are created in a region and are only reachable through that
 * region's host; using the wrong one fails with "Project is not accessible in
 * this region". The bare `cloud.appwrite.io` host is the older global one and
 * does not serve regional projects. The list may grow — the endpoint field
 * accepts anything, including a self-hosted instance.
 */
const KNOWN_ENDPOINTS: { label: string; url: string }[] = [
  { label: "Frankfurt", url: "https://fra.cloud.appwrite.io/v1" },
  { label: "New York", url: "https://nyc.cloud.appwrite.io/v1" },
  { label: "Sydney", url: "https://syd.cloud.appwrite.io/v1" },
  { label: "San Francisco", url: "https://sfo.cloud.appwrite.io/v1" },
  { label: "legacy global", url: "https://cloud.appwrite.io/v1" },
];

/** What a probe of one endpoint tells us about a project. */
type ProbeResult = "found" | "wrong-region" | "no-project" | "unreachable";

/**
 * Ask one endpoint whether it hosts `projectId`.
 *
 * `account.get()` is the cheapest call that exercises project routing. As a
 * guest it fails with a missing-scope error — which is itself proof the project
 * was found, since routing had to succeed to get that far.
 */
async function probeEndpoint(endpoint: string, projectId: string): Promise<ProbeResult> {
  try {
    const client = new Client().setEndpoint(endpoint).setProject(projectId);
    await new Account(client).get();
    return "found"; // an existing session; the project is certainly here
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not accessible in this region/i.test(message)) return "wrong-region";
    if (/could not be found/i.test(message)) return "no-project";
    if (/missing scope|unauthorized|guests|401/i.test(message)) return "found";
    if (/fetch|network|Failed to fetch/i.test(message)) return "unreachable";
    // Anything else means routing worked and the failure is about the session.
    return "found";
  }
}

interface Uploaded {
  name: string;
  size: number;
  url: string;
}

export function AppwritePanel() {
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [anonymous, setAnonymous] = useState(true);
  const [publicRead, setPublicRead] = useState(true);

  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<{ text: string; kind: "info" | "ok" | "err" }[]>([]);
  const [uploaded, setUploaded] = useState<Uploaded[]>([]);
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [probes, setProbes] = useState<{ label: string; url: string; result: ProbeResult }[]>([]);

  /** Try each known endpoint until one admits to hosting this project. */
  async function detectRegion() {
    if (!settings.projectId) return;
    setDetecting(true);
    setProbes([]);

    const found: typeof probes = [];
    for (const endpoint of KNOWN_ENDPOINTS) {
      const result = await probeEndpoint(endpoint.url, settings.projectId);
      found.push({ ...endpoint, result });
      setProbes([...found]);

      if (result === "found") {
        update({ endpoint: endpoint.url });
        say(`project found in ${endpoint.label} — endpoint set to ${endpoint.url}`, "ok");
        setDetecting(false);
        return;
      }
    }

    setDetecting(false);
    say(
      "None of the known endpoints host this project. Copy the API Endpoint shown in your Appwrite console under Settings, and paste it above.",
      "err",
    );
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setSettings({ ...EMPTY, ...JSON.parse(saved) });
    } catch {
      // Ignore unreadable settings; the defaults are fine.
    }
  }, []);

  function update(patch: Partial<Settings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private browsing; settings just will not persist.
    }
  }

  const say = (text: string, kind: "info" | "ok" | "err" = "info") =>
    setLog((prev) => [...prev, { text, kind }]);

  const ready = settings.endpoint && settings.projectId && settings.bucketId && file;

  async function run() {
    if (!file) return;
    setRunning(true);
    setLog([]);
    setUploaded([]);
    setPlaylistUrl(null);

    try {
      const client = new Client().setEndpoint(settings.endpoint).setProject(settings.projectId);
      say(`connected to ${settings.endpoint} · project ${settings.projectId}`);

      if (anonymous) {
        // Uploads need an identity unless the bucket allows guests outright.
        const account = new Account(client);
        try {
          const session = await account.get();
          say(`already signed in as ${session.$id}`, "ok");
        } catch {
          await account.createAnonymousSession();
          say("created an anonymous session", "ok");
        }
      }

      const storage = new Storage(client);
      const results: Uploaded[] = [];

      // A bucket with File Security enabled rejects a create that carries no
      // permissions. Public read is also what HLS needs: a player has to fetch
      // every segment, so they must be readable by whoever is watching.
      const permissions = publicRead ? [Permission.read(Role.any())] : undefined;
      if (publicRead) say("files will be created with public read permission");

      // The adapter takes an authenticated Storage instance — never a key.
      const put = appwriteAdapter({
        storage,
        bucketId: settings.bucketId,
        ...(permissions ? { permissions } : {}),
      });

      /** Appwrite's view URL for a file, which is addressed by id, not path. */
      const viewUrl = (name: string) =>
        `${settings.endpoint}/storage/buckets/${settings.bucketId}/files/${name}/view?project=${settings.projectId}`;

      const queue = new HlsQueue({
        segmentDuration: 6,
        retries: 2,
        upload: async (item) => {
          // Appwrite serves files by id, so a playlist's relative URIs resolve
          // under the playlist's own URL and 404. Point them at absolute view
          // URLs instead — the playlist is emitted last, so every segment is
          // already uploaded by now.
          if (item.isManifest) {
            const rewritten = rewritePlaylistUris(await item.blob.text(), viewUrl);
            await put({
              ...item,
              blob: new Blob([rewritten], { type: item.contentType }),
            });
            return;
          }
          await put(item);
        },
        onJobDone: () => say("packaging and upload finished", "ok"),
        onJobError: ({ error }) => say(error.message, "err"),
      });

      // Record what went up, so the files can be linked afterwards.
      const original = queue as unknown as { constructor: unknown };
      void original;

      const started = performance.now();
      const ids = queue.add(file);
      say(`job ${ids[0]} — packaging ${file.name}`);

      const report = await queue.drain();

      if (report.failed.length > 0) {
        say(report.failed[0]!.error.message, "err");
      } else {
        const produced = report.succeeded[0]!;
        say(
          `${produced.files.length} files uploaded in ${((performance.now() - started) / 1000).toFixed(1)}s`,
          "ok",
        );

        // Build view URLs from the deterministic ids the adapter derives.
        const { toAppwriteFileId } = await import("bitrate-js/adapters/appwrite");
        for (const name of produced.files) {
          const id = toAppwriteFileId(undefined, name);
          const url = `${settings.endpoint}/storage/buckets/${settings.bucketId}/files/${id}/view?project=${settings.projectId}`;
          results.push({ name, size: 0, url });
          if (name.endsWith(".m3u8")) setPlaylistUrl(url);
        }
        setUploaded(results);
        say("playlist URIs rewritten to absolute view URLs — Appwrite serves files by id, so relative ones would 404", "ok");
        say("these are real, publicly addressable URLs if your bucket permits reads", "ok");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      say(message, "err");
      if (/missing scope|not authorized|guests/i.test(message)) {
        say(
          "The bucket is refusing this identity. In the Appwrite console, give the bucket Create permission to Any or Users, or sign in first.",
          "info",
        );
      }
      if (/not accessible in this region/i.test(message)) {
        say(
          "Appwrite Cloud projects live in one region and are only reachable through that region's endpoint. Press Detect above, or copy the API Endpoint from your Appwrite console under Settings.",
          "info",
        );
      } else if (/Project with the requested ID could not be found/i.test(message)) {
        say("Check the project ID, and that the endpoint matches the project's region.", "info");
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <section className="card">
        <h2>Upload to your own Appwrite</h2>
        <p className="lede">
          Package a video and push the result to a real Appwrite bucket. All three values below
          are <strong>public identifiers</strong> that ship in every Appwrite client bundle — they
          are kept in this browser only and never leave it except to your own endpoint.
        </p>

        <p className="note err">
          <strong>Do not paste an Appwrite API key anywhere.</strong> An API key is a server-side
          secret with project-wide scope. This panel has nowhere to put one, and the adapter is
          built to refuse credentials — a browser has no safe place to keep them.
        </p>

        <div style={{ display: "grid", gap: "0.7rem", marginTop: "1rem", maxWidth: 560 }}>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            Endpoint
            <input
              className="mono"
              style={inputStyle}
              value={settings.endpoint}
              placeholder="https://fra.cloud.appwrite.io/v1"
              onChange={(e) => update({ endpoint: e.target.value.trim() })}
            />
          </label>

          <div className="row">
            <span style={{ color: "var(--dim)", fontSize: "0.8rem" }}>region</span>
            {KNOWN_ENDPOINTS.map((option) => (
              <button
                key={option.url}
                className={`small ${settings.endpoint === option.url ? "" : "ghost"}`}
                onClick={() => update({ endpoint: option.url })}
                title={option.url}
              >
                {option.label}
              </button>
            ))}
            <button
              className="small ghost"
              disabled={!settings.projectId || detecting}
              onClick={() => void detectRegion()}
              title="Try each endpoint and keep the one that hosts this project"
            >
              {detecting ? "Detecting…" : "Detect"}
            </button>
          </div>

          {probes.length > 0 && (
            <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
              {probes.map((p) => (
                <div key={p.url} className="mono">
                  {p.result === "found" ? "✓" : "·"} {p.label} —{" "}
                  {p.result === "found"
                    ? "hosts this project"
                    : p.result === "wrong-region"
                      ? "different region"
                      : p.result === "no-project"
                        ? "no such project here"
                        : "unreachable"}
                </div>
              ))}
            </div>
          )}
          <label style={{ display: "grid", gap: "0.25rem" }}>
            Project ID
            <input
              className="mono"
              style={inputStyle}
              value={settings.projectId}
              placeholder="65f1a2b3c4d5e6f7a8b9"
              onChange={(e) => update({ projectId: e.target.value.trim() })}
            />
          </label>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            Bucket ID
            <input
              className="mono"
              style={inputStyle}
              value={settings.bucketId}
              placeholder="videos"
              onChange={(e) => update({ bucketId: e.target.value.trim() })}
            />
          </label>
        </div>

        <div className="row" style={{ marginTop: "0.9rem" }}>
          <label className="chip" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={anonymous}
              onChange={(e) => setAnonymous(e.target.checked)}
            />
            create an anonymous session
          </label>
          <span style={{ color: "var(--dim)", fontSize: "0.8rem" }}>
            needed unless the bucket allows guests
          </span>

          <label className="chip" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={publicRead}
              onChange={(e) => setPublicRead(e.target.checked)}
            />
            public read permission
          </label>
          <span style={{ color: "var(--dim)", fontSize: "0.8rem" }}>
            required if the bucket has File Security on, and for playback
          </span>
        </div>
      </section>

      <section className="card">
        <h2>Choose a video and upload</h2>
        {!file ? (
          <Dropzone onFiles={(f) => setFile(f[0]!)} />
        ) : (
          <div className="row">
            <span className="chip mono">{file.name}</span>
            <span className="chip">{formatBytes(file.size)}</span>
            <div className="spacer" />
            <button className="ghost" onClick={() => setFile(null)} disabled={running}>
              Change
            </button>
            <button onClick={() => void run()} disabled={!ready || running}>
              {running ? "Uploading…" : "Package and upload"}
            </button>
          </div>
        )}

        {!ready && file && (
          <p className="note warn" style={{ marginTop: "0.9rem" }}>
            Fill in the endpoint, project ID and bucket ID above.
          </p>
        )}

        {log.length > 0 && (
          <div style={{ marginTop: "1rem" }}>
            {log.map((entry, i) => (
              <p
                key={i}
                className={`note ${entry.kind === "ok" ? "ok" : entry.kind === "err" ? "err" : ""}`}
                style={{ marginBottom: "0.4rem" }}
              >
                {entry.text}
              </p>
            ))}
          </div>
        )}
      </section>

      {uploaded.length > 0 && (
        <section className="card">
          <h2>In your bucket</h2>
          <p className="lede">
            Open any of these to confirm they really landed. The playlist is the one URL you would
            hand to a player.
          </p>
          {playlistUrl && (
            <p className="note ok">
              Playlist:{" "}
              <a href={playlistUrl} target="_blank" rel="noreferrer" className="mono">
                {playlistUrl.slice(0, 90)}…
              </a>
            </p>
          )}
          <table style={{ marginTop: "0.8rem" }}>
            <thead>
              <tr>
                <th>File</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {uploaded.map((item) => (
                <tr key={item.name}>
                  <td className="mono">{item.name}</td>
                  <td>
                    <a href={item.url} target="_blank" rel="noreferrer">
                      view
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2>What this proves</h2>
        <p className="lede">The adapter never sees a credential:</p>
        <pre>{`import { Client, Storage } from "appwrite";
import { appwriteAdapter } from "bitrate-js/adapters/appwrite";

// Your app authenticates the client — the adapter only borrows it.
const client = new Client().setEndpoint(endpoint).setProject(projectId);
const storage = new Storage(client);

const queue = new HlsQueue({
  upload: appwriteAdapter({ storage, bucketId: "videos" }),
});`}</pre>
        <p className="note" style={{ marginTop: "0.8rem" }}>
          Appwrite file ids allow at most 36 characters of <code>[a-zA-Z0-9._-]</code>, so segment
          names are mapped deterministically — the same file always gets the same id, which keeps
          retries idempotent rather than creating duplicates.
        </p>
      </section>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border-bright)",
  borderRadius: 8,
  padding: "0.45rem 0.6rem",
  fontSize: "0.85rem",
  width: "100%",
};
