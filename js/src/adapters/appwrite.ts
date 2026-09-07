/**
 * Appwrite Storage adapter.
 *
 * SECURITY: pass a `Storage` instance built from a client authenticated with a
 * **user session**, and set bucket permissions accordingly. Never put an
 * Appwrite API key in browser code — API keys are server-side secrets with
 * project-wide scope (SECURITY.md §1).
 *
 * `appwrite` is an optional peer dependency.
 */

import type { UploadAdapter, UploadItem } from "../types.js";
import { assertSafeKey, PermanentUploadError } from "../upload.js";

/** The slice of Appwrite's `Storage` service this adapter uses. */
export interface AppwriteStorageLike {
  createFile: (
    bucketId: string,
    fileId: string,
    file: File,
    permissions?: string[],
  ) => Promise<unknown>;
}

export interface AppwriteAdapterOptions {
  /** `new Storage(client)` from the Appwrite SDK. */
  storage: AppwriteStorageLike;
  bucketId: string;
  /** Prefix folded into the generated file id. */
  prefix?: string;
  /** Permissions applied to each created file. */
  permissions?: string[];
}

/**
 * Appwrite file ids allow at most 36 characters of `[a-zA-Z0-9._-]` and may not
 * begin with a special character — so HLS names like `job_1/720p_00001.m4s`
 * must be mapped rather than used directly.
 *
 * The mapping is deterministic: the same output file always yields the same id,
 * which keeps retries idempotent.
 */
export function toAppwriteFileId(prefix: string | undefined, name: string): string {
  assertSafeKey(name);
  const raw = `${prefix ? `${prefix}-` : ""}${name}`;
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "");

  if (cleaned.length <= 36) return cleaned || "f";

  // Too long: keep a readable tail (the part that differs between segments) and
  // prepend a short hash of the full name so ids stay unique.
  const hash = fnv1a(raw).toString(36).padStart(7, "0").slice(0, 7);
  return `${hash}-${cleaned.slice(cleaned.length - 28)}`;
}

/** FNV-1a, 32-bit — small, dependency-free, and adequate for id disambiguation. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Build an {@link UploadAdapter} that writes to Appwrite Storage.
 *
 * @example
 * ```ts
 * import { Client, Storage } from "appwrite";
 * import { appwriteAdapter } from "bitrate-js/adapters/appwrite";
 *
 * const client = new Client().setEndpoint(endpoint).setProject(projectId);
 * const upload = appwriteAdapter({ storage: new Storage(client), bucketId: "videos" });
 * ```
 */
export function appwriteAdapter(options: AppwriteAdapterOptions): UploadAdapter {
  const { storage, bucketId, prefix, permissions } = options;

  if (!bucketId) throw new Error("appwriteAdapter: `bucketId` is required");
  if (typeof storage?.createFile !== "function") {
    throw new Error("appwriteAdapter: `storage` must be an Appwrite Storage instance");
  }

  return async function upload(item: UploadItem): Promise<void> {
    const fileId = toAppwriteFileId(prefix, item.name);
    const file = new File([item.blob], item.name, { type: item.contentType });

    try {
      await storage.createFile(bucketId, fileId, file, permissions);
    } catch (error) {
      const code = (error as { code?: number })?.code;
      const message = (error as { message?: string })?.message ?? String(error);

      const permanent =
        code === 400 ||
        code === 401 ||
        code === 403 ||
        code === 404 ||
        /not authorized|missing scope|Bucket with the requested ID could not be found/i.test(message);

      const text = `Appwrite upload failed for "${item.name}" (id ${fileId}): ${message}`;
      throw permanent ? new PermanentUploadError(text, { cause: error }) : new Error(text, { cause: error });
    }
  };
}
