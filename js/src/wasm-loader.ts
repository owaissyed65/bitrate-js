/**
 * One-time WASM initialization.
 *
 * wasm-pack's `web` target requires an explicit init before any export is
 * callable. Every entry point funnels through {@link ensureWasm} so callers
 * never have to think about it, and concurrent callers share a single load.
 */

import init from "./wasm/bitrate_core.js";
import { wasmBytes } from "./wasm-inline.js";

let ready: Promise<void> | null = null;

/**
 * Initialize the WASM module, at most once per page.
 *
 * The module is embedded in the bundle, so this needs no network request, no
 * asset copying and no bundler configuration.
 *
 * @param moduleOrPath Optional override — a URL, `Response`, `BufferSource` or
 *   compiled `WebAssembly.Module`. Only needed if you would rather fetch the
 *   `.wasm` separately than use the embedded copy.
 */
export function ensureWasm(
  moduleOrPath?: string | URL | Response | BufferSource | WebAssembly.Module,
): Promise<void> {
  ready ??= (async () => {
    await init({ module_or_path: moduleOrPath ?? wasmBytes() });
  })().catch((err: unknown) => {
    // Let a later call retry rather than caching the failure forever.
    ready = null;
    throw err;
  });
  return ready;
}

/** Testing seam: forget any previous initialization. */
export function resetWasmForTests(): void {
  ready = null;
}
