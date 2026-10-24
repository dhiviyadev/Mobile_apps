/**
 * A static file server for testing production builds like GitHub Pages
 * serves them: under a base path, with a 10-minute max-age. Closing it is
 * how the offline tests go offline for real (Playwright's setOffline does
 * not stop a service worker's own fetches).
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

export interface StaticServer {
  /** e.g. http://127.0.0.1:4180/Mobile_apps/ */
  url: string;
  close(): Promise<void>;
  /** Serves a modified copy of one file from now on (e.g. a "new deploy" of sw.js). */
  override(rel: string, transform: (body: string) => string): void;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

export function serveStatic(dir: string, base: string, port: number): Promise<StaticServer> {
  const overrides = new Map<string, (body: string) => string>();
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (!pathname.startsWith(base)) {
      res.writeHead(404).end('not found');
      return;
    }
    const rel = pathname.slice(base.length) || 'index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    let body: Buffer | string = readFileSync(file);
    const transform = overrides.get(rel);
    if (transform) body = transform(body.toString('utf8'));
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(rel)] ?? 'application/octet-stream',
      'Cache-Control': 'max-age=600',
      // Some hosts (vite preview, CDNs with CORS) send this; the service worker must still find its copies.
      Vary: 'Origin',
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      let closed = false;
      resolve({
        url: `http://127.0.0.1:${port}${base}`,
        override: (rel, transform) => overrides.set(rel, transform),
        close: () => {
          if (closed) return Promise.resolve();
          closed = true;
          server.closeAllConnections();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}
