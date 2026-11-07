import { expect, test } from '@playwright/test';
import { newVoxelWorld, openWorldMenu, primeSettings, waitForGame } from './helpers';

type V = {
  player: { body: { x: number; y: number; z: number; vx: number; vy: number; vz: number } };
  generator: { genVersion: number; limit: number; surfaceHeight: (x: number, z: number) => number };
  world: { isLoaded: (x: number, z: number) => boolean; radiusChunks: number };
};

test.describe('Voxelvale world generators', () => {
  test.beforeEach(async ({ page }) => {
    await primeSettings(page);
  });

  test('a new world is endless (generator 3) and streams terrain past the old edge', async ({ page }) => {
    await page.goto('/');
    await newVoxelWorld(page, 'sandbox', 'Endless test');
    await waitForGame(page);
    const info = await page.evaluate(() => ({ gen: (window as unknown as { __voxel: V }).__voxel.generator.genVersion, limit: (window as unknown as { __voxel: V }).__voxel.generator.limit, radius: (window as unknown as { __voxel: V }).__voxel.world.radiusChunks }));
    expect(info).toEqual({ gen: 3, limit: 32000, radius: 2000 });
    // Far past where generator-2 worlds end (512): the terrain loads there and the player is not pushed back.
    await page.evaluate(() => {
      const v = (window as unknown as { __voxel: V }).__voxel;
      const y = v.generator.surfaceHeight(1500, 40) + 2;
      Object.assign(v.player.body, { x: 1500.5, y, z: 40.5, vx: 0, vy: 0, vz: 0 });
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.world.isLoaded(1500, 40)), { timeout: 30_000 }).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.player.body.x)).toBeGreaterThan(1490);
  });

  test('an old generator-2 save moves into the world list and still loads with generator 2', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      const save = { seed: 4242, edits: [], player: { x: 10.5, y: 50, z: -20.5, yaw: 0, pitch: 0 }, time: 0.3, gen: 2 };
      localStorage.setItem('cobalt-hub.voxel.offline.v1', JSON.stringify(save));
    });
    // The world menu imports the old save as a world of its own.
    await openWorldMenu(page);
    const card = page.locator('[data-testid="world-card"]:has-text("My Sandbox World")');
    await expect(card).toBeVisible();
    await card.getByTestId('play-world').click();
    await waitForGame(page);
    const info = await page.evaluate(() => ({ gen: (window as unknown as { __voxel: V }).__voxel.generator.genVersion, limit: (window as unknown as { __voxel: V }).__voxel.generator.limit, x: (window as unknown as { __voxel: V }).__voxel.player.body.x }));
    expect(info.gen).toBe(2);
    expect(info.limit).toBe(512);
    expect(Math.abs(info.x - 10.5)).toBeLessThan(2);
  });
});
