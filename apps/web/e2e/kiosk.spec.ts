import { expect, test } from '@playwright/test';

test.describe('/kiosk', () => {
  for (const path of ['/kiosk', '/kiosk/session']) {
    test(`${path} mounts the kiosk-game canvas client-side`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      // Server HTML holds only the placeholder: the game is loaded with ssr:false.
      const html = (await response?.text()) ?? '';
      expect(html).not.toContain('kiosk-runtime');

      const host = page.getByTestId('kiosk-stage-host');
      await expect(host).toBeAttached({ timeout: 30_000 });
      await expect(host.locator('canvas')).toBeAttached({ timeout: 30_000 });
      await expect(page.getByTestId('kiosk-out-of-service')).toHaveCount(0);
      const box = await host.locator('canvas').first().boundingBox();
      expect(box?.width).toBeGreaterThan(100);
      expect(box?.height).toBeGreaterThan(100);
      expect(errors).toEqual([]);
    });
  }

  test('kiosk pages carry no console chrome or readable UI text', async ({ page }) => {
    await page.goto('/kiosk');
    await expect(page.getByTestId('kiosk-stage-host').locator('canvas')).toBeAttached({
      timeout: 30_000,
    });
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByTestId('user-menu')).toHaveCount(0);
  });
});
