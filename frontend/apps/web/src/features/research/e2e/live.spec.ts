/**
 * Research pages rendered against the live API after `shriii-api demo-pipeline --fast` (CI job
 * `demo-web` in .github/workflows/session-e2e.yml). Proves the dashboards show results computed by the
 * real pipeline (not mocks): non-zero participant counts, validation results with confidence
 * intervals, model metrics and indicator distributions, and no API failures while rendering.
 */
import type { Page } from '@playwright/test';
import { expect, signIn, test } from '../../../../e2e/fixtures';

test.use({ viewport: { width: 1440, height: 900 } });

function watchApi(page: Page): string[] {
  const failures: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/v1/') && r.status() >= 500)
      failures.push(`${r.status()} ${r.url()}`);
  });
  page.on('pageerror', (e) => failures.push(`pageerror ${e.message}`));
  return failures;
}

test('overview counts come from the live study', async ({ page }) => {
  const failures = watchApi(page);
  await signIn(page, 'researcher', { next: '/research' });
  await expect(page.getByRole('heading', { name: 'Research overview' })).toBeVisible();
  const kpi = page.getByTestId('kpi-participants');
  await expect(kpi).toContainText(/[1-9]/);
  await page.screenshot({ path: test.info().outputPath('overview.png'), fullPage: true });
  expect(failures).toEqual([]);
});

test('validation workbench shows pipeline results with intervals', async ({ page }) => {
  const failures = watchApi(page);
  await signIn(page, 'researcher', { next: '/research/validation' });
  await expect(page.getByRole('heading', { name: 'Trait validation workbench' })).toBeVisible();
  await expect(page.getByText('Retest ICC(A,1)').first()).toBeVisible();
  // An estimate with its 95% interval, e.g. "0.62 [0.48, 0.74]".
  await expect(
    page.getByText(/-?\d?\.\d+\s*\[\s*-?\d?\.\d+\s*,\s*-?\d?\.\d+\s*\]/).first(),
  ).toBeVisible();
  await expect(page.getByText(/Needs API/)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('validation.png'), fullPage: true });
  expect(failures).toEqual([]);
});

test('models page shows the trained comparison', async ({ page }) => {
  const failures = watchApi(page);
  await signIn(page, 'researcher', { next: '/research/models' });
  await expect(page.getByText('Four-way predictive comparison')).toBeVisible();
  await expect(page.getByText(/Observed vs predicted/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('models.png'), fullPage: true });
  expect(failures).toEqual([]);
});

test('analytics distributions render from live indicator values', async ({ page }) => {
  const failures = watchApi(page);
  await signIn(page, 'analyst', { next: '/research/analytics' });
  await expect(page.getByText(/Distribution ·/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('analytics.png'), fullPage: true });
  expect(failures).toEqual([]);
});
