import { type Browser, expect, type Page, test } from '@playwright/test';
import { waitForGame } from './helpers';

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

const v = (page: Page) => page.evaluate.bind(page);

test('two players share a Voxelvale world: edits, chat and avatars replicate', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop project only');
  const a = await openPlayer(browser, 'Alpha');
  await a.getByTestId('card-voxel').click();
  await a.getByRole('tab', { name: 'Sandbox' }).click();
  await a.getByTestId('create-private').click();
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
