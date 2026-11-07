/**
 * Voxelvale world library, world menu, hosting from the device and the
 * teleport menu (Package W).
 */
import { readFile } from 'node:fs/promises';
import { type Browser, expect, type Page, test, type TestInfo } from '@playwright/test';
import { hostNewWorld, leaveGame, newVoxelWorld, openWorldMenu, primeSettings, waitForGame } from './helpers';

type G = {
  player: { body: { x: number; y: number; z: number; onGround: boolean }; pitch: number; teleport(x: number, y: number, z: number): void };
  world: { getBlock(x: number, y: number, z: number): number };
  applyWorldEdit(x: number, y: number, z: number, id: number): void;
  survival: { debugGive(k: string, n: number): void; model: { view: { count(i: number): number; items: number[]; counts: number[] } } };
  input: { press(a: string): void; release(a: string): void };
  interaction: { target: { x: number; y: number; z: number } | null };
  teleport: { open(): void };
  net: { roomCode: string } | null;
};
const g = (page: Page) => <T>(fn: (v: G) => T) => page.evaluate(`(${fn.toString()})(window.__voxel)`) as Promise<T>;
const BREAD = 274;
const BRICK = 11;

async function openPlayer(browser: Browser, info: TestInfo, name: string): Promise<Page> {
  const ctx = await browser.newContext(info.project.use);
  const page = await ctx.newPage();
  await primeSettings(page, { nickname: name, detectedQuality: 'low' });
  await page.goto('/');
  return page;
}

/** Bag contents as item -> count (survival). */
const bagTotal = (page: Page) =>
  g(page)((v) => v.survival.model.view.counts.slice(0, 37).reduce((n: number, c: number) => n + c, 0));

test.describe('world library (offline)', () => {
  // Several of these load a world twice (make it, leave, open it again).
  test.describe.configure({ timeout: 120_000 });
  test.beforeEach(async ({ page }) => {
    await primeSettings(page);
    await page.goto('/');
  });

  test('a world keeps its blocks and bag after leaving, and is listed', async ({ page }) => {
    await newVoxelWorld(page, 'survival', 'Castle Rock');
    await waitForGame(page);
    const cell = await g(page)((v) => {
      const b = v.player.body;
      const c = [Math.floor(b.x) + 2, Math.floor(b.y) + 2, Math.floor(b.z)];
      v.applyWorldEdit(c[0], c[1], c[2], 11);
      v.survival.debugGive('bread', 3);
      return c;
    });
    await expect.poll(() => g(page)((v) => v.survival.model.view.count(274))).toBe(3);
    await leaveGame(page);
    await openWorldMenu(page);
    const card = page.getByTestId('world-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Castle Rock');
    await expect(card).toContainText('Survival');

    // A fresh page load reads the library from the device.
    await page.reload();
    await openWorldMenu(page);
    await page.getByTestId('play-world').click();
    await waitForGame(page);
    await expect.poll(() => page.evaluate((c) => (window as unknown as { __voxel: G }).__voxel.world.getBlock(c[0], c[1], c[2]), cell)).toBe(BRICK);
    await expect.poll(() => g(page)((v) => v.survival.model.view.count(274))).toBe(3);
    expect(BREAD).toBe(274);
  });

  test('old offline saves are moved into the library', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('cobalt-hub.voxel.offline.v1', JSON.stringify({ seed: 77, gen: 2, edits: [], player: { x: 0.5, y: 40, z: 0.5, yaw: 0, pitch: 0 }, time: 0.3 }));
      localStorage.setItem('cobalt-hub.voxel.offline.survival.v1', JSON.stringify({ seed: 78, gen: 2, edits: [], player: { x: 0.5, y: 40, z: 0.5, yaw: 0, pitch: 0 }, time: 0.3, survival: { v: 1, day: 3, rules: { keepInventory: false }, vitals: { hp: 20, food: 20, air: 10, dead: false }, spawn: null, inv: [[274, 2, 0]], chests: [], satchels: [] } }));
    });
    await openWorldMenu(page);
    await expect(page.getByTestId('world-card')).toHaveCount(2);
    await expect(page.locator('.vw-name')).toContainText(['My', 'My']);
    await expect(page.getByTestId('world-menu')).toContainText('My Sandbox World');
    await expect(page.getByTestId('world-menu')).toContainText('Day 3');
    expect(await page.evaluate(() => [localStorage.getItem('cobalt-hub.voxel.offline.v1'), localStorage.getItem('cobalt-hub.voxel.offline.survival.v1')])).toEqual([null, null]);
    await page.locator('[data-testid="world-card"]:has(.vw-mode-survival)').getByTestId('play-world').click();
    await waitForGame(page);
    await expect.poll(() => g(page)((v) => v.survival.model.view.count(274))).toBe(2);
  });

  test('export a world, then import the file as a second world', async ({ page }, info) => {
    test.skip(!!info.project.use.isMobile, 'downloads: desktop only');
    await newVoxelWorld(page, 'sandbox', 'Harbor');
    await waitForGame(page);
    await leaveGame(page);
    await openWorldMenu(page);
    await page.getByTestId('world-more').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('world-export').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('Harbor.voxelvale');
    const path = await file.path();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('import-world').click();
    await (await chooser).setFiles({ name: 'Harbor.voxelvale', mimeType: 'application/octet-stream', buffer: await readFile(path) });
    await expect(page.getByTestId('world-card')).toHaveCount(2);
    await expect(page.getByTestId('world-menu')).toContainText('Harbor (2)');
    // Something that is not a world is refused.
    const chooser2 = page.waitForEvent('filechooser');
    await page.getByTestId('import-world').click();
    await (await chooser2).setFiles({ name: 'notes.voxelvale', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(page.locator('.toast-error')).toContainText('not a Voxelvale world');
    await expect(page.getByTestId('world-card')).toHaveCount(2);
  });

  test('a pillar built far above the old height limit is still there after reopening the world', async ({ page }, info) => {
    await newVoxelWorld(page, 'sandbox', 'Skyline');
    await waitForGame(page);
    // A brick pillar from the ground to y 199 with a ledge at its top, then the player on top of it.
    const at = await g(page)((v) => {
      const b = v.player.body;
      const x = Math.floor(b.x) + 3;
      const z = Math.floor(b.z);
      let y = 1;
      while (v.world.getBlock(x, y, z) !== 0) y++;
      for (let k = y; k <= 199; k++) v.applyWorldEdit(x, k, z, 11);
      v.applyWorldEdit(x + 1, 199, z, 11);
      v.player.teleport(x + 0.5, 200, z + 0.5);
      return { x, z };
    });
    // Place a block by hand on the ledge at y 200: pick stone, face +x and look down at the ledge's top.
    if (info.project.use.hasTouch) await page.locator('.slot').nth(2).tap();
    await page.evaluate(() => {
      const v = (window as unknown as { __voxel: { player: { yaw: number; pitch: number }; hud: { select(i: number): void } } }).__voxel;
      v.hud.select(2);
      v.player.yaw = -Math.PI / 2;
      v.player.pitch = -Math.atan(1.62);
    });
    await expect
      .poll(() => g(page)((v) => ({ t: v.interaction.target && [v.interaction.target.x, v.interaction.target.y, v.interaction.target.z], ground: v.player.body.onGround, y: Math.round(v.player.body.y) })))
      .toEqual({ t: [at.x + 1, 199, at.z], ground: true, y: 200 });
    const item = await page.evaluate(() => {
      const v = (window as unknown as { __voxel: { hud: { selected: number; slotViews: { item: number }[] } } }).__voxel;
      return v.hud.slotViews[v.hud.selected].item;
    });
    await page.evaluate(() => (window as unknown as { __voxel: { input: { tap(a: string): void } } }).__voxel.input.tap('secondary'));
    const read = (x: number, y: number, z: number) => page.evaluate(([x, y, z]) => (window as unknown as { __voxel: G }).__voxel.world.getBlock(x, y, z), [x, y, z]);
    await expect.poll(() => read(at.x + 1, 200, at.z)).toBe(item);
    expect(item).toBeGreaterThan(0);

    await leaveGame(page);
    await openWorldMenu(page);
    await page.locator('[data-testid="world-card"]', { hasText: 'Skyline' }).getByTestId('play-world').click();
    await waitForGame(page);
    // The player is back on top of the pillar, and every block of it is there.
    await expect.poll(() => g(page)((v) => Math.round(v.player.body.y))).toBe(200);
    await expect.poll(() => read(at.x + 1, 200, at.z)).toBe(item);
    for (const y of [64, 65, 120, 199]) expect(await read(at.x, y, at.z)).toBe(BRICK);
    expect(await read(at.x, 200, at.z)).toBe(0);
  });

  test('rename and delete from the menu', async ({ page }) => {
    await newVoxelWorld(page, 'sandbox', 'Draft');
    await waitForGame(page);
    await leaveGame(page);
    await openWorldMenu(page);
    await page.getByTestId('world-more').click();
    await page.getByTestId('world-rename').click();
    await page.getByTestId('rename-input').fill('Final');
    await page.getByTestId('rename-ok').click();
    await expect(page.locator('.vw-name')).toHaveText('Final');
    await page.getByTestId('world-more').click();
    await page.getByTestId('world-delete').click();
    await page.getByTestId('confirm-delete').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('worlds-empty')).toBeVisible();
  });

  test('teleport menu: save a place, walk away, teleport back', async ({ page }, info) => {
    test.setTimeout(120_000);
    await newVoxelWorld(page, 'sandbox');
    await waitForGame(page);
    const home = await g(page)((v) => ({ ...v.player.body }));
    if (info.project.use.hasTouch) await page.locator('.touch-btn[data-id="teleport"]').tap();
    else await page.keyboard.press('KeyP');
    await expect(page.getByTestId('teleport-menu')).toBeVisible();
    await page.getByTestId('tp-place-name').fill('Home');
    await page.getByTestId('tp-save').click();
    await expect(page.locator('.tp-row')).toHaveCount(1);
    await page.locator('.tp-close').click();
    await expect(page.getByTestId('teleport-menu')).toHaveCount(0);
    await g(page)((v) => v.player.teleport(v.player.body.x + 25, v.player.body.y + 3, v.player.body.z - 18));
    await page.waitForTimeout(400);
    await g(page)((v) => v.teleport.open());
    await expect(page.locator('.tp-row')).toContainText('Home');
    await page.getByTestId('tp-go').click();
    await expect
      .poll(async () => {
        const b = await g(page)((v) => ({ ...v.player.body }));
        return Math.hypot(b.x - home.x, b.z - home.z);
      }, { timeout: 10_000 })
      .toBeLessThan(2);
    // Places are kept with the world.
    await leaveGame(page);
    await openWorldMenu(page);
    await page.getByTestId('play-world').click();
    await waitForGame(page);
    await g(page)((v) => v.teleport.open());
    await expect(page.locator('.tp-row')).toContainText('Home');
  });
});

test.describe('hosting worlds online', () => {
  test('a Private hosted world: join by code, kicked cleanly when the host leaves, progress back on rehost', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop project only');
    test.setTimeout(180_000);
    const host = await openPlayer(browser, info, 'Hosty');
    const code = await hostNewWorld(host, 'survival', { name: 'Fort' });
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    const guest = await openPlayer(browser, info, 'Guesty');
    await guest.getByTestId('room-code').fill(code);
    await guest.getByTestId('join-code').click();
    await waitForGame(guest);
    await expect.poll(() => g(host)((v) => (v as unknown as { net: { players(): unknown[] } }).net.players().length)).toBe(2);

    // The guest gathers something (the e2e server allows the survival test cheat).
    await guest.bringToFront();
    await g(guest)((v) => v.survival.debugGive('bread', 3));
    await expect.poll(() => bagTotal(guest), { timeout: 10_000 }).toBe(3);
    const had = await bagTotal(guest);

    // The host leaves (Save & quit): the guest is told and sent back.
    await host.bringToFront();
    await leaveGame(host);
    await expect(guest.locator('.toast')).toContainText('The host left', { timeout: 15_000 });
    await expect(guest.locator('.game-root')).toHaveCount(0);

    // Hosting again reuses the code; the guest's bag comes back from the host's save.
    await openWorldMenu(host);
    await expect(host.locator('.vw-code')).toHaveText(code);
    await host.getByTestId('host-world').click();
    await host.getByTestId('host-go').click();
    await waitForGame(host);
    expect(await g(host)((v) => v.net!.roomCode)).toBe(code);
    await guest.bringToFront();
    await guest.getByTestId('room-code').fill(code);
    await guest.getByTestId('join-code').click();
    await waitForGame(guest);
    await expect.poll(() => bagTotal(guest), { timeout: 15_000 }).toBe(had);
  });

  test('a Public hosted world is listed under Open worlds; teleport requests bring a player next to another', async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop project only');
    test.setTimeout(240_000);
    const host = await openPlayer(browser, info, 'Hosty');
    const code = await hostNewWorld(host, 'sandbox', { name: 'Open Meadow', public: true });

    const guest = await openPlayer(browser, info, 'Guesty');
    await openWorldMenu(guest);
    await guest.getByTestId('tab-join').click();
    const row = guest.getByTestId('open-world').filter({ hasText: 'Open Meadow' });
    await expect(row).toBeVisible({ timeout: 40_000 });
    await expect(row).toContainText("Hosty's");
    await row.getByRole('button', { name: 'Join' }).click();
    await waitForGame(guest);
    expect(await g(guest)((v) => v.net!.roomCode)).toBe(code);

    // The guest walks away a little (moves the server accepts), then asks to teleport to the host.
    await host.bringToFront();
    const hostAt = await g(host)((v) => ({ ...v.player.body }));
    await guest.bringToFront();
    await g(guest)((v) => v.teleport.open());
    await guest.locator('.tp-tabs .seg-btn', { hasText: 'Players' }).click();
    await guest.getByTestId('tp-ask').click();
    await host.bringToFront();
    await expect(host.getByTestId('tp-request')).toContainText('Guesty', { timeout: 10_000 });
    await host.keyboard.press('KeyY');
    await guest.bringToFront();
    await expect
      .poll(async () => {
        const b = await g(guest)((v) => ({ ...v.player.body }));
        return Math.hypot(b.x - hostAt.x, b.z - hostAt.z);
      }, { timeout: 15_000 })
      .toBeLessThan(4.5);
  });
});
