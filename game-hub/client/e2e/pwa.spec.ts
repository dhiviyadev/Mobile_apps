import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { primeSettings, waitForGame } from './helpers';
import { serveStatic, type StaticServer } from './staticServer';

/**
 * The production build as GitHub Pages serves it (under /Mobile_apps/):
 * manifest and tags, the service worker, offline play, online play under the
 * worker, the kill switch and the update flow. Builds client/dist-e2e itself.
 * E2E_STATIC_PORT moves the static server (default 4180).
 */
const clientDir = fileURLToPath(new URL('..', import.meta.url));
const distDir = fileURLToPath(new URL('../dist-e2e', import.meta.url));
const BASE = '/Mobile_apps/';
const staticPort = Number(process.env.E2E_STATIC_PORT) || 4180;
const serverPort = Number(process.env.E2E_SERVER_PORT) || 2567;
const SITE_URL = `http://127.0.0.1:${staticPort}${BASE}`;

test.describe.configure({ mode: 'serial' });
/** One browser project is enough for the production build. */
const desktopOnly = (info: TestInfo) => info.project.name !== 'desktop';

let server: StaticServer;

test.beforeAll(async ({}, info) => {
  if (desktopOnly(info)) return;
  info.setTimeout(180_000);
  execFileSync('npx', ['vite', 'build', '--outDir', 'dist-e2e', '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: clientDir,
    stdio: 'inherit',
    env: { ...process.env, VITE_BASE: BASE, VITE_SERVER_URL: `ws://127.0.0.1:${serverPort}`, VITE_SITE_URL: SITE_URL, VITE_SW: 'on' },
  });
});

test.beforeEach(async ({}, info) => {
  test.skip(desktopOnly(info), 'desktop project only');
  server = await serveStatic(distDir, BASE, staticPort);
});

test.afterEach(async () => {
  await server?.close();
});

/** Waits until the service worker controls the page (registered 1.5 s after load, then precached). */
async function waitForController(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 });
}

/** Asks the active worker which build it is and what it precached. */
function swInfo(page: Page): Promise<{ buildId: string; precache: string[]; kill: boolean }> {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => resolve(e.data);
      reg.active!.postMessage({ type: 'GET_INFO' }, [channel.port2]);
    });
  });
}

test('manifest, icons and search tags are correct under /Mobile_apps/', async ({ request }) => {
  const manifest = await (await request.get(`${server.url}manifest.webmanifest`)).json();
  expect(manifest).toMatchObject({ id: BASE, start_url: './', scope: './', display: 'fullscreen' });
  const icons = [...manifest.icons, ...manifest.shortcuts.flatMap((s: { icons: unknown[] }) => s.icons)] as { src: string; sizes: string; type: string }[];
  for (const icon of icons) {
    const res = await request.get(new URL(icon.src, `${server.url}manifest.webmanifest`).href);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()['content-type']).toBe(icon.type);
    if (icon.type === 'image/png') {
      const b = await res.body();
      expect(`${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  }
  const html = await (await request.get(server.url)).text();
  expect(html).toContain(`<link rel="canonical" href="${SITE_URL}">`);
  expect(html).toContain(`<meta property="og:image" content="${SITE_URL}og-image.png">`);
  const ld = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)?.[1];
  expect(JSON.parse(ld!)['@graph'][0]['@type']).toBe('WebSite');
  expect(await (await request.get(`${server.url}robots.txt`)).text()).toContain(`Sitemap: ${SITE_URL}sitemap.xml`);
  expect(await (await request.get(`${server.url}sitemap.xml`)).text()).toContain(`<loc>${SITE_URL}</loc>`);
  expect((await request.get(`${server.url}sw.js`)).status()).toBe(200);
  expect((await request.get(`${server.url}og-image.png`)).status()).toBe(200);
});

test('the service worker precaches everything and both games open offline', async ({ page, context }) => {
  test.setTimeout(180_000);
  await primeSettings(page, { detectedQuality: 'low' });
  await page.goto(server.url);
  await waitForController(page);
  const info = await swInfo(page);
  expect(info.precache).toContain('index.html');
  expect(info.precache.some((f) => /^assets\/three-.*\.js$/.test(f))).toBe(true);
  expect(info.precache.some((f) => /^assets\/voxel\.worker-.*\.js$/.test(f))).toBe(true);
  const missing = await page.evaluate(async ({ buildId, files, base }) => {
    const cache = await caches.open(`cobalt-hub-precache-${buildId}`);
    const out: string[] = [];
    for (const f of files) if (!(await cache.match(new URL(f, location.origin + base).href))) out.push(f);
    return out;
  }, { buildId: info.buildId, files: info.precache, base: BASE });
  expect(missing).toEqual([]);

  // Offline for real: the site's server is gone, and the browser reports no network.
  await server.close();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('card-arena')).toBeVisible();
  await expect(page.locator('h1')).toHaveText('Cobalt Game Hub');

  await page.getByTestId('card-arena').click();
  await page.getByRole('button', { name: 'Practice vs bots' }).click();
  await waitForGame(page);
  await page.keyboard.press('Escape');
  await page.getByTestId('leave-game').click();
  await expect(page.getByTestId('card-voxel')).toBeVisible();

  await page.getByTestId('card-voxel').click();
  await page.getByRole('tab', { name: 'Sandbox' }).click();
  await page.getByRole('button', { name: 'Play offline' }).click();
  await waitForGame(page);
  await expect(page.getByTestId('hotbar')).toBeVisible();
  await context.setOffline(false);
});

test('online play works while the service worker is in control', async ({ page }) => {
  await primeSettings(page, { detectedQuality: 'low' });
  await page.goto(server.url);
  await waitForController(page);
  await expect(page.locator('.server-pill')).toHaveText(/online/, { timeout: 30_000 });
  await page.getByTestId('card-arena').click();
  await page.getByRole('tab', { name: '1 vs 1' }).click();
  await page.getByTestId('create-private').click();
  await expect(page.locator('.wu-code')).toHaveText(/^[A-Z2-9]{6}$/, { timeout: 30_000 });
});

test('?sw=off unregisters and clears the offline copy; ?sw=on restores it', async ({ page }) => {
  await page.goto(server.url);
  await waitForController(page);
  await page.goto(`${server.url}?sw=off`);
  await expect(page).toHaveURL(server.url);
  await expect(page.getByTestId('card-arena')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  expect(await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('cobalt-hub-')))).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('cobalt-hub.sw'))).toBe('off');
  // Stays off across reloads.
  await page.reload();
  await page.waitForTimeout(2500);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);

  await page.goto(`${server.url}?sw=on`);
  await expect(page).toHaveURL(server.url);
  await waitForController(page);
  expect(await page.evaluate(() => localStorage.getItem('cobalt-hub.sw'))).toBeNull();
});

test('a new deploy shows Update ready, and Restart switches to it', async ({ page }) => {
  await page.goto(server.url);
  await waitForController(page);
  const { buildId } = await swInfo(page);
  server.override('sw.js', (code) => code.replaceAll(buildId, 'e2enext00000'));
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  await expect(page.getByTestId('update-ready')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => ((window as unknown as { __oldPage: boolean }).__oldPage = true));
  const reloaded = page.waitForEvent('load');
  await page.getByTestId('update-restart').click();
  await reloaded;
  expect(await page.evaluate(() => (window as unknown as { __oldPage?: boolean }).__oldPage)).toBeUndefined();
  // The page reloads once the new worker takes over; ask again until it answers from the new build.
  const buildAfterReload = async () => {
    try {
      return (await swInfo(page)).buildId;
    } catch {
      return 'reloading';
    }
  };
  await expect.poll(buildAfterReload, { timeout: 30_000 }).toBe('e2enext00000');
  await expect(page.getByTestId('card-arena')).toBeVisible();
  await expect(page.getByTestId('update-ready')).toBeHidden();
});
