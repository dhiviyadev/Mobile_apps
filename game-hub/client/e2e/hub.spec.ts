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

  test('create a private room and have a friend join with the code', async ({ browser }) => {
    const host = await browser.newPage();
    await host.goto('/');
    await host.getByTestId('nickname').fill('HostPlayer');
    await host.getByTestId('card-arena').click();
    await host.getByTestId('create-private').click();
    const codeEl = host.getByTestId('lobby-code');
    await expect(codeEl).toHaveText(/^[A-Z2-9]{6}$/);
    const code = (await codeEl.textContent())!;

    const friend = await browser.newPage();
    await friend.goto('/');
    await friend.getByTestId('nickname').fill('Friend');
    await friend.getByTestId('room-code').fill(code.toLowerCase());
    await friend.getByTestId('join-code').click();
    await expect(friend.getByTestId('lobby-code')).toHaveText(code);
    await expect(host.getByTestId('lobby-players').locator('li')).toHaveCount(2);

    await friend.getByTestId('leave-room').click();
    await expect(friend.getByTestId('card-arena')).toBeVisible();
    await expect(host.getByTestId('lobby-players').locator('li')).toHaveCount(1);
    await host.close();
    await friend.close();
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
