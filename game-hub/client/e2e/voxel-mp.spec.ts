import { type Browser, expect, type Page, test } from '@playwright/test';
import { hostNewWorld, waitForGame } from './helpers';

type V = {
  player: { body: { x: number; y: number; z: number; onGround: boolean }; yaw: number; pitch: number };
  world: { getBlock: (x: number, y: number, z: number) => number };
  interaction: { target: { x: number; y: number; z: number; block: number } | null };
  net: { roomCode: string; players: () => { name: string }[]; requestEdit: (x: number, y: number, z: number, id: number) => boolean; chat: { isOpen: boolean } } | null;
  applyEdit: (x: number, y: number, z: number, id: number) => void;
};

async function openPlayer(browser: Browser, name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await ctx.newPage();
  await page.addInitScript((n) => localStorage.setItem('cobalt-hub.settings.v1', JSON.stringify({ nickname: n })), name);
  await page.goto('/');
  return page;
}

const v = (page: Page) => {
  void page.bringToFront();
  return page.evaluate.bind(page);
};

test('two players share a Voxelvale world: edits, chat and avatars replicate', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop project only');
  const a = await openPlayer(browser, 'Alpha');
  await hostNewWorld(a, 'sandbox');
  await waitForGame(a);
  const code = await a.evaluate(() => (window as unknown as { __voxel: V }).__voxel.net!.roomCode);
  expect(code).toMatch(/^[A-Z2-9]{6}$/);

  const b = await openPlayer(browser, 'Bravo');
  await b.getByTestId('room-code').fill(code);
  await b.getByTestId('join-code').click();
  await waitForGame(b);
  await expect.poll(() => v(a)(() => (window as unknown as { __voxel: V }).__voxel.net!.players().length)).toBe(2);

  // Alpha places a block two above its head; Bravo must see it.
  const target = await a.evaluate(() => {
    const g = (window as unknown as { __voxel: V }).__voxel;
    const p = g.player.body;
    const x = Math.floor(p.x) + 1;
    const y = Math.floor(p.y) + 3;
    const z = Math.floor(p.z);
    g.net!.requestEdit(x, y, z, 11); // brick
    g.applyEdit(x, y, z, 11);
    return { x, y, z };
  });
  await expect
    .poll(() => b.evaluate((t) => (window as unknown as { __voxel: V }).__voxel.world.getBlock(t.x, t.y, t.z), target), { timeout: 10_000 })
    .toBe(11);

  // A late joiner gets the edit history.
  const c = await openPlayer(browser, 'Charlie');
  await c.getByTestId('room-code').fill(code);
  await c.getByTestId('join-code').click();
  await waitForGame(c);
  await expect
    .poll(() => c.evaluate((t) => (window as unknown as { __voxel: V }).__voxel.world.getBlock(t.x, t.y, t.z), target), { timeout: 10_000 })
    .toBe(11);

  // Chat from Alpha shows up for Bravo.
  await a.keyboard.press('KeyT');
  await a.getByTestId('chat-input').fill('hello builders');
  await a.getByTestId('chat-input').press('Enter');
  await expect(b.getByTestId('chat-log')).toContainText('hello builders');
  await expect(b.getByTestId('chat-log')).toContainText('Alpha');

  // Bravo renders Alpha's avatar (instanced body count >= 1) and nametag.
  await expect
    .poll(() =>
      b.evaluate(() => {
        let bodies = 0;
        const g = (window as unknown as { __voxel: { scene: { traverse: (f: (o: { isInstancedMesh?: boolean; count?: number; isSprite?: boolean; visible?: boolean }) => void) => void } } }).__voxel;
        g.scene.traverse((o) => {
          if (o.isInstancedMesh && (o.count ?? 0) > bodies) bodies = o.count ?? 0;
        });
        return bodies;
      }),
    )
    .toBeGreaterThanOrEqual(2);

  await Promise.all([a.context().close(), b.context().close(), c.context().close()]);
});

test('survival PvP: the host turns PvP on and a punch hurts the other player', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop project only');
  test.setTimeout(150_000);
  type P = V & { input: { tap(a: string): void }; survival: unknown };
  const a = await openPlayer(browser, 'Alpha');
  await hostNewWorld(a, 'survival');
  await waitForGame(a);
  const code = await a.evaluate(() => (window as unknown as { __voxel: V }).__voxel.net!.roomCode);
  const b = await openPlayer(browser, 'Bravo');
  await b.getByTestId('room-code').fill(code);
  await b.getByTestId('join-code').click();
  await waitForGame(b);
  await expect.poll(() => v(a)(() => (window as unknown as { __voxel: V }).__voxel.net!.players().length)).toBe(2);

  // The host turns PvP on from the pause menu.
  await a.bringToFront();
  await a.keyboard.press('Escape');
  await expect(a.getByTestId('pause-menu')).toBeVisible();
  await a.getByRole('button', { name: /PvP: Off/ }).click();
  await expect.poll(() => a.evaluate(() => (window as unknown as { __voxel: { net: { session: { state: { rules: number } } } } }).__voxel.net.session.state.rules)).toBe(1);
  await expect(a.getByTestId('pause-menu')).toBeHidden();

  // Bravo stands two blocks in front of Alpha (Alpha looks along -Z).
  const pos = await a.evaluate(() => {
    const g = (window as unknown as { __voxel: V }).__voxel;
    g.player.yaw = 0;
    g.player.pitch = 0;
    return { x: g.player.body.x, y: g.player.body.y, z: g.player.body.z };
  });
  await b.bringToFront();
  await b.evaluate((p) => (window as unknown as { __voxel: { player: { teleport(x: number, y: number, z: number): void } } }).__voxel.player.teleport(p.x, p.y, p.z - 2), pos);
  await b.waitForTimeout(1500); // Bravo's frames send the new position
  await a.bringToFront();
  await a.waitForTimeout(2500); // spawn protection
  const hp = () => b.evaluate(() => {
    const g = (window as unknown as { __voxel: { net: { session: { state: { players: Map<string, { hp: number }> }; sessionId: string } } } }).__voxel;
    return g.net.session.state.players.get(g.net.session.sessionId)!.hp;
  });
  await expect
    .poll(async () => {
      // Keep Bravo in front of Alpha (its own physics may have moved it).
      await b.evaluate((p) => {
        const g = (window as unknown as { __voxel: { player: { body: { x: number; z: number }; teleport(x: number, y: number, z: number): void } } }).__voxel;
        if (Math.hypot(g.player.body.x - p.x, g.player.body.z - (p.z - 2)) > 0.6) g.player.teleport(p.x, p.y, p.z - 2);
      }, pos);
      await a.evaluate(() => {
        const g = (window as unknown as { __voxel: P }).__voxel;
        g.player.yaw = 0;
        g.player.pitch = 0;
        g.input.tap('primary');
      });
      return hp();
    }, { timeout: 15_000 })
    .toBeLessThan(20);
  await expect(a.locator('.dmg-num.show').first()).toBeAttached();
  await Promise.all([a.context().close(), b.context().close()]);
});
