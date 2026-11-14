import { expect, test, type Page } from '@playwright/test';
import { newVoxelWorld, primeSettings, waitForGame } from './helpers';

type V = {
  player: { teleport(x: number, y: number, z: number): void; body: { x: number; y: number; z: number } };
  world: { getBlock(x: number, y: number, z: number): number; isLoaded(x: number, z: number): boolean };
  generator: { genVersion: number };
  sky: { realmMix: number };
  portal: { light(x: number, y: number, z: number): void };
  applyWorldEdit(x: number, y: number, z: number, id: number): void;
  openPicker?: unknown;
  worldFeatures: { openPicker(slot?: number): void };
};
const BLOCK = { Air: 0, StoneBricks: 94, LatticeStone: 163, Veil: 165 };

const pos = (page: Page) => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.player.body);

test.describe('Gloamreach: make a Lattice Ring, light it, cross and come back', () => {
  test.beforeEach(async ({ page }) => {
    await primeSettings(page);
  });

  test('picker has the stone and the lens; a lit ring carries you across and home', async ({ page }) => {
    await page.goto('/');
    await newVoxelWorld(page, 'sandbox', 'Gloam test');
    await waitForGame(page);
    expect(await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.generator.genVersion)).toBe(4);

    // The Block Picker offers the frame block and (in its Items tab) the key.
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.worldFeatures.openPicker(0));
    const picker = page.getByTestId('block-picker');
    await expect(picker).toBeVisible();
    await picker.locator('.bp-search').fill('Lattice');
    await expect(picker.getByTestId('bp-cell-163')).toBeVisible();
    await picker.locator('.bp-search').fill('Dusk Lens');
    await expect(picker.getByTestId('bp-cell-337')).toBeVisible();
    await picker.locator('.bp-close').click();

    // Build a ring in front of the player (the same edits the picker's stones make), then light it.
    const ring = await page.evaluate(
      ({ B }) => {
        const v = (window as unknown as { __voxel: V }).__voxel;
        const p = v.player.body;
        const f = { x: Math.floor(p.x) - 2, y: Math.floor(p.y), z: Math.floor(p.z) + 4 };
        for (let dy = -1; dy < 6; dy++) for (let u = -1; u <= 5; u++) for (let s = -3; s <= 3; s++) v.applyWorldEdit(f.x + u, f.y + dy, f.z + s, dy === -1 ? B.StoneBricks : B.Air);
        for (let v2 = 0; v2 < 5; v2++) {
          for (let u = 0; u < 5; u++) {
            const border = u === 0 || u === 4 || v2 === 0 || v2 === 4;
            const corner = (u === 0 || u === 4) && (v2 === 0 || v2 === 4);
            if (border && !corner) v.applyWorldEdit(f.x + u, f.y + v2, f.z, B.LatticeStone);
          }
        }
        v.portal.light(f.x + 1, f.y, f.z);
        return f;
      },
      { B: BLOCK },
    );
    await expect.poll(() => page.evaluate(({ f, B }) => (window as unknown as { __voxel: V }).__voxel.world.getBlock(f.x + 2, f.y + 2, f.z) === B.Veil, { f: ring, B: BLOCK })).toBe(true);

    // Stand in the veil: swirl, two seconds, across.
    await page.evaluate((f) => (window as unknown as { __voxel: V }).__voxel.player.teleport(f.x + 2.5, f.y + 1, f.z + 0.5), ring);
    await expect(page.getByTestId('gloam-veil')).toBeVisible();
    await expect.poll(async () => (await pos(page)).x, { timeout: 30_000 }).toBeGreaterThan(14000);
    await expect(page.getByTestId('place-banner')).toContainText('Gloamreach', { timeout: 10_000 });
    // A different sky: the realm blend reaches 1.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.sky.realmMix), { timeout: 10_000 }).toBeGreaterThan(0.95);
    await page.screenshot({ path: test.info().outputPath('gloamreach-arrival.png') });

    // Home through the partner gate (the lit veil beside where we landed).
    await page.waitForTimeout(4500);
    const veil = await page.evaluate(({ B }) => {
      const v = (window as unknown as { __voxel: V }).__voxel;
      const p = v.player.body;
      for (let r = 0; r <= 16; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let y = 2; y < 63; y++) if (v.world.getBlock(Math.floor(p.x) + dx, y, Math.floor(p.z) + dz) === B.Veil) return [Math.floor(p.x) + dx, y, Math.floor(p.z) + dz];
      return null;
    }, { B: BLOCK });
    expect(veil).not.toBeNull();
    await page.evaluate(([x, y, z]) => (window as unknown as { __voxel: V }).__voxel.player.teleport(x + 0.5, y, z + 0.5), veil as number[]);
    await expect.poll(async () => (await pos(page)).x, { timeout: 30_000 }).toBeLessThan(12000);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.sky.realmMix), { timeout: 10_000 }).toBeLessThan(0.05);
  });
});
