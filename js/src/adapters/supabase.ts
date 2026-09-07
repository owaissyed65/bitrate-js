/**
 * Supabase Storage adapter.
 *
 * SECURITY: pass a Supabase client your app already created with the **anon**
 * key, and protect the bucket with Row Level Security policies. Never ship a
 * `service_role` key to the browser — it bypasses RLS entirely and grants full
 * access to your project (SECURITY.md §1).
 *
 * `@supabase/supabase-js` is an optional peer dependency.
 */

import type { UploadAdapter, UploadItem } from "../types.js";
import { joinKey, PermanentUploadError } from "../upload.js";

/** The slice of the Supabase client this adapter uses. */
export interface SupabaseClientLike {
  storage: {
    from: (bucket: string) => {
      upload: (
        path: string,
        body: Blob,
        options?: { contentType?: string; upsert?: boolean; cacheControl?: string },
      ) => Promise<{ error: { message: string; statusCode?: string } | null }>;
    };
  };
}

export interface SupabaseAdapterOptions {
  /** A client created with `createClient(url, anonKey)`. */
  client: SupabaseClientLike;
  bucket: string;
  /** Path prefix inside the bucket. */
  prefix?: string;
  /** Overwrite existing objects. Default `true`, so retries are idempotent. */
  upsert?: boolean;
  /** Cache lifetime in seconds for segments. */
  segmentCacheSeconds?: number;
  /** Cache lifetime in seconds for playlists. */
  manifestCacheSeconds?: number;
}

/**
 * Build an {@link UploadAdapter} that writes to Supabase Storage.
 *
 * @example
 * ```ts
 * import { createClient } from "@supabase/supabase-js";
 * import { supabaseAdapter } from "bitrate-js/adapters/supabase";
 *
 * const upload = supabaseAdapter({
 *   client: createClient(url, anonKey),
 *   bucket: "videos",
 *   prefix: "hls",
 * });
 * ```
 */
export function supabaseAdapter(options: SupabaseAdapterOptions): UploadAdapter {
  const {
    client,
    bucket,
    prefix,
    upsert = true,
    segmentCacheSeconds = 31_536_000,
    manifestCacheSeconds = 60,
  } = options;

  if (!bucket) throw new Error("supabaseAdapter: `bucket` is required");
  if (typeof client?.storage?.from !== "function") {
    throw new Error("supabaseAdapter: `client` must be a Supabase client");
  }

  return async function upload(item: UploadItem): Promise<void> {
    const path = joinKey(prefix, item.name);

    const { error } = await client.storage.from(bucket).upload(path, item.blob, {
      contentType: item.contentType,
      upsert,
      cacheControl: String(item.isManifest ? manifestCacheSeconds : segmentCacheSeconds),
    });

    if (!error) return;

    // An RLS denial or a missing bucket will not resolve by retrying.
    const status = Number(error.statusCode);
    const permanent =
      status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      /row-level security|not authorized|Bucket not found|invalid/i.test(error.message);

    const message = `Supabase upload failed for "${path}": ${error.message}`;
    throw permanent ? new PermanentUploadError(message) : new Error(message);
  };
}
