/**
 * Which build outputs the service worker downloads for offline play, the
 * size budget for them, and the build id that names the cache.
 */
import { createHash } from 'node:crypto';

/** Never precached: link previews, crawler files, host config, source maps, the worker itself. */
export const PRECACHE_EXCLUDE: readonly RegExp[] = [
  /^og-image\.png$/,
  /^screenshots\//,
  /^robots\.txt$/,
  /^sitemap\.xml$/,
  /^_headers$/,
  /^_redirects$/,
  /^CNAME$/,
  /\.map$/,
  /^sw\.js$/,
  /^\.vite\//,
];

/** Warn above this many precached bytes, fail the build above the max (raw, before gzip). */
export const PRECACHE_WARN_BYTES = 4 * 1024 * 1024;
export const PRECACHE_MAX_BYTES = 12 * 1024 * 1024;

/** Paths relative to the site root, sorted; throws if index.html is missing. */
export function selectPrecache(files: Iterable<string>): string[] {
  const list = [...new Set(files)].filter((f) => !PRECACHE_EXCLUDE.some((re) => re.test(f))).sort((a, b) => a.localeCompare(b));
  if (!list.includes('index.html')) throw new Error('[pwa] index.html is missing from the build output');
  return list;
}

const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

/**
 * 12 hex characters identifying the precached content. Identical builds give
 * an identical id (and sw.js), so browsers never see a spurious update.
 */
export function computeBuildId(entries: Iterable<readonly [string, Uint8Array | string]>): string {
  const lines = [...entries].map(([f, bytes]) => `${f}:${sha256(bytes)}`).sort();
  return sha256(lines.join('\n')).slice(0, 12);
}
