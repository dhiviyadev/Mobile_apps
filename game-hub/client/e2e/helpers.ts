import { type CDPSession, expect, type Page } from '@playwright/test';

/** Sets a nickname (and any other settings) before the hub boots. */
export async function primeSettings(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((s) => {
    if (!localStorage.getItem('cobalt-hub.settings.v1')) localStorage.setItem('cobalt-hub.settings.v1', JSON.stringify(s));
  }, { nickname: 'E2E', ...extra });
}

/** Low-level multi-touch via the Chrome DevTools Protocol (Playwright only has tap()). */
export class Touch {
  private constructor(private readonly cdp: CDPSession) {}

  static async create(page: Page): Promise<Touch> {
    return new Touch(await page.context().newCDPSession(page));
  }

  async start(id: number, x: number, y: number): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id }] });
  }

  async move(id: number, x: number, y: number): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id }] });
  }

  async end(id: number): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    void id;
  }

  /** Drags in small steps so pointermove events fire like a real finger. */
  async drag(id: number, from: [number, number], to: [number, number], steps = 10): Promise<void> {
    await this.start(id, from[0], from[1]);
    for (let i = 1; i <= steps; i++) {
      await this.move(id, from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    }
  }
}

/** Waits until the loading screen is gone. */
export async function waitForGame(page: Page): Promise<void> {
  await page.waitForSelector('.game-root canvas', { timeout: 60_000 });
  await page.waitForSelector('.loading-screen', { state: 'detached', timeout: 60_000 });
}

/** Arcfire Arena dev hooks used by the helpers below (window.__arena, dev builds only). */
type ArenaDev = {
  match: { phase: string; vote: { stage: 'open' | 'reveal' } | null };
  backend: { sim?: { phase: string; phaseTimer: number } };
};

/** Opens Arcfire Arena practice vs bots in a mode and gets past the map vote, if any. */
export async function startArenaPractice(page: Page, mode: '1 vs 1' | '2 vs 2' | 'Free-for-all'): Promise<void> {
  await page.getByTestId('card-arena').click();
  await page.getByRole('tab', { name: mode }).click();
  await page.getByRole('button', { name: 'Practice vs bots' }).click();
  await waitForGame(page);
  await passMapVote(page);
}

/**
 * Offline map vote: picks card `card`, then fast-forwards the vote and its reveal. A no-op unless the
 * match is in the vote phase.
 */
export async function passMapVote(page: Page, card = 0): Promise<void> {
  const phase = () => page.evaluate(() => (window as unknown as { __arena: ArenaDev }).__arena.match.phase);
  if ((await phase()) !== 'vote') return;
  await page.getByTestId(`vote-card-${card}`).click();
  const skip = () =>
    page.evaluate(() => {
      const a = (window as unknown as { __arena: ArenaDev }).__arena;
      // Only the vote's timers: never skip the loadout that follows.
      if (a.backend.sim?.phase === 'vote') a.backend.sim.phaseTimer = 0;
      return a.match.phase === 'vote' ? (a.match.vote?.stage ?? 'open') : 'done';
    });
  await expect.poll(skip, { timeout: 10_000 }).not.toBe('open');
  await expect.poll(skip, { timeout: 10_000 }).toBe('done');
}

/** Opens the Voxelvale world menu (or uses it when it is already up, as after leaving a game). */
export async function openWorldMenu(page: Page): Promise<void> {
  const menu = page.getByTestId('world-menu');
  if (!(await menu.isVisible())) await page.getByTestId('card-voxel').click();
  await expect(menu).toBeVisible();
  // The list is read from the device's storage: wait for it.
  await expect(page.locator('[data-testid="world-card"], [data-testid="worlds-empty"]').first()).toBeVisible();
}

/**
 * Plays Voxelvale offline: the parkour course, or the most recently played world
 * of that mode (making a new one when there is none). Does not wait for the game.
 */
export async function playVoxelOffline(page: Page, mode: 'sandbox' | 'survival' | 'parkour'): Promise<void> {
  await openWorldMenu(page);
  if (mode === 'parkour') {
    await page.getByTestId('play-parkour').click();
    return;
  }
  const card = page.locator(`[data-testid="world-card"]:has(.vw-mode-${mode})`).first();
  if (await card.count()) {
    await card.getByTestId('play-world').click();
    return;
  }
  await newVoxelWorld(page, mode);
}

/** Makes a new world from the menu (it starts right away). */
export async function newVoxelWorld(page: Page, mode: 'sandbox' | 'survival', name?: string): Promise<void> {
  await openWorldMenu(page);
  await page.getByTestId('new-world').click();
  if (name) await page.getByTestId('new-world-name').fill(name);
  await page.getByTestId(`new-world-${mode}`).click();
  await page.getByTestId('create-world').click();
}

/** Leaves the running game from the pause menu. */
export async function leaveGame(page: Page): Promise<void> {
  if (await page.locator('.touch-btn[data-id="menu"]').count()) await page.locator('.touch-btn[data-id="menu"]').tap();
  else await page.keyboard.press('Escape');
  await page.getByTestId('leave-game').click();
}

/**
 * Hosts a brand-new world online from this device: makes it (it starts offline),
 * leaves, then takes it online as Private or Public. Waits for the hosted game.
 */
export async function hostNewWorld(page: Page, mode: 'sandbox' | 'survival', opts: { name?: string; public?: boolean } = {}): Promise<string> {
  await newVoxelWorld(page, mode, opts.name);
  await waitForGame(page);
  await leaveGame(page);
  await openWorldMenu(page);
  await page.getByTestId('world-card').first().getByTestId('host-world').click();
  await page.getByTestId(opts.public ? 'host-public' : 'host-private').click();
  await page.getByTestId('host-go').click();
  await waitForGame(page);
  return page.evaluate(() => (window as unknown as { __voxel: { net: { roomCode: string } } }).__voxel.net.roomCode);
}
