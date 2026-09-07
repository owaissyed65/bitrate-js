/**
 * S3 adapter — also covers every S3-compatible service: Cloudflare R2,
 * Backblaze B2, MinIO, DigitalOcean Spaces, Wasabi.
 *
 * SECURITY: this adapter accepts a client your app already configured; it never
 * takes access keys. Putting long-lived IAM credentials in browser code exposes
 * them to every visitor. Configure the client with short-lived STS credentials,
 * or prefer `presignedAdapter` and sign URLs on your backend (SECURITY.md §1).
 *
 * `@aws-sdk/client-s3` is an optional peer dependency — install it only if you
 * use this adapter.
 */

import type { UploadAdapter, UploadItem } from "../types.js";
import { joinKey, PermanentUploadError } from "../upload.js";

/**
 * The slice of the S3 client this adapter uses.
 *
 * Declared structurally so we neither import nor pin the AWS SDK.
 */
export interface S3ClientLike {
  send: (command: unknown) => Promise<unknown>;
}

/** The `PutObjectCommand` constructor from `@aws-sdk/client-s3`. */
export type PutObjectCommandCtor = new (input: {
  Bucket: string;
  Key: string;
  Body: Uint8Array;
  ContentType: string;
  CacheControl?: string;
}) => unknown;

export interface S3AdapterOptions {
  /** An S3 client your application constructed and authenticated. */
  client: S3ClientLike;
  /** `PutObjectCommand`, imported by you from `@aws-sdk/client-s3`. */
  putObjectCommand: PutObjectCommandCtor;
  bucket: string;
  /** Key prefix, e.g. `"hls"`. Segments are stored under `<prefix>/<name>`. */
  prefix?: string;
  /**
   * `Cache-Control` for media segments. Segments are immutable once written,
   * so a long TTL is safe and worthwhile.
   */
  segmentCacheControl?: string;
  /** `Cache-Control` for playlists, which may be rewritten. */
  manifestCacheControl?: string;
}

/**
 * Build an {@link UploadAdapter} that writes to an S3-compatible bucket.
 *
 * @example
 * ```ts
 * import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
 * import { s3Adapter } from "bitrate-js/adapters/s3";
 *
 * const upload = s3Adapter({
 *   client: new S3Client({ region: "us-east-1", credentials: temporaryCreds }),
 *   putObjectCommand: PutObjectCommand,
 *   bucket: "videos",
 *   prefix: "hls",
 * });
 * ```
 */
export function s3Adapter(options: S3AdapterOptions): UploadAdapter {
  const {
    client,
    putObjectCommand: PutObjectCommand,
    bucket,
    prefix,
    segmentCacheControl = "public, max-age=31536000, immutable",
    manifestCacheControl = "public, max-age=60",
  } = options;

  if (!bucket) throw new Error("s3Adapter: `bucket` is required");
  if (typeof client?.send !== "function") {
    throw new Error("s3Adapter: `client` must be an S3 client with a send() method");
  }
  if (typeof PutObjectCommand !== "function") {
    throw new Error(
      "s3Adapter: `putObjectCommand` is required — import PutObjectCommand from @aws-sdk/client-s3",
    );
  }

  return async function upload(item: UploadItem): Promise<void> {
    const key = joinKey(prefix, item.name);
    const body = new Uint8Array(await item.blob.arrayBuffer());

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: item.contentType,
          CacheControl: item.isManifest ? manifestCacheControl : segmentCacheControl,
        }),
      );
    } catch (error) {
      throw toUploadError(error, key);
    }
  };
}

/**
 * Classify an S3 failure. Auth, permission and missing-bucket errors will fail
 * identically on every retry, so surface them immediately.
 */
function toUploadError(error: unknown, key: string): Error {
  const name = (error as { name?: string })?.name ?? "";
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

  const permanent =
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    /AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|NoSuchBucket|ExpiredToken/.test(name);

  const message = `S3 upload failed for "${key}"${status ? ` (HTTP ${status})` : ""}: ${name || String(error)}`;
  return permanent
    ? new PermanentUploadError(message, { cause: error })
    : new Error(message, { cause: error });
}
