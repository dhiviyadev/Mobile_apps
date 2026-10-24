import { expect, test } from '@playwright/test';
import { primeSettings, waitForGame } from './helpers';

/**
 * Limited browsers (dev server, no service worker): the Google app's in-app
 * browser, no WebGL 2, the install prompt, iPad Safari, an installed app,
 * shortcut links, a missing game chunk and an iframe.
 */
const GOOGLE_APP_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-X710 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Safari/537.36 GSA/15.40.32.29.arm64';
const IPAD_SAFARI_UA = 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const tabletOnly = (name: string) => name !== 'tablet';
const desktopOnly = (name: string) => name !== 'desktop';

test('Google app on Android: hub, install help and offline arena work without SW, fullscreen, wake lock or storage', async ({ browser }, info) => {
  test.skip(tabletOnly(info.project.name), 'tablet only');
  const context = await browser.newContext({ userAgent: GOOGLE_APP_UA, viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true });
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => undefined, configurable: true });
    Object.defineProperty(Navigator.prototype, 'wakeLock', { get: () => undefined, configurable: true });
    const el = Element.prototype as unknown as Record<string, unknown>;
    el.requestFullscreen = undefined;
    el.webkitRequestFullscreen = undefined;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('html[data-host="google-app"]')).toHaveCount(1);
  await expect(page.getByTestId('platform-banner')).toContainText('Google app');
  await page.getByTestId('install-app').click();
  const sheet = page.getByTestId('install-sheet');
  await expect(sheet).toBeVisible();
  const href = await sheet.getByTestId('open-in-chrome').getAttribute('href');
  expect(href).toMatch(/^intent:\/\//);
  expect(href).toContain('package=com.android.chrome');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();

  await page.getByTestId('card-arena').click();
  await page.getByRole('button', { name: 'Practice vs bots' }).click();
  await waitForGame(page);
  expect(errors).toEqual([]);
  await context.close();
});

test('no WebGL 2: a clear message instead of a broken game', async ({ page }, info) => {
  test.skip(desktopOnly(info.project.name), 'desktop only');
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return type === 'webgl2' ? null : (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof original;
  });
  await primeSettings(page, { detectedQuality: 'low' });
  await page.goto('/');
  await expect(page.locator('.platform-banner.danger')).toBeVisible();
  await page.getByTestId('card-arena').click();
  await page.getByRole('button', { name: 'Practice vs bots' }).click();
  await expect(page.getByTestId('unsupported-dialog')).toContainText('3D graphics');
  await expect(page.locator('.game-root')).toHaveCount(0);
});

test('the Install app button uses the captured install prompt', async ({ page }, info) => {
  test.skip(tabletOnly(info.project.name), 'tablet only');
  await page.goto('/');
  await expect(page.getByTestId('card-arena')).toBeVisible();
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & Record<string, unknown>;
    e.prompt = async () => {
      (window as unknown as { __prompted: boolean }).__prompted = true;
    };
    e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    window.dispatchEvent(e);
  });
  await expect(page.getByTestId('install-app')).toBeVisible();
  await expect(page.getByTestId('app-promo-install')).toHaveText('Install');
  await page.getByTestId('install-app').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prompted?: boolean }).__prompted)).toBe(true);
  await expect(page.getByTestId('install-sheet')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(page.getByTestId('install-app')).toBeHidden();
  await expect(page.getByTestId('app-promo')).toBeHidden();
});

test('iPad Safari explains Add to Home Screen', async ({ browser }, info) => {
  test.skip(tabletOnly(info.project.name), 'tablet only');
  const context = await browser.newContext({ userAgent: IPAD_SAFARI_UA, viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('app-promo')).toBeVisible();
  await page.getByTestId('install-app').click();
  await expect(page.getByTestId('install-sheet')).toContainText('Add to Home Screen');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('install-sheet')).toBeHidden();
  await context.close();
});

test('the installed app hides the install UI', async ({ page }, info) => {
  test.skip(tabletOnly(info.project.name), 'tablet only');
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    const noop = () => undefined;
    window.matchMedia = (q: string) =>
      q.includes('display-mode: fullscreen')
        ? ({ matches: true, media: q, onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: () => false } as MediaQueryList)
        : original(q);
  });
  await page.goto('/');
  await expect(page.locator('html.standalone')).toHaveCount(1);
  await expect(page.getByTestId('card-arena')).toBeVisible();
  await expect(page.getByTestId('install-app')).toBeHidden();
  await expect(page.getByTestId('app-promo')).toBeHidden();
});

test('a shortcut link opens the game sheet', async ({ page }, info) => {
  test.skip(desktopOnly(info.project.name), 'desktop only');
  await page.goto('/?open=voxel');
  await expect(page.getByRole('dialog', { name: 'Voxelvale' })).toBeVisible();
  expect(page.url()).not.toContain('open=');
});

test('a missing game chunk offers a reload', async ({ page }, info) => {
  test.skip(desktopOnly(info.project.name), 'desktop only');
  await primeSettings(page, { detectedQuality: 'low' });
  await page.route('**/src/games/arena/index.ts*', (route) => route.abort());
  await page.goto('/');
  await page.getByTestId('card-arena').click();
  await page.getByRole('button', { name: 'Practice vs bots' }).click();
  await expect(page.getByTestId('update-dialog')).toBeVisible();
  await expect(page.locator('.game-root')).toHaveCount(0);
});

test('embedded in an iframe, it offers to open full screen', async ({ page, baseURL }, info) => {
  test.skip(desktopOnly(info.project.name), 'desktop only');
  await page.setContent(`<iframe src="${baseURL}/" style="width:1000px;height:700px"></iframe>`);
  await expect(page.frameLocator('iframe').getByTestId('platform-banner')).toContainText('Open full screen');
});

test('the hub has a crawlable heading and About text', async ({ page }, info) => {
  test.skip(desktopOnly(info.project.name), 'desktop only');
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Cobalt Game Hub');
  await expect(page.getByTestId('about')).toContainText('Arcfire Arena');
  await expect(page).toHaveTitle(/Cobalt Game Hub/);
  expect(await page.locator('link[rel="manifest"]').getAttribute('href')).toBe('/manifest.webmanifest');
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.name).toBe('Cobalt Game Hub');
});
