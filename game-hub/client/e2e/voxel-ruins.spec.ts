import { expect, test } from '@playwright/test';
import { playVoxelOffline, primeSettings, waitForGame } from './helpers';

type Creature = { id: number; kind: string; x: number; y: number; z: number; health: number };
type V = {
  debug: { testBoss(key: string): boolean | null; creatures(): Creature[] };
  exit(): void;
};

/** The four bosses of the generator-4 ruins awaken in their synthetic arenas and are drawn (dev hook). */
test.describe('Voxelvale ruin bosses (offline)', () => {
  test.beforeEach(async ({ page }) => {
    await primeSettings(page);
    await page.goto('/');
    await playVoxelOffline(page, 'sandbox');
    await waitForGame(page);
    await page.waitForTimeout(400);
  });

  for (const key of ['brineclaw-matriarch', 'stormtalon', 'bramblehorn-elder', 'anvilheart-colossus']) {
    test(`${key} awakens in its arena`, async ({ page }) => {
      const ok = await page.evaluate((k) => (window as unknown as { __voxel: V }).__voxel.debug.testBoss(k), key);
      expect(ok).toBe(true);
      await expect
        .poll(() => page.evaluate((k) => (window as unknown as { __voxel: V }).__voxel.debug.creatures().some((c) => c.kind === k && c.health > 0), key), { timeout: 20_000 })
        .toBe(true);
    });
  }
});
