import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { execSync } from "node:child_process";

// The commit this app was built from, so it can notice a background service from an older version.
let build = "";
try {
  build = execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
  build = "";
}

// Tauri expects a fixed dev port and no screen clearing.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: { __NEXUS_BUILD__: JSON.stringify(build) },
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
