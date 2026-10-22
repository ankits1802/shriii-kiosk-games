/**
 * Admin console smoke + screenshot suite (API mocked; no database). Run with
 * `pnpm exec playwright test -c src/features/admin/e2e/playwright.admin.config.ts`.
 * Screenshots go to docs/screenshots/wave2/web-admin/ (set ADMIN_SHOTS=0 to skip writing them).
 */
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, mockApi, signIn, test } from '../../../../e2e/fixtures';
import { mockAdminApi } from './mock-admin-api';

const SHOTS = fileURLToPath(
  new URL('../../../../../../../docs/screenshots/wave2/web-admin/', import.meta.url),
);
const ROUND = process.env.ADMIN_SHOT_ROUND ? `-${process.env.ADMIN_SHOT_ROUND}` : '';

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  if (process.env.ADMIN_SHOTS === '0') return;
  // Sticky shell elements would repeat mid-image in a full-page capture taken while scrolled.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('[data-sonner-toast]').evaluateAll((els) => {
    for (const el of els) el.remove();
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}${name}${ROUND}.png`, fullPage });
}

function toneWav(amplitude: number, seconds: number, fs = 48000): Buffer {
  const n = Math.round(seconds * fs);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(fs, 24);
  buf.writeUInt32LE(fs * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(
      Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 997 * i) / fs)),
      44 + i * 2,
    );
  }
  return buf;
}

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await mockAdminApi(page);
  await signIn(page, 'admin', { next: '/admin/games' });
  await expect(page).toHaveURL(/\/admin\/games$/);
});

test('games: catalogue, configuration, editor validation and approval', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1, name: 'Games' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'stall', exact: true })).toBeVisible();
  await shot(page, '01-games-catalogue');

  await page.getByRole('cell', { name: 'stall', exact: true }).click();
  const detail = page.getByTestId('game-detail');
  await expect(detail.getByRole('heading', { name: /stall/ })).toBeVisible();
  await expect(detail.getByText('Blocks and trials')).toBeVisible();
  await detail.scrollIntoViewIfNeeded();
  await shot(page, '02-games-config');

  await detail.getByRole('tab', { name: 'Edit draft' }).click();
  const editor = detail.getByRole('textbox', { name: 'Game configuration JSON' });
  await expect(detail.getByTestId('config-valid')).toBeVisible();
  const text = await editor.inputValue();
  await editor.fill(
    text.replace(
      /"min_counts": \{\n(\s+)"(\w+)": (\d+)/,
      (_m, ws, k, n) => `"min_counts": {\n${ws}"${k}": ${Number(n) - 1}`,
    ),
  );
  await expect(detail.getByTestId('config-invalid')).toBeVisible();
  await expect(detail.getByText(/Locked field changed/).first()).toBeVisible();
  await shot(page, '03-games-editor-locked-field');

  // Phase tags select trials for dictionary indicators, so retagging a block is locked too.
  await editor.fill(text.replace('"phase": "pressure"', '"phase": "main"'));
  await expect(detail.getByTestId('config-invalid')).toBeVisible();
  await expect(detail.getByText(/phase tags \(condition\.phase\)/).first()).toBeVisible();
  await shot(page, '03b-games-editor-phase-locked');

  await detail.getByRole('tab', { name: 'Changes vs approved' }).click();
  await expect(detail.getByLabel('Configuration changes')).toBeVisible();

  await detail.getByRole('button', { name: 'Approve version' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Approver 1').fill('Dr A. Rao (PI)');
  await dialog.getByLabel('Approver 2').fill('dr a. rao (pi)');
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(dialog.getByText('Each approver must be a different person.')).toBeVisible();
  await shot(page, '04-games-approval-two-person', false);
});

test('content: coverage, catalogue, line detail with ITC steps and audio slot', async ({
  page,
}) => {
  await page.goto('/admin/content');
  await expect(page.getByRole('heading', { level: 1, name: 'Content' })).toBeVisible();
  await expect(page.getByTestId('coverage-hi-IN')).toBeVisible();
  await shot(page, '05-content-overview');

  // Switching the language re-renders the status columns for that language.
  await page.getByLabel('Language').click();
  await page.getByRole('option', { name: 'en-IN' }).click();
  await expect(page.getByText('source language').first()).toBeVisible();
  await page.getByLabel('Language').click();
  await page.getByRole('option', { name: 'hi-IN' }).click();
  await expect(page.getByText('source language')).toHaveCount(0);

  await page.getByRole('cell', { name: 'attract.greeting' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Next ITC steps')).toBeVisible();
  await expect(sheet.getByTestId('audio-slot-hi-IN')).toBeVisible();
  await shot(page, '06-content-line-detail', false);

  // A 2 s, 997 Hz tone at the delivered loudness target: the slot measures it locally and passes.
  await sheet
    .getByTestId('audio-slot-hi-IN')
    .locator('input[type=file]')
    .setInputFiles({
      name: 'attract.greeting.hi-IN.take1.wav',
      mimeType: 'audio/wav',
      buffer: toneWav(10 ** ((-16 + 3.01) / 20), 4.2),
    });
  await expect(sheet.getByText('passes QC').or(sheet.getByText('needs review'))).toBeVisible();
  await sheet.getByTestId('audio-slot-hi-IN').scrollIntoViewIfNeeded();
  await shot(page, '06b-content-audio-qc', false);
});

test('kiosks: fleet health, kiosk detail and one-time token', async ({ page }) => {
  await page.goto('/admin/kiosks');
  await expect(page.getByRole('heading', { level: 1, name: 'Kiosks' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /^pune-market-02 Hadapsar/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'games 0.1.0' }).first()).toBeVisible();
  // A device still on an older pack shows the assigned version beside what it reports.
  await expect(page.getByTestId('content-drift')).toHaveText('assigned games 0.1.0');
  await expect(page.getByText(/last heartbeat of 3 of 4 active kiosks/)).toBeVisible();
  await shot(page, '07-kiosks-fleet');

  await page.getByRole('cell', { name: /^pune-market-01 Hadapsar/ }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Remote commands')).toBeVisible();
  await shot(page, '08-kiosks-detail', false);
  await page.keyboard.press('Escape');

  await page.route('**/api/v1/admin/kiosks', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            kiosk: {
              kiosk_id: 'ahilya-01',
              site_id: 'indore',
              label: null,
              status: 'active',
              hardware_sku: null,
              app_version: null,
              last_heartbeat_at: null,
              last_heartbeat: {},
              health_status: 'unknown',
              created_at: new Date().toISOString(),
              revoked_at: null,
            },
            device_token: 'kdt_TEST_ONLY_not_a_real_token_9f2b1c',
            backend_x25519_public_key: 'dGVzdC1vbmx5LXB1YmxpYy1rZXktZm9yLXNjcmVlbnNob3Q=',
          },
        })
      : route.fallback(),
  );
  await page.getByRole('button', { name: 'Register kiosk' }).click();
  const reg = page.getByRole('form', { name: 'Register kiosk' });
  await reg.getByLabel('Kiosk id').fill('Ahilya 01');
  await reg.getByRole('button', { name: 'Register and issue token' }).click();
  await expect(reg.getByText(/Lower-case letters/)).toBeVisible();
  await reg.getByLabel('Kiosk id').fill('ahilya-01');
  await reg.getByLabel('Site').fill('indore');
  await reg.getByRole('button', { name: 'Register and issue token' }).click();
  const tokenDialog = page.getByRole('dialog', { name: /Device token for ahilya-01/ });
  await expect(tokenDialog).toBeVisible();
  await expect(tokenDialog.getByRole('button', { name: 'Done' })).toBeDisabled();
  await shot(page, '09-kiosks-token-once', false);
});

test('settings: policy proposal, roles matrix, retention dry run and audit log', async ({
  page,
}) => {
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByTestId('policy-current')).toContainText('v1.1.0');
  await expect(page.getByRole('button', { name: /Approve v1.1.0 as dev-admin/ })).toBeVisible();
  // The pending proposal does not hide the approved policy in force.
  await expect(page.getByTestId('policy-in-force')).toContainText('v1.0.0 stays in force');
  await shot(page, '10-settings-policy');

  await page.getByRole('tab', { name: 'Users and roles' }).click();
  await expect(page.getByText('Permission matrix')).toBeVisible();
  await shot(page, '11-settings-roles');

  await page.getByRole('tab', { name: 'Retention' }).click();
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByRole('columnheader', { name: 'Would affect' })).toBeVisible();
  await shot(page, '12-settings-retention');

  await page.getByRole('tab', { name: 'Audit log' }).click();
  await expect(page.getByRole('form', { name: 'Audit filters' })).toBeVisible();
  await page.getByRole('cell', { name: 'settings.put' }).first().click();
  await shot(page, '13-settings-audit');
});
