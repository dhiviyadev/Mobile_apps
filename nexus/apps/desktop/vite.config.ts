import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Tauri expects a fixed dev port and no screen clearing.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari16",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: { input: { main: "index.html" } },
  },
  test: { environment: "jsdom", globals: true, setupFiles: ["src/test-setup.ts"] },
});
