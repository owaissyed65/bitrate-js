import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },

  // A GitHub project page is served from /<repo>/, not the domain root, so every
  // asset URL needs that prefix or the built page loads a blank screen and 404s
  // its own JavaScript. CI sets BASE_PATH; local dev stays at the root.
  base: process.env.BASE_PATH ?? "/",

  // The library is a linked workspace folder; don't pre-bundle it stale.
  optimizeDeps: { exclude: ["bitrate-js"] },
});
