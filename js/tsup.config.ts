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
      "transcode.worker": "src/worker/transcode.worker.ts",
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
