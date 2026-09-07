# bitrate — Client-Side HLS / Adaptive-Bitrate Packager

A Rust → WebAssembly library that turns a video **File** picked in the browser into
**HLS output (master + rendition playlists + fMP4 segments) at multiple bitrates** —
entirely client-side, no server. Published as an **npm package** so any JS/TS web app
can `import` it.

---

## 1. Goal & non-goals

**Goal:** developer drops in **one or many Files** → package **queues** them → for each:
`chunk → ABR ladder (e.g. 1080/720/480) → HLS output` in the browser tab → **hands each
finished segment to the developer's own upload function** (upload-to-anywhere). Consumable
as `npm i bitrate`.

**Non-goals (v1):**
- Not a server-side transcoder or an ffmpeg replacement for long/4K films.
- Not DRM / encryption (can come later as an add-on).
- Not a player — we produce output that `hls.js` or native Safari can play.

---

## 2. Architecture — the hybrid model

The heavy work splits in two. Rust does one half brilliantly, the browser does the other.

```
                        ┌──────────────── runs in a Web Worker ─────────────────┐
  File (mp4/mov/webm)   │                                                        │
        │               │   WebCodecs            WebCodecs           Rust/WASM   │
        ▼               │  ┌──────────┐  frames ┌──────────┐ chunks ┌──────────┐│
  [demux / container]───┼─▶│ Video    │────────▶│ Video    │───────▶│ fMP4     ││──▶ master.m3u8
  (Rust/WASM: mp4,      │  │ Decoder  │         │ Encoder  │        │ segmenter│    ├─ 1080p.m3u8 + *.m4s
   webm crate)          │  └──────────┘         │ ×N rungs │        │  + HLS   │    ├─ 720p.m3u8  + *.m4s
                        │                       └──────────┘        │ manifest ││    └─ 480p.m3u8  + *.m4s
                        │                        (per bitrate)      └──────────┘│
                        └────────────────────────────────────────────────────────┘
```

| Concern | Owner | Why |
|---|---|---|
| Decode source, re-encode at each bitrate | **WebCodecs** (`VideoDecoder`/`VideoEncoder`, browser-native) | Hardware-accelerated H.264/VP9/AV1. Pure-Rust encoders are too slow for a tab. |
| Demux input container, mux fMP4 segments, build `.m3u8` | **Rust/WASM** (`wasm-bindgen`) | Byte/format logic — Rust is fast, safe, and this is our real IP. |
| Orchestration, progress, backpressure | **JS glue** in a Web Worker | Keep the UI thread free; stream so we don't OOM. |

**Why not ffmpeg.wasm?** ~30 MB payload, C-not-Rust, slow, GPL baggage. A lean Rust muxer
+ native WebCodecs is smaller, faster, and the differentiator worth shipping.

---

## 3. Package surface (what developers get)

Two layers. Most developers use the **queue** (multi-file, upload-anywhere); the
**packager** underneath is available for one-off use.

### 3a. Queue — the main API (multiple files → upload anywhere)

```ts
import { HlsQueue } from "bitrate";

const q = new HlsQueue({
  ladder: [
    { height: 1080, bitrate: 5_000_000 },
    { height: 720,  bitrate: 2_800_000 },
    { height: 480,  bitrate: 1_200_000 },
  ],
  segmentDuration: 6,
  codec: "avc",
  container: "fmp4",

  concurrency: 1,              // how many files processed at once (1–2; tab has limits)
  retries: 0,                  // per-file retry attempts (0 = skip on first failure)

  // ── upload-to-anywhere ──
  // use a ready-made preset…
  upload: s3Adapter({ client: myS3Client, bucket: "videos", prefix: "hls/" }),
  // …or supabaseAdapter({...}) / appwriteAdapter({...})
  // …or write your own for ANY backend:
  //   upload: async ({ jobId, name, blob, contentType }) => {
  //     await fetch(`https://my-backend/${jobId}/${name}`,
  //       { method: "PUT", body: blob, headers: { "Content-Type": contentType } });
  //   },

  onProgress: ({ jobId, rung, percent }) => {},   // per-file progress
  onJobDone:  ({ jobId, urls }) => {},            // one file finished
  onJobError: ({ jobId, error }) => {},           // one file failed (queue keeps going)
});

q.add([file1, file2, file3]);          // drop in many files
q.add(file4);                          // add more any time
const report = await q.drain();        // resolves when all done
// report → { succeeded: [...], failed: [{ jobId, error }] }   ← skip-&-continue result
```

**Failure policy:** skip & continue — a bad file or failed upload is recorded in
`report.failed` and the queue keeps processing the rest. `retries` lets uploads (network
blips) retry before being marked failed.

### The upload format (identical for every provider)

Each HLS file — manifests (`.m3u8`, text) and segments (`.mp4`/`.m4s`, binary) — is
handed to the adapter as one uniform object:

```ts
type UploadItem = {
  jobId:       string;   // which source file this belongs to
  name:        string;   // path/filename to store as, e.g. "1080p_00001.m4s"
  blob:        Blob;     // the bytes
  contentType: string;   // correct MIME — "application/vnd.apple.mpegurl" | "video/mp4"
  isManifest:  boolean;  // true for .m3u8 (lets caller set no-cache / short TTL)
};
type UploadAdapter = (item: UploadItem) => Promise<void>;   // "everything" = implement this
```

Because it's just "store this Blob at this path with this content-type," **the same output
works on any storage.** Manifests use **relative segment URLs**, so uploaded output plays
regardless of the destination's base URL — no rewriting per provider.

### Built-in adapters (presets)

| Preset | Covers |
|---|---|
| `s3Adapter` | AWS S3 **and any S3-compatible**: Cloudflare R2, Backblaze B2, MinIO, DO Spaces, Wasabi |
| `supabaseAdapter` | Supabase Storage |
| `appwriteAdapter` | Appwrite Storage |
| *(your own function)* | **Everything else** — the universal escape hatch |

Presets are thin wrappers over the same `UploadAdapter` contract, kept in **separate
entry points** (`bitrate/adapters/s3`, etc.) so a caller only pulls in the SDK it uses —
no bundle bloat, no hard dependency on all three.

### 3b. Packager — single-file core (used by the queue)

```ts
import { HlsPackager } from "bitrate";

const pkg = new HlsPackager({ ladder: [...], segmentDuration: 6, codec: "avc" });
const out = await pkg.transcode(file, {
  onProgress: ({ rung, percent }) => {},
  signal: abortController.signal,
});
// out.manifest   → master .m3u8 text
// out.playlists  → Map<rung, string>
// out.segments   → Array<{ name, blob }>   (play locally, or upload yourself)
```

Also ship: `HlsQueue.isSupported()` / `HlsPackager.isSupported()` (feature-detect
WebCodecs), and a "segmenter-only" entry (`Segmenter`) for callers who already have
encoded frames.

---

## 3c. Output file structure (fMP4 / CMAF)

**Root file = `master.m3u8`** — the single URL you hand to a player.

```
master.m3u8              ◀── master playlist (ROOT) — lists the quality options
├── 1080p.m3u8           ◀── media playlist — lists this rung's segments in order
│   ├── 1080p_init.mp4   ◀── init segment — codec/setup header, loaded ONCE
│   ├── 1080p_00000.m4s  ◀── media segment (~6s) — these enable seeking
│   └── 1080p_00001.m4s
├── 720p.m3u8  → 720p_init.mp4, 720p_*.m4s
└── 480p.m3u8  → 480p_init.mp4, 480p_*.m4s
```

**Container decision: fMP4 (`.m4s`) is the default.** Same seeking/chunking as legacy
`.ts`, but also serves DASH from the same files and is LL-HLS ready. `container: "ts"`
stays available as an opt-in for very old devices (deferred to a later milestone).

---

## 3d. Large-file strategy (1 GB and beyond)

**Size is not the limit — time is.** A `File` is a disk reference, not memory, so with
strict streaming, memory stays flat (~200 MB) whether the input is 100 MB or 20 GB.
Never call `file.arrayBuffer()`; WASM32's 4 GB address space makes streaming mandatory.

```
✅  read slice → decode frame → encode → mux segment → UPLOAD → free → repeat
❌  load whole file → encode → collect all segments → upload         (tab dies)
```

A 1 GB source ≈ 1 hour of video ≈ **15–45 min** to transcode 3 rungs with hardware
acceleration (hours without it). The real risk is the user closing the tab at minute 38 —
hence resumability below.

### Two modes

```ts
new HlsQueue({ mode: "remux" })      // chunk only, no re-encode  → 1 GB in seconds
new HlsQueue({ mode: "transcode" })  // full ABR ladder           → 1 GB in ~30 min
new HlsQueue({ mode: "auto" })       // remux when source already suitable
```

**`remux` is the sleeper feature** — many callers only want a big MP4 chunked into
seekable HLS. It is near-instant, needs no encoder, and works on far more devices.
Ship it *before* the full transcode ladder.

### Performance & safety measures

| # | Measure | Win |
|---|---|---|
| 1 | **Decode once, encode N times** (one decoder fans out to all rungs) | ~3× faster than decoding per rung |
| 2 | **Remux/passthrough mode** | 10–100× faster when re-encoding isn't needed |
| 3 | **Upload-as-you-go**, free each segment immediately | Flat memory at any file size |
| 4 | **Memory watchdog + backpressure** (cap in-flight frames via `encodeQueueSize`) | No OOM when uploads lag |
| 5 | **Hardware-accel detection** up front | Honest expectations; refuse hopeless jobs |
| 6 | **Multipart upload + retry** for large segments | Survives flaky networks on long jobs |
| 7 | **Progress + real ETA** | Users don't close the tab |
| 8 | **Smart ladder** — never upscale (480p source ⇏ 1080p rung) | No wasted time/storage |

---

## 3e. Resumability — IndexedDB (no server)

**IndexedDB, not a server DB.** Postgres would require a server and break the core
no-server constraint. IndexedDB is client-side, holds gigabytes, and stores Blobs natively.

```
IndexedDB "bitrate"
├── jobs       { jobId, fileName, fileSize, lastModified, settings,
│                status, lastCompletedSegment: 247,   ◀── THE RESUME POINT
│                fileHandle?, createdAt, updatedAt }
├── segments   { jobId, name, blob, contentType, uploaded: false }  ◀── retry after reload
└── manifests  { jobId, name, text }
```

**Resume flow:** reopen page → "1 unfinished video — Resume?" → re-open source → seek to
segment 248 → continue, and flush any `uploaded: false` segments.

**The security catch:** browsers won't silently re-read a disk file after reload. Two paths,
both preserving all encoding progress:

| Path | How | Support |
|---|---|---|
| **Best — File System Access API** | Store `FileSystemFileHandle` in IndexedDB; re-prompt permission once on resume | Chrome/Edge — one click, auto-resumes |
| **Fallback — re-pick** | User re-selects the file; verify `name + size + lastModified` match, then resume | Safari/Firefox — one click |

Plus: `navigator.storage.persist()` (avoid eviction mid-job),
`navigator.storage.estimate()` (warn about quota *before* a 1 GB job, not at 80%), and
**auto-cleanup** of a job's records once every segment is confirmed uploaded.

---

## 4. Repo layout

```
bitrate/
├── crates/
│   └── bitrate-core/        # Rust: demux, fMP4/TS mux, HLS manifest — wasm-bindgen
│       ├── src/
│       │   ├── lib.rs
│       │   ├── demux/       # mp4, webm readers
│       │   ├── mux/         # fmp4 (ISO-BMFF) + ts writer
│       │   └── hls/         # manifest (master + media playlists)
│       └── Cargo.toml
├── js/                      # TS wrapper: WebCodecs pipeline + worker + public API
│   ├── src/
│   │   ├── index.ts
│   │   ├── queue.ts         # HlsQueue: multi-file, concurrency, skip-&-continue, retries
│   │   ├── upload.ts        # UploadAdapter contract + retry wrapper
│   │   ├── adapters/        # presets, each its own entry point (optional peer-dep SDKs)
│   │   │   ├── s3.ts        #   s3Adapter — S3 + R2/B2/MinIO/Spaces (S3-compatible)
│   │   │   ├── supabase.ts  #   supabaseAdapter
│   │   │   └── appwrite.ts  #   appwriteAdapter
│   │   ├── packager.ts      # HlsPackager: single-file pipeline (remux | transcode)
│   │   ├── encoder.ts       # WebCodecs ladder — decode once, fan out to N encoders
│   │   ├── storage.ts       # IndexedDB: job state, pending segments, resume
│   │   └── worker.ts
│   └── package.json
├── examples/demo/           # Vite app: pick file → package → play with hls.js
├── PLAN.md
└── README.md
```

Build: `wasm-pack build crates/bitrate-core` → JS wrapper imports the wasm → bundled
(Vite/tsup) into `bitrate` npm package with ESM + types.

---

## 5. Milestones

| # | Milestone | Deliverable | Proves |
|---|---|---|---|
Reordered so **remux ships before transcode** — it is simpler, near-instant, works on more
devices, and is independently useful.

**Status: M0–M6 complete.** The pipeline works end-to-end and is verified in a real
browser (canvas frames → WebCodecs H.264 → fMP4 → HLS → played back through hls.js, with a
frame-accurate seek). Remaining: M7 robustness (Web Worker, audio) and M8 publishing.

| # | Milestone | Deliverable | Proves |
|---|---|---|---|
| **M0** ✅ | Scaffold | Rust crate + `wasm-pack` + TS wrapper + Vite demo, "hello wasm" round-trip | Toolchain works end-to-end |
| **M1** ✅ | Segmenter core | Rust: encoded H.264 samples → **fMP4 segments + single-rendition `.m3u8`** | The Rust muxer/manifest (our IP) |
| **M2** ✅ | **Remux mode** ⭐ | Streaming demux of an existing MP4 → chunk → **playable, seekable HLS in hls.js**, no re-encode. Handles **1 GB** at flat memory. | The fast path + the streaming discipline |
| **M3** ✅ | Queue + upload | **`HlsQueue`**: multiple files, `concurrency`, **skip-&-continue + retries**, `UploadAdapter` + **`s3Adapter` / `supabaseAdapter` / `appwriteAdapter`** presets, per-job events | The multi-file, upload-to-anywhere workflow |
| **M4** ✅ | Resume (IndexedDB) | Job state + pending segments in IndexedDB, `FileSystemFileHandle` path + re-pick fallback, `persist()`/`estimate()`, auto-cleanup | Long jobs survive a closed tab |
| **M5** ✅ | Transcode single rung | WebCodecs decode → re-encode @720p → feed M1 | Full transcode pipeline, one bitrate |
| **M6** ✅ | ABR ladder | **Decode once, fan out to N encoders** → master.m3u8 + all renditions, quality switching, smart ladder (no upscaling) | The adaptive-bitrate feature |
| **M7** | Robustness | Web Worker, backpressure/memory watchdog, abort, audio track, hw-accel detection, ETA, multipart upload | Won't freeze/OOM on real batches |
| **M8** | Package & DX | npm publish (ESM+types), `isSupported`, README, browser-support matrix, demo deploy | Others can actually use it |

Ship an early alpha after **M4** (remux + queue + upload + resume is already a complete,
genuinely useful product), then add transcoding in M5–M6.

---

## 6. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| **Memory / tab freeze** on big files | Stream frame-by-frame (never `file.arrayBuffer()`), cap in-flight frames (WebCodecs backpressure via `encodeQueueSize`), Web Worker, release `VideoFrame`s promptly, upload-and-free each segment. See §3d. |
| **Long job lost** (tab closed at minute 38) | IndexedDB resume — see §3e. Plus honest ETA so users don't close the tab. |
| **No hardware encoder** → hours-long job | Detect up front, warn or refuse; steer such users to `remux` mode. |
| **Storage quota** exhausted mid-job | `navigator.storage.estimate()` before starting; `persist()` to avoid eviction; auto-cleanup after upload. |
| **Browser support** (WebCodecs) | Chrome/Edge solid; Safari 16.4+/Firefox recent OK. `isSupported()` + documented matrix. No legacy fallback in v1. |
| **Audio + A/V sync** | Handle audio via `AudioDecoder`/`AudioEncoder` (AAC) as its own track in fMP4; keep timescales/DTS aligned. Remux mode (M2) carries audio through untouched. |
| **Resume can't re-read the file** (browser security) | `FileSystemFileHandle` in IndexedDB (Chrome/Edge) or re-pick + `name/size/lastModified` verification (Safari/Firefox). Encoding progress is preserved either way. |
| **Codec/manifest conformance** | Validate against `hls.js` + native Safari early; use fMP4 (CMAF) over TS for cleaner muxing. |
| **Scope creep** | v1 = H.264 + fMP4 + video/audio. VP9/AV1/TS/DRM are follow-ups. |

---

## 7. Decisions

**Settled:**
- Container: **fMP4/CMAF (`.m4s`)** default; `.ts` opt-in, deferred.
- Codec: **H.264/AVC** for v1.
- Upload: **pluggable `UploadAdapter`** + S3 / Supabase / Appwrite presets.
- Failures: **skip & continue** + retries, with a final report.
- Persistence: **IndexedDB** (no server DB — Postgres would break the no-server constraint).
- Build order: **remux before transcode**.

**Still open (before M0):**
1. **Package name** on npm — is `bitrate` available, or a scoped name (`@you/bitrate`)?
2. **Bundler/tooling:** Vite for demo, `tsup` for lib — confirm.
3. **Local toolchain:** confirm Rust + `wasm-pack` are installed on the dev machine.

---

*Next step after sign-off: execute **M0** (scaffold the Rust crate + wasm-pack + TS wrapper + demo).*
