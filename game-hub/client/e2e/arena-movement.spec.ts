import { expect, type Page, test } from '@playwright/test';
import { primeSettings, startArenaPractice } from './helpers';

/**
 * Arcfire Arena movement and items in the browser, on fixture maps loaded into the offline sim
 * (window.__arenaFixtures.flatArenaMap), so nothing here depends on real map geometry.
 */

type Fx = { eye: number; roll: number; fovAdd: number; dipY: number };
type Predicted = { x: number; y: number; z: number; vx: number; vz: number; hp: number; sliding: boolean; crouching: boolean; onGround: boolean };
type ArenaDev = {
  match: { phase: string };
  predicted: Predicted | null;
  yaw: number;
  pitch: number;
  input: { setStick(x: number, y: number): void };
  moveFx: { fx: Fx };
  itemsFx: {
    pads: { drawCalls: number; group: { children: unknown[] } };
    pickups: { drawCalls: number; isVisible(i: number): boolean; group: { children: unknown[] } };
  };
  renderer: { drawCalls: number };
  backend: {
    sim: {
      tick: number;
      phaseTimer: number;
      brains: Map<string, unknown>;
      players: Map<string, { id: string; sim: Record<string, number | boolean> }>;
      changeMap(map: unknown): void;
    };
  };
};
type Win = { __arena: ArenaDev; __arenaFixtures: { flatArenaMap(o?: unknown): unknown } };

const A = <T>(page: Page, fn: (a: ArenaDev) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__arena)`) as Promise<T>;

/** A 5 m trampoline (launchVelocityForHeight(5) = 15.69 m/s) 0.3 m tall, centred at (0, -6). */
const TRAMPOLINE = { minX: -1, maxX: 1, minZ: -7, maxZ: -5, top: 0.3, vx: 0, vy: 15.69, vz: 0, horizontal: 'keep', bounce: 0.85 };
/** A launcher at (8, -6) aimed 12 m further north. */
const LAUNCHER = { minX: 7, maxX: 9, minZ: -7, maxZ: -5, top: 0.3, vx: 0, vy: 15, vz: -9, horizontal: 'set', bounce: 0 };
const padBox = (p: typeof TRAMPOLINE) => ({ minX: p.minX, maxX: p.maxX, minY: 0, maxY: p.top, minZ: p.minZ, maxZ: p.maxZ, kind: 'pad' });

/**
 * Practice 1v1 on a fixture map: live round, the bot frozen (no brain) out of the way, and us at
 * (x, 0, z) looking north (-Z).
 */
async function practiceOn(page: Page, map: object, at: [number, number] = [0, 0]): Promise<void> {
  await startArenaPractice(page, '1 vs 1');
  await page.evaluate((m) => {
    const w = window as unknown as Win;
    const sim = w.__arena.backend.sim;
    sim.changeMap(w.__arenaFixtures.flatArenaMap(m));
    sim.brains.clear();
    sim.phaseTimer = 0;
  }, map);
  await expect.poll(() => A(page, (a) => a.match.phase), { timeout: 10_000 }).toBe('live');
  await teleport(page, at);
}

async function teleport(page: Page, [x, z]: [number, number], hp?: number): Promise<void> {
  await page.evaluate(
    ([x, z, hp]) => {
      const a = (window as unknown as Win).__arena;
      for (const p of a.backend.sim.players.values()) {
        if (p.id === 'you') Object.assign(p.sim, { x, y: 0, z, vx: 0, vy: 0, vz: 0, onGround: true, ...(hp === null ? {} : { hp }) });
        else Object.assign(p.sim, { x: 30, y: 0, z: 30 });
      }
      a.yaw = 0;
      a.pitch = 0;
    },
    [x, z, hp ?? null] as const,
  );
  // Reconciliation snaps the predicted player there (more than 3 m) or blends it in.
  await expect.poll(() => A(page, (a) => Math.round(a.predicted!.z * 10) / 10)).toBeCloseTo(z, 0);
}

const speed = (page: Page) => A(page, (a) => Math.hypot(a.predicted!.vx, a.predicted!.vz));

test.describe('Arcfire Arena movement', () => {
  test('desktop: W + C slides, then stands up again', async ({ page }, info) => {
    test.skip(!!info.project.use.hasTouch, 'desktop-only');
    await primeSettings(page);
    await page.goto('/');
    await practiceOn(page, {}, [0, 20]);
    await page.keyboard.down('KeyW');
    await expect.poll(() => speed(page)).toBeGreaterThan(7);
    await page.keyboard.press('KeyC');
    await expect.poll(() => A(page, (a) => a.predicted!.sliding), { timeout: 3000 }).toBe(true);
    // Mid slide: low eye, tilted and zoomed camera (camera motion is on by default).
    const fx = await A(page, (a) => ({ ...a.moveFx.fx }));
    expect(fx.roll).toBeGreaterThan(0);
    // Leaving the page mid-match asks first (Ctrl+W while sliding with Ctrl).
    expect(await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    })).toBe(true);
    await expect.poll(() => A(page, (a) => a.predicted!.sliding), { timeout: 3000 }).toBe(false);
    await page.keyboard.up('KeyW');
    await expect.poll(() => A(page, (a) => a.predicted!.crouching)).toBe(false);
  });

  test('touch: the Crouch button turns into a Slide button, and a slide does not latch crouch', async ({ page }, info) => {
    test.skip(!info.project.use.hasTouch, 'touch-only');
    await primeSettings(page);
    await page.goto('/');
    await practiceOn(page, {}, [0, 20]);
    const crouch = page.locator('.touch-btn[data-id="crouch"]');
    // Standing still: the crouch icon (down arrow).
    await expect(crouch.locator('path')).toHaveAttribute('d', 'M12 5v14M5 12l7 7 7-7');
    await page.evaluate(() => (window as unknown as Win).__arena.input.setStick(0, 1));
    await expect.poll(() => speed(page)).toBeGreaterThan(7);
    // Running: the slide icon, highlighted.
    await expect(crouch.locator('path')).toHaveAttribute('d', 'M3 19h18M5 15h11M13 12l3 3-3 3');
    await expect(crouch).toHaveClass(/slide-ready/);
    await crouch.tap();
    await expect.poll(() => A(page, (a) => a.predicted!.sliding), { timeout: 3000 }).toBe(true);
    await page.waitForTimeout(1500);
    // The slide is over and we are running again, not stuck crouching.
    await expect(crouch).not.toHaveClass(/\bon\b/);
    expect(await A(page, (a) => a.predicted!.crouching)).toBe(false);
    expect(await speed(page)).toBeGreaterThan(7);
    await page.evaluate(() => (window as unknown as Win).__arena.input.setStick(0, 0));
    await expect(crouch.locator('path')).toHaveAttribute('d', 'M12 5v14M5 12l7 7 7-7');
    // A tap while standing still still toggles crouch, as before.
    await expect.poll(() => speed(page)).toBe(0);
    await crouch.tap();
    await expect(crouch).toHaveClass(/\bon\b/);
    await expect.poll(() => A(page, (a) => a.predicted!.crouching)).toBe(true);
    await crouch.tap();
    await expect.poll(() => A(page, (a) => a.predicted!.crouching)).toBe(false);
  });

  test('camera motion off: no tilt, zoom or dip at all', async ({ page }, info) => {
    test.skip(!!info.project.use.hasTouch, 'desktop-only');
    await primeSettings(page, { cameraMotion: false });
    await page.goto('/');
    await practiceOn(page, {}, [0, 20]);
    await page.keyboard.down('KeyW');
    await expect.poll(() => speed(page)).toBeGreaterThan(7);
    await page.keyboard.press('KeyC');
    await expect.poll(() => A(page, (a) => a.predicted!.sliding), { timeout: 3000 }).toBe(true);
    const samples: Fx[] = [];
    for (let i = 0; i < 6; i++) {
      samples.push(await A(page, (a) => ({ ...a.moveFx.fx })));
      await page.waitForTimeout(80);
    }
    // Then a jump and a landing.
    await page.keyboard.press('Space');
    for (let i = 0; i < 8; i++) {
      samples.push(await A(page, (a) => ({ ...a.moveFx.fx })));
      await page.waitForTimeout(100);
    }
    await page.keyboard.up('KeyW');
    for (const s of samples) expect([s.roll, s.fovAdd, s.dipY]).toEqual([0, 0, 0]);
    expect(samples.some((s) => s.eye < 1.3)).toBe(true); // the slide eye still drops
  });
});

test.describe('Arcfire Arena items', () => {
  test('a health pack heals to 90 and hides, then respawns', async ({ page }) => {
    await primeSettings(page);
    await page.goto('/');
    await practiceOn(page, { pickups: [{ kind: 'health', x: 0, y: 0, z: -4 }] }, [0, 4]);
    expect(await A(page, (a) => a.itemsFx.pickups.isVisible(0))).toBe(true);
    await teleport(page, [0.3, -4], 40);
    await expect.poll(() => A(page, (a) => a.predicted!.hp), { timeout: 3000 }).toBe(90);
    expect(await A(page, (a) => a.itemsFx.pickups.isVisible(0))).toBe(false);
    await expect(page.getByTestId('pickup-flash')).toHaveText('+50 HP');
    // Step away, then fast-forward the 20 s respawn.
    await teleport(page, [6, 0]);
    await page.evaluate(() => {
      (window as unknown as Win).__arena.backend.sim.tick += 600;
    });
    await expect.poll(() => A(page, (a) => a.itemsFx.pickups.isVisible(0)), { timeout: 5000 }).toBe(true);
  });

  test('a trampoline throws the predicted player above 3 m', async ({ page }, info) => {
    await primeSettings(page);
    await page.goto('/');
    await practiceOn(page, { pads: [TRAMPOLINE], boxes: [padBox(TRAMPOLINE)] }, [0, 0]);
    if (info.project.use.hasTouch) await page.evaluate(() => (window as unknown as Win).__arena.input.setStick(0, 1));
    else await page.keyboard.down('KeyW');
    await expect.poll(() => A(page, (a) => a.predicted!.y), { timeout: 5000, intervals: [50] }).toBeGreaterThan(3);
    if (!info.project.use.hasTouch) await page.keyboard.up('KeyW');
  });

  test('pads and pickups cost draw calls only on maps that have them', async ({ page }, info) => {
    test.skip(!!info.project.use.hasTouch, 'desktop-only');
    await primeSettings(page);
    await page.goto('/');
    await practiceOn(page, {}, [0, 6]);
    await page.evaluate(() => {
      (window as unknown as Win).__arena.pitch = -0.35;
    });
    expect(await A(page, (a) => [a.itemsFx.pads.drawCalls, a.itemsFx.pickups.drawCalls, a.itemsFx.pads.group.children.length, a.itemsFx.pickups.group.children.length])).toEqual([0, 0, 0, 0]);
    await page.waitForTimeout(500);
    const before = await A(page, (a) => a.renderer.drawCalls);
    await page.evaluate(
      (m) => {
        const w = window as unknown as Win;
        w.__arena.backend.sim.changeMap(w.__arenaFixtures.flatArenaMap(m));
      },
      {
        pads: [TRAMPOLINE, LAUNCHER],
        boxes: [padBox(TRAMPOLINE), padBox(LAUNCHER)],
        pickups: [{ kind: 'health', x: -3, y: 0, z: -2 }, { kind: 'ammo', x: 3, y: 0, z: -2 }],
      },
    );
    await expect.poll(() => A(page, (a) => [a.itemsFx.pads.drawCalls, a.itemsFx.pickups.drawCalls])).toEqual([2, 3]);
    // Caps + landing marks + two pickup kinds + rings.
    await expect.poll(() => A(page, (a) => a.renderer.drawCalls)).toBe(before + 5);
  });
});
