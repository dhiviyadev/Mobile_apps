import type { CDPSession, Page } from '@playwright/test';

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
