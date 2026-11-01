import { expect, type Page, test } from '@playwright/test';
import { primeSettings, startArenaPractice } from './helpers';

/** Arcfire Arena weapons: loadout picker, auto-shoot, crossbow bolts, draw-call budget, weapon gallery. */

type W = { id: number; mag: number; reserve: number };
type Sim = {
  phaseTimer: number;
  brains: Map<string, unknown>;
  players: Map<string, { id: string; bot: boolean; sim: { x: number; y: number; z: number; vx: number; vz: number; hp: number; alive: boolean; slot: number; reload: number; weapons: W[] } }>;
  changeMap(m: unknown): void;
};
type A = {
  match: { phase: string };
  predicted: { weapons: W[]; slot: number; alive: boolean } | null;
  backend: { sim: Sim };
  yaw: number;
  pitch: number;
  input: { press(a: string, touch?: boolean): void; release(a: string): void };
  renderer: { drawCalls: number; triangles: number };
  weaponFx: { projectiles: { count(): number }; preview: { weapon: number; ads: number } | null };
  viewmodel: { scene: { visible: boolean } };
};
type Win = { __arena: A; __arenaFixtures: { flatArenaMap(): unknown } };

/** Runs fn(window.__arena, window) in the page (fn must be self-contained). */
const arena = <T>(page: Page, fn: (a: A, w: Win) => T) => page.evaluate(`(${fn.toString()})(window.__arena, window)`) as Promise<T>;

/** Live round on the open flat map; the bot stands still 8 m ahead and is hard to kill. */
async function liveDuel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__arena.backend.sim.changeMap(w.__arenaFixtures.flatArenaMap());
    w.__arena.backend.sim.phaseTimer = 0;
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__arena.match.phase), { timeout: 15_000 }).toBe('live');
  await placeBot(page, 0);
}

/** Puts us at z 10 looking at the bot at z 2; `yaw` turns us away from it. */
async function placeBot(page: Page, yaw: number): Promise<void> {
  await page.evaluate((y: number) => {
    const a = (window as unknown as Win).__arena;
    const sim = a.backend.sim;
    for (const id of [...sim.brains.keys()]) sim.brains.delete(id);
    Object.assign(sim.players.get('you')!.sim, { x: 0, y: 0, z: 10, vx: 0, vz: 0 });
    const bot = [...sim.players.values()].find((p) => p.bot)!;
    Object.assign(bot.sim, { x: 0, y: 0, z: 2, vx: 0, vz: 0, alive: true, hp: 5000 });
    a.yaw = y;
    a.pitch = -0.14;
  }, yaw);
}

const mag = (page: Page) => page.evaluate(() => (window as unknown as Win).__arena.predicted!.weapons[0].mag);
const settingsJson = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('cobalt-hub.settings.v1') ?? '{}'));

test.describe('Arcfire Arena weapons', () => {
  test.beforeEach(async ({ page }) => {
    await primeSettings(page, { quality: 'medium' });
    await page.goto('/');
  });

  test('loadout picker: 8 primaries, 3 sidearms, picks apply and persist', async ({ page }) => {
    test.setTimeout(120_000); // two practice starts
    await startArenaPractice(page, '1 vs 1');
    await expect(page.getByTestId('loadout-primary').locator('.lo-card')).toHaveCount(8);
    await expect(page.getByTestId('loadout-secondary').locator('.lo-card')).toHaveCount(3);
    await page.getByTestId('loadout-smg').click();
    await page.getByTestId('loadout-hand-cannon').click();
    await expect.poll(() => arena(page, (a) => a.predicted?.weapons.map((w) => w.id).join())).toBe('5,10,4');
    await expect(page.getByTestId('loadout-smg')).toHaveClass(/active/);
    await expect(page.getByTestId('loadout-hand-cannon')).toHaveClass(/active/);
    // Every card shows a drawn weapon icon.
    expect(await page.locator('.lo-card img.lo-icon[src^="data:image/png"]').count()).toBe(11);
    // On the next visit the picks are remembered.
    await page.goto('/');
    await startArenaPractice(page, '1 vs 1');
    await expect(page.getByTestId('loadout-smg')).toHaveClass(/active/);
    await expect(page.getByTestId('loadout-hand-cannon')).toHaveClass(/active/);
    await expect.poll(() => arena(page, (a) => a.predicted?.weapons.map((w) => w.id).join())).toBe('5,10,4');
  });

  test('on a phone the loadout picker scrolls by finger to the sidearms', async ({ page }, info) => {
    test.skip(!info.project.use.hasTouch, 'touch only');
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 844, height: 390 }); // a phone held in landscape
    await startArenaPractice(page, '1 vs 1');
    const picker = page.getByTestId('loadout');
    await expect(picker).toBeVisible();
    // The picker fits on screen and its content is taller than it, so it must scroll.
    const box = (await picker.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(390 + 1);
    expect(await picker.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const sidearm = page.getByTestId('loadout-hand-cannon');
    // Real finger swipes upwards on the picker, through the browser's touch input (not a programmatic scroll).
    const cdp = await page.context().newCDPSession(page);
    const x = Math.round(box.x + box.width / 2);
    for (let swipe = 0; swipe < 3 && (await sidearm.boundingBox())!.y + 40 > 390; swipe++) {
      let y = Math.round(box.y + box.height * 0.85);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 0; i < 12; i++) {
        y -= 18;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(300);
    }
    expect(await picker.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const card = (await sidearm.boundingBox())!;
    expect(card.y + card.height / 2).toBeLessThan(390);
    await sidearm.tap();
    await expect(sidearm).toHaveClass(/active/);
  });

  test('auto-shoot is off by default, fires on an enemy when on, never at a wall', async ({ page }, info) => {
    const touch = !!info.project.use.hasTouch;
    await startArenaPractice(page, '1 vs 1');
    await liveDuel(page);
    if (!touch) {
      await page.locator('.game-root > canvas').click({ position: { x: 640, y: 400 } });
      await placeBot(page, 0);
    }
    await page.waitForTimeout(600);
    const before = await mag(page);
    await page.waitForTimeout(1000);
    expect(await mag(page)).toBe(before);
    await expect(page.getByTestId('auto-chip')).toBeHidden();

    // Toggle: X on a keyboard, the Auto button on touch.
    if (touch) await page.locator('.touch-btn[data-id="auto"]').tap();
    else await page.keyboard.press('KeyX');
    await expect.poll(async () => (await settingsJson(page)).autoShoot).toBe(true);
    await expect(page.locator('.toast-host')).toContainText('Auto-shoot on');
    if (touch) await expect(page.locator('.touch-btn[data-id="auto"]')).toHaveClass(/\bon\b/);
    await expect.poll(() => mag(page), { timeout: 5000 }).toBeLessThan(before);
    await expect(page.getByTestId('auto-chip')).toBeVisible();
    await expect
      .poll(() => arena(page, (a) => [...a.backend.sim.players.values()].find((p) => p.bot)!.sim.hp), { timeout: 5000 })
      .toBeLessThan(5000);

    // Facing away: it stops.
    await placeBot(page, Math.PI / 2);
    await page.waitForTimeout(500);
    const m1 = await mag(page);
    await page.waitForTimeout(500);
    expect(await mag(page)).toBe(m1);
  });

  test('crossbow bolts fly, land and the crossbow reloads by itself', async ({ page }, info) => {
    await startArenaPractice(page, '1 vs 1');
    await page.getByTestId('loadout-crossbow').click();
    await liveDuel(page);
    // Desktop: take the pointer so the game is not paused (offline practice stops while paused).
    if (!info.project.use.hasTouch) await page.locator('.game-root > canvas').click({ position: { x: 640, y: 400 } });
    await arena(page, (a) => {
      a.yaw = 0.6; // past the bot, toward the open floor
      a.pitch = 0.02;
    });
    await expect.poll(() => arena(page, (a) => a.predicted?.weapons[0].id)).toBe(6);
    await page.waitForTimeout(700); // drawn and ready
    await arena(page, (a) => a.input.press('primary', true));
    await page.waitForTimeout(150);
    await arena(page, (a) => a.input.release('primary'));
    await expect.poll(() => arena(page, (a) => a.weaponFx.projectiles.count()), { timeout: 3000 }).toBeGreaterThan(0);
    await expect.poll(() => arena(page, (a) => a.predicted!.weapons[0].mag), { timeout: 4000 }).toBe(0);
    await expect.poll(() => arena(page, (a) => a.predicted!.weapons[0].mag), { timeout: 4000 }).toBe(1);
    expect(await arena(page, (a) => a.predicted!.weapons[0].reserve)).toBe(19);
  });

  test('stays within the draw-call and triangle budget', async ({ page }) => {
    await startArenaPractice(page, '1 vs 1');
    await page.evaluate(() => {
      (window as unknown as Win).__arena.backend.sim.phaseTimer = 0;
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__arena.match.phase), { timeout: 15_000 }).toBe('live');
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => {
      const a = (window as unknown as Win).__arena as unknown as A & { mapMesh: { geometry: { index: { count: number } | null; attributes: { position: { count: number } } } } };
      const g = a.mapMesh.geometry;
      return { calls: a.renderer.drawCalls, tris: a.renderer.triangles, map: (g.index ? g.index.count : g.attributes.position.count) / 3 };
    });
    console.log(`budget: ${r.calls} draw calls, ${r.tris} triangles (map ${r.map})`);
    expect(r.calls).toBeLessThanOrEqual(42);
    expect(r.tris).toBeLessThanOrEqual(20_000 + r.map);
  });

  test('weapon gallery @gallery', async ({ page }, info) => {
    test.skip(!process.env.WEAPON_GALLERY, 'screenshots for visual review only (WEAPON_GALLERY=1)');
    test.setTimeout(240_000);
    await startArenaPractice(page, '1 vs 1');
    await page.addStyleTag({ content: '.loadout,.click-to-play,.arena-banner{display:none!important}' });
    await liveDuel(page);
    await placeBot(page, Math.PI);
    const keys = ['assault-rifle', 'shotgun', 'sniper-rifle', 'pistol', 'combat-knife', 'smg', 'crossbow', 'burst-rifle', 'marksman-rifle', 'lmg', 'hand-cannon', 'machine-pistol'];
    for (let id = 0; id < keys.length; id++) {
      for (const [mode, ads] of [['hip', 0], ['ads', 1]] as const) {
        await page.evaluate(([w, s]: [number, number]) => {
          (window as unknown as Win).__arena.weaponFx.preview = { weapon: w, ads: s };
        }, [id, ads] as [number, number]);
        await page.waitForTimeout(500);
        await page.screenshot({ path: info.outputPath(`weapons/${keys[id]}-${mode}.png`) });
      }
    }
  });
});
