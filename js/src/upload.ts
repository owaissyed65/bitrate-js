/**
 * Upload plumbing shared by every adapter.
 *
 * The package never takes cloud credentials (SECURITY.md §1) — an adapter is
 * just a function that puts bytes somewhere, supplied by the consuming app.
 */

import type { UploadAdapter, UploadItem } from "./types.js";

/** Default backoff schedule; each retry waits roughly twice as long. */
const BASE_DELAY_MS = 300;
const MAX_DELAY_MS = 10_000;

export interface RetryOptions {
  /** Extra attempts after the first. `0` means try once. */
  retries?: number;
  /** Cancels waiting and further attempts. */
  signal?: AbortSignal | undefined;
  /** Injected in tests; defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called before each retry, for logging or UI. */
  onRetry?: ((info: { attempt: number; delayMs: number; error: unknown }) => void) | undefined;
}

/** An error that should not be retried, however many attempts remain. */
export class PermanentUploadError extends Error {
  override readonly name = "PermanentUploadError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Wait `ms`, rejecting early if `signal` aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wrap an adapter so transient failures are retried with exponential backoff
 * and full jitter.
 *
 * Jitter matters: a queue that retries dozens of segments in lockstep would
 * otherwise hammer the storage endpoint in synchronized waves.
 */
export function withRetry(adapter: UploadAdapter, options: RetryOptions = {}): UploadAdapter {
  const { retries = 0, signal, sleep = delay, onRetry } = options;

  return async function upload(item: UploadItem): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      signal?.throwIfAborted();
      try {
        await adapter(item);
        return;
      } catch (error) {
        lastError = error;

        // A rejected credential or a 404 bucket will fail identically forever.
        if (error instanceof PermanentUploadError) throw error;
        if (attempt === retries) break;

        const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
        const delayMs = Math.round(Math.random() * ceiling);
        onRetry?.({ attempt: attempt + 1, delayMs, error });
        await sleep(delayMs, signal);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Upload of "${item.name}" failed: ${String(lastError)}`);
  };
}

/**
 * Reject object keys that could escape their intended prefix.
 *
 * The Rust core sanitizes names it generates, but an adapter may join them with
 * a caller-supplied prefix; this is the last line of defence (SECURITY.md §2).
 */
function hasControlChars(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function assertSafeKey(key: string): string {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\\") ||
    hasControlChars(key)
  ) {
    throw new PermanentUploadError(`Unsafe object key rejected: ${JSON.stringify(key)}`);
  }
  return key;
}

/** Join a prefix and a name into a safe object key. */
export function joinKey(prefix: string | undefined, name: string): string {
  const cleaned = (prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  return assertSafeKey(cleaned ? `${cleaned}/${name}` : name);
}
