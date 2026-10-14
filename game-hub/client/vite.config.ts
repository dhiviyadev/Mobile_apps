import { defineConfig } from 'vite';

export default defineConfig({
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
          if (id.includes('node_modules/colyseus.js') || id.includes('node_modules/@colyseus')) return 'net';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
});
