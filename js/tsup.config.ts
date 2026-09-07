import { defineConfig } from "tsup";

// Never bundle provider SDKs — they are optional peer deps (SECURITY.md §4).
const external = ["@aws-sdk/client-s3", "@supabase/supabase-js", "appwrite"];

export default defineConfig([
  {
    entry: [
      "src/index.ts",
      "src/adapters/presigned.ts",
      "src/adapters/s3.ts",
      "src/adapters/supabase.ts",
      "src/adapters/appwrite.ts",
      "src/adapters/firebase.ts",
      "src/zip.ts",
    ],
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
