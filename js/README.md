# bitrate

**Client-side HLS / adaptive-bitrate video packager.** Chunk, transcode and upload large
videos entirely in the browser — no server, no upload-then-wait.

[![npm](https://img.shields.io/npm/v/bitrate-js.svg)](https://www.npmjs.com/package/bitrate-js)
[![bundle size](https://img.shields.io/bundlephobia/minzip/bitrate-js)](https://bundlephobia.com/package/bitrate-js)
[![license](https://img.shields.io/npm/l/bitrate-js.svg)](https://github.com/OWNER/bitrate/blob/main/LICENSE)

Rust/WASM does the demuxing, segmenting and manifests. The browser's WebCodecs API does
the encoding. You supply where the output goes.

```bash
npm install bitrate-js
```

No `ffmpeg`, no transcoding server, no build configuration — the WASM module is inlined
into the bundle, so there is no `.wasm` asset to copy and consumers never install Rust.

> **Status: 0.1, early.** The pipeline works end-to-end and is verified in a real browser
> against real files, but the API may still change before 1.0.
> See [PLAN.md](https://github.com/OWNER/bitrate/blob/main/PLAN.md) for the roadmap and [SECURITY.md](https://github.com/OWNER/bitrate/blob/main/SECURITY.md) for the security model.

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
- **Keeps the audio** — the source audio track is carried through untouched and muxed
  alongside the video, with both timelines kept in step.
- **Uploads anywhere** through a pluggable adapter.
- **Flat memory** — reads the source through `Blob.slice` and releases each output file as
  it is produced, so peak memory does not grow with file size.

## Two modes

| Mode | Speed | Use when |
|---|---|---|
| `remux` | **Near-instant** (1 GB in seconds) | You just want chunking + seeking. No re-encode, no WebCodecs needed, works on more devices. |
| `transcode` | Slower; needs a GPU encoder | You need a real multi-quality ABR ladder. Audio is re-encoded and carried through. |

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

## Try it

A React showcase runs every feature in the browser: a segment timeline you can click to
seek, a player with quality switching, live job cards, and security checks run against
the library itself.

```bash
npm run build --prefix js
npm install --prefix examples/react-app && npm run dev --prefix examples/react-app
```

Then open http://localhost:5180.

---

## Usage

### Queue: many files, uploaded anywhere

```ts
import { HlsQueue, JobStore } from "bitrate-js";
import { presignedAdapter } from "bitrate-js/adapters/presigned";

const q = new HlsQueue({
  mode: "remux",              // or "transcode" for an ABR ladder
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
import { transcode, isTranscodeSupported, LADDERS } from "bitrate-js";

if (isTranscodeSupported()) {
  for await (const out of transcode(file, { ladder: LADDERS.standard })) { … }
}
```

#### Choosing a ladder

A ladder is the set of qualities you produce. More rungs means better adaptation and more
encoding time. Rungs taller than the source are dropped, so a preset can be handed any file
without checking it first.

| Preset | Rungs | Use for |
|---|---|---|
| `LADDERS.single` | 720p | One quality — cheapest, no adaptation |
| `LADDERS.mobile` | 720 · 480 · 360 | Phone-first audiences, poor networks |
| `LADDERS.standard` | 1080 · 720 · 480 | The usual default |
| `LADDERS.wide` | 1080 · 720 · 480 · 360 | Adds a rung for very bad connections |
| `LADDERS.uhd` | 2160 · 1440 · 1080 · 720 | 4K sources. Expect real time |

Or write your own — a rung is just a height and a bitrate:

```ts
ladder: [
  { height: 1080, bitrate: 6_000_000 },   // a higher bitrate than the preset
  { height: 540,  bitrate: 1_000_000 },   // a size no preset offers
]
```

#### Every transcode option

```ts
transcode(file, {
  ladder: LADDERS.standard,      // which qualities to produce
  segmentDuration: 6,            // seconds per segment; also the keyframe interval
  prefix: "video",               // names files <prefix>_<height>p_00000.m4s

  audio: true,                   // re-encode and keep the sound (default)
  audioBitrate: 128_000,         // AAC bitrate

  profile: "main",               // "main" | "high" | "baseline"
  hardwareAcceleration: "prefer-hardware",
  latencyMode: "quality",        // "quality" | "realtime"
  allowUpscale: false,           // keep rungs taller than the source

  signal: controller.signal,
  onProgress: ({ fraction }) => {},
});
```

**`profile`** — `"high"` compresses better at the same bitrate and is safe on anything
modern; `"baseline"` is the most compatible and the least efficient. Each falls back if the
browser cannot honour it, so a preference never causes a failure.

**`hardwareAcceleration`** — `"prefer-hardware"` is dramatically faster where it exists.
Software encoding of a long video in a tab is rarely practical.

**`latencyMode`** — `"realtime"` encodes faster and looks worse at the same bitrate. Worth
it when a user is waiting on the result.

**`allowUpscale`** — off by default: upscaling costs encoding time and storage and adds no
detail. Turn it on only if a fixed set of renditions matters more than the wasted work.

**`segmentDuration`** — also sets the keyframe interval, since every segment must start on
one. Shorter segments adapt faster and seek more precisely; longer ones compress better and
mean fewer files.

The same options are accepted by `HlsQueue`:

```ts
new HlsQueue({
  mode: "transcode",
  ladder: LADDERS.mobile,
  profile: "high",
  hardwareAcceleration: "prefer-hardware",
  upload: myAdapter,
});
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

Complete configuration for every provider — including CORS, cache headers and the settings
people usually miss — is in **[ADAPTERS.md](https://github.com/OWNER/bitrate/blob/main/ADAPTERS.md)**.

Full security model in [SECURITY.md](https://github.com/OWNER/bitrate/blob/main/SECURITY.md): path-traversal defence, untrusted-input
parsing, supply chain, CSP, and local-data hygiene.

**CSP note:** WASM needs `script-src 'wasm-unsafe-eval'`. The package uses no `eval`,
injects no DOM, and makes no network requests of its own — the only traffic is the upload
adapter you supply.

### Input requirements

Sources need an H.264 video track in an MP4 container. Both layouts are read:

- **Progressive** — samples described in `stbl`. What most cameras and editors write.
- **Fragmented** — samples described in `moof` boxes. What streaming-oriented writers,
  many phones, and anything that had to start writing before knowing the final length
  produce.

For a fragmented source only the `moof` boxes are read, never the `mdat` payloads, so a
multi-gigabyte file costs a few megabytes of reading to index.

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

### Using it without a bundler

The package is a single ESM file, so it works from a plain `<script type="module">`. A
browser cannot resolve a bare name like `"bitrate-js"` on its own, so declare it in an
**import map**:

```html
<script type="importmap">
  { "imports": { "bitrate-js": "/node_modules/bitrate-js/dist/index.js" } }
</script>

<script type="module">
  import { remux, isSupported } from "bitrate-js";
  // …
</script>
```

Or skip the import map and use the path directly:

```html
<script type="module">
  import { remux } from "/node_modules/bitrate-js/dist/index.js";
</script>
```

### Saving the output

A rendition is many files, and saving them one at a time makes the browser prompt about
multiple downloads and scatters them away from the playlist that references them. There is
a dependency-free ZIP writer for that:

```ts
import { downloadZip } from "bitrate-js/zip";

await downloadZip(
  output.map((f) => ({ name: f.name, data: f.blob })),
  "hls-output.zip",
);
```

Entries are stored rather than deflated: HLS output is already-compressed video, so
compressing again costs CPU for nothing.

### Without modules at all

There is also a classic-script build that defines `window.bitrate`. ES modules cannot load
over `file://`, so this is what a page opened straight from disk needs:

```html
<script src="/node_modules/bitrate-js/dist/bitrate.global.js"></script>
<script>
  bitrate.isSupported();
</script>
```

> **`Failed to resolve module specifier "bitrate-js"`** means neither is in place — the page
> is being served without a bundler and without an import map. It also appears if you open
> an HTML file straight from disk (`file://`) instead of through a server.

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

Run the showcase:

```bash
npm install --prefix examples/react-app && npm run dev --prefix examples/react-app
```

### Releasing

Publishing is tag-driven, so a release is an explicit act rather than a side effect of
merging. Bump `js/package.json`, tag the same version, and push the tag:

```bash
npm version minor --prefix js --no-git-tag-version
git commit -am "Release v0.2.0" && git tag v0.2.0 && git push --follow-tags
```

`.github/workflows/release.yml` then checks the tag against `package.json`, runs
`prepublishOnly` (README sync, WASM build, typecheck, tests) and publishes with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements) — an OIDC
attestation tying the published tarball to this repository and commit, so nobody has to
trust that the bytes on npm came from this source.

It needs one repository secret, `NPM_TOKEN` (an npm **automation** token), and the
`repository` field in `js/package.json` must match the repository it runs in or provenance
is rejected.

`js/README.md` and `js/LICENSE` are generated from the repository copies by
`npm run sync:readme` — edit the root files, not those. CI fails if they drift.

## License

MIT
