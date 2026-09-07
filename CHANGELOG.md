# Changelog

This project follows [semantic versioning](https://semver.org). Before 1.0 the minor
version may carry breaking changes; they are called out here.

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
- Resume after a closed tab, backed by IndexedDB; the re-picked file is verified against
  the stored job before anything is reused.
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
- Resuming applies to `remux` only; a transcode job restarts from the beginning.
- Sources must carry H.264 video in an MP4 container.
