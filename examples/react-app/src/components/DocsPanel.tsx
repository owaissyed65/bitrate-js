/**
 * The handbook, inside the showcase.
 *
 * Documentation sitting in a separate file nobody opens is documentation that
 * does not exist. It lives here, beside the panels that demonstrate each thing
 * it describes, so a reader can move between the explanation and the working
 * demo without leaving the page.
 *
 * Provider configuration is deliberately NOT repeated here — the Adapters tab
 * is the one place for that, and two copies would drift.
 */

import { useState } from "react";

interface Chapter {
  id: string;
  label: string;
  /** Who this chapter is written for, shown as a hint in the rail. */
  audience: "everyone" | "developers" | "agents";
  body: JSX.Element;
}

/** Condensed spec for pasting into an assistant's context. */
const AGENT_BRIEF = `PACKAGE bitrate-js — client-side HLS packager (browser only, no server)
INSTALL npm install bitrate-js   # WASM inlined; no bundler config; consumers need no Rust

CORE IDEA
  Cuts an MP4 (H.264) into fMP4 HLS segments in the browser and uploads them as
  produced. Async generators, so memory is flat regardless of file size.

TWO MODES
  remux     — repackage, no re-encode. Seconds for 1 GB. One quality. WASM only.
  transcode — re-encode into a ladder. Minutes. Needs WebCodecs + HW encoder.
  Audio is kept in both. Prefer remux unless multiple qualities are required.

ENTRY POINTS
  remux(file, opts)            -> AsyncGenerator<OutputFile>
  transcode(file, opts)        -> AsyncGenerator<OutputFile>
  packageFrames(frames, opts)  -> AsyncGenerator<OutputFile>   # canvas/screen capture
  inspect(file)                -> Promise<SourceInfo>
  new HlsQueue(opts)           # batch + retries + resume + skip-on-failure
  isSupported() / isTranscodeSupported()

OFF THE MAIN THREAD
  transcodeInWorker(file, opts) -> AsyncGenerator<OutputFile>   # same shape
  createTranscodeWorker()       # reuse one worker across many files
  Pulls, not pushes: holds after each file until the page asks, so memory
  stays flat. A worker also escapes background-tab throttling.

STILLS  (needs WebCodecs)
  posterFrame(file, { atFraction: 0.1, maxWidth: 640 })  -> { blob, width, height, atSeconds }
  thumbnailSprite(file, { count: 20, maxWidth: 160 })    -> + { columns, rows, tileWidth, times }
  WebP by default. Defaults to 10% in, not 0:00, since videos open on black.

SUBTITLES  (compose; not a packager option — they come from elsewhere)
  srtToVtt(srt)                               -> WebVTT string
  subtitleFiles(tracks, { prefix, duration }) -> OutputFile[]  (.vtt + .m3u8 each)
  attachSubtitles(masterText, tracks)         -> master with EXT-X-MEDIA + SUBTITLES=
  track: { language, name, content, default?, autoselect?, forced? }
  Serve .vtt as text/vtt. Embedded CEA-608/708 is NOT extracted.

OutputFile { name, blob, contentType, isManifest }
UploadItem { jobId, name, blob, contentType, isManifest }
UploadAdapter = (item: UploadItem) => Promise<void>

OUTPUT
  <prefix>_master.m3u8   <- the ONLY url to hand a player
  <prefix>_720p.m3u8     <- one per rung
  <prefix>_720p_init.mp4 <- headers, fetched once
  <prefix>_720p_00000.m4s
  URIs are relative. Exception: id-addressed storage (Appwrite) needs
  rewritePlaylistUris(text, resolve) or segments 404.

LADDERS  (rungs above the source are dropped automatically)
  single 720 | mobile 720/480/360 | standard 1080/720/480
  wide 1080/720/480/360 | uhd 2160/1440/1080/720

TRANSCODE OPTS
  ladder, segmentDuration=6, prefix, audio=true, audioBitrate=128000,
  profile="main"|"high"|"baseline", hardwareAcceleration, latencyMode,
  allowUpscale=false, signal, onProgress, onPhase, resume, onSegment

QUEUE OPTS
  mode, ladder, segmentDuration, concurrency=1, retries=2, upload, store,
  onProgress, onJobDone, onJobError
  queue.add(files) / addResume({stored,file}) / drain() / cancel()
  drain() NEVER rejects — inspect report.succeeded and report.failed.

PROGRESS  onProgress({ jobId, stage, percent, stagePercent, detail })
  stage: reading | packaging | audio | encoding | finishing | uploading
  percent is video encoding only; uploads report a count, not a percentage.

RESUME  store: await JobStore.open()  — IndexedDB, checkpointed after each
  segment is uploaded. Works in BOTH modes. Resume must use the same mode and
  ladder or addResume throws. The re-picked file is verified first.

ADAPTERS  bitrate-js/adapters/{presigned,s3,supabase,appwrite,firebase}
  s3        -> S3, R2, B2, MinIO, Spaces
  presigned -> Azure (needs header x-ms-blob-type: BlockBlob), GCS, anything signed
  Each sets cache headers and classifies permanent vs retryable failures.

SECURITY — HARD RULE
  NEVER pass a cloud credential to browser code. No adapter accepts one.
  Use a short-lived signed URL from your backend, or a client your app already
  authenticated as the signed-in user. accessKeyId / secretAccessKey /
  service_role / apiKey must never appear client-side.

CACHE HEADERS
  .m4s, init.mp4 -> public, max-age=31536000, immutable
  .m3u8          -> public, max-age=60   (rewritten as the job progresses)

CSP  requires script-src 'wasm-unsafe-eval'
INPUT  H.264 in MP4. Progressive and fragmented (moof) sources both supported.
PLAYBACK  Safari natively; elsewhere hls.js. No player is bundled.`;

/** One row of the API reference. */
function Api({ sig, children }: { sig: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 19em) minmax(0, 1fr)",
        gap: "0.2rem 1.2rem",
        padding: "0.5rem 0",
        borderTop: "1px solid var(--border)",
        alignItems: "baseline",
      }}
    >
      <code className="mono" style={{ color: "var(--text)", wordBreak: "break-word" }}>
        {sig}
      </code>
      <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>{children}</span>
    </div>
  );
}

function ApiGroup({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: "1.1rem 0 0.2rem",
        color: "var(--dim)",
        fontSize: "0.72rem",
        letterSpacing: "0.09em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </p>
  );
}

/** A collapsible symptom → cause → fix entry. */
function Fix({ symptom, children }: { symptom: string; children: React.ReactNode }) {
  return (
    <details style={{ borderTop: "1px solid var(--border)", padding: "0.5rem 0" }}>
      <summary className="mono" style={{ cursor: "pointer", fontSize: "0.85rem" }}>
        {symptom}
      </summary>
      <div
        style={{
          padding: "0.6rem 0 0.3rem 1rem",
          display: "grid",
          gap: "0.6rem",
          color: "var(--muted)",
          fontSize: "0.87rem",
          maxWidth: "72ch",
        }}
      >
        {children}
      </div>
    </details>
  );
}

const CHAPTERS: Chapter[] = [
  // ---------------------------------------------------------------- overview
  {
    id: "what",
    label: "What it is",
    audience: "everyone",
    body: (
      <>
        <h2>What problem this solves</h2>
        <p className="lede">
          Written for anyone — no video background assumed. The rest of the chapters get more
          technical.
        </p>

        <p style={{ maxWidth: "68ch", marginBottom: "0.9rem" }}>
          When a browser plays an ordinary MP4, it has to fetch a lot of the file before
          anything happens, and jumping to the middle means fetching more. On a slow
          connection, a big video is a spinner.
        </p>
        <p style={{ maxWidth: "68ch", marginBottom: "0.9rem" }}>
          <strong>Streaming formats fix this by cutting the video into small pieces</strong> —
          typically six seconds each — plus a text file listing them in order. The player fetches
          the list, then pulls only the pieces it needs. Skipping to minute nine fetches the
          piece at minute nine and nothing else.
        </p>
        <p style={{ maxWidth: "68ch", marginBottom: "0.9rem" }}>
          That format is <strong>HLS</strong>, and it is what almost every video site serves.
          Normally you make it on a server with <code className="mono">ffmpeg</code>: the user
          uploads the whole file, waits, and your server does the work.
        </p>
        <p style={{ maxWidth: "68ch", marginBottom: "1rem" }}>
          <strong>bitrate does it in the browser instead.</strong> The cutting happens on the
          user&rsquo;s machine while they wait, and the pieces upload as they are made. No
          transcoding server, no queue, no per-minute encoding bill.
        </p>

        <div className="chips" style={{ marginBottom: "1rem" }}>
          <span className="chip">Rust → WebAssembly</span>
          <span className="chip">WebCodecs</span>
          <span className="chip">~260 kB packed</span>
          <span className="chip">Zero runtime dependencies</span>
          <span className="chip">MIT</span>
        </div>

        <p className="note">
          <strong>Who this is for.</strong> Anyone letting users upload video: a course platform,
          an internal tool, a social app, a CMS. If you are already paying for a transcoding
          service, this replaces it for the common case.
        </p>
      </>
    ),
  },

  // ------------------------------------------------------------------- modes
  {
    id: "modes",
    label: "Remux vs transcode",
    audience: "everyone",
    body: (
      <>
        <h2>The one decision worth making deliberately</h2>
        <p className="lede">
          Everything else has a sensible default. This one is the difference between seconds and
          minutes.
        </p>

        <div className="grid-2" style={{ marginBottom: "1rem" }}>
          <div style={{ border: "1px solid var(--border)", borderRadius: "10px", padding: "0.9rem 1rem" }}>
            <h3 className="mono" style={{ margin: "0 0 0.2rem", fontSize: "0.95rem" }}>
              remux
            </h3>
            <p style={{ color: "var(--dim)", fontSize: "0.8rem", margin: "0 0 0.6rem" }}>
              Repackage. Do not re-encode.
            </p>
            <p style={{ fontSize: "0.88rem", margin: "0 0 0.7rem" }}>
              The video is already compressed. Remuxing keeps those exact compressed frames and
              just puts them into new, smaller containers with a playlist alongside.
            </p>
            <table>
              <tbody>
                <tr>
                  <td style={{ color: "var(--dim)" }}>Speed</td>
                  <td>Near-instant — 1 GB in seconds</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--dim)" }}>Quality</td>
                  <td>Identical to the source</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--dim)" }}>Needs</td>
                  <td>WebAssembly only</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--dim)" }}>Gives</td>
                  <td>One quality</td>
                </tr>
              </tbody>
            </table>
            <p className="note" style={{ marginTop: "0.7rem" }}>
              <strong>Pick this unless you specifically need multiple qualities.</strong> It is the
              right answer more often than people expect.
            </p>
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: "10px", padding: "0.9rem 1rem" }}>
            <h3 className="mono" style={{ margin: "0 0 0.2rem", fontSize: "0.95rem" }}>
              transcode
            </h3>
            <p style={{ color: "var(--dim)", fontSize: "0.8rem", margin: "0 0 0.6rem" }}>
              Decode every frame. Encode it again, once per quality.
            </p>
            <p style={{ fontSize: "0.88rem", margin: "0 0 0.7rem" }}>
              Produces several versions at different sizes so the player can switch as the network
              changes — sharp on wifi, watchable on a train.
            </p>
            <table>
              <tbody>
                <tr>
                  <td style={{ color: "var(--dim)" }}>Speed</td>
                  <td>Minutes. Real work per frame</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--dim)" }}>Quality</td>
                  <td>Re-compressed, so slightly lossy</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--dim)" }}>Needs</td>
                  <td>WebCodecs + hardware encoder</td>
                </tr>
                <tr>
                  <td style={{ color: "var(--dim)" }}>Gives</td>
                  <td>A full adaptive ladder</td>
                </tr>
              </tbody>
            </table>
            <p className="note warn" style={{ marginTop: "0.7rem" }}>
              A ten-minute 1080p video takes minutes and the tab must stay open. That is what
              re-encoding costs, not a defect.
            </p>
          </div>
        </div>

        <p className="note">
          Audio is re-encoded to AAC and kept in <strong>both</strong> modes. Resume works in both
          too.
        </p>
      </>
    ),
  },

  // ------------------------------------------------------------------ output
  {
    id: "output",
    label: "What comes out",
    audience: "everyone",
    body: (
      <>
        <h2>What you get back</h2>
        <p className="lede">
          A pile of files. Exactly one of them is the one you hand to a player.
        </p>

        <pre style={{ marginBottom: "1rem" }}>{`video_master.m3u8          ← give a player THIS URL
├── video_1080p.m3u8       ← the list of pieces for one quality
│   ├── video_1080p_init.mp4    ← headers; loaded once
│   ├── video_1080p_00000.m4s   ← ~6 seconds of video
│   ├── video_1080p_00001.m4s
│   └── …
├── video_720p.m3u8   →  init + segments
└── video_480p.m3u8   →  init + segments`}</pre>

        <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>The vocabulary, once</h3>
        <table>
          <thead>
            <tr>
              <th>Term</th>
              <th>Means</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">.m3u8</td>
              <td>A plain-text playlist. Just a list of file names with durations.</td>
            </tr>
            <tr>
              <td className="mono">.m4s</td>
              <td>One segment — a few seconds of video. The pieces the player fetches.</td>
            </tr>
            <tr>
              <td className="mono">init.mp4</td>
              <td>The header describing the stream. Fetched once, before any segment.</td>
            </tr>
            <tr>
              <td>master playlist</td>
              <td>The top-level file listing each quality. The only URL you need to keep.</td>
            </tr>
            <tr>
              <td>rung</td>
              <td>One quality in the ladder, e.g. 720p at 2.8 Mbps.</td>
            </tr>
            <tr>
              <td>keyframe</td>
              <td>
                A frame that stands alone. Every segment starts on one — that is what makes seeking
                work.
              </td>
            </tr>
          </tbody>
        </table>

        <p className="note" style={{ marginTop: "0.9rem" }}>
          Segment references are <strong>relative</strong>, so the same output plays from any
          storage base URL without rewriting. The exception is storage that addresses files by id
          rather than path — see the Adapters tab.
        </p>
      </>
    ),
  },

  // ------------------------------------------------------------------- start
  {
    id: "start",
    label: "Quick start",
    audience: "developers",
    body: (
      <>
        <h2>Quick start</h2>
        <p className="lede">
          The WebAssembly is inlined into the bundle, so there is no <code className="mono">.wasm</code>{" "}
          asset to copy and no bundler configuration. Nobody installing this needs Rust.
        </p>

        <pre style={{ marginBottom: "1.1rem" }}>npm install bitrate-js</pre>

        <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem" }}>Check the browser first</h3>
        <p style={{ fontSize: "0.88rem", color: "var(--muted)", margin: "0 0 0.5rem" }}>
          Before you start work, not halfway through it. The Capabilities tab runs this live.
        </p>
        <pre style={{ marginBottom: "1.1rem" }}>{`import { isSupported } from "bitrate-js";

const { remux, transcode, resume, reasons } = isSupported();
// remux:     true almost everywhere
// transcode: needs WebCodecs
// reasons:   human-readable strings explaining any false`}</pre>

        <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem" }}>Package one file</h3>
        <p style={{ fontSize: "0.88rem", color: "var(--muted)", margin: "0 0 0.5rem" }}>
          An async generator hands you one finished file at a time. Upload each and it is released
          — which is why a 1 GB source does not grow memory.
        </p>
        <pre style={{ marginBottom: "1.1rem" }}>{`import { remux } from "bitrate-js";

for await (const out of remux(file, { prefix: "lesson1", segmentDuration: 6 })) {
  // out.name        "lesson1_00003.m4s"
  // out.blob        the bytes
  // out.contentType set this on upload or playback fails
  // out.isManifest  true for .m3u8 — use a short cache lifetime
  await upload(out.name, out.blob, out.contentType);
}`}</pre>

        <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem" }}>Play the result</h3>
        <p style={{ fontSize: "0.88rem", color: "var(--muted)", margin: "0 0 0.5rem" }}>
          Safari plays HLS natively. Everywhere else use <code className="mono">hls.js</code> — no
          player is bundled. The Play a URL tab does exactly this.
        </p>
        <pre>{`import Hls from "hls.js";

if (video.canPlayType("application/vnd.apple.mpegurl")) {
  video.src = masterUrl;              // Safari
} else if (Hls.isSupported()) {
  const hls = new Hls();
  hls.loadSource(masterUrl);
  hls.attachMedia(video);
}`}</pre>
      </>
    ),
  },

  // ------------------------------------------------------------------- queue
  {
    id: "queue",
    label: "The queue",
    audience: "developers",
    body: (
      <>
        <h2>The queue</h2>
        <p className="lede">
          Real uploads are several files at once, and one of them is always broken. The Queue tab
          demonstrates this with a deliberately corrupt file in the batch.
        </p>

        <pre style={{ marginBottom: "1rem" }}>{`import { HlsQueue, JobStore } from "bitrate-js";
import { presignedAdapter } from "bitrate-js/adapters/presigned";

const queue = new HlsQueue({
  mode: "remux",
  segmentDuration: 6,
  concurrency: 1,          // files at once. Raise with care.
  retries: 2,              // extra attempts per file
  store: await JobStore.open(),   // enables resume after a reload

  upload: presignedAdapter({
    getUrl: (item) => fetch("/api/sign?f=" + item.name).then((r) => r.text()),
  }),

  onProgress: ({ stage, percent, detail }) => {},
  onJobDone:  ({ jobId, masterPlaylist, files }) => {},
  onJobError: ({ jobId, error }) => {},   // the queue keeps going
});

queue.add([file1, file2, file3]);

const report = await queue.drain();
// report.succeeded[] / report.failed[]  —  drain() never rejects`}</pre>

        <p className="note">
          <strong>drain() never rejects.</strong> A failed file lands in{" "}
          <code className="mono">report.failed</code> with its error. One corrupt video out of
          twenty should not throw away the nineteen that worked.
        </p>
      </>
    ),
  },

  // ----------------------------------------------------------------- ladders
  {
    id: "ladders",
    label: "Ladders",
    audience: "developers",
    body: (
      <>
        <h2>Ladders</h2>
        <p className="lede">
          A ladder is the set of qualities you produce. More rungs means better adaptation and
          proportionally more encoding time. Rungs taller than the source are dropped, so any
          preset can be handed any file without checking it first.
        </p>

        <table style={{ marginBottom: "1rem" }}>
          <thead>
            <tr>
              <th>Preset</th>
              <th>Rungs</th>
              <th>Use for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">LADDERS.single</td>
              <td className="mono">720</td>
              <td>One quality. Cheapest; no adaptation.</td>
            </tr>
            <tr>
              <td className="mono">LADDERS.mobile</td>
              <td className="mono">720 · 480 · 360</td>
              <td>Phone-first audiences, poor networks.</td>
            </tr>
            <tr>
              <td className="mono">LADDERS.standard</td>
              <td className="mono">1080 · 720 · 480</td>
              <td>The usual default.</td>
            </tr>
            <tr>
              <td className="mono">LADDERS.wide</td>
              <td className="mono">1080 · 720 · 480 · 360</td>
              <td>Adds a rung for genuinely bad connections.</td>
            </tr>
            <tr>
              <td className="mono">LADDERS.uhd</td>
              <td className="mono">2160 · 1440 · 1080 · 720</td>
              <td>4K sources. Expect real time.</td>
            </tr>
          </tbody>
        </table>

        <p style={{ fontSize: "0.88rem", margin: "0 0 0.4rem" }}>
          Or write your own — a rung is a height and a bitrate, nothing more:
        </p>
        <pre style={{ marginBottom: "1.1rem" }}>{`ladder: [
  { height: 1080, bitrate: 6_000_000 },  // higher than the preset
  { height: 540,  bitrate: 1_000_000 },  // a size no preset offers
]`}</pre>

        <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem" }}>Every transcode option</h3>
        <pre style={{ marginBottom: "1rem" }}>{`transcode(file, {
  ladder: LADDERS.standard,     // which qualities to produce
  segmentDuration: 6,           // seconds; also the keyframe interval
  prefix: "video",              // names files <prefix>_720p_00000.m4s

  audio: true,                  // re-encode and keep the sound (default)
  audioBitrate: 128_000,        // AAC bitrate

  profile: "main",              // "main" | "high" | "baseline"
  hardwareAcceleration: "prefer-hardware",
  latencyMode: "quality",       // "quality" | "realtime"
  allowUpscale: false,          // keep rungs taller than the source

  signal: controller.signal,    // cancel
  onProgress: ({ fraction }) => {},
  onPhase:    ({ stage, detail }) => {},
});`}</pre>

        <table>
          <thead>
            <tr>
              <th>Option</th>
              <th>What it actually changes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">profile</td>
              <td>
                <code className="mono">high</code> compresses better at the same bitrate and is safe
                on anything modern. <code className="mono">baseline</code> is the most compatible
                and least efficient. Each falls back if the browser refuses it, so a preference
                never causes a failure.
              </td>
            </tr>
            <tr>
              <td className="mono">hardwareAcceleration</td>
              <td>
                <code className="mono">prefer-hardware</code> is dramatically faster where it
                exists. Software encoding a long video in a tab is rarely practical.
              </td>
            </tr>
            <tr>
              <td className="mono">latencyMode</td>
              <td>
                <code className="mono">realtime</code> encodes faster and looks worse at the same
                bitrate. Worth it when someone is waiting on the result.
              </td>
            </tr>
            <tr>
              <td className="mono">segmentDuration</td>
              <td>
                Also the keyframe interval, since every segment must start on one. Shorter adapts
                faster and seeks more precisely; longer compresses better and makes fewer files.
              </td>
            </tr>
            <tr>
              <td className="mono">allowUpscale</td>
              <td>Off by default. Upscaling costs time and storage and adds no detail.</td>
            </tr>
          </tbody>
        </table>
      </>
    ),
  },

  // ------------------------------------------------------------------ resume
  {
    id: "resume",
    label: "Resume & progress",
    audience: "developers",
    body: (
      <>
        <h2>Surviving a closed tab</h2>
        <p className="lede">
          Give the queue a <code className="mono">JobStore</code> and progress is checkpointed to
          IndexedDB after every segment is <em>safely uploaded</em>. The Resume tab interrupts a
          real job and continues it.
        </p>

        <pre style={{ marginBottom: "1rem" }}>{`const store = await JobStore.open();
const [interrupted] = await store.resumableJobs();

if (interrupted) {
  // Ask the user to re-pick the same file. It is verified against the
  // stored name, size and date — resuming onto a different video would
  // splice two files together.
  queue.addResume({ stored: interrupted, file: rePickedFile });
  await queue.drain();
}`}</pre>

        <p style={{ maxWidth: "70ch", fontSize: "0.9rem", marginBottom: "0.8rem" }}>
          Works for <strong>both modes</strong>. A resumed re-encode is exact rather than
          approximate: every segment starts on a keyframe and decodes on its own, so picking up at
          a segment boundary produces the stream an uninterrupted run would have. There is no seam.
        </p>

        <p className="note warn" style={{ marginBottom: "1.4rem" }}>
          <strong>Same mode, same ladder.</strong> <code className="mono">addResume</code> refuses a
          mismatch by name rather than appending renditions that do not match the segments already
          uploaded.
        </p>

        <h2>Telling the user what is happening</h2>
        <p className="lede">
          A transcode does real work long before the first frame is encoded. Reporting a bare
          percentage means showing 0% for minutes, which is indistinguishable from being stuck.
        </p>

        <table style={{ marginBottom: "1rem" }}>
          <thead>
            <tr>
              <th>stage</th>
              <th>What is happening</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">reading</td>
              <td>
                Parsing the container. For a fragmented source — most screen recordings — this
                reads the whole file.
              </td>
            </tr>
            <tr>
              <td className="mono">packaging</td>
              <td>Remux is chunking.</td>
            </tr>
            <tr>
              <td className="mono">audio</td>
              <td>The whole audio track is re-encoded up front, before any video.</td>
            </tr>
            <tr>
              <td className="mono">encoding</td>
              <td>
                The video work. <code className="mono">percent</code> is meaningful here.
              </td>
            </tr>
            <tr>
              <td className="mono">finishing</td>
              <td>Draining the decoder, flushing encoders, writing playlists.</td>
            </tr>
            <tr>
              <td className="mono">uploading</td>
              <td>
                One file going out. <code className="mono">detail</code> names it.
              </td>
            </tr>
          </tbody>
        </table>

        <pre style={{ marginBottom: "1rem" }}>{`onProgress: ({ stage, percent, stagePercent, detail }) => {
  setLabel(LABELS[stage]);          // "Re-encoding audio"
  setBar(stage === "encoding" ? percent : stagePercent ?? 0);
  setDetail(detail);                // "lesson1_00007.m4s (file 12)"
}`}</pre>

        <p className="note">
          <strong>Uploads carry no percentage, on purpose.</strong> The total file count is not
          known until the packager finishes. Inventing a denominator is how you get the bar that
          sits at 99% forever, so uploads report a running count instead.
        </p>
      </>
    ),
  },

  // --------------------------------------------------------------------- api
  {
    id: "api",
    label: "API reference",
    audience: "developers",
    body: (
      <>
        <h2>API reference</h2>
        <p className="lede">
          Everything exported from <code className="mono">bitrate-js</code>. Adapters live on
          subpaths so an SDK you do not use never enters your bundle.
        </p>

        <ApiGroup>Packaging</ApiGroup>
        <Api sig="remux(file, options?)">
          Async generator of <code className="mono">OutputFile</code>. Chunks without re-encoding.
        </Api>
        <Api sig="transcode(file, options?)">
          Async generator. Re-encodes into a ladder. Needs WebCodecs.
        </Api>
        <Api sig="packageFrames(frames, options?)">
          Package <code className="mono">VideoFrame</code>s from a canvas, screen capture or any
          producer — no source file.
        </Api>
        <Api sig="inspect(file)">
          Resolves to <code className="mono">SourceInfo</code>: width, height, duration, timescale,
          codec.
        </Api>

        <Api sig="transcodeInWorker(file, options?)">
          The same generator, on a worker thread. The tab stays usable and a backgrounded tab
          is not throttled.
        </Api>
        <Api sig="createTranscodeWorker()">
          Spawn one worker to reuse across many files, instead of paying startup each time.
        </Api>
        <Api sig="posterFrame(file, options?)">
          One still, as an image blob. Defaults to a tenth of the way in.
        </Api>
        <Api sig="thumbnailSprite(file, options?)">
          A grid of stills — what a player shows when you drag the scrub bar.
        </Api>

        <ApiGroup>Subtitles</ApiGroup>
        <Api sig="srtToVtt(srt)">
          SubRip to WebVTT. They differ by a comma before the milliseconds, and a player given
          the wrong one shows nothing and says nothing.
        </Api>
        <Api sig="subtitleFiles(tracks, options)">
          The <code className="mono">.vtt</code> and its playlist, per track.
        </Api>
        <Api sig="attachSubtitles(master, tracks)">
          Declare the tracks and tag every variant. Miss the second and the menu is empty.
        </Api>

        <ApiGroup>Queue</ApiGroup>
        <Api sig="new HlsQueue(options)">
          Batch packaging and upload with retries and skip-on-failure.
        </Api>
        <Api sig="queue.add(files)">
          Queue one file or many. Returns job ids. Callable while running.
        </Api>
        <Api sig="queue.addResume({ stored, file })">
          Continue an interrupted job. Verifies the file; refuses a changed mode or ladder.
        </Api>
        <Api sig="queue.drain()">
          Resolves to <code className="mono">QueueReport</code>. Never rejects.
        </Api>
        <Api sig="queue.cancel()">Abort everything in flight.</Api>
        <Api sig="queue.jobs">Snapshot of every job, for rendering.</Api>

        <ApiGroup>Ladders and codecs</ApiGroup>
        <Api sig="LADDERS">
          <code className="mono">single</code>, <code className="mono">mobile</code>,{" "}
          <code className="mono">standard</code>, <code className="mono">wide</code>,{" "}
          <code className="mono">uhd</code>.
        </Api>
        <Api sig="planLadder(ladder, w, h, allowUpscale?)">
          Resolve a ladder against a real source. Drops rungs that would upscale.
        </Api>
        <Api sig="isTranscodeSupported()">Whether WebCodecs is present.</Api>
        <Api sig="codecStringFromAvcC(avcc)">
          RFC 6381 codec string read from a source, e.g. <code className="mono">avc1.4d0028</code>.
        </Api>
        <Api sig="levelForFrame(w, h, fps)">
          The H.264 level a frame size actually requires.
        </Api>

        <ApiGroup>Storage and resume</ApiGroup>
        <Api sig="JobStore.open(name?)">
          Open the IndexedDB store that makes resume possible.
        </Api>
        <Api sig="store.resumableJobs()">Interrupted jobs waiting to continue.</Api>
        <Api sig="checkQuota()">
          <code className="mono">QuotaReport</code>: quota, usage, free space.
        </Api>
        <Api sig="assertRoomFor(bytes)">
          Fail before a long job rather than at 80% of it.
        </Api>
        <Api sig="requestPersistence()">Ask the browser not to evict the store.</Api>
        <Api sig="isStorageAvailable()">Whether IndexedDB can be used at all.</Api>
        <Api sig="matchesJob(stored, file)">
          Whether a re-picked file is the one a job started with.
        </Api>

        <ApiGroup>Playlists and output</ApiGroup>
        <Api sig="rewritePlaylistUris(text, resolve)">
          Point relative references at absolute URLs. For id-addressed storage.
        </Api>
        <Api sig="playlistReferences(text)">Every file a playlist refers to.</Api>
        <Api sig="createZip(entries) / downloadZip(…)">
          Store-only ZIP writer, no dependency. A rendition is many files; this saves them as one.
        </Api>

        <ApiGroup>Capability and safety</ApiGroup>
        <Api sig="isSupported()">
          <code className="mono">SupportReport</code> with <code className="mono">reasons[]</code>{" "}
          explaining every false.
        </Api>
        <Api sig="withRetry(fn, options?)">
          Retry with backoff, honouring <code className="mono">PermanentUploadError</code>.
        </Api>
        <Api sig="PermanentUploadError">
          Throw from an adapter when retrying cannot help — a permissions denial, say.
        </Api>
        <Api sig="assertSafeKey(name) / joinKey(prefix, name)">
          Path-traversal defence for object keys.
        </Api>
        <Api sig="MIME_MANIFEST / MIME_SEGMENT">
          The content types playback requires.
        </Api>

        <ApiGroup>Subpath imports</ApiGroup>
        <Api sig="bitrate-js/adapters/{presigned,s3,supabase,appwrite,firebase}">
          One per protocol. Full configuration for all eleven providers is on the Adapters tab.
        </Api>
        <Api sig="bitrate-js/zip">The ZIP writer on its own.</Api>
        <Api sig="bitrate-js/global">
          Classic script build defining <code className="mono">window.bitrate</code>, for pages with
          no build step.
        </Api>
      </>
    ),
  },

  // ---------------------------------------------------------------- trouble
  {
    id: "trouble",
    label: "When it breaks",
    audience: "developers",
    body: (
      <>
        <h2>When it breaks</h2>
        <p className="lede">
          Every one of these has been hit in practice. The cause is rarely what the message first
          suggests.
        </p>

        <Fix symptom={`Failed to resolve module specifier "bitrate-js"`}>
          <p>
            The page is served without a bundler, or opened straight from disk over{" "}
            <code className="mono">file://</code>. A browser cannot resolve a bare package name on
            its own.
          </p>
          <pre>{`<script type="importmap">
  { "imports": { "bitrate-js": "/node_modules/bitrate-js/dist/index.js" } }
</script>`}</pre>
          <p>
            For a page with no build step at all,{" "}
            <code className="mono">bitrate-js/global</code> defines{" "}
            <code className="mono">window.bitrate</code> and needs neither.
          </p>
        </Fix>

        <Fix symptom="A transcode looks stuck — no progress, no uploads, no error">
          <p>
            Usually it is working and saying nothing. Wire <code className="mono">onProgress</code>{" "}
            and read the <code className="mono">stage</code>:{" "}
            <code className="mono">reading</code> and <code className="mono">audio</code> both do
            real work before a single frame is encoded, and on a large screen recording that is
            minutes.
          </p>
          <p>
            <strong>Also check the tab is in front.</strong> A backgrounded tab throttles timers
            roughly a hundredfold, and browsers throttle WebCodecs too.
          </p>
          <p>
            If it truly is stuck, the console names the rung and resolution whose encoder failed.
            Dropping to <code className="mono">LADDERS.single</code> narrows a ladder to one
            encoder, the quickest way to confirm an encoder-count limit.
          </p>
        </Fix>

        <Fix symptom="The playlist plays, but every segment 404s">
          <p>
            Your storage addresses files by <strong>id</strong> rather than path — Appwrite does
            this. Relative references then resolve under the playlist&rsquo;s own URL and miss.
          </p>
          <p>
            Rewrite them with <code className="mono">rewritePlaylistUris</code> before uploading the
            playlist. The playlist is emitted last, so every segment already exists by then.
          </p>
        </Fix>

        <Fix symptom="Video plays but there is no sound, or it will not play at all">
          <p>
            Almost always a missing or wrong <code className="mono">Content-Type</code> on upload.
            Pass <code className="mono">item.contentType</code> straight through — players are
            strict about it.
          </p>
          <p>
            Check CORS as well: the range requests a player makes need{" "}
            <code className="mono">Access-Control-Expose-Headers</code> to include{" "}
            <code className="mono">Content-Range</code>.
          </p>
        </Fix>

        <Fix symptom="No permissions provided for action 'create' (Appwrite)">
          <p>
            The bucket has File Security enabled, so a create carrying no permissions is rejected.
            Pass them explicitly — and public read is what HLS needs anyway, since a player must
            fetch every segment.
          </p>
          <pre>{`appwriteAdapter({
  storage,
  bucketId,
  permissions: [Permission.read(Role.any())],
})`}</pre>
        </Fix>

        <Fix symptom="Project is not accessible in this region (Appwrite)">
          <p>
            Appwrite Cloud projects live in one region and are reachable only through that
            region&rsquo;s host — <code className="mono">sfo.</code>,{" "}
            <code className="mono">fra.</code>, <code className="mono">nyc.</code>,{" "}
            <code className="mono">syd.</code>. The bare{" "}
            <code className="mono">cloud.appwrite.io</code> is the older global host and does not
            serve regional projects. The Appwrite tab has a Detect button that finds the right one.
          </p>
        </Fix>

        <Fix symptom="The source reports 0.0 seconds and no samples">
          <p>
            A fragmented MP4 — its <code className="mono">moov</code> declares no samples because
            they live in <code className="mono">moof</code> boxes instead. Screen recordings and
            phone captures are commonly fragmented.
          </p>
          <p>
            This is supported: only the <code className="mono">moof</code> boxes are read, never the
            payloads, so indexing a multi-gigabyte file costs a few megabytes of reading.
          </p>
        </Fix>

        <Fix symptom="Content Security Policy blocks the module">
          <p>
            WebAssembly needs <code className="mono">script-src &apos;wasm-unsafe-eval&apos;</code>.
            The package uses no <code className="mono">eval</code>, injects no DOM, and makes no
            network requests of its own — the only traffic is the upload adapter you supply.
          </p>
        </Fix>
      </>
    ),
  },

  // ------------------------------------------------------------------ agents
  {
    id: "agents",
    label: "For AI agents",
    audience: "agents",
    body: <AgentChapter />,
  },
];

function AgentChapter() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(AGENT_BRIEF);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked; the text is selectable below either way.
      setCopied(false);
    }
  }

  return (
    <>
      <h2>For AI agents</h2>
      <p className="lede">
        A condensed, complete specification. Paste it into an assistant&rsquo;s context and it has
        what it needs to write correct code against this library — without guessing at option names
        or inventing an API.
      </p>

      <div className="row" style={{ marginBottom: "0.8rem" }}>
        <button onClick={() => void copy()}>{copied ? "Copied" : "Copy the brief"}</button>
        <span style={{ color: "var(--dim)", fontSize: "0.8rem" }}>
          {AGENT_BRIEF.split("\n").length} lines · plain text
        </span>
      </div>

      <pre style={{ maxHeight: "60vh", overflowY: "auto" }}>{AGENT_BRIEF}</pre>

      <p className="note" style={{ marginTop: "0.9rem" }}>
        The security rule is stated in the brief deliberately. An assistant that has not been told
        will cheerfully write <code className="mono">accessKeyId</code> into browser code, because
        that is what most server-side examples look like.
      </p>
    </>
  );
}

const AUDIENCE_LABEL: Record<Chapter["audience"], string> = {
  everyone: "plain english",
  developers: "developers",
  agents: "machine-readable",
};

export function DocsPanel() {
  const [current, setCurrent] = useState(CHAPTERS[0]!.id);
  const chapter = CHAPTERS.find((c) => c.id === current) ?? CHAPTERS[0]!;

  return (
    <>
      <section className="card">
        <h2>Handbook</h2>
        <p className="lede">
          The whole library, explained. The first three chapters assume no video background; the
          rest are reference. Every chapter points at the tab that demonstrates it.
        </p>

        <div className="row" style={{ gap: "0.4rem" }}>
          {CHAPTERS.map((c) => (
            <button
              key={c.id}
              className={`small ${current === c.id ? "" : "ghost"}`}
              onClick={() => setCurrent(c.id)}
              title={AUDIENCE_LABEL[c.audience]}
            >
              {c.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <p
          style={{
            margin: "0 0 0.6rem",
            color: "var(--dim)",
            fontSize: "0.72rem",
            letterSpacing: "0.09em",
            textTransform: "uppercase",
          }}
        >
          {AUDIENCE_LABEL[chapter.audience]}
        </p>
        {chapter.body}
      </section>
    </>
  );
}
