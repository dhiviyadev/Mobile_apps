import { expect, test } from '@playwright/test';

test.describe('hub & lobby', () => {
  test('landing page shows both games and a nickname field', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('card-voxel')).toBeVisible();
    await expect(page.getByTestId('card-arena')).toBeVisible();
    await expect(page.getByTestId('nickname')).toBeVisible();
    await expect(page.locator('.server-pill')).toHaveText(/online/);
  });

  test('quick match requires a nickname', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('card-arena').click();
    await page.getByTestId('quick-match').click();
    await expect(page.locator('.toast-error')).toBeVisible();
  });

  test('create a private room and have a friend join with the code', async ({ browser }, info) => {
    const touch = !!info.project.use.hasTouch;
    const open = async (name: string) => {
      const ctx = await browser.newContext(info.project.use);
      const page = await ctx.newPage();
      await page.addInitScript((n) => localStorage.setItem('cobalt-hub.settings.v1', JSON.stringify({ nickname: n, detectedQuality: 'low' })), name);
      await page.goto('/');
      return page;
    };
    const host = await open('HostPlayer');
    await host.getByTestId('card-arena').click();
    await host.getByRole('tab', { name: 'Free-for-all' }).click();
    await host.getByTestId('create-private').click();
    const codeEl = host.locator('.wu-code');
    await expect(codeEl).toHaveText(/^[A-Z2-9]{6}$/, { timeout: 30_000 });
    const code = (await codeEl.textContent())!.trim();

    const friend = await open('Friend');
    await friend.getByTestId('room-code').fill(code.toLowerCase());
    await friend.getByTestId('join-code').click();
    await expect(friend.locator('.wu-code')).toHaveText(code, { timeout: 30_000 });
    await host.bringToFront();
    await expect(host.locator('.wu-chip')).toHaveCount(2, { timeout: 10_000 });

    // Leave through the pause menu: back to the hub, and the host sees one player again.
    await friend.bringToFront();
    if (touch) await friend.locator('.touch-btn[data-id="menu"]').tap();
    else await friend.keyboard.press('Escape');
    await friend.getByTestId('leave-game').click();
    await expect(friend.getByTestId('card-arena')).toBeVisible();
    await host.bringToFront();
    await expect(host.locator('.wu-chip')).toHaveCount(1, { timeout: 10_000 });
    await host.context().close();
    await friend.context().close();
  });

  test('bad room code shows a friendly error', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('nickname').fill('Tester');
    await page.getByTestId('room-code').fill('ZZZZZZ');
    await page.getByTestId('join-code').click();
    await expect(page.locator('.toast-error')).toContainText('No room with code');
  });

  test('settings menu opens and persists a toggle', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings')).toBeVisible();
    await page.getByRole('button', { name: 'Controls' }).click();
    const invert = page.locator('label.setting-row', { hasText: 'Invert Y axis' }).locator('input');
    await invert.check();
    await page.reload();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cobalt-hub.settings.v1') ?? '{}').invertY);
    expect(stored).toBe(true);
  });
});
