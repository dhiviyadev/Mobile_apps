/**
 * Vite plugin "cobalt-pwa": makes the hub an installable, offline-capable,
 * findable web app without extra dependencies.
 *
 * - transformIndexHtml: title, description, canonical, Open Graph/Twitter
 *   tags, JSON-LD, manifest and icon links (seo.ts).
 * - generateBundle: emits the generated icons, social image, screenshots,
 *   manifest, robots.txt and sitemap.xml; picks the precache list, hashes it
 *   into a build id and compiles src/platform/sw/sw.ts into sw.js with a
 *   nested Vite build.
 * - closeBundle: checks dist has everything the worker and manifest point
 *   at, or fails the build (and with it the Pages deploy).
 * - Dev server: serves the generated files (there is no service worker in dev).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { build, type Connect, loadEnv, type Plugin, type ResolvedConfig, type Rollup } from 'vite';
import { renderIcon, renderOgImage, renderShortcutIcon } from './brandArt';
import { buildManifest, MANIFEST_ICONS, type ManifestScreenshot, SHORTCUTS } from './manifest';
import { computeBuildId, PRECACHE_MAX_BYTES, PRECACHE_WARN_BYTES, selectPrecache } from './precache';
import { headTags, robotsTxt, sitemapXml } from './seo';
import { resolveSiteConfig, type SiteConfig, siteUrlWarning } from './site';

export type AssetSource = Uint8Array | string;

/** Screenshots copied from docs/ for the manifest and JSON-LD (refresh the PNGs there, same names). */
const SCREENSHOTS = [
  { file: 'voxel-sandbox.png', label: 'Voxelvale: building in a generated block world' },
  { file: 'arena-live.png', label: 'Arcfire Arena: a live round' },
  { file: 'hub.png', label: 'The Cobalt Game Hub' },
] as const;

/** The service worker's source files (relative to the client root). */
const SW_SOURCES = ['src/platform/sw/sw.ts', 'src/platform/sw/routing.ts'];

/** Width and height from a PNG's IHDR chunk (bytes 16-23). */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/**
 * Every generated file, by path relative to the site root, as a lazy thunk:
 * the dev server renders only what is requested.
 */
export function staticAssetSources(site: SiteConfig, root: string, warn: (msg: string) => void = console.warn): Map<string, () => AssetSource> {
  const out = new Map<string, () => AssetSource>();
  for (const size of [192, 512]) out.set(`icons/icon-${size}.png`, () => renderIcon('any', size));
  for (const size of [192, 512]) out.set(`icons/maskable-${size}.png`, () => renderIcon('maskable', size));
  out.set('icons/apple-touch-icon-180.png', () => renderIcon('apple', 180));
  out.set('icons/favicon-48.png', () => renderIcon('any', 48));
  out.set('icons/shortcut-voxel-96.png', () => renderShortcutIcon('voxel'));
  out.set('icons/shortcut-arena-96.png', () => renderShortcutIcon('arena'));
  out.set('og-image.png', () => renderOgImage());

  const shots: ManifestScreenshot[] = [];
  const shotDir = path.resolve(root, '../docs/screenshots');
  for (const { file, label } of SCREENSHOTS) {
    const p = path.join(shotDir, file);
    if (!existsSync(p)) {
      warn(`[pwa] screenshot ${p} not found; left out of the manifest`);
      continue;
    }
    const bytes = new Uint8Array(readFileSync(p));
    shots.push({ src: `screenshots/${file}`, ...pngSize(bytes), label });
    out.set(`screenshots/${file}`, () => bytes);
  }
  out.set('manifest.webmanifest', () => JSON.stringify(buildManifest(site, shots), null, 2) + '\n');
  out.set('robots.txt', () => robotsTxt(site));
  const sitemap = sitemapXml(site);
  if (sitemap) out.set('sitemap.xml', () => sitemap);
  return out;
}

/** All generated files, rendered (about a second for the art). */
export function generateStaticAssets(site: SiteConfig, root: string, warn?: (msg: string) => void): Map<string, AssetSource> {
  return new Map([...staticAssetSources(site, root, warn)].map(([k, fn]) => [k, fn()]));
}

/** Compiles the service worker into one classic script (no imports, so every browser can load it). */
export async function buildServiceWorker(o: { root: string; precache: string[]; buildId: string; entry: string; kill: boolean }): Promise<string> {
  const res = await build({
    configFile: false,
    envFile: false,
    logLevel: 'warn',
    root: o.root,
    publicDir: false,
    define: {
      __SW_BUILD_ID__: JSON.stringify(o.buildId),
      __SW_PRECACHE__: JSON.stringify(o.kill ? [] : o.precache),
      __SW_ENTRY__: JSON.stringify(o.entry),
      __SW_KILL__: JSON.stringify(o.kill),
    },
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      minify: 'esbuild',
      target: 'es2017',
      lib: { entry: path.resolve(o.root, SW_SOURCES[0]), formats: ['iife'], name: 'cobaltSw', fileName: () => 'sw.js' },
    },
  });
  const out = (Array.isArray(res) ? res[0] : res) as Rollup.RollupOutput;
  return (out.output[0] as Rollup.OutputChunk).code;
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function devMiddleware(base: () => string, sources: () => Map<string, () => AssetSource>): Connect.NextHandleFunction {
  const memo = new Map<string, AssetSource>();
  return (req, res, next) => {
    const p = (req.url ?? '').split('?')[0];
    const b = base();
    const rel = p.startsWith(b) ? p.slice(b.length) : p.slice(1);
    const make = sources().get(rel);
    if (!make) return next();
    let body = memo.get(rel);
    if (body === undefined) memo.set(rel, (body = make()));
    res.setHeader('Content-Type', CONTENT_TYPES[path.extname(rel)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(typeof body === 'string' ? body : Buffer.from(body));
  };
}

function walk(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix + e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel + '/'));
    else out.push(rel);
  }
  return out;
}

export function cobaltPwa(): Plugin {
  let config: ResolvedConfig;
  let site: SiteConfig;
  let sources: Map<string, () => AssetSource> | null = null;
  const assetSources = () => (sources ??= staticAssetSources(site, config.root, (m) => config.logger.warn(m)));
  /** Set once generateBundle succeeded; closeBundle checks dist only then. */
  let expected: string[] | null = null;
  let buildId = '';

  return {
    name: 'cobalt-pwa',
    configResolved(c) {
      config = c;
      const env = { ...loadEnv(c.mode, c.envDir, 'VITE_'), SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH };
      site = resolveSiteConfig(env, c.base, Date.now());
      const warning = siteUrlWarning(site);
      if (warning) c.logger.warn(warning);
    },
    configureServer(server) {
      server.middlewares.use(devMiddleware(() => config.base, assetSources));
    },
    transformIndexHtml: { order: 'post', handler: () => headTags(site) },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const contents = new Map<string, AssetSource>();
        for (const [rel, make] of assetSources()) {
          const source = make();
          this.emitFile({ type: 'asset', fileName: rel, source });
          contents.set(rel, source);
        }
        for (const rel of walk(config.publicDir)) contents.set(rel, new Uint8Array(readFileSync(path.join(config.publicDir, rel))));
        for (const [rel, item] of Object.entries(bundle)) {
          if (!contents.has(rel)) contents.set(rel, item.type === 'chunk' ? item.code : item.source);
        }

        const precache = selectPrecache(contents.keys());
        const bytes = (rel: string) => {
          const c = contents.get(rel)!;
          return typeof c === 'string' ? Buffer.byteLength(c) : c.byteLength;
        };
        const total = precache.reduce((n, f) => n + bytes(f), 0);
        const kb = Math.round(total / 1024);
        if (total > PRECACHE_MAX_BYTES) this.error(`[pwa] precache is ${kb} KB, over the ${PRECACHE_MAX_BYTES / 1024} KB limit`);
        if (total > PRECACHE_WARN_BYTES) this.warn(`[pwa] precache is ${kb} KB; players download all of it for offline play`);

        const kill = site.serviceWorker === 'off';
        // The worker's own code counts too: a worker-only change must not reuse the old cache name.
        buildId = computeBuildId([
          ...precache.map((f) => [f, contents.get(f)!] as const),
          ...SW_SOURCES.map((f) => [`(worker) ${f}`, readFileSync(path.resolve(config.root, f))] as const),
          ['(worker) kill', String(kill)] as const,
        ]);
        // The page's entry chunk (its facade is index.html, which imports src/main.ts).
        const entry = Object.values(bundle).find(
          (c): c is Rollup.OutputChunk => c.type === 'chunk' && c.isEntry && /\/(index\.html|src\/main\.ts)$/.test(c.facadeModuleId?.replace(/\\/g, '/') ?? ''),
        )?.fileName;
        if (!entry || !String(contents.get('index.html')).includes(entry)) this.error('[pwa] could not find the entry chunk of index.html');
        const code = await buildServiceWorker({ root: config.root, precache, buildId, entry, kill });
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: code });

        const icons = [...MANIFEST_ICONS.map((i) => i.src), ...SHORTCUTS.map((s) => s.icon)];
        expected = [...new Set([...precache, 'sw.js', 'manifest.webmanifest', ...icons, ...(site.siteUrl ? ['og-image.png', 'sitemap.xml'] : [])])];
        config.logger.info(
          kill
            ? '[pwa] kill-switch service worker (VITE_SW=off): it removes itself and the offline copy'
            : `[pwa] service worker ${buildId}: ${precache.length} files, ${kb} KB precached`,
        );
      },
    },
    closeBundle() {
      if (config.command !== 'build' || !expected) return;
      const outDir = path.resolve(config.root, config.build.outDir);
      const missing = expected.filter((f) => !existsSync(path.join(outDir, f)));
      const sw = path.join(outDir, 'sw.js');
      if (existsSync(sw) && !readFileSync(sw, 'utf8').includes(buildId)) missing.push(`sw.js (build id ${buildId})`);
      expected = null;
      if (missing.length) throw new Error(`[pwa] dist is incomplete: ${missing.join(', ')}`);
    },
  };
}
