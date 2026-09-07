/**
 * Build a single self-contained HTML test page.
 *
 * The library and its WASM are inlined as a classic script, so the page can be
 * opened straight from disk — no server, no bundler, no install. Everything a
 * module-based page cannot do over `file://`.
 *
 * Run after `npm run build`; writes `examples/standalone/bitrate.html`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const url = (p) => fileURLToPath(new URL(p, import.meta.url));

const library = await readFile(url("../dist/bitrate.global.js"), "utf8");
const template = await readFile(url("./standalone-template.html"), "utf8");

if (!template.includes("__BITRATE_LIBRARY__")) {
  throw new Error("template is missing the __BITRATE_LIBRARY__ placeholder");
}

// `</script>` inside the bundle would close the tag early; escaping the slash
// keeps the JavaScript identical while making it inert to the HTML parser.
const safe = library.replace(/<\/script>/gi, "<\\/script>");

const html = template.replace("__BITRATE_LIBRARY__", () => safe);

const outDir = url("../../examples/standalone/");
await mkdir(outDir, { recursive: true });
const outFile = `${outDir}bitrate.html`;
await writeFile(outFile, html, "utf8");

console.log(
  `standalone page: ${(html.length / 1024).toFixed(0)} KB -> examples/standalone/bitrate.html`,
);
