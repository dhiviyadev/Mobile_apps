import { fileURLToPath } from 'node:url';
import { GAME_TITLES, HUB_NAME } from '@hub/shared';
import { describe, expect, it } from 'vitest';
import { OG_TEXT, renderIcon, renderOgImage, renderShortcutIcon } from '../tools/pwa/brandArt';
import { buildManifest } from '../tools/pwa/manifest';
import { FONT_5X7, textWidth } from '../tools/pwa/pixelFont';
import { generateStaticAssets, pngSize } from '../tools/pwa/plugin';
import { computeBuildId, selectPrecache } from '../tools/pwa/precache';
import { Raster } from '../tools/pwa/raster';
import { drawText } from '../tools/pwa/pixelFont';
import { headTags, jsonLd, robotsTxt, sitemapXml } from '../tools/pwa/seo';
import { resolveSiteConfig, SITE_TEXT, type SiteConfig, siteUrlWarning } from '../tools/pwa/site';
import { decodePng } from './helpers/png';

const clientDir = fileURLToPath(new URL('..', import.meta.url));
const SITE_URL = 'https://dhiviyadev.github.io/Mobile_apps/';
const pages: SiteConfig = resolveSiteConfig({ VITE_SITE_URL: SITE_URL, SOURCE_DATE_EPOCH: '1767225600' }, '/Mobile_apps/', 0);
const local: SiteConfig = resolveSiteConfig({}, '/', Date.UTC(2026, 9, 23));

const BG = [0x10, 0x16, 0x2a];
const near = (px: number[], rgb: number[], tol: number) => rgb.every((v, i) => Math.abs(px[i] - v) <= tol);

describe('generated icons', () => {
  it.each([
    ['any', 48],
    ['any', 192],
    ['any', 512],
    ['maskable', 192],
    ['maskable', 512],
    ['apple', 180],
  ] as const)('%s %i px is a valid RGBA PNG of that size', (kind, size) => {
    const png = decodePng(renderIcon(kind, size));
    expect([png.width, png.height, png.colorType]).toEqual([size, size, 6]);
    expect(pngSize(renderIcon(kind, size))).toEqual({ width: size, height: size });
  });

  it.each([192, 512])('maskable %i px keeps everything outside the 40 %% safe circle plain background', (size) => {
    const png = decodePng(renderIcon('maskable', size));
    const c = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (Math.hypot(x + 0.5 - c, y + 0.5 - c) <= 0.4 * size) continue;
        const p = png.pixel(x, y);
        if (!near(p, BG, 1) || p[3] !== 255) throw new Error(`pixel ${x},${y} = ${p}`);
      }
    }
    expect(near(png.pixel(c, c - size * 0.1), BG, 1)).toBe(false);
  });

  it('"any" icons have transparent corners; the Apple icon is opaque', () => {
    expect(decodePng(renderIcon('any', 192)).pixel(0, 0)[3]).toBe(0);
    const apple = decodePng(renderIcon('apple', 180));
    for (let i = 3; i < apple.pixels.length; i += 4) expect(apple.pixels[i]).toBe(255);
  });

  it('shortcut icons are 96 px', () => {
    for (const g of ['voxel', 'arena'] as const) expect(decodePng(renderShortcutIcon(g)).width).toBe(96);
  });

  it('the social image is 1200×630 with the cube and the colour band', () => {
    const og = decodePng(renderOgImage());
    expect([og.width, og.height]).toEqual([1200, 630]);
    expect(near(og.pixel(300, 250), [0x5f, 0xd1, 0x7a], 8)).toBe(true); // top face of the cube
    expect(near(og.pixel(100, 621), [0x5f, 0xd1, 0x7a], 8)).toBe(true);
    expect(near(og.pixel(900, 621), [0xff, 0x7a, 0x45], 8)).toBe(true);
  });

  it('the pixel font covers every string on the social image and fits it', () => {
    for (const rows of Object.values(FONT_5X7)) {
      expect(rows).toHaveLength(7);
      for (const r of rows) expect(r).toMatch(/^[01]{5}$/);
    }
    const r = new Raster(10, 10);
    for (const t of Object.values(OG_TEXT)) expect(() => drawText(r, t, 0, 0, 1, [255, 255, 255])).not.toThrow();
    expect(() => drawText(r, 'Q', 0, 0, 1, [255, 255, 255])).toThrow();
    expect(560 + textWidth(`${OG_TEXT.voxel} ${OG_TEXT.arena}`, 4)).toBeLessThanOrEqual(1140);
  });
});

describe('web app manifest', () => {
  const files = generateStaticAssets(pages, clientDir, () => undefined);
  const manifest = JSON.parse(files.get('manifest.webmanifest') as string);

  it('keeps the install identity and relative URLs under /Mobile_apps/', () => {
    expect(manifest).toMatchObject({ id: '/Mobile_apps/', start_url: './', scope: './', display: 'fullscreen', orientation: 'landscape' });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', purpose: 'maskable' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
    ]));
    expect(manifest.related_applications[0].url).toBe(`${SITE_URL}manifest.webmanifest`);
  });

  it('points only at files the build emits, with their real sizes', () => {
    const srcs = [
      ...manifest.icons.map((i: { src: string }) => i.src),
      ...manifest.shortcuts.flatMap((s: { icons: { src: string }[] }) => s.icons.map((i) => i.src)),
      ...manifest.screenshots.map((s: { src: string }) => s.src),
    ];
    for (const src of srcs) if (src !== 'icon.svg') expect(files.has(src), src).toBe(true);
    for (const shot of manifest.screenshots) {
      const { width, height } = pngSize(files.get(shot.src) as Uint8Array);
      expect(shot.sizes).toBe(`${width}x${height}`);
    }
  });

  it('uses the base as id, and leaves out related_applications without a site URL', () => {
    const m = buildManifest(local, []);
    expect(m.id).toBe('/');
    expect(m).not.toHaveProperty('related_applications');
  });
});

describe('search and social tags', () => {
  const html = (site: SiteConfig) =>
    headTags(site)
      .map((t) => `<${t.tag} ${Object.entries(t.attrs ?? {}).map(([k, v]) => `${k}="${v}"`).join(' ')}>${typeof t.children === 'string' ? t.children : ''}`)
      .join('\n');

  it('adds canonical, Open Graph image and parseable JSON-LD without ratings', () => {
    const tags = headTags(pages);
    expect(tags.find((t) => t.attrs?.rel === 'canonical')?.attrs?.href).toBe(SITE_URL);
    expect(tags.find((t) => t.attrs?.property === 'og:image')?.attrs?.content).toBe(`${SITE_URL}og-image.png`);
    const ld = tags.find((t) => t.attrs?.type === 'application/ld+json')!.children as string;
    expect(ld).not.toMatch(/<\/script/i);
    const parsed = JSON.parse(ld);
    expect(parsed['@graph'][1].name).toBe(HUB_NAME);
    expect(ld).not.toMatch(/aggregateRating|"review"/);
    expect(JSON.stringify(jsonLd(local))).not.toMatch(/aggregateRating|review/);
    expect(html(pages)).toContain(`<title >${SITE_TEXT.title}`);
  });

  it('leaves out absolute URLs without a site URL', () => {
    const out = html(local);
    expect(out).not.toContain('canonical');
    expect(out).not.toContain('og:url');
    expect(out).not.toContain('og:image"');
    expect(JSON.stringify(jsonLd(local))).not.toContain('"url"');
  });

  it('adds the Search Console verification tag only when set', () => {
    expect(html(pages)).not.toContain('google-site-verification');
    const verified = resolveSiteConfig({ VITE_SITE_URL: SITE_URL, VITE_GOOGLE_SITE_VERIFICATION: 'tok123' }, '/Mobile_apps/', 0);
    expect(html(verified)).toContain('name="google-site-verification" content="tok123"');
  });

  it('writes robots.txt and a sitemap dated by SOURCE_DATE_EPOCH', () => {
    expect(robotsTxt(pages)).toBe(`# Cobalt Game Hub\nUser-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`);
    expect(robotsTxt(local)).not.toContain('Sitemap');
    expect(sitemapXml(pages)).toContain(`<url><loc>${SITE_URL}</loc><lastmod>2026-01-01</lastmod></url>`);
    expect(sitemapXml(local)).toBeNull();
  });

  it('normalises the site URL and warns when it does not match the base', () => {
    expect(resolveSiteConfig({ VITE_SITE_URL: 'https://example.org/Mobile_apps' }, '/Mobile_apps/', 0).siteUrl).toBe('https://example.org/Mobile_apps/');
    expect(siteUrlWarning(pages)).toBeNull();
    expect(siteUrlWarning(resolveSiteConfig({ VITE_SITE_URL: 'https://example.org/' }, '/Mobile_apps/', 0))).toMatch(/base path/);
    expect(resolveSiteConfig({ VITE_SW: 'off' }, '/', 0).serviceWorker).toBe('off');
  });

  it('matches the names used by the games', () => {
    expect(SITE_TEXT.name).toBe(HUB_NAME);
    expect(SITE_TEXT.games.voxel.name).toBe(GAME_TITLES.voxel);
    expect(SITE_TEXT.games.arena.name).toBe(GAME_TITLES.arena);
  });
});

describe('precache selection', () => {
  it('keeps the app shell, games, worker and icons; drops crawler and host files', () => {
    const list = selectPrecache([
      'index.html', 'assets/voxel.worker-x.js', 'assets/three-a.js', 'icons/maskable-512.png', 'icon.svg', 'manifest.webmanifest',
      'og-image.png', 'screenshots/a.png', 'robots.txt', 'sitemap.xml', '_headers', '_redirects', 'CNAME', 'sw.js', 'assets/a.js.map',
    ]);
    expect(list).toEqual(['assets/three-a.js', 'assets/voxel.worker-x.js', 'icon.svg', 'icons/maskable-512.png', 'index.html', 'manifest.webmanifest']);
    expect(() => selectPrecache(['assets/a.js'])).toThrow(/index\.html/);
  });

  it('build ids are deterministic, order independent and change with content', () => {
    const a = computeBuildId([['index.html', 'x'], ['assets/a.js', new Uint8Array([1, 2])]]);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(computeBuildId([['assets/a.js', new Uint8Array([1, 2])], ['index.html', 'x']])).toBe(a);
    expect(computeBuildId([['index.html', 'x'], ['assets/a.js', new Uint8Array([1, 3])]])).not.toBe(a);
  });
});
