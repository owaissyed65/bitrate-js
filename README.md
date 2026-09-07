# bitrate

**Client-side HLS / adaptive-bitrate video packager.** Chunk, transcode and upload large
videos entirely in the browser — no server, no upload-then-wait.

Rust/WASM does the demuxing, segmenting and manifests. The browser's WebCodecs API does
the encoding. You supply where the output goes.

> **Status: pre-alpha (M0).** Scaffold only — the pipeline is not implemented yet.
> See [PLAN.md](PLAN.md) for the roadmap and [SECURITY.md](SECURITY.md) for the security model.

---

## What it does

```
user picks files ─▶ QUEUE ─▶ chunk / encode ABR ladder ─▶ HLS ─▶ your storage
  (one or many)              (Rust/WASM + WebCodecs)              (S3, Supabase,
                                                                   Appwrite, anything)
```

- **Chunks large videos** into seekable HLS segments — a 1 GB file streams and seeks
  instantly instead of downloading whole.
- **Adaptive bitrate** — produces multiple quality rungs so players adapt to network speed.
- **Multi-file queue** with progress, retries, and skip-and-continue on failure.
- **Resumes after a closed tab** via IndexedDB — no redoing a 40-minute job.
- **Uploads anywhere** through a pluggable adapter.

## Two modes

| Mode | Speed | Use when |
|---|---|---|
| `remux` | **Near-instant** (1 GB in seconds) | You just want chunking + seeking. No re-encode, works on more devices. |
| `transcode` | ~15–45 min for 1 GB | You need a real multi-quality ABR ladder. Requires WebCodecs + GPU. |
| `auto` | — | Picks `remux` when the source is already suitable. |

## Output

The root file is **`master.m3u8`** — the single URL you hand to a player.

```
master.m3u8            ◀── ROOT: lists the quality options
├── 1080p.m3u8         ◀── media playlist for this rung
│   ├── 1080p_init.mp4 ◀── init segment (loaded once)
│   └── 1080p_*.m4s    ◀── ~6s segments (these enable seeking)
├── 720p.m3u8  → …
└── 480p.m3u8  → …
```

## Usage (planned API)

```ts
import { HlsQueue, isSupported } from "bitrate-js";
import { presignedAdapter } from "bitrate-js/adapters/presigned";

if (!isSupported().remux) throw new Error("Browser too old");

const q = new HlsQueue({
  mode: "auto",
  ladder: [
    { height: 1080, bitrate: 5_000_000 },
    { height: 720,  bitrate: 2_800_000 },
    { height: 480,  bitrate: 1_200_000 },
  ],
  segmentDuration: 6,
  concurrency: 1,
  retries: 3,

  upload: presignedAdapter({
    getUrl: (item) => fetch(`/api/sign?f=${item.name}`).then((r) => r.text()),
  }),

  onProgress: ({ jobId, percent, etaSeconds }) => {},
  onJobDone:  ({ jobId, masterPlaylist }) => {},
  onJobError: ({ jobId, error }) => {},   // queue keeps going
});

q.add([file1, file2, file3]);
const report = await q.drain();
// report.succeeded / report.failed
```

## Security — read before writing an adapter

> **This package never accepts cloud credentials, and you must never put them in browser code.**

A browser has no secure place for a secret. Anything you pass to client-side code is
readable by every visitor in DevTools.

```ts
// ❌ NEVER — leaks your AWS secret to the world
{ accessKeyId: "AKIA…", secretAccessKey: "…" }

// ✅ Backend signs a short-lived URL for one object (recommended)
presignedAdapter({ getUrl: (i) => fetch(`/api/sign?f=${i.name}`).then(r => r.text()) })

// ✅ Or hand over a client your app already authenticated
s3Adapter({ client: appS3Client, bucket: "videos" })
```

| Provider | Correct client-side auth |
|---|---|
| S3 / R2 / B2 / MinIO | Pre-signed URL or STS temporary credentials |
| Supabase | `anon` key + Row Level Security on the bucket |
| Appwrite | Session-scoped client + bucket permissions |

Full model in [SECURITY.md](SECURITY.md).

**CSP note:** WASM needs `script-src 'wasm-unsafe-eval'`. The package uses no `eval`,
injects no DOM, and makes no network requests of its own.

## Browser support

| | remux | transcode | seamless resume |
|---|---|---|---|
| Chrome / Edge | ✅ | ✅ | ✅ |
| Safari 16.4+ | ✅ | ✅ | re-pick file |
| Firefox (recent) | ✅ | ✅ | re-pick file |

Call `isSupported()` to check at runtime.

## Development

Requires **Rust + wasm-pack** (for the WASM core) and **Node 18+**.

```bash
# one-time: install Rust, then
cargo install wasm-pack

cd js
npm install
npm run build      # builds WASM, then bundles the package
npm test
```

## License

MIT
