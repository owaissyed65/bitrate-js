import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/presigned.ts",
    "src/adapters/s3.ts",
    "src/adapters/supabase.ts",
    "src/adapters/appwrite.ts",
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
