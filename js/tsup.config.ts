import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/presigned.ts",
    // s3 / supabase / appwrite adapters land in M3 — see PLAN.md §5.
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  treeshake: true,
  // Never bundle provider SDKs — they are optional peer deps (SECURITY.md §4).
  external: ["@aws-sdk/client-s3", "@supabase/supabase-js", "appwrite"],
  // Ship sourcemaps without embedding local absolute paths.
  sourcemap: true,
});
