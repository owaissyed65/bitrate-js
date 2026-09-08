# Changelog

This project follows [semantic versioning](https://semver.org). Before 1.0 the minor
version may carry breaking changes; they are called out here.

## 0.2.0

- **Transcoding on a worker thread** — `transcodeInWorker` is the same generator as
  `transcode`, off the main thread. The tab stays usable, and a backgrounded tab is no
  longer throttled. It pulls rather than pushes, holding after each file until the page
  asks for the next, so memory stays flat.
- **Poster frames and sprite sheets** — `posterFrame` and `thumbnailSprite` decode stills
  from a few hundred kilobytes of the source. Defaults to a tenth of the way in, since
  plenty of videos open on black.
- **Subtitles** — `srtToVtt`, `subtitleFiles` and `attachSubtitles` add WebVTT renditions
  to a master playlist. SubRip is converted. Captions embedded in the bitstream
  (CEA-608/708) are not extracted.
- **The WASM no longer loads on import.** It was a static import, so any consumer paid
  ~114 kB just for importing the package. It is a dynamic import now: eager cost is
  106 kB, with the WASM fetched on first real use.

## 0.1.1

No code changes. The npm page now points at the live demo at bitrate-js.vercel.app
rather than the repository, and the README leads with it — package metadata is frozen
into a published version, so correcting it needs a release of its own.

The bundlephobia badge is gone; that service rate-limits and rendered as an error more
often than it rendered a size.

## 0.1.0 — first published release

The first version on npm. The pipeline is verified end to end in a real browser against
real files, not only in tests.

### Packaging

- **Remux** — repackage an H.264/MP4 source into fragmented-MP4 HLS without re-encoding.
  Near-instant; a 1 GB file takes seconds.
- **Transcode** — re-encode into an adaptive-bitrate ladder with WebCodecs, with
  `LADDERS.single` / `mobile` / `standard` / `wide` / `uhd` presets, or any
  `{ height, bitrate }[]` of your own. Rungs taller than the source are dropped, so a
  preset can be handed any file.
- **Audio in both modes** — carried through untouched when remuxing, re-encoded to AAC
  when transcoding, with the two timelines kept in step.
- **Fragmented MP4 input** — sources whose samples live in `moof` boxes rather than `stbl`
  are read by indexing the fragments only, never the `mdat` payloads.
- **`packageFrames`** — package `VideoFrame`s from a canvas, screen capture or any other
  producer, with no source file at all.
- Encoder controls: `profile`, `hardwareAcceleration`, `latencyMode`, `allowUpscale`,
  `segmentDuration`, `audioBitrate`.

### Queue and uploads

- Multi-file queue with concurrency, retries, progress, cancellation, and
  skip-and-continue so one bad file cannot sink a batch.
- Resume after a closed tab, backed by IndexedDB, in **both** modes; the re-picked file is
  verified against the stored job before anything is reused. A re-encode restarts at a
  segment boundary, decoding a short run-up from the preceding keyframe — every segment
  begins on a keyframe and is decodable alone, so the join is exact rather than
  approximate.
- Adapters for pre-signed URLs, S3-compatible storage, Supabase and Appwrite. **No adapter
  accepts cloud credentials** — only an app-authenticated client or a short-lived signed
  URL. A test enforces it.

### Delivery

- WASM inlined into the bundle: no `.wasm` asset to copy, no bundler configuration, and
  consumers never install Rust.
- ESM with per-adapter subpath exports, plus a classic-script build exposing
  `window.bitrate` for pages with no build step.
- Dependency-free store-only ZIP writer at `bitrate-js/zip` for saving a rendition as one
  file.
- Flat memory: the source is read through `Blob.slice` and each output is released as it
  is produced, so peak memory does not grow with file size.

### Known limitations

- Transcoding runs on the main thread, so a long encode makes the tab unresponsive. A Web
  Worker is planned.
- A resumed job must use the same mode and ladder it started with; the queue refuses a
  mismatch rather than appending output that does not match what is already uploaded.
- Sources must carry H.264 video in an MP4 container.
