/**
 * Embed the compiled WASM into a TypeScript module as base64.
 *
 * Shipping a separate `.wasm` asset would make consumers configure their
 * bundler (and is a classic "works in dev, 404s in production" trap). Inlining
 * costs ~33% in size but makes `npm install` enough — no config in Vite,
 * webpack, Next.js, Rollup or anything else.
 *
 * Run after `wasm-pack`; the generated file is git-ignored and rebuilt.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(new URL("../src/wasm/bitrate_core_bg.wasm", import.meta.url));
const outPath = fileURLToPath(new URL("../src/wasm-inline.ts", import.meta.url));

const bytes = await readFile(wasmPath);
const base64 = bytes.toString("base64");

const source = `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by \`scripts/inline-wasm.mjs\` from \`bitrate_core_bg.wasm\`
 * (${bytes.length.toLocaleString("en-US")} bytes). Regenerate with \`npm run build\`.
 */

const BASE64 =
  "${base64}";

/** Decode the embedded module into bytes the WASM loader can instantiate. */
export function wasmBytes(): Uint8Array {
  // \`atob\` in browsers and workers; \`Buffer\` when running under Node.
  if (typeof atob === "function") {
    const binary = atob(BASE64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(BASE64, "base64"));
}
`;

await writeFile(outPath, source, "utf8");
console.log(
  `inlined ${bytes.length.toLocaleString("en-US")} bytes of wasm -> ${(base64.length / 1024).toFixed(1)} KB base64`,
);
