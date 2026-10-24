import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildServiceWorker } from '../tools/pwa/plugin';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('service worker build', () => {
  it('compiles to one classic script with the build baked in', async () => {
    const code = await buildServiceWorker({ root, precache: ['index.html', 'assets/a.js'], buildId: 'test12345678', entry: 'assets/a.js', kill: false });
    expect(code).toContain('test12345678');
    expect(code).toContain('cobalt-hub-');
    expect(code).toContain('assets/a.js');
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    expect(() => new Function(code)).not.toThrow();
  }, 30_000);

  it('builds the kill switch that unregisters itself', async () => {
    const code = await buildServiceWorker({ root, precache: ['index.html'], buildId: 'kill00000000', entry: 'assets/a.js', kill: true });
    expect(code).toContain('unregister');
    expect(code).toContain('kill00000000');
    expect(code).not.toContain('addEventListener("fetch"'); // a dead worker answers no requests
  }, 30_000);
});
