# Security posture — `bitrate`

This is a **published npm package that runs in other people's browsers**. Two threat
surfaces matter: (1) what *we* could leak or enable in a consuming app, and (2) what a
*malicious input video* could do to us. Both are addressed below.

---

## 1. Credentials — the rule that shapes the API

> **The package never accepts cloud credentials, and never stores or transmits them.**

A browser has no secure place to keep a secret. Any `accessKeyId` / `secretAccessKey` /
service-role key placed in client code is readable by every visitor in DevTools. An API
that *invites* developers to pass secrets is a vulnerability in the package itself, even
if the package never mishandles them.

### Adapter contract

Adapters accept **an already-authenticated client** the consuming app owns, or **a
callback returning a short-lived pre-signed URL**. Never raw keys.

```ts
// ❌ Never offered by this package
s3Adapter({ accessKeyId, secretAccessKey })

// ✅ App owns the client and its credential lifecycle
s3Adapter({ client: appS3Client, bucket: "videos", prefix: "hls/" })

// ✅ Safest: app's backend signs a short-lived, single-object URL
presignedAdapter({ getUrl: (name) => fetch(`/api/sign?f=${name}`).then(r => r.text()) })
```

| Provider | Correct client-side auth |
|---|---|
| S3 / R2 / B2 / MinIO | Pre-signed URL, or STS temporary credentials — **never** long-lived IAM keys |
| Supabase | `anon` key + **Row Level Security** policies on the storage bucket |
| Appwrite | Session-scoped client + bucket permissions |

Docs must state plainly: **server-issued, short-lived, least-privilege, scoped to a single
object.** A pre-signed URL should permit `PUT` of one key, and expire in minutes.

### Related rules
- Never log, serialize, or persist adapter config, URLs, or headers (they may embed tokens).
- Never write credentials or signed URLs into IndexedDB.
- Redact query strings from any error message that surfaces a URL.
- The package makes **no network requests of its own** — no telemetry, no phone-home, no
  CDN fetches at runtime. The only traffic is the adapter the developer supplied.

---

## 2. Path safety (storage-side injection)

Segment names derive from user-supplied file names. Unsanitized, `../` or absolute paths
could write outside the intended prefix in a bucket.

- Generate object keys from an internal `jobId` (nanoid), **not** from the source file name.
- Sanitize any caller-supplied `prefix`/name: strip `..`, leading `/`, backslashes, NUL,
  control chars; allow a conservative charset; enforce a length cap.
- Assert every produced key starts with the configured prefix before handing it to an adapter.

---

## 3. Untrusted input parsing (the Rust attack surface)

The demuxer parses **attacker-controlled binary** (a video file). This is the classic
memory-corruption target — and precisely why the core is Rust.

- `#![forbid(unsafe_code)]` in `bitrate-core`; if `unsafe` ever becomes necessary, it is
  isolated, documented, and justified in review.
- No panics on malformed input — parsers return `Result`; a panic in WASM aborts the
  caller's page, so treat panics as bugs. Deny `unwrap`/`expect`/indexing lints in parser
  modules.
- **Bounds and sanity limits** before allocating: cap box/atom sizes, track counts,
  dimensions, and sample counts. Never allocate from an untrusted length field.
- Reject pathological inputs early (zip-bomb-style nesting, absurd dimensions, negative
  or overflowing timestamps). Use checked arithmetic on all offsets.
- **Fuzz the demuxer** (`cargo-fuzz`) with a seed corpus of real and corrupted files; wire
  it into CI. Add every crash found as a regression test.
- WASM linear memory is sandboxed — a parser bug cannot reach the host page's memory — but
  it can still OOM or hang the tab, so enforce the resource caps above.

---

## 4. Supply chain

- **Zero required runtime dependencies.** Provider SDKs (`@aws-sdk/*`,
  `@supabase/supabase-js`, `appwrite`) are **optional peer dependencies** in separate entry
  points, so a consumer installs only what they use and we never pin their SDK version.
- Minimal, audited Rust dependency tree; `cargo-deny` in CI (advisories, licenses, bans).
- `npm audit` + Dependabot on CI; committed lockfile.
- **Publish with provenance** (`npm publish --provenance` from a trusted CI workflow) so
  consumers can verify the tarball came from this repo's source.
- 2FA required on the npm account; no publish tokens in the repo.
- `files` allowlist in `package.json` — ship only `dist/`; never source maps referencing
  local paths, `.env`, or test fixtures.
- Reproducible builds: pin the Rust toolchain (`rust-toolchain.toml`) and wasm-pack version.

---

## 5. Browser execution safety

- **No `eval` / `new Function` / dynamic script injection** — the library is CSP-safe.
- WASM instantiation requires `script-src 'wasm-unsafe-eval'` in strict CSP; this is
  documented in the README with a sample policy rather than asking users to loosen CSP.
- No DOM injection: the package renders nothing and never writes user text into HTML.
- Workers are created from bundled, same-origin assets — never from a remote URL or a
  `blob:` built out of caller-supplied strings.
- No use of `localStorage`/cookies; state lives in IndexedDB and contains **no secrets**.

---

## 6. Local data hygiene (IndexedDB)

- Store only what resume requires: job metadata, progress index, pending segment blobs.
- **Never** store credentials, signed URLs, or adapter config.
- Delete a job's records once all segments are confirmed uploaded (auto-cleanup).
- Provide an explicit `clear()` API so apps can purge on logout — video frames are
  user content and must not linger on a shared machine.
- Note in docs: IndexedDB is origin-scoped and unencrypted on disk. Sensitive video on a
  shared device should use `mode: "remux"` with immediate upload and cleanup.

---

## 7. Denial of service (self-inflicted)

Large or malicious inputs can hang or OOM the consuming app's tab.

- Hard caps: max input size, max duration, max resolution, max concurrent jobs —
  all configurable, all with safe defaults.
- Streaming-only I/O (never `file.arrayBuffer()`); bounded in-flight frames via
  `encodeQueueSize` backpressure.
- Check `navigator.storage.estimate()` before starting; fail fast with a clear error.
- All work in a Web Worker so a stall never freezes the host UI.
- Every operation is cancellable via `AbortSignal`, and cancellation frees resources.

---

## 8. Disclosure

Report vulnerabilities privately via GitHub Security Advisories on this repository.
Please do not open a public issue for a suspected vulnerability. Target response: 72 hours.
