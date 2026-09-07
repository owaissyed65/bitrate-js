import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
  // The library is a linked workspace folder; don't pre-bundle it stale.
  optimizeDeps: { exclude: ["bitrate-js"] },
});
