/**
 * Firebase Storage adapter.
 *
 * SECURITY: pass the `FirebaseStorage` instance your app already created for a
 * signed-in user, and let Security Rules decide what that user may write. There
 * is no key to hand over here and none should ever appear in browser code — a
 * service account JSON is a server credential (SECURITY.md §1).
 *
 * `firebase` is an optional peer dependency, and is never bundled: the two
 * functions this needs are passed in, the same way the S3 adapter takes
 * `PutObjectCommand`. That keeps the SDK out of the graph for everyone not
 * using it.
 */

import type { UploadAdapter, UploadItem } from "../types.js";
import { joinKey, PermanentUploadError } from "../upload.js";

/** A `StorageReference`, opaque here — it is only handed straight back. */
export type StorageRefLike = object;

/** The slice of `firebase/storage` this adapter uses. */
export interface FirebaseStorageDeps {
  /** The instance from `getStorage(app)`. */
  storage: object;
  /** `ref` from `firebase/storage`. */
  ref: (storage: object, path: string) => StorageRefLike;
  /** `uploadBytes` from `firebase/storage`. */
  uploadBytes: (
    reference: StorageRefLike,
    data: Blob,
    metadata?: { contentType?: string; cacheControl?: string },
  ) => Promise<unknown>;
}

export interface FirebaseAdapterOptions extends FirebaseStorageDeps {
  /** Path prefix inside the bucket, e.g. `hls/<userId>`. */
  prefix?: string;
  /** Cache lifetime in seconds for segments. Immutable, so effectively forever. */
  segmentCacheSeconds?: number;
  /**
   * Cache lifetime in seconds for playlists.
   *
   * Short by design: a playlist is rewritten as a job progresses, and a cached
   * one leaves players reading a stale segment list.
   */
  manifestCacheSeconds?: number;
}

/**
 * Firebase reports failures by `code`. These will not resolve by retrying, so
 * the queue should move on to the next file rather than burn its attempts.
 */
const PERMANENT = new Set([
  "storage/unauthorized",
  "storage/unauthenticated",
  "storage/invalid-argument",
  "storage/invalid-checksum",
  "storage/bucket-not-found",
  "storage/project-not-found",
  "storage/quota-exceeded",
  "storage/unsupported-environment",
]);

/**
 * Build an {@link UploadAdapter} that writes to Firebase Storage.
 *
 * @example
 * ```ts
 * import { getStorage, ref, uploadBytes } from "firebase/storage";
 * import { firebaseAdapter } from "bitrate-js/adapters/firebase";
 *
 * const upload = firebaseAdapter({
 *   storage: getStorage(app),
 *   ref,
 *   uploadBytes,
 *   prefix: `hls/${user.uid}`,
 * });
 * ```
 *
 * The matching rule, without which every upload is rejected before it starts:
 *
 * ```
 * match /hls/{userId}/{file} {
 *   allow read: if true;
 *   allow write: if request.auth != null && request.auth.uid == userId;
 * }
 * ```
 */
export function firebaseAdapter(options: FirebaseAdapterOptions): UploadAdapter {
  const {
    storage,
    ref,
    uploadBytes,
    prefix,
    segmentCacheSeconds = 31_536_000,
    manifestCacheSeconds = 60,
  } = options;

  if (!storage) throw new Error("firebaseAdapter: `storage` is required");
  if (typeof ref !== "function" || typeof uploadBytes !== "function") {
    throw new Error(
      "firebaseAdapter: pass `ref` and `uploadBytes` imported from \"firebase/storage\"",
    );
  }

  return async function upload(item: UploadItem): Promise<void> {
    const path = joinKey(prefix, item.name);

    try {
      await uploadBytes(ref(storage, path), item.blob, {
        contentType: item.contentType,
        cacheControl: item.isManifest
          ? `public, max-age=${manifestCacheSeconds}`
          : `public, max-age=${segmentCacheSeconds}, immutable`,
      });
    } catch (error) {
      const code = (error as { code?: string })?.code ?? "";
      const detail = (error as { message?: string })?.message ?? String(error);
      const message = `Firebase upload failed for "${path}": ${detail}`;

      throw PERMANENT.has(code) ? new PermanentUploadError(message) : new Error(message);
    }
  };
}
