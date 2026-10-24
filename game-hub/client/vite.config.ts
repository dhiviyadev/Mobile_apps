import { defineConfig } from 'vite';
import { cobaltPwa } from './tools/pwa/plugin';

export default defineConfig({
  // Path the site is served under: "/" by default, "/<repo>/" on GitHub Pages project sites.
  base: process.env.VITE_BASE || '/',
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
  build: {
    target: 'es2020',
    // Games are split into their own lazily loaded chunks (see src/hub/launch.ts);
    // three.js lands in a shared vendor chunk that is only fetched when a game opens.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/@colyseus')) return 'net';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
  // Web app manifest, icons, service worker and search tags (see tools/pwa/plugin.ts).
  plugins: [cobaltPwa()],
});
