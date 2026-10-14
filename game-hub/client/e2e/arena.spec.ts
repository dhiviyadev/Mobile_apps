import { expect, type Page, test } from '@playwright/test';
import { primeSettings, Touch, waitForGame } from './helpers';

type A = {
  match: { phase: string; round: number; mode: string; mapIndex: number; players: { id: string; team: number; kills: number }[] };
  predicted: { alive: boolean; hp: number; weapons: { mag: number; reserve: number; id: number }[]; slot: number; x: number; z: number } | null;
  backend: { sim: { teamWins: number[]; players: Map<string, { id: string; team: number; sim: { alive: boolean } }>; eliminate(id: string): void; phase: string; phaseTimer: number } };
};

const arena = (page: Page) => page.evaluate.bind(page);

async function startPractice(page: Page, mode: '1 vs 1' | '2 vs 2' | 'Free-for-all') {
  await page.getByTestId('card-arena').click();
  await page.getByRole('tab', { name: mode }).click();
  await page.getByRole('button', { name: 'Practice vs bots' }).click();
  await waitForGame(page);
}

test.describe('Arcfire Arena practice', () => {
  test.beforeEach(async ({ page }) => {
    await primeSettings(page);
    await page.goto('/');
  });

  test('starts in the loadout phase and lets you pick a weapon', async ({ page }) => {
    await startPractice(page, '1 vs 1');
    await expect(page.getByTestId('loadout')).toBeVisible();
    await page.getByTestId('loadout-sct').click();
    await expect.poll(() => arena(page)(() => (window as unknown as { __arena: A }).__arena.predicted?.weapons[0].id)).toBe(1);
    await expect.poll(() => arena(page)(() => (window as unknown as { __arena: A }).__arena.match.phase), { timeout: 15_000 }).toBe('live');
    await expect(page.getByTestId('loadout')).toBeHidden();
  });

  test('touch: holding Fire shoots and uses ammo; reload refills', async ({ page }, info) => {
    test.skip(!info.project.use.hasTouch, 'touch-only');
    await startPractice(page, '1 vs 1');
    await expect.poll(() => arena(page)(() => (window as unknown as { __arena: A }).__arena.match.phase), { timeout: 15_000 }).toBe('live');
    const fire = (await page.locator('.touch-btn[data-id="fire"]').boundingBox())!;
    const touch = await Touch.create(page);
    await touch.start(1, fire.x + fire.width / 2, fire.y + fire.height / 2);
    await page.waitForTimeout(600);
    await touch.end(1);
    const mag = await arena(page)(() => (window as unknown as { __arena: A }).__arena.predicted!.weapons[0].mag);
    expect(mag).toBeLessThan(30);
    await page.locator('.touch-btn[data-id="reload"]').tap();
    await expect.poll(() => arena(page)(() => (window as unknown as { __arena: A }).__arena.predicted!.weapons[0].mag), { timeout: 6000 }).toBe(30);
    await expect(page.getByTestId('ammo')).toHaveText('30');
  });

  test('desktop: mouse fire, weapon keys and scoreboard', async ({ page }, info) => {
    test.skip(!!info.project.use.hasTouch, 'desktop-only');
    await startPractice(page, '2 vs 2');
    await expect.poll(() => arena(page)(() => (window as unknown as { __arena: A }).__arena.match.phase), { timeout: 15_000 }).toBe('live');
    await page.keyboard.press('Digit2');
    await expect.poll(() => arena(page)(() => (window as unknown as { __arena: A }).__arena.predicted!.slot)).toBe(1);
    await page.keyboard.down('Tab');
    await expect(page.getByTestId('scoreboard')).toBeVisible();
    await expect(page.getByTestId('scoreboard').locator('tr')).toHaveCount(6); // 2 headers + 4 players
    await page.keyboard.up('Tab');
    await expect(page.getByTestId('scoreboard')).toBeHidden();
  });

  test('winning the deciding round shows the end-of-match screen and next map', async ({ page }) => {
    await startPractice(page, '1 vs 1');
    await expect.poll(() => arena(page)(() => (window as unknown as { __arena: A }).__arena.match.phase), { timeout: 15_000 }).toBe('live');
    const map0 = await arena(page)(() => (window as unknown as { __arena: A }).__arena.match.mapIndex);
    await page.evaluate(() => {
      const sim = (window as unknown as { __arena: A }).__arena.backend.sim;
      sim.teamWins = [4, 0];
      for (const p of sim.players.values()) if (p.id !== 'you') sim.eliminate(p.id);
    });
    await expect(page.getByTestId('arena-banner')).toContainText('Round won');
    await expect(page.getByTestId('match-end')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('match-end')).toContainText('Victory');
    await page.getByTestId('play-again').click();
    await expect(page.getByTestId('match-end')).toBeHidden();
    await expect.poll(() => arena(page)(() => (window as unknown as { __arena: A }).__arena.match.mapIndex)).toBe((map0 + 1) % 3);
    await expect.poll(() => arena(page)(() => (window as unknown as { __arena: A }).__arena.match.round)).toBe(1);
  });
});
