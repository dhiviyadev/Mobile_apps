import { expect, test } from '@playwright/test';
import { primeSettings, Touch, waitForGame } from './helpers';

type V = {
  player: { body: { x: number; y: number; z: number; onGround: boolean }; yaw: number; pitch: number };
  world: { getBlock: (x: number, y: number, z: number) => number };
  hud: { selected: number };
  interaction: { target: { x: number; y: number; z: number; block: number } | null };
};

test.describe('Voxelvale offline', () => {
  test.beforeEach(async ({ page }) => {
    await primeSettings(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('cobalt-hub.voxel.offline.v1'));
  });

  test('loads a world and renders the HUD', async ({ page }) => {
    await page.getByTestId('card-voxel').click();
    await page.getByRole('tab', { name: 'Sandbox' }).click();
    await page.getByRole('button', { name: 'Play offline' }).click();
    await waitForGame(page);
    await expect(page.getByTestId('hotbar')).toBeVisible();
    const pos = await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.player.body);
    expect(pos.y).toBeGreaterThan(20);
  });

  test('touch: joystick moves, drag looks, buttons break and place', async ({ page }, info) => {
    test.skip(!info.project.use.hasTouch, 'touch-only');
    await page.getByTestId('card-voxel').click();
    await page.getByRole('tab', { name: 'Sandbox' }).click();
    await page.getByRole('button', { name: 'Play offline' }).click();
    await waitForGame(page);
    await page.waitForTimeout(500);
    const touch = await Touch.create(page);
    const vp = page.viewportSize()!;
    const get = () => page.evaluate(() => {
      const v = (window as unknown as { __voxel: V }).__voxel;
      return { ...v.player.body, yaw: v.player.yaw, pitch: v.player.pitch };
    });

    // Look: drag on the right half.
    const before = await get();
    await touch.drag(1, [vp.width * 0.6, vp.height * 0.4], [vp.width * 0.45, vp.height * 0.4]);
    await touch.end(1);
    const afterLook = await get();
    expect(afterLook.yaw).toBeGreaterThan(before.yaw + 0.3);

    // Move: push the floating stick forward and hold.
    await touch.drag(2, [vp.width * 0.15, vp.height * 0.7], [vp.width * 0.15, vp.height * 0.7 - 70], 6);
    await page.waitForTimeout(900);
    await touch.end(2);
    const afterMove = await get();
    expect(Math.hypot(afterMove.x - afterLook.x, afterMove.z - afterLook.z)).toBeGreaterThan(1);

    // Look straight down and break the block under our feet with the Break button.
    await page.evaluate(() => {
      const v = (window as unknown as { __voxel: V }).__voxel;
      v.player.pitch = -Math.PI / 2 + 0.02;
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.player.body.onGround)).toBe(true);
    // Wait for a target under our feet: the first frames after the pitch change may still report the old view.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const v = (window as unknown as { __voxel: V }).__voxel;
          const t = v.interaction.target;
          return !!t && t.y < v.player.body.y && Math.abs(t.x + 0.5 - v.player.body.x) < 1.5 && Math.abs(t.z + 0.5 - v.player.body.z) < 1.5;
        }),
      )
      .toBe(true);
    const target = (await page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.interaction.target))!;
    const below = [target.x, target.y, target.z] as const;
    const blockBefore = target.block;
    expect(blockBefore).not.toBe(0);
    const breakBtn = page.locator('.touch-btn[data-id="break"]');
    const box = (await breakBtn.boundingBox())!;
    await touch.start(3, box.x + box.width / 2, box.y + box.height / 2);
    // Hold until the block breaks (frame rate in headless CI varies a lot).
    await expect
      .poll(() => page.evaluate((b) => (window as unknown as { __voxel: V }).__voxel.world.getBlock(...b), below), { timeout: 15_000 })
      .not.toBe(blockBefore);
    await touch.end(3);

    // Pick slot 3 (stone) on the hotbar and place a block.
    const slot = page.locator('.slot').nth(2);
    await slot.tap();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voxel: V }).__voxel.hud.selected)).toBe(2);
  });

  test('parkour mode shows a timer and checkpoints', async ({ page }) => {
    await page.getByTestId('card-voxel').click();
    await page.getByRole('tab', { name: 'Parkour' }).click();
    await page.getByRole('button', { name: 'Play offline' }).click();
    await waitForGame(page);
    await expect(page.getByTestId('parkour-timer')).toHaveText('00:00.00');
    await expect(page.locator('.pk-cp')).toContainText('Checkpoint 0/');
  });

  test('pause menu leaves back to the hub', async ({ page }, info) => {
    await page.getByTestId('card-voxel').click();
    await page.getByRole('tab', { name: 'Sandbox' }).click();
    await page.getByRole('button', { name: 'Play offline' }).click();
    await waitForGame(page);
    if (info.project.use.hasTouch) await page.locator('.touch-btn[data-id="menu"]').tap();
    else await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('leave-game').click();
    await expect(page.getByTestId('card-voxel')).toBeVisible();
    // The offline world was saved.
    const saved = await page.evaluate(() => localStorage.getItem('cobalt-hub.voxel.offline.v1'));
    expect(saved).toBeTruthy();
  });
});

test.describe('Voxelvale world upgrade', () => {
  test.beforeEach(async ({ page }) => {
    await primeSettings(page);
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.removeItem('cobalt-hub.voxel.offline.v1');
      localStorage.removeItem('cobalt-hub.voxel.hotbar.v1');
    });
  });

  test('block picker assigns a torch that can be placed and is remembered', async ({ page }, info) => {
    await page.getByTestId('card-voxel').click();
    await page.getByRole('tab', { name: 'Sandbox' }).click();
    await page.getByRole('button', { name: 'Play offline' }).click();
    await waitForGame(page);
    if (info.project.use.hasTouch) await page.locator('.touch-btn[data-id="blocks"]').tap();
    else await page.evaluate(() => (window as unknown as { __voxel: { worldFeatures: { openPicker(): void } } }).__voxel.worldFeatures.openPicker());
    await expect(page.getByTestId('block-picker')).toBeVisible();
    expect(await page.locator('.bp-cell').count()).toBeGreaterThanOrEqual(90);
    await page.getByTestId('bp-cell-112').click();
    const slotItem = () =>
      page.evaluate(() => {
        const v = (window as unknown as { __voxel: { hud: { selected: number; slotViews: { item: number }[] } } }).__voxel;
        return v.hud.slotViews[v.hud.selected].item;
      });
    await expect.poll(slotItem).toBe(112);
    if (info.project.use.hasTouch) await page.locator('.bp-close').tap();
    else await page.keyboard.press('Escape');
    await expect(page.getByTestId('block-picker')).toHaveCount(0);
    // Look straight down and place it on the ground (a torch needs the block below).
    type G = {
      player: { pitch: number; body: { y: number; onGround: boolean } };
      world: { getBlock(x: number, y: number, z: number): number };
      interaction: { target: { x: number; y: number; z: number; ny: number } | null };
      input: { tap(a: string): void };
    };
    await page.evaluate(() => {
      (window as unknown as { __voxel: G }).__voxel.player.pitch = -Math.PI / 2 + 0.02;
    });
    await expect.poll(() => page.evaluate(() => {
      const v = (window as unknown as { __voxel: G }).__voxel;
      return !!v.interaction.target && v.interaction.target.ny === 1 && v.player.body.onGround;
    })).toBe(true);
    const cell = await page.evaluate(() => {
      const t = (window as unknown as { __voxel: G }).__voxel.interaction.target!;
      return [t.x, t.y + 1, t.z] as const;
    });
    // Step aside is not needed: torches are not solid, so they may go where we stand.
    await page.evaluate(() => (window as unknown as { __voxel: G }).__voxel.input.tap('secondary'));
    await expect.poll(() => page.evaluate((c) => (window as unknown as { __voxel: G }).__voxel.world.getBlock(c[0], c[1], c[2]), cell)).toBe(112);
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('cobalt-hub.voxel.hotbar.v1')))!)).toContain(112);
    await page.reload();
    await page.getByTestId('card-voxel').click();
    await page.getByRole('tab', { name: 'Sandbox' }).click();
    await page.getByRole('button', { name: 'Play offline' }).click();
    await waitForGame(page);
    await expect.poll(slotItem).toBe(112);
  });

  test('an offline world from before the update keeps generator 1', async ({ page }) => {
    await page.evaluate(() =>
      localStorage.setItem('cobalt-hub.voxel.offline.v1', JSON.stringify({ seed: 1234, edits: [], player: { x: 0.5, y: 40, z: 0.5, yaw: 0, pitch: 0 }, time: 0.3 })),
    );
    await page.getByTestId('card-voxel').click();
    await page.getByRole('tab', { name: 'Sandbox' }).click();
    await page.getByRole('button', { name: 'Play offline' }).click();
    await waitForGame(page);
    expect(await page.evaluate(() => (window as unknown as { __voxel: { world: { genVersion: number } } }).__voxel.world.genVersion)).toBe(1);
    await expect(page.getByTestId('place-banner')).toContainText('New biomes');
    if (await page.locator('.touch-btn[data-id="menu"]').count()) await page.locator('.touch-btn[data-id="menu"]').tap();
    else await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toContainText('before the Biomes update');
  });
});

test.describe('touch layout editor', () => {
  test('buttons can be dragged, are saved, and mirror in left-handed mode', async ({ page }, info) => {
    test.skip(!info.project.use.hasTouch, 'touch-only');
    await primeSettings(page);
    await page.goto('/');
    await page.getByTestId('card-voxel').click();
    await page.getByRole('tab', { name: 'Sandbox' }).click();
    await page.getByRole('button', { name: 'Play offline' }).click();
    await waitForGame(page);
    await page.locator('.touch-btn[data-id="menu"]').tap();
    await page.getByRole('button', { name: 'Edit touch layout' }).click();
    await expect(page.locator('.touch-layer.editing')).toBeVisible();

    const jump = page.locator('.touch-btn[data-id="jump"]');
    const box = (await jump.boundingBox())!;
    const touch = await Touch.create(page);
    await touch.drag(5, [box.x + box.width / 2, box.y + box.height / 2], [box.x - 200, box.y - 150], 12);
    await touch.end(5);
    await page.getByRole('button', { name: 'Done' }).click();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cobalt-hub.settings.v1')!).touchLayout['voxel:jump']);
    expect(saved.x).toBeLessThan(0.85);
    const moved = (await jump.boundingBox())!;
    expect(moved.x).toBeLessThan(box.x - 100);

    // Left-handed mode mirrors the layout horizontally.
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('cobalt-hub.settings.v1')!);
      s.leftHanded = true;
      localStorage.setItem('cobalt-hub.settings.v1', JSON.stringify(s));
    });
    await page.locator('.touch-btn[data-id="menu"]').tap();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Controls' }).click();
    await page.locator('label.setting-row', { hasText: 'Left-handed layout' }).locator('input').setChecked(false);
    await page.locator('label.setting-row', { hasText: 'Left-handed layout' }).locator('input').setChecked(true);
    const vp = page.viewportSize()!;
    const breakBtn = (await page.locator('.touch-btn[data-id="break"]').boundingBox())!;
    expect(breakBtn.x + breakBtn.width / 2).toBeLessThan(vp.width / 2);
  });
});
