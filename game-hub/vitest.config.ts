import { defineConfig } from 'vitest/config';

// One test run covers every workspace. Each project picks up its own tsconfig
// (the server needs legacy decorators for @colyseus/schema).
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', root: './shared', include: ['test/**/*.test.ts'], environment: 'node' } },
      // Colyseus probes for pm2 when process.send exists, so run server tests in worker threads.
      { test: { name: 'server', root: './server', include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 20000, pool: 'threads', env: { LOG_LEVEL: 'warn' } } },
      { test: { name: 'client', root: './client', include: ['test/**/*.test.ts'], environment: 'node' } },
    ],
  },
});
