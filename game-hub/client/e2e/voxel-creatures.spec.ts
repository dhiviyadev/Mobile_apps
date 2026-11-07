import { expect, type Page, test } from '@playwright/test';
import { playVoxelOffline, primeSettings, Touch, waitForGame } from './helpers';

type Creature = { id: number; kind: string; x: number; y: number; z: number; health: number };
type V = {
  player: { body: { x: number; y: number; z: number }; yaw: number; pitch: number };
  camera: { position: { x: number; y: number; z: number } };
  entities: { count(): number; instanceCount: number; lastTameResult: string | null };
  localEntities: { saveMobs?: unknown; sim: { saveMobs(): unknown[] } };
  worldFeatures: { setSlot(i: number, item: number): void };
  input: { selectSlot(i: number): void; tap(a: string): void };
  hud: { selected: number };
  debug: { setTime(t: number): void; spawnMob(k: string, dx: number, dz: number): number | null; creatures(): Creature[]; hitTarget(n?: number): boolean };
  exit(): void;
};
const HAY_BALE = 86;

async function startSandbox(page: Page): Promise<void> {
  await playVoxelOffline(page, 'sandbox');
  await waitForGame(page);
  await page.waitForTimeout(400);
}

/** Points the camera at a creature (by id). */
async function aimAt(page: Page, id: number): Promise<boolean> {
  return page.evaluate((id) => {
    const v = (window as unknown as { __voxel: V }).__voxel;
    const c = v.debug.creatures().find((m) => m.id === id);
    if (!c) return false;
    const e = v.camera.position;
    const dx = c.x - e.x;
    const dy = c.y + 0.6 - e.y;
    const dz = c.z - e.z;
    v.player.yaw = Math.atan2(-dx, -dz);
    v.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    return true;
  }, id);
}

test.describe('Voxelvale creatures (offline)', () => {
  test.beforeEach(async ({ page }) => {
    await primeSettings(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('cobalt-hub.voxel.offline.v1'));
  });

  test('a spawned Woolback is drawn and named under the crosshair', async ({ page }) => {
    await startSandbox(page);
    const id = await page.evaluate(() => {
      const v = (window as unknown as { __voxel: V }).__voxel;
      v.debug.setTime(0.5);
      return v.debug.spawnMob('woolback', 0, -4);
    });
    expect(id).not.toBeNull();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.entities.count())).toBeGreaterThanOrEqual(1);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.entities.instanceCount)).toBeGreaterThan(0);
    await expect.poll(async () => {
      await aimAt(page, id!);
      return (await page.getByTestId('mob-target').textContent()) ?? '';
    }).toContain('Woolback');
  });

  test('feeding a Hay Bale tames a Woolback and the world keeps it', async ({ page }, info) => {
    await startSandbox(page);
    const id = await page.evaluate((hay) => {
      const v = (window as unknown as { __voxel: V }).__voxel;
      v.debug.setTime(0.5);
      v.worldFeatures.setSlot(0, hay);
      v.input.selectSlot(0);
      return v.debug.spawnMob('woolback', 0, -3);
    }, HAY_BALE);
    expect(id).not.toBeNull();
    const touch = info.project.use.hasTouch ? await Touch.create(page) : null;
    const place = page.locator('.touch-btn[data-id="place"]');
    await expect.poll(async () => {
      await aimAt(page, id!);
      if (touch) {
        const box = (await place.boundingBox())!;
        await touch.start(5, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(80);
        await touch.end(5);
      } else {
        await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.input.tap('secondary'));
      }
      await page.waitForTimeout(120);
      return page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.entities.lastTameResult);
    }, { timeout: 30_000 }).toBe('tamed');
    // Saved with the world and back after reopening it.
    await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.exit());
    await expect(page.getByTestId('world-card')).toHaveCount(1);
    await page.reload();
    await startSandbox(page);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.localEntities.sim.saveMobs().length)).toBe(1);
  });
});
