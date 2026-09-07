/**
 * Pre-signed URL adapter — the recommended, most secure upload path.
 *
 * Your backend signs a short-lived URL scoped to a single object; the browser PUTs
 * the bytes to it. No credential ever reaches the client. Works with S3, R2, B2,
 * MinIO, GCS, Azure Blob — anything that supports signed uploads.
 *
 * See SECURITY.md §1.
 */

import type { UploadAdapter, UploadItem } from "../types.js";

export interface PresignedOptions {
  /**
   * Ask your backend for a short-lived upload URL for `item.name`.
   *
   * Your endpoint must authenticate the user and constrain the signature to a
   * single key under the intended prefix — never sign arbitrary caller-supplied
   * paths, and keep the expiry to minutes.
   */
  getUrl: (item: UploadItem) => Promise<string> | string;
  /** HTTP method the signature was issued for. Default `"PUT"`. */
  method?: "PUT" | "POST";
  /**
   * Extra headers. Must match whatever your signature covers.
   *
   * A function receives the file, which is what lets a playlist and a segment
   * carry different cache lifetimes — segments are immutable and a playlist is
   * rewritten as the job progresses, so one value cannot suit both. Azure needs
   * a fixed header here (`x-ms-blob-type: BlockBlob`), which the object form
   * covers.
   */
  headers?: Record<string, string> | ((item: UploadItem) => Record<string, string>);
}

/** Strip the query string so signed URLs never leak into logs or error messages. */
function redact(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : `${url.slice(0, q)}?<redacted>`;
}

/** Create an {@link UploadAdapter} that PUTs each file to a freshly signed URL. */
export function presignedAdapter(opts: PresignedOptions): UploadAdapter {
  const method = opts.method ?? "PUT";

  return async function upload(item: UploadItem): Promise<void> {
    const url = await opts.getUrl(item);
    const extra = typeof opts.headers === "function" ? opts.headers(item) : opts.headers;

    const res = await fetch(url, {
      method,
      body: item.blob,
      headers: { "Content-Type": item.contentType, ...extra },
      // Signed URLs carry their own auth; never attach ambient cookies.
      credentials: "omit",
      mode: "cors",
    });

    if (!res.ok) {
      throw new Error(
        `Upload failed for "${item.name}": ${res.status} ${res.statusText} (${redact(url)})`,
      );
    }
  };
}
