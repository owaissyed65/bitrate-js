# Upload adapters

Everything the packager produces reaches your uploader in the same shape, so one contract
covers every backend:

```ts
type UploadItem = {
  jobId: string;       // which source video this belongs to
  name: string;        // path to store as, e.g. "job_1_00001.m4s"
  blob: Blob;          // the bytes
  contentType: string; // "video/mp4" | "application/vnd.apple.mpegurl"
  isManifest: boolean; // true for .m3u8 — useful for cache headers
};

type UploadAdapter = (item: UploadItem) => Promise<void>;
```

Because it is always *"store these bytes at this path with this content type"*, the same
output works on any storage. Segment URIs are **relative**, so nothing needs rewriting per
provider.

---

## The rule that shapes every example here

> **Never put a long-lived credential in browser code.**

Anything shipped to the client is readable in DevTools by every visitor. There are exactly
two safe patterns, and every adapter below uses one of them:

| Pattern | How it works | Best for |
|---|---|---|
| **Pre-signed URL** | Your backend signs a short-lived URL for one object; the browser PUTs to it | S3 and everything S3-compatible, GCS, Azure |
| **Scoped client session** | Your app authenticates a client the user is already signed in to; storage rules limit what they can write | Supabase, Appwrite, Firebase |

If a provider only offers a permanent secret key for uploads, **proxy through your own
backend** — see [Your own server](#your-own-server).

---

## Contents

- [Pre-signed URL](#pre-signed-url) — the general answer
- [AWS S3](#aws-s3)
- [Cloudflare R2](#cloudflare-r2)
- [Backblaze B2](#backblaze-b2)
- [MinIO](#minio)
- [DigitalOcean Spaces](#digitalocean-spaces)
- [Supabase Storage](#supabase-storage)
- [Appwrite Storage](#appwrite-storage)
- [Firebase Storage](#firebase-storage)
- [Azure Blob Storage](#azure-blob-storage)
- [Google Cloud Storage](#google-cloud-storage)
- [Your own server](#your-own-server)
- [Cross-cutting settings](#cross-cutting-settings) — CORS, cache headers, content types

---

## Pre-signed URL

Works with any storage that supports signed uploads, and keeps every credential on your
server. **Start here unless a provider-specific adapter is clearly easier.**

```bash
npm install bitrate-js
```

```ts
import { HlsQueue } from "bitrate-js";
import { presignedAdapter } from "bitrate-js/adapters/presigned";

const queue = new HlsQueue({
  segmentDuration: 6,
  retries: 3,
  upload: presignedAdapter({
    // Called once per output file. Return a URL that permits PUT of that object.
    getUrl: async (item) => {
      const res = await fetch(
        `/api/sign?name=${encodeURIComponent(item.name)}&type=${encodeURIComponent(item.contentType)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`signing failed: ${res.status}`);
      return res.text();
    },
    method: "PUT",
  }),
});

queue.add(files);
const report = await queue.drain();
```

### The backend that signs (Node + AWS SDK v3)

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: process.env.AWS_REGION });

app.get("/api/sign", requireAuth, async (req, res) => {
  const name = String(req.query.name ?? "");
  const type = String(req.query.type ?? "");

  // Constrain what can be signed. Never sign a caller-supplied path verbatim —
  // that would let anyone write anywhere in the bucket.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) return res.status(400).end();
  if (type !== "video/mp4" && type !== "application/vnd.apple.mpegurl") {
    return res.status(400).end();
  }

  // Scope every object to the signed-in user.
  const key = `hls/${req.user.id}/${name}`;

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: process.env.BUCKET,
      Key: key,
      ContentType: type,
      CacheControl: name.endsWith(".m3u8")
        ? "public, max-age=60"
        : "public, max-age=31536000, immutable",
    }),
    { expiresIn: 300 }, // minutes, not days
  );

  res.type("text/plain").send(url);
});
```

**Signature rules worth keeping:** one object per signature, a short expiry, a prefix the
user cannot escape, and a content type you chose rather than one they supplied.

> The adapter strips query strings from error messages, so a failed upload never logs the
> signature.

---

## AWS S3

Use this when your app already holds an authenticated S3 client — typically one built from
**temporary STS credentials**, not permanent IAM keys.

```bash
npm install bitrate-js @aws-sdk/client-s3
```

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { HlsQueue } from "bitrate-js";
import { s3Adapter } from "bitrate-js/adapters/s3";

// Credentials come from your backend and expire. Never hardcode IAM keys.
const { accessKeyId, secretAccessKey, sessionToken, expiration } = await fetch(
  "/api/storage-credentials",
).then((r) => r.json());

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId, secretAccessKey, sessionToken },
});

const queue = new HlsQueue({
  upload: s3Adapter({
    client,
    putObjectCommand: PutObjectCommand,
    bucket: "my-videos",
    prefix: `hls/${userId}`,
    // Segments never change once written; playlists might.
    segmentCacheControl: "public, max-age=31536000, immutable",
    manifestCacheControl: "public, max-age=60",
  }),
});
```

### Handing out temporary credentials (backend)

```ts
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const sts = new STSClient({ region: process.env.AWS_REGION });

app.get("/api/storage-credentials", requireAuth, async (req, res) => {
  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: process.env.UPLOAD_ROLE_ARN,
      RoleSessionName: `upload-${req.user.id}`,
      DurationSeconds: 900,
      // Narrow the role down to this user's prefix.
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: `arn:aws:s3:::my-videos/hls/${req.user.id}/*`,
          },
        ],
      }),
    }),
  );
  res.json(result.Credentials);
});
```

### Bucket CORS

Browser uploads fail without this.

```json
[
  {
    "AllowedOrigins": ["https://yourapp.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

---

## Cloudflare R2

R2 speaks the S3 API, so the same adapter works. Its selling point for video is **zero
egress fees**, which matters when every viewer downloads every segment.

```bash
npm install bitrate-js @aws-sdk/client-s3
```

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Adapter } from "bitrate-js/adapters/s3";

const client = new S3Client({
  region: "auto", // R2 requires exactly this
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: temporaryCredentials, // from your backend
});

const upload = s3Adapter({
  client,
  putObjectCommand: PutObjectCommand,
  bucket: "videos",
  prefix: "hls",
});
```

**Notes**
- `region` must be `"auto"`.
- Set CORS on the bucket in the Cloudflare dashboard (R2 → bucket → Settings → CORS).
- Serve playback through a custom domain or an R2 public bucket; the
  `*.r2.cloudflarestorage.com` endpoint is for the API, not for viewers.
- Pre-signed URLs work here too, and are the better default.

---

## Backblaze B2

B2 offers an S3-compatible endpoint. Egress to Cloudflare is free via the Bandwidth
Alliance, which pairs well with HLS.

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Adapter } from "bitrate-js/adapters/s3";

const client = new S3Client({
  region: "us-west-004", // match your bucket's region
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  credentials: temporaryCredentials,
});

const upload = s3Adapter({
  client,
  putObjectCommand: PutObjectCommand,
  bucket: "videos",
  prefix: "hls",
});
```

**Notes**
- The endpoint host must match the bucket's region exactly.
- B2 application keys are long-lived, so prefer **pre-signed URLs** from your backend
  rather than putting a key in the browser.
- Set CORS rules on the bucket (B2 console → bucket → CORS Rules).

---

## MinIO

Self-hosted and S3-compatible — useful for development and for on-premise deployments.

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Adapter } from "bitrate-js/adapters/s3";

const client = new S3Client({
  region: "us-east-1", // MinIO ignores this but the SDK requires it
  endpoint: "https://minio.example.com",
  forcePathStyle: true, // MinIO uses path-style, not virtual-hosted
  credentials: temporaryCredentials,
});

const upload = s3Adapter({
  client,
  putObjectCommand: PutObjectCommand,
  bucket: "videos",
  prefix: "hls",
});
```

**Notes**
- `forcePathStyle: true` is required.
- Configure CORS on the MinIO server, or upload through a signed URL.
- MinIO supports STS, so short-lived credentials are available here too.

---

## DigitalOcean Spaces

```ts
const client = new S3Client({
  region: "nyc3",
  endpoint: "https://nyc3.digitaloceanspaces.com",
  credentials: temporaryCredentials,
});

const upload = s3Adapter({
  client,
  putObjectCommand: PutObjectCommand,
  bucket: "my-space",
  prefix: "hls",
});
```

**Notes**
- The endpoint's region must match the Space.
- Spaces keys are long-lived; prefer pre-signed URLs.
- Enable the CDN for playback, and set CORS under Settings → CORS Configurations.

---

## Supabase Storage

Supabase is a natural fit because the browser is *meant* to talk to it directly: the `anon`
key is public, and **Row Level Security** decides what each user may write.

```bash
npm install bitrate-js @supabase/supabase-js
```

```ts
import { createClient } from "@supabase/supabase-js";
import { HlsQueue } from "bitrate-js";
import { supabaseAdapter } from "bitrate-js/adapters/supabase";

// The anon key is designed to be public. Never ship a service_role key —
// it bypasses RLS entirely.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
await supabase.auth.signInWithPassword({ email, password });

const queue = new HlsQueue({
  upload: supabaseAdapter({
    client: supabase,
    bucket: "videos",
    prefix: `hls/${userId}`,
    upsert: true, // makes a retry overwrite rather than fail
    segmentCacheSeconds: 31_536_000,
    manifestCacheSeconds: 60,
  }),
});
```

### The RLS policy that allows it

Without a policy, every upload fails with a row-level-security error.

```sql
-- Let a signed-in user write only inside their own folder.
create policy "users upload their own videos"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'videos'
  and (storage.foldername(name))[1] = 'hls'
  and (storage.foldername(name))[2] = auth.uid()::text
);

-- Playback needs the objects to be readable.
create policy "anyone can read videos"
on storage.objects for select
to public
using (bucket_id = 'videos');
```

Making the bucket **public** achieves the read half without a policy.

**Notes**
- The adapter classifies an RLS denial as permanent, so it is not retried pointlessly.
- `upsert: true` keeps retries idempotent.

---

## Appwrite Storage

```bash
npm install bitrate-js appwrite
```

```ts
import { Client, Storage, Account, Permission, Role } from "appwrite";
import { HlsQueue } from "bitrate-js";
import { appwriteAdapter } from "bitrate-js/adapters/appwrite";

// Endpoint, project id and bucket id are all public identifiers.
// An Appwrite API key is a server-side secret — never put one in a browser.
const client = new Client()
  .setEndpoint("https://sfo.cloud.appwrite.io/v1") // must match the project's region
  .setProject(PROJECT_ID);

// Uploads need an identity unless the bucket allows guests.
await new Account(client).createAnonymousSession();

const queue = new HlsQueue({
  upload: appwriteAdapter({
    storage: new Storage(client),
    bucketId: "videos",
    // Required if the bucket has File Security enabled, and needed for playback
    // regardless: a player must be able to fetch every segment.
    permissions: [Permission.read(Role.any())],
  }),
});
```

### Two settings that catch people out

**1. Regional endpoints.** Appwrite Cloud projects live in one region and are only
reachable through that region's host. The wrong one fails with *"Project is not accessible
in this region"*. Copy the API Endpoint from your console under Settings, or use one of:

```
https://fra.cloud.appwrite.io/v1   Frankfurt
https://nyc.cloud.appwrite.io/v1   New York
https://sfo.cloud.appwrite.io/v1   San Francisco
https://syd.cloud.appwrite.io/v1   Sydney
```

**2. File Security.** With it enabled, every created file must carry its own permissions,
or Appwrite answers *"No permissions provided for action 'create'"*. Either pass
`permissions` as above, or turn File Security off and set bucket-level permissions instead.

Also check the bucket's **Allowed File Extensions** — if it is restricted, add `mp4`, `m4s`
and `m3u8`, or clear the list.

**Note on file ids:** Appwrite allows at most 36 characters of `[a-zA-Z0-9._-]`, so segment
names are mapped deterministically. The same file always gets the same id, which keeps
retries idempotent rather than creating duplicates.

---

## Firebase Storage

No dedicated adapter, but the custom form is four lines. Firebase Security Rules play the
role RLS plays for Supabase.

```bash
npm install bitrate-js firebase
```

```ts
import { getStorage, ref, uploadBytes } from "firebase/storage";
import { HlsQueue } from "bitrate-js";

const storage = getStorage(app); // the user is already signed in

const queue = new HlsQueue({
  upload: async (item) => {
    await uploadBytes(ref(storage, `hls/${userId}/${item.name}`), item.blob, {
      contentType: item.contentType,
      cacheControl: item.isManifest
        ? "public, max-age=60"
        : "public, max-age=31536000, immutable",
    });
  },
});
```

```js
// storage.rules
match /hls/{userId}/{file} {
  allow read: if true;
  allow write: if request.auth != null && request.auth.uid == userId;
}
```

---

## Azure Blob Storage

Use a **SAS token** scoped to one blob, issued by your backend. Azure needs one extra
header on a block-blob PUT.

```ts
import { presignedAdapter } from "bitrate-js/adapters/presigned";

const upload = presignedAdapter({
  getUrl: (item) => fetch(`/api/sas?name=${encodeURIComponent(item.name)}`).then((r) => r.text()),
  method: "PUT",
  // Required by Azure; without it the PUT is rejected.
  headers: { "x-ms-blob-type": "BlockBlob" },
});
```

Enable CORS on the storage account for `PUT`, `GET` and `HEAD`, and allow the
`x-ms-blob-type` header.

---

## Google Cloud Storage

GCS supports V4 signed URLs, so the pre-signed adapter applies unchanged.

```ts
const upload = presignedAdapter({
  getUrl: (item) =>
    fetch(`/api/sign?name=${encodeURIComponent(item.name)}&type=${item.contentType}`).then((r) =>
      r.text(),
    ),
});
```

```ts
// Backend
import { Storage } from "@google-cloud/storage";

const [url] = await new Storage()
  .bucket("videos")
  .file(`hls/${userId}/${name}`)
  .getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 5 * 60 * 1000,
    contentType,
  });
```

Set a CORS configuration on the bucket allowing `PUT` from your origin.

---

## Your own server

The general escape hatch, and the right choice for any provider whose upload credential is
a permanent secret: keep the secret on your server and proxy the bytes.

```ts
const queue = new HlsQueue({
  upload: async (item) => {
    const res = await fetch(`/api/videos/${item.jobId}/${encodeURIComponent(item.name)}`, {
      method: "PUT",
      body: item.blob,
      headers: { "Content-Type": item.contentType },
      credentials: "include",
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${res.statusText}`);
  },
});
```

Retries are handled for you, but you can mark a failure as final so it is not retried:

```ts
import { PermanentUploadError } from "bitrate-js";

upload: async (item) => {
  const res = await fetch(url, { method: "PUT", body: item.blob });
  if (res.status === 401 || res.status === 403) {
    // Retrying a rejected credential just wastes time.
    throw new PermanentUploadError(`not authorised to write ${item.name}`);
  }
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
},
```

---

## Cross-cutting settings

### Content types

Playback breaks without these, and browsers will not guess correctly.

| File | Content type |
|---|---|
| `.m3u8` | `application/vnd.apple.mpegurl` |
| `.mp4`, `.m4s` | `video/mp4` |

`item.contentType` already carries the right value — pass it through.

### Cache headers

```
segments   Cache-Control: public, max-age=31536000, immutable
playlists  Cache-Control: public, max-age=60
```

Segments are immutable once written, so they can be cached forever. Playlists may be
rewritten, so keep their lifetime short.

### CORS

Two separate things, and both are needed:

1. **Uploading** — your storage must allow `PUT` from your app's origin.
2. **Playback** — it must allow `GET` from wherever the player runs, since a player fetches
   every segment with `fetch`/XHR.

A missing playback CORS rule shows up as a player that loads the playlist and then stalls.

### Retries

```ts
new HlsQueue({
  retries: 3, // extra attempts per file, with exponential backoff and full jitter
});
```

Adapters classify auth failures, missing buckets and RLS denials as **permanent**, so those
fail fast instead of being retried pointlessly.

### Where the files end up

```
<prefix>/<jobId>_init.mp4      the init segment, loaded once
<prefix>/<jobId>_00000.m4s     media segments
<prefix>/<jobId>.m3u8          the playlist — this is the URL you give a player
```

Job ids are random and never derived from the source file name, so a hostile name cannot
reach a storage key.
