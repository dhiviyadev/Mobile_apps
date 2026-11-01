import { expect, type Page, test } from '@playwright/test';
import { primeSettings, waitForGame } from './helpers';

type S = {
  debugGive(key: string, n?: number): void;
  debugDamage(hp: number): void;
  openInventory(): void;
  model: { view: { count(item: number): number; items: Uint16Array; counts: Uint8Array } };
};
type V = {
  player: { body: { x: number; y: number; z: number; onGround: boolean }; yaw: number; pitch: number };
  world: { getBlock: (x: number, y: number, z: number) => number };
  hud: { selected: number };
  input: { press(a: string): void; release(a: string): void; tap(a: string): void; selectSlot(i: number): void };
  interaction: { target: { x: number; y: number; z: number; block: number } | null };
  survival: S;
  worldFeatures: { setSlot(i: number, item: number): void };
};
const v = (page: Page) => page.evaluate.bind(page);

async function startSurvival(page: Page): Promise<void> {
  await page.getByTestId('card-voxel').click();
  await expect(page.getByRole('tab', { name: 'Survival' })).toBeVisible();
  await page.getByRole('tab', { name: 'Survival' }).click();
  await page.getByRole('button', { name: 'Play offline' }).click();
  await waitForGame(page);
}

const count = (page: Page, item: number) => v(page)((i) => (window as unknown as { __voxel: V }).__voxel.survival.model.view.count(i), item);

test.describe('Voxelvale survival (offline)', () => {
  test.beforeEach(async ({ page }) => {
    await primeSettings(page);
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.removeItem('cobalt-hub.voxel.offline.survival.v1');
      localStorage.removeItem('cobalt-hub.voxel.offline.v1');
    });
  });

  test('vitals, mining with drops, crafting and moving items in the bag', async ({ page }, info) => {
    await startSurvival(page);
    await expect(page.locator('.gem.full')).toHaveCount(10);
    await expect(page.locator('.ration.full')).toHaveCount(10);
    await expect(page.locator('.hotbar .slot')).toHaveCount(9);

    // Mine the block under our feet by hand: it drops and is picked up.
    await page.evaluate(() => {
      const g = (window as unknown as { __voxel: V }).__voxel;
      g.player.pitch = -Math.PI / 2 + 0.02;
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.player.body.onGround)).toBe(true);
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.input.press('primary'));
    await expect
      .poll(() => page.evaluate(() => {
        const s = (window as unknown as { __voxel: V }).__voxel.survival.model.view;
        let n = 0;
        for (let i = 0; i < 36; i++) n += s.counts[i];
        return n;
      }), { timeout: 20_000 })
      .toBeGreaterThan(0);
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.input.release('primary'));

    // Craft planks from a log in the bag.
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.survival.debugGive('block:Log', 2));
    await expect.poll(() => count(page, 6)).toBe(2);
    if (info.project.use.hasTouch) await page.locator('.touch-btn[data-id="inventory"]').tap();
    else await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.survival.openInventory());
    await expect(page.getByTestId('inventory')).toBeVisible();
    await page.getByTestId('craft-1').click();
    await expect.poll(() => count(page, 8)).toBe(4);
    // Tap to lift, tap to place.
    const from = await page.evaluate(() => {
      const s = (window as unknown as { __voxel: V }).__voxel.survival.model.view;
      for (let i = 0; i < 36; i++) if (s.items[i] === 8 && s.counts[i]) return i;
      return -1;
    });
    const to = from === 20 ? 21 : 20;
    await page.getByTestId(`inv-slot-${from}`).click();
    await page.getByTestId(`inv-slot-${to}`).click();
    await expect.poll(() => page.evaluate((t) => (window as unknown as { __voxel: V }).__voxel.survival.model.view.items[t], to)).toBe(8);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('inventory')).toBeHidden();
  });

  test('bow shots use arrows; death drops a satchel; the save keeps the bag', async ({ page }) => {
    await startSurvival(page);
    await page.evaluate(() => {
      const s = (window as unknown as { __voxel: V }).__voxel.survival;
      s.debugGive('bow', 1);
      s.debugGive('arrow', 5);
    });
    await expect.poll(() => count(page, 280)).toBe(5);
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.input.selectSlot(0));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.hud.selected)).toBe(0);
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.input.press('secondary'));
    await page.waitForTimeout(1200);
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.input.release('secondary'));
    await expect.poll(() => count(page, 280)).toBe(4);

    // The bag survives a reload (offline save on leaving).
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.survival.debugDamage(5));
    await expect.poll(() => page.locator('.gem.full').count()).toBeLessThan(10);
    await page.evaluate(() => (window as unknown as { __voxel: { exit(): void } }).__voxel.exit());
    await expect(page.getByTestId('card-voxel')).toBeVisible();
    await startSurvival(page);
    await expect.poll(() => count(page, 312)).toBe(1);
    await expect.poll(() => page.locator('.gem.full').count()).toBeLessThan(10);

    // Death: one satchel with everything, then respawn at full health.
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.survival.debugDamage(40));
    await expect(page.getByTestId('death-screen')).toBeVisible();
    await expect(page.getByTestId('death-screen')).toContainText('satchel');
    await expect.poll(() => count(page, 312)).toBe(0);
    await page.getByTestId('respawn').click();
    await expect(page.getByTestId('death-screen')).toBeHidden();
    await expect(page.locator('.gem.full')).toHaveCount(10);
    await expect(page.getByTestId('satchel-chip')).toBeVisible();
  });

  test('touch: a shield in the off hand shows the Guard button', async ({ page }, info) => {
    test.skip(!info.project.use.hasTouch, 'touch-only');
    await startSurvival(page);
    const guard = page.locator('.touch-btn[data-id="guard"]');
    await expect(guard).toBeHidden();
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.survival.debugGive('wooden_shield', 1));
    await expect.poll(() => count(page, 308)).toBe(1);
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.input.tap('swapHands'));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.survival.model.view.items[36])).toBe(308);
    await expect(guard).toBeVisible();
  });

  test('sandbox: weapons can be held and swung', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.getByTestId('card-voxel').click();
    await page.getByRole('tab', { name: 'Sandbox' }).click();
    await page.getByRole('button', { name: 'Play offline' }).click();
    await waitForGame(page);
    await page.evaluate(() => {
      const g = (window as unknown as { __voxel: V }).__voxel;
      g.worldFeatures.setSlot(0, 306);
      g.input.selectSlot(0);
      g.player.pitch = Math.PI / 2 - 0.05;
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.hud.selected)).toBe(0);
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.input.tap('primary'));
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
    await expect(page.locator('.gem')).toHaveCount(0);
  });
});
