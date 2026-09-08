import { defineConfig } from "tsup";

// Never bundle provider SDKs — they are optional peer deps (SECURITY.md §4).
const external = ["@aws-sdk/client-s3", "@supabase/supabase-js", "appwrite"];

export default defineConfig([
  {
    // Named explicitly rather than derived from the source paths, because the
    // worker's output name is load-bearing: index.js resolves it with
    // `new URL("./transcode.worker.js", import.meta.url)`, so it has to sit
    // beside index.js. Emitted at dist/worker/ it 404s, and a worker that fails
    // to load simply never answers.
    entry: {
      index: "src/index.ts",
      "adapters/presigned": "src/adapters/presigned.ts",
      "adapters/s3": "src/adapters/s3.ts",
      "adapters/supabase": "src/adapters/supabase.ts",
      "adapters/appwrite": "src/adapters/appwrite.ts",
      "adapters/firebase": "src/adapters/firebase.ts",
      zip: "src/zip.ts",
    },
    format: ["esm"],
    dts: true,
    clean: true,
    treeshake: true,
    external,
    // Ship sourcemaps without embedding local absolute paths.
    sourcemap: true,
  },
  {
    // The worker, built entirely on its own.
    //
    // `splitting: false` is the point: a worker that imports sibling chunks is
    // a code-splitting build, and a bundler's default `worker.format` of
    // "iife" cannot express one — Vite fails the production build outright with
    // "UMD and IIFE output formats are not supported for code-splitting
    // builds". The alternative is asking every consumer to set
    // `worker: { format: "es" }`, which trades a build error for a
    // configuration step in everyone's project.
    //
    // Self-contained costs a second copy of the WASM on disk. It is never
    // loaded twice: a page fetches this file only when it transcodes on a
    // worker, and the main chunk only when it does the work itself.
    entry: { "transcode.worker": "src/worker/transcode.worker.ts" },
    format: ["esm"],
    splitting: false,
    dts: false,
    clean: false,
    treeshake: true,
    external,
    sourcemap: true,
  },
  {
    // A classic <script> build exposing `window.bitrate`.
    //
    // ES modules cannot be loaded over file://, so a page opened straight from
    // disk needs this. It also suits anyone dropping the library into a page
    // with no build step at all.
    entry: { bitrate: "src/index.ts" },
    format: ["iife"],
    globalName: "bitrate",
    dts: false,
    clean: false,
    treeshake: true,
    minify: true,
    external,
    sourcemap: false,
  },
]);
