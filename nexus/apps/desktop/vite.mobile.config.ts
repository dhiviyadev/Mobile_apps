import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Phone companion app: built to dist-mobile/ and served by the NEXUS core at /m.
// In development, /api and /ws are proxied to the core so the app is same-origin like in production.
export default defineConfig({
  root: fileURLToPath(new URL("./mobile", import.meta.url)),
  base: "/m/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: { "import.meta.env.VITE_TARGET": JSON.stringify("mobile") },
  server: {
    port: 1421,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": { target: "http://127.0.0.1:8765", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8765", ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-mobile", import.meta.url)),
    emptyOutDir: true,
    target: "safari16",
    chunkSizeWarningLimit: 900,
  },
});
