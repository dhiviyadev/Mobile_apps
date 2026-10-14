import { type Browser, expect, type Page, test } from '@playwright/test';
import { waitForGame } from './helpers';

type G = {
  match: { phase: string; players: { id: string; name: string }[] };
  predicted: { x: number; z: number; alive: boolean; weapons: { mag: number }[] } | null;
  latestPoses: Map<string, { x: number; z: number }>;
  backend: { localId: string; serverTick(): number; interpDelayTicks(): number };
  input: { press(a: string): void; release(a: string): void; setKeyboardMove(x: number, y: number): void };
};

async function openPlayer(browser: Browser, name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage();
  await page.addInitScript((n) => localStorage.setItem('cobalt-hub.settings.v1', JSON.stringify({ nickname: n })), name);
  await page.goto('/');
  return page;
}

/** Evaluates in a page after bringing it to the front (background windows get throttled frames). */
const g = async <T>(page: Page, fn: (g: G) => T): Promise<T> => {
  await page.bringToFront();
  return page.evaluate(fn as never) as Promise<T>;
};
declare global {
  interface Window {
    __arena: G;
  }
}

test('online arena: warmup lobby, prediction vs server, auto-start and replicated combat', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop project only');
  test.setTimeout(150_000);
  const a = await openPlayer(browser, 'Alpha');
  await a.getByTestId('card-arena').click();
  await a.getByRole('tab', { name: '1 vs 1' }).click();
  await a.getByTestId('create-private').click();
  await waitForGame(a);
  await expect(a.getByTestId('warmup')).toBeVisible();
  await expect(a.getByTestId('warmup-status')).toContainText('1/2 players');

  // ---- client-side prediction, confirmed by the server ---------------------------------------
  await expect.poll(() => g(a, () => window.__arena.predicted !== null)).toBe(true);
  const before = await g(a, () => ({ ...window.__arena.predicted! }));
  await a.evaluate(() => window.__arena.input.setKeyboardMove(0, 1));
  await expect
    .poll(async () => {
      const p = await g(a, () => window.__arena.predicted!);
      return Math.hypot(p.x - before.x, p.z - before.z);
    }, { timeout: 15_000 })
    .toBeGreaterThan(2);
  await a.evaluate(() => window.__arena.input.setKeyboardMove(0, 0));
  await expect
    .poll(() => g(a, () => {
      const w = window.__arena;
      const s = w.latestPoses.get(w.backend.localId)!;
      return Math.hypot(w.predicted!.x - s.x, w.predicted!.z - s.z);
    }), { timeout: 10_000 })
    .toBeLessThan(0.3);

  // ---- second player joins with the code ----------------------------------------------------------
  const code = (await a.locator('.wu-code').textContent())!.trim();
  const b = await openPlayer(browser, 'Bravo');
  await b.getByTestId('room-code').fill(code);
  await b.getByTestId('join-code').click();
  await waitForGame(b);
  await expect.poll(() => g(a, () => window.__arena.latestPoses.size), { timeout: 10_000 }).toBe(2);
  const clock = await g(b, () => ({ tick: window.__arena.backend.serverTick(), delay: window.__arena.backend.interpDelayTicks() }));
  expect(clock.tick).toBeGreaterThan(0);
  expect(clock.delay).toBeGreaterThanOrEqual(2);
  expect(clock.delay).toBeLessThanOrEqual(6);

  // ---- two humans in a 1v1: the server starts the match by itself -----------------------------------
  await expect.poll(() => g(b, () => window.__arena.match.phase), { timeout: 20_000 }).not.toBe('warmup');
  await expect.poll(() => g(a, () => window.__arena.match.phase), { timeout: 20_000 }).toBe('live');

  // ---- firing is predicted locally and confirmed by the server (no rollback) ---------------------------
  await a.evaluate(() => window.__arena.input.press('primary'));
  await expect.poll(() => g(a, () => window.__arena.predicted!.weapons[0].mag), { timeout: 10_000 }).toBeLessThan(28);
  await a.evaluate(() => window.__arena.input.release('primary'));
  await expect
    .poll(async () => {
      const m1 = await g(a, () => window.__arena.predicted!.weapons[0].mag);
      await a.waitForTimeout(400);
      const m2 = await g(a, () => window.__arena.predicted!.weapons[0].mag);
      return m1 === m2 && m1 < 30;
    }, { timeout: 10_000 })
    .toBe(true);
  await Promise.all([a.context().close(), b.context().close()]);
});
