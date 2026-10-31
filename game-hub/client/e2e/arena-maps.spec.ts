import { expect, type Page, test } from '@playwright/test';
import { passMapVote, primeSettings, waitForGame } from './helpers';

type Pt = { x: number; y: number; z: number };
type A = {
  match: {
    phase: string;
    round: number;
    mapIndex: number;
    vote: { stage: 'open' | 'reveal'; candidates: number[]; winner: number; tie: boolean } | null;
    players: { id: string; vote: number }[];
  };
  map: { id: string; pads: { minX: number; maxX: number; minZ: number; maxZ: number; top: number; horizontal: string }[]; pickups: { kind: string; x: number; y: number; z: number }[] };
  predicted: { x: number; y: number; z: number; hp: number; alive: boolean } | null;
  yaw: number;
  input: { setKeyboardMove(x: number, y: number): void };
  itemsFx: { pickups?: { isVisible(i: number): boolean } };
  backend: {
    sim: {
      phase: string;
      phaseTimer: number;
      tick: number;
      botDifficulty: string;
      nav: { points: Pt[]; padNode: number[]; adj: { to: number }[][] };
      players: Map<string, { sim: Pt & { vx: number; vy: number; vz: number; hp: number } }>;
      removeBots(): void;
      resetToWarmup(): void;
    };
  };
};
/** The page's dev hook, typed for this file (arena-mp.spec.ts declares its own window.__arena). */
type W = { __arena: A };
const arena = <T>(page: Page, fn: (a: A) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__arena)`) as Promise<T>;

async function openPractice(page: Page, mode: '1 vs 1' | '2 vs 2' | 'Free-for-all' = '1 vs 1'): Promise<void> {
  await page.getByTestId('card-arena').click();
  await page.getByRole('tab', { name: mode }).click();
  await page.getByRole('button', { name: 'Practice vs bots' }).click();
  await waitForGame(page);
}

/** Gets past the vote and loadout, then removes the bots and goes back to warmup: free roaming on the voted map. */
async function roamAlone(page: Page): Promise<void> {
  await passMapVote(page);
  await page.evaluate(() => {
    const sim = (window as unknown as W).__arena.backend.sim;
    sim.removeBots();
    sim.resetToWarmup();
  });
  await expect.poll(() => arena(page, (a) => a.match.phase)).toBe('warmup');
  await expect.poll(() => arena(page, (a) => a.predicted?.alive ?? false)).toBe(true);
}

test.describe('Arcfire Arena maps and map vote', () => {
  test.beforeEach(async ({ page }) => {
    await primeSettings(page);
    await page.goto('/');
  });

  test('map vote before the match', async ({ page }, info) => {
    const touch = !!info.project.use.hasTouch;
    await openPractice(page, 'Free-for-all');
    const panel = page.getByTestId('map-vote');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.mv-card')).toHaveCount(3);
    const secs = Number(await page.getByTestId('vote-timer').innerText());
    expect(secs).toBeGreaterThanOrEqual(12);
    expect(secs).toBeLessThanOrEqual(15);
    if (touch) await expect(page.locator('.touch-layer')).toBeHidden();
    const cand = (await arena(page, (a) => a.match.vote!.candidates)) as number[];
    const myVote = () => arena(page, (a) => a.match.players.find((p) => p.id === 'you')!.vote);
    if (!touch) {
      await page.keyboard.press('Digit1');
      await expect.poll(myVote).toBe(cand[0]);
      await expect(page.getByTestId('vote-card-0')).toHaveClass(/mine/);
    }
    const tapOrClick = (i: number) => (touch ? page.getByTestId(`vote-card-${i}`).tap() : page.getByTestId(`vote-card-${i}`).click());
    await tapOrClick(1);
    await expect(page.getByTestId('vote-card-1')).toHaveClass(/mine/);
    await expect.poll(myVote).toBe(cand[1]);
    await tapOrClick(2);
    await expect.poll(myVote).toBe(cand[2]);
    await expect(page.getByTestId('vote-card-2')).toHaveClass(/mine/);
    await expect(page.getByTestId('vote-card-1')).not.toHaveClass(/mine/);
    // The only human has voted: the vote closes within 3 s of sim time (software-rendered frames can run slower) and the human vote wins.
    await expect.poll(() => arena(page, (a) => a.match.vote?.stage ?? 'none'), { timeout: 10_000 }).toBe('reveal');
    await expect(page.locator('.mv-card.winner')).toHaveAttribute('data-testid', 'vote-card-2');
    await expect(page.getByTestId('vote-hint')).toContainText('Next map');
    await expect(panel).toBeHidden({ timeout: 10_000 });
    expect(await arena(page, (a) => a.match.phase)).toBe('loadout');
    expect(await arena(page, (a) => a.match.mapIndex)).toBe(cand[2]);
    expect(await arena(page, (a) => a.match.round)).toBe(1);
    if (touch) await expect(page.locator('.touch-layer')).toBeVisible();
  });

  test('bot difficulty from the vote panel is used and remembered', async ({ page }) => {
    await openPractice(page);
    await expect(page.getByTestId('bots-normal')).toHaveClass(/on/);
    await page.getByTestId('bots-easy').click();
    await expect.poll(() => arena(page, (a) => a.backend.sim.botDifficulty)).toBe('easy');
    await expect(page.getByTestId('bots-easy')).toHaveClass(/on/);
    expect(await page.evaluate(() => localStorage.getItem('cobalt-hub.settings.v1'))).toContain('"arenaBotDifficulty":"easy"');
    await page.reload();
    await openPractice(page);
    await expect(page.getByTestId('bots-easy')).toHaveClass(/on/);
    expect(await arena(page, (a) => a.backend.sim.botDifficulty)).toBe('easy');
    await expect(page.getByTestId('map-vote')).toContainText('Bots');
  });

  test('a trampoline on the voted map launches you', async ({ page }) => {
    await openPractice(page);
    await roamAlone(page);
    // Stand on the nav node that leads onto the first trampoline and walk onto it.
    const start = await arena(page, (a) => {
      const pi = a.map.pads.findIndex((p) => p.horizontal === 'keep');
      const nav = a.backend.sim.nav;
      const padNode = nav.padNode.indexOf(pi);
      const from = nav.points[nav.adj.findIndex((es) => es.some((e) => e.to === padNode))];
      const to = nav.points[padNode];
      Object.assign(a.backend.sim.players.get('you')!.sim, { x: from.x, y: from.y, z: from.z, vx: 0, vy: 0, vz: 0 });
      a.yaw = Math.atan2(-(to.x - from.x), -(to.z - from.z));
      return { from, top: a.map.pads[pi].top };
    });
    await expect.poll(() => arena(page, (a) => a.predicted!.y)).toBeCloseTo(start.from.y, 0);
    await page.evaluate(() => (window as unknown as W).__arena.input.setKeyboardMove(0, 0.4));
    let peak = 0;
    await expect
      .poll(async () => {
        peak = Math.max(peak, await arena(page, (a) => a.predicted!.y));
        return peak;
      }, { timeout: 6000, intervals: [50] })
      .toBeGreaterThan(start.top + 3);
    await page.evaluate(() => (window as unknown as W).__arena.input.setKeyboardMove(0, 0));
  });

  test('a health pack on the voted map heals you', async ({ page }) => {
    await openPractice(page);
    await roamAlone(page);
    test.skip(!(await page.evaluate(() => !!(window as unknown as W).__arena.itemsFx.pickups)), 'pickups are rendered by the movement & items package');
    const i = await arena(page, (a) => a.map.pickups.findIndex((p) => p.kind === 'health'));
    await page.evaluate((i) => {
      const a = (window as unknown as W).__arena;
      const pk = a.map.pickups[i];
      Object.assign(a.backend.sim.players.get('you')!.sim, { x: pk.x, y: pk.y, z: pk.z, vx: 0, vy: 0, vz: 0, hp: 40 });
    }, i);
    await expect.poll(() => arena(page, (a) => a.predicted!.hp), { timeout: 1500 }).toBe(90);
    expect(await page.evaluate((i) => (window as unknown as W).__arena.itemsFx.pickups!.isVisible(i), i)).toBe(false);
    await page.evaluate((i) => {
      const a = (window as unknown as W).__arena;
      // Step off the pack first: at 90 HP it would be collected again the moment it respawns.
      const pk = a.map.pickups[i];
      Object.assign(a.backend.sim.players.get('you')!.sim, { x: pk.x + 6, z: pk.z, hp: 100 });
      a.backend.sim.tick += 600;
    }, i);
    await expect.poll(() => page.evaluate((i) => (window as unknown as W).__arena.itemsFx.pickups!.isVisible(i), i), { timeout: 3000 }).toBe(true);
  });
});
