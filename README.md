# bitrate

**Client-side HLS / adaptive-bitrate video packager.** Chunk, transcode and upload large
videos entirely in the browser — no server, no upload-then-wait.

Rust/WASM does the demuxing, segmenting and manifests. The browser's WebCodecs API does
the encoding. You supply where the output goes.

> **Status: alpha.** The pipeline works end-to-end and is verified in a real browser, but
> the package is not published yet and the API may still change.
> See [PLAN.md](PLAN.md) for the roadmap and [SECURITY.md](SECURITY.md) for the security model.

---

## What it does

```
user picks files ─▶ QUEUE ─▶ chunk / encode ABR ladder ─▶ HLS ─▶ your storage
  (one or many)              (Rust/WASM + WebCodecs)              (S3, Supabase,
                                                                   Appwrite, anything)
```

- **Chunks large videos** into seekable HLS — a 1 GB file streams and seeks instantly
  instead of downloading whole.
- **Adaptive bitrate** — multiple quality rungs so players adapt to network speed.
- **Multi-file queue** with progress, retries, and skip-and-continue on failure.
- **Resumes after a closed tab** via IndexedDB — no redoing a 40-minute job.
- **Uploads anywhere** through a pluggable adapter.
- **Flat memory** — reads the source through `Blob.slice` and releases each output file as
  it is produced, so peak memory does not grow with file size.

## Two modes

| Mode | Speed | Use when |
|---|---|---|
| `remux` | **Near-instant** (1 GB in seconds) | You just want chunking + seeking. No re-encode, no WebCodecs needed, works on more devices. |
| `transcode` | Slower; needs a GPU encoder | You need a real multi-quality ABR ladder. |

## Output

The root file is **`master.m3u8`** (or `<prefix>.m3u8` for a single rendition) — the one
URL you hand to a player.

```
master.m3u8            ◀── ROOT: lists the quality options
├── video_1080p.m3u8   ◀── media playlist for this rung
│   ├── …_init.mp4     ◀── init segment (loaded once)
│   └── …_00000.m4s    ◀── ~6s segments (these enable seeking)
├── video_720p.m3u8  → …
└── video_480p.m3u8  → …
```

Segment URIs are **relative**, so the same output plays from any storage base URL without
rewriting.

---

## Usage

### Queue: many files, uploaded anywhere

```ts
import { HlsQueue, JobStore } from "bitrate-js";
import { presignedAdapter } from "bitrate-js/adapters/presigned";

const q = new HlsQueue({
  segmentDuration: 6,
  concurrency: 1,
  retries: 3,
  store: await JobStore.open(),          // enables resume after a reload

  upload: presignedAdapter({
    getUrl: (item) => fetch(`/api/sign?f=${item.name}`).then((r) => r.text()),
  }),

  onProgress: ({ jobId, percent }) => {},
  onJobDone:  ({ jobId, masterPlaylist }) => {},
  onJobError: ({ jobId, error }) => {},   // queue keeps going
});

q.add([file1, file2, file3]);
const report = await q.drain();
// report.succeeded / report.failed — drain never rejects
```

### One file, streamed

```ts
import { remux } from "bitrate-js";

for await (const out of remux(file, { prefix: "720p", segmentDuration: 6 })) {
  await upload(out.name, out.blob, out.contentType);   // upload and release as you go
}
```

### Transcode into an ABR ladder

```ts
import { transcode, isTranscodeSupported, DEFAULT_LADDER } from "bitrate-js";

if (isTranscodeSupported()) {
  for await (const out of transcode(file, { ladder: DEFAULT_LADDER })) { … }
}
```

### Frames from somewhere else

```ts
import { packageFrames } from "bitrate-js";

// Canvas animation, screen capture, MediaStreamTrackProcessor…
for await (const out of packageFrames(myVideoFrames, { segmentDuration: 2 })) { … }
```

### Resume an interrupted job

```ts
const store = await JobStore.open();
const [interrupted] = await store.resumableJobs();

if (interrupted) {
  // Ask the user to re-pick the same file; it is verified before resuming.
  q.addResume({ stored: interrupted, file: rePickedFile });
  await q.drain();
}
```

---

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
s3Adapter({ client: appS3Client, putObjectCommand: PutObjectCommand, bucket: "videos" })
```

| Provider | Correct client-side auth |
|---|---|
| S3 / R2 / B2 / MinIO / Spaces | Pre-signed URL or STS temporary credentials |
| Supabase | `anon` key + Row Level Security on the bucket |
| Appwrite | Session-scoped client + bucket permissions |

Full model in [SECURITY.md](SECURITY.md): path-traversal defence, untrusted-input parsing,
supply chain, CSP, and local-data hygiene.

**CSP note:** WASM needs `script-src 'wasm-unsafe-eval'`. The package uses no `eval`,
injects no DOM, and makes no network requests of its own — the only traffic is the upload
adapter you supply.

## Browser support

| | remux | transcode | seamless resume |
|---|---|---|---|
| Chrome / Edge | ✅ | ✅ | ✅ |
| Safari 16.4+ | ✅ | ✅ | re-pick file |
| Firefox (recent) | ✅ | ✅ | re-pick file |

```ts
import { isSupported } from "bitrate-js";
const { remux, transcode, reasons } = isSupported();
```

The WASM module is **inlined into the bundle**, so there is no `.wasm` asset to copy and no
bundler configuration — `npm install` is enough.

## Development

Requires **Rust + wasm-pack** and **Node 18+**. Rust is needed only to *build* the package;
consumers install a pre-compiled `.wasm` and never need a toolchain.

```bash
# Windows: MSVC build tools are required for the host linker
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

```bash
rustup target add wasm32-unknown-unknown && npm install -g wasm-pack
```

```bash
cd js && npm install && npm run build && npm test
```

```bash
cargo test && cargo clippy --all-targets
```

Run the demo:

```bash
npm install --prefix examples/demo && npm run dev --prefix examples/demo
```

## License

MIT
