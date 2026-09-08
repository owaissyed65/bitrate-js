import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    fs: {
      // With `npm link`, bitrate-js resolves to ../../js, which is outside this
      // project and therefore outside Vite's default serving allow list. Normal
      // imports still work, but the transcode worker is fetched as a plain URL
      // and comes back 403 — which surfaces only as "the worker failed to
      // load". Not needed for an installed copy in node_modules; harmless there.
      // The repository root — two levels up from examples/react-app — so the
      // linked js/dist is reachable.
      allow: ["../.."],
    },
  },

  // A GitHub project page is served from /<repo>/, not the domain root, so every
  // asset URL needs that prefix or the built page loads a blank screen and 404s
  // its own JavaScript. CI sets BASE_PATH; local dev stays at the root.
  base: process.env.BASE_PATH ?? "/",

  // The library is a linked workspace folder; don't pre-bundle it stale.
  optimizeDeps: { exclude: ["bitrate-js"] },
});
