import { useState } from "react";

/**
 * A browsable reference for every supported upload target.
 *
 * The same information lives in ADAPTERS.md; having it in the app means the
 * configuration is next to the thing that produces the files, and the
 * provider-specific gotchas are visible before someone hits them.
 */

interface Provider {
  id: string;
  name: string;
  note: string;
  /** How credentials are kept out of the browser. */
  auth: string;
  install: string;
  code: string;
  /** Provider-specific settings people miss. */
  gotchas: { title: string; detail: string }[];
}

const PROVIDERS: Provider[] = [
  {
    id: "presigned",
    name: "Pre-signed URL",
    note: "Works with S3, R2, B2, MinIO, GCS, Azure — anything that can sign an upload. Start here.",
    auth: "Your backend signs a short-lived URL for one object. No credential reaches the browser.",
    install: "npm install bitrate-js",
    code: `import { HlsQueue } from "bitrate-js";
import { presignedAdapter } from "bitrate-js/adapters/presigned";

const queue = new HlsQueue({
  retries: 3,
  upload: presignedAdapter({
    getUrl: async (item) => {
      const res = await fetch(
        \`/api/sign?name=\${encodeURIComponent(item.name)}\` +
        \`&type=\${encodeURIComponent(item.contentType)}\`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(\`signing failed: \${res.status}\`);
      return res.text();
    },
  }),
});

// ---- the backend that signs (Node + AWS SDK v3) ----
app.get("/api/sign", requireAuth, async (req, res) => {
  const name = String(req.query.name ?? "");

  // Never sign a caller-supplied path verbatim: that would let anyone
  // write anywhere in the bucket.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) return res.status(400).end();

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: process.env.BUCKET,
      Key: \`hls/\${req.user.id}/\${name}\`,   // scoped to this user
      ContentType: String(req.query.type),
    }),
    { expiresIn: 300 },                    // minutes, not days
  );
  res.type("text/plain").send(url);
});`,
    gotchas: [
      {
        title: "One object per signature",
        detail: "Sign a specific key with a short expiry, never a prefix or a wildcard.",
      },
      {
        title: "Signatures leak in logs",
        detail: "The adapter strips query strings from error messages so a failure never logs one.",
      },
    ],
  },
  {
    id: "s3",
    name: "AWS S3",
    note: "Also the base for R2, B2, MinIO and Spaces — they all speak the S3 API.",
    auth: "An S3 client your app built from temporary STS credentials. Never permanent IAM keys.",
    install: "npm install bitrate-js @aws-sdk/client-s3",
    code: `import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Adapter } from "bitrate-js/adapters/s3";

// Credentials come from your backend and expire.
const creds = await fetch("/api/storage-credentials").then((r) => r.json());

const client = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  },
});

const upload = s3Adapter({
  client,
  putObjectCommand: PutObjectCommand,
  bucket: "my-videos",
  prefix: \`hls/\${userId}\`,
  segmentCacheControl: "public, max-age=31536000, immutable",
  manifestCacheControl: "public, max-age=60",
});

// ---- bucket CORS, without which browser uploads fail ----
[{
  "AllowedOrigins": ["https://yourapp.com"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000
}]`,
    gotchas: [
      {
        title: "CORS is required twice",
        detail:
          "PUT from your origin for uploading, and GET for playback — a player fetches every segment.",
      },
      {
        title: "Scope the STS role",
        detail: "Limit the assumed role to s3:PutObject on that user's prefix only.",
      },
    ],
  },
  {
    id: "r2",
    name: "Cloudflare R2",
    note: "S3-compatible, with zero egress fees — which matters when every viewer downloads every segment.",
    auth: "Same as S3: a client from temporary credentials, or pre-signed URLs.",
    install: "npm install bitrate-js @aws-sdk/client-s3",
    code: `import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Adapter } from "bitrate-js/adapters/s3";

const client = new S3Client({
  region: "auto",                                   // R2 requires exactly this
  endpoint: \`https://\${ACCOUNT_ID}.r2.cloudflarestorage.com\`,
  credentials: temporaryCredentials,
});

const upload = s3Adapter({
  client,
  putObjectCommand: PutObjectCommand,
  bucket: "videos",
  prefix: "hls",
});`,
    gotchas: [
      { title: 'region must be "auto"', detail: "Any other value is rejected." },
      {
        title: "Serve playback from a custom domain",
        detail:
          "The r2.cloudflarestorage.com endpoint is the API. Viewers need a public bucket or a custom domain.",
      },
    ],
  },
  {
    id: "b2",
    name: "Backblaze B2",
    note: "S3-compatible. Egress to Cloudflare is free, which pairs well with HLS.",
    auth: "B2 application keys are long-lived, so prefer pre-signed URLs from your backend.",
    install: "npm install bitrate-js @aws-sdk/client-s3",
    code: `const client = new S3Client({
  region: "us-west-004",                            // match your bucket
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  credentials: temporaryCredentials,
});

const upload = s3Adapter({
  client,
  putObjectCommand: PutObjectCommand,
  bucket: "videos",
  prefix: "hls",
});`,
    gotchas: [
      {
        title: "Endpoint region must match the bucket",
        detail: "A mismatched host fails in a way that looks like a credential problem.",
      },
    ],
  },
  {
    id: "minio",
    name: "MinIO",
    note: "Self-hosted and S3-compatible. Handy for development and on-premise deployments.",
    auth: "MinIO supports STS, so short-lived credentials work here too.",
    install: "npm install bitrate-js @aws-sdk/client-s3",
    code: `const client = new S3Client({
  region: "us-east-1",        // ignored by MinIO, required by the SDK
  endpoint: "https://minio.example.com",
  forcePathStyle: true,       // MinIO uses path-style addressing
  credentials: temporaryCredentials,
});

const upload = s3Adapter({
  client,
  putObjectCommand: PutObjectCommand,
  bucket: "videos",
  prefix: "hls",
});`,
    gotchas: [
      {
        title: "forcePathStyle is required",
        detail: "Without it the SDK builds virtual-hosted URLs that MinIO does not serve.",
      },
    ],
  },
  {
    id: "spaces",
    name: "DigitalOcean Spaces",
    note: "S3-compatible object storage with an optional CDN in front.",
    auth: "Spaces keys are long-lived; prefer pre-signed URLs.",
    install: "npm install bitrate-js @aws-sdk/client-s3",
    code: `const client = new S3Client({
  region: "nyc3",
  endpoint: "https://nyc3.digitaloceanspaces.com",
  credentials: temporaryCredentials,
});

const upload = s3Adapter({
  client,
  putObjectCommand: PutObjectCommand,
  bucket: "my-space",
  prefix: "hls",
});`,
    gotchas: [
      {
        title: "Enable the CDN for playback",
        detail: "Set CORS under Settings → CORS Configurations for both PUT and GET.",
      },
    ],
  },
  {
    id: "supabase",
    name: "Supabase Storage",
    note: "Designed for the browser to talk to directly — the anon key is public and RLS decides what may be written.",
    auth: "anon key plus Row Level Security. Never a service_role key: it bypasses RLS entirely.",
    install: "npm install bitrate-js @supabase/supabase-js",
    code: `import { createClient } from "@supabase/supabase-js";
import { supabaseAdapter } from "bitrate-js/adapters/supabase";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
await supabase.auth.signInWithPassword({ email, password });

const upload = supabaseAdapter({
  client: supabase,
  bucket: "videos",
  prefix: \`hls/\${userId}\`,
  upsert: true,               // makes a retry overwrite rather than fail
  segmentCacheSeconds: 31_536_000,
  manifestCacheSeconds: 60,
});

-- ---- the RLS policy that allows it ----
create policy "users upload their own videos"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'videos'
  and (storage.foldername(name))[2] = auth.uid()::text
);

-- playback needs the objects to be readable
create policy "anyone can read videos"
on storage.objects for select
to public
using (bucket_id = 'videos');`,
    gotchas: [
      {
        title: "Without a policy, every upload fails",
        detail:
          "A row-level-security denial is classified as permanent, so it is not retried pointlessly.",
      },
      {
        title: "upsert: true keeps retries idempotent",
        detail: "Otherwise a retried segment collides with the one already there.",
      },
    ],
  },
  {
    id: "appwrite",
    name: "Appwrite Storage",
    note: "Endpoint, project id and bucket id are all public identifiers that ship in any Appwrite client bundle.",
    auth: "A session-scoped client. An Appwrite API key is a server-side secret and must never reach a browser.",
    install: "npm install bitrate-js appwrite",
    code: `import { Client, Storage, Account, Permission, Role } from "appwrite";
import { appwriteAdapter } from "bitrate-js/adapters/appwrite";

const client = new Client()
  .setEndpoint("https://sfo.cloud.appwrite.io/v1")  // must match the project's region
  .setProject(PROJECT_ID);

// Uploads need an identity unless the bucket allows guests.
await new Account(client).createAnonymousSession();

const upload = appwriteAdapter({
  storage: new Storage(client),
  bucketId: "videos",
  // Required when the bucket has File Security on, and needed for playback
  // regardless: a player must be able to fetch every segment.
  permissions: [Permission.read(Role.any())],
});`,
    gotchas: [
      {
        title: "Projects are regional",
        detail:
          'Using the wrong host fails with "Project is not accessible in this region". Copy the API Endpoint from your console under Settings — fra / nyc / sfo / syd.',
      },
      {
        title: "File Security demands per-file permissions",
        detail:
          "With it enabled, a create carrying none fails with \"No permissions provided for action 'create'\". Pass permissions, or turn it off and use bucket-level ones.",
      },
      {
        title: "Check allowed file extensions",
        detail: "If the bucket restricts them, add mp4, m4s and m3u8 or clear the list.",
      },
    ],
  },
  {
    id: "firebase",
    name: "Firebase Storage",
    note: "No dedicated adapter needed — the custom form is four lines.",
    auth: "The signed-in Firebase user, with Security Rules deciding what they may write.",
    install: "npm install bitrate-js firebase",
    code: `import { getStorage, ref, uploadBytes } from "firebase/storage";

const storage = getStorage(app);   // the user is already signed in

const upload = async (item) => {
  await uploadBytes(ref(storage, \`hls/\${userId}/\${item.name}\`), item.blob, {
    contentType: item.contentType,
    cacheControl: item.isManifest
      ? "public, max-age=60"
      : "public, max-age=31536000, immutable",
  });
};

// ---- storage.rules ----
match /hls/{userId}/{file} {
  allow read: if true;
  allow write: if request.auth != null && request.auth.uid == userId;
}`,
    gotchas: [
      {
        title: "Rules replace RLS here",
        detail: "Without a matching rule the upload is rejected before it starts.",
      },
    ],
  },
  {
    id: "azure",
    name: "Azure Blob Storage",
    note: "Use a SAS token scoped to one blob, issued by your backend.",
    auth: "A short-lived SAS token. The account key stays on your server.",
    install: "npm install bitrate-js",
    code: `import { presignedAdapter } from "bitrate-js/adapters/presigned";

const upload = presignedAdapter({
  getUrl: (item) =>
    fetch(\`/api/sas?name=\${encodeURIComponent(item.name)}\`).then((r) => r.text()),
  method: "PUT",
  // Required by Azure; without it the PUT is rejected.
  headers: { "x-ms-blob-type": "BlockBlob" },
});`,
    gotchas: [
      {
        title: "x-ms-blob-type is mandatory",
        detail: "Allow that header in the account's CORS rules as well.",
      },
    ],
  },
  {
    id: "gcs",
    name: "Google Cloud Storage",
    note: "V4 signed URLs, so the pre-signed adapter applies unchanged.",
    auth: "A V4 signed URL from your backend.",
    install: "npm install bitrate-js",
    code: `import { presignedAdapter } from "bitrate-js/adapters/presigned";

const upload = presignedAdapter({
  getUrl: (item) =>
    fetch(\`/api/sign?name=\${encodeURIComponent(item.name)}&type=\${item.contentType}\`)
      .then((r) => r.text()),
});

// ---- backend ----
import { Storage } from "@google-cloud/storage";

const [url] = await new Storage()
  .bucket("videos")
  .file(\`hls/\${userId}/\${name}\`)
  .getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 5 * 60 * 1000,
    contentType,
  });`,
    gotchas: [
      {
        title: "contentType must match",
        detail: "The signature covers it, so the PUT must send exactly what was signed.",
      },
    ],
  },
  {
    id: "custom",
    name: "Your own server",
    note: "The general escape hatch — and the right answer for any provider whose upload credential is a permanent secret.",
    auth: "Your existing session. The secret never leaves your server.",
    install: "npm install bitrate-js",
    code: `import { HlsQueue, PermanentUploadError } from "bitrate-js";

const queue = new HlsQueue({
  retries: 3,
  upload: async (item) => {
    const res = await fetch(
      \`/api/videos/\${item.jobId}/\${encodeURIComponent(item.name)}\`,
      {
        method: "PUT",
        body: item.blob,
        headers: { "Content-Type": item.contentType },
        credentials: "include",
      },
    );

    if (res.status === 401 || res.status === 403) {
      // Retrying a rejected credential just wastes time.
      throw new PermanentUploadError(\`not authorised to write \${item.name}\`);
    }
    if (!res.ok) throw new Error(\`upload failed: \${res.status}\`);
  },
});`,
    gotchas: [
      {
        title: "Throw PermanentUploadError to stop retries",
        detail: "Anything else is treated as transient and retried with backoff.",
      },
    ],
  },
];

export function AdaptersPanel() {
  const [selected, setSelected] = useState(PROVIDERS[0]!.id);
  const provider = PROVIDERS.find((p) => p.id === selected)!;

  return (
    <>
      <section className="card">
        <h2>Where the output goes</h2>
        <p className="lede">
          Every file reaches your uploader in the same shape, so one contract covers every
          backend. Pick a provider for its exact configuration.
        </p>

        <pre style={{ marginBottom: "1rem" }}>{`type UploadItem = {
  jobId: string;       // which source video this belongs to
  name: string;        // path to store as, e.g. "job_1_00001.m4s"
  blob: Blob;          // the bytes
  contentType: string; // "video/mp4" | "application/vnd.apple.mpegurl"
  isManifest: boolean; // true for .m3u8 — useful for cache headers
};`}</pre>

        <p className="note err">
          <strong>Never put a long-lived credential in browser code.</strong> Anything shipped to
          the client is readable in DevTools. Every example below uses either a short-lived
          signed URL or a session-scoped client.
        </p>

        <div className="row" style={{ marginTop: "1rem" }}>
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              className={`small ${p.id === selected ? "" : "ghost"}`}
              onClick={() => setSelected(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>{provider.name}</h2>
        <p className="lede">{provider.note}</p>

        <p className="note ok">
          <strong>Auth:</strong> {provider.auth}
        </p>

        <pre style={{ marginTop: "1rem" }}>{provider.install}</pre>
        <pre style={{ marginTop: "0.6rem", maxHeight: 460 }}>{provider.code}</pre>
      </section>

      {provider.gotchas.length > 0 && (
        <section className="card">
          <h2>Worth knowing</h2>
          {provider.gotchas.map((g) => (
            <p key={g.title} className="note warn" style={{ marginBottom: "0.7rem" }}>
              <strong>{g.title}</strong>
              <br />
              {g.detail}
            </p>
          ))}
        </section>
      )}

      <section className="card">
        <h2>Applies to every provider</h2>

        <h3 style={{ fontSize: "0.92rem", margin: "0 0 0.4rem" }}>Content types</h3>
        <p className="lede">Playback breaks without these, and browsers will not guess.</p>
        <table>
          <tbody>
            <tr>
              <td className="mono">.m3u8</td>
              <td className="mono">application/vnd.apple.mpegurl</td>
            </tr>
            <tr>
              <td className="mono">.mp4 · .m4s</td>
              <td className="mono">video/mp4</td>
            </tr>
          </tbody>
        </table>
        <p className="note" style={{ marginTop: "0.6rem" }}>
          <code>item.contentType</code> already carries the right value — pass it through.
        </p>

        <h3 style={{ fontSize: "0.92rem", margin: "1.2rem 0 0.4rem" }}>Cache headers</h3>
        <pre>{`segments   Cache-Control: public, max-age=31536000, immutable
playlists  Cache-Control: public, max-age=60`}</pre>
        <p className="note" style={{ marginTop: "0.6rem" }}>
          Segments never change once written; playlists might.
        </p>

        <h3 style={{ fontSize: "0.92rem", margin: "1.2rem 0 0.4rem" }}>CORS, twice</h3>
        <p className="note warn">
          <strong>Uploading</strong> needs <code>PUT</code> allowed from your app's origin.
          <br />
          <strong>Playback</strong> needs <code>GET</code> allowed from wherever the player runs,
          since a player fetches every segment itself. A missing playback rule looks like a player
          that loads the playlist and then stalls.
        </p>

        <h3 style={{ fontSize: "0.92rem", margin: "1.2rem 0 0.4rem" }}>Where files land</h3>
        <pre>{`<prefix>/<jobId>_init.mp4     the init segment, loaded once
<prefix>/<jobId>_00000.m4s    media segments
<prefix>/<jobId>.m3u8         the playlist — the URL you give a player`}</pre>
        <p className="note" style={{ marginTop: "0.6rem" }}>
          Job ids are random and never derived from the source file name, so a hostile name cannot
          reach a storage key.
        </p>
      </section>
    </>
  );
}
