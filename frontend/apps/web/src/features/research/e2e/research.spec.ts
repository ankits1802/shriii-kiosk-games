/**
 * Research console smoke + screenshot suite (API mocked with demo-pipeline-shaped data; no database).
 *   pnpm exec playwright test -c src/features/research/e2e/playwright.research.config.ts
 * Screenshots go to docs/screenshots/wave2/web-research/ (RESEARCH_SHOTS=0 skips writing them;
 * RESEARCH_SHOT_ROUND=n suffixes the file names for review rounds).
 */
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, mockApi, signIn, test } from '../../../../e2e/fixtures';
import { mockResearchApi, pidFor } from './mock-research-api';

const SHOTS = fileURLToPath(
  new URL('../../../../../../../docs/screenshots/wave2/web-research/', import.meta.url),
);
const ROUND = process.env.RESEARCH_SHOT_ROUND ? `-${process.env.RESEARCH_SHOT_ROUND}` : '';

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  if (process.env.RESEARCH_SHOTS === '0') return;
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  // Hide toasts for the capture only. Never remove them: they are React-owned nodes, and deleting
  // them makes React's next toast insert throw (insertBefore NotFoundError) and crash the page.
  const hide = await page.addStyleTag({
    content: '[data-sonner-toaster] { visibility: hidden !important; }',
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}${name}${ROUND}.png`, fullPage });
  await hide.evaluate((el) => el.parentNode?.removeChild(el));
}

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await mockResearchApi(page);
});

test('overview dashboard shows counts, breakdowns and data quality', async ({ page }) => {
  await signIn(page, 'researcher', { next: '/research' });
  await expect(page.getByRole('heading', { name: 'Research overview' })).toBeVisible();
  await expect(page.getByTestId('kpi-participants')).toContainText(/\d/);
  await expect(page.getByTestId('synthetic-notice')).toBeVisible();
  await expect(page.getByText('Recruitment breakdowns')).toBeVisible();
  await shot(page, '01-overview');
});

test('validation workbench: evidence, MTMM, reliability, fairness, gates', async ({ page }) => {
  await signIn(page, 'researcher', { next: '/research/validation' });
  await expect(page.getByRole('heading', { name: 'Trait validation workbench' })).toBeVisible();
  await expect(page.getByTestId('synthetic-notice')).toBeVisible();
  await expect(page.getByText('Retest ICC(A,1)').first()).toBeVisible();
  await expect(page.getByText(/Multitrait–multimethod matrix/)).toBeVisible();
  await shot(page, '06-validation-convergent');
  await page.getByRole('tab', { name: 'Reliability' }).click();
  await expect(page.getByText('Retest ICC(A,1) by group and indicator')).toBeVisible();
  await shot(page, '07-validation-reliability');
  await page.getByRole('tab', { name: /Fairness/ }).click();
  await expect(page.getByText('Differential item functioning')).toBeVisible();
  await shot(page, '08-validation-fairness');
  await page.getByRole('tab', { name: /Gates/ }).click();
  await expect(page.getByText(/Trait gate ·/)).toBeVisible();
  await shot(page, '09-validation-gates');
});

test('studies: list, design, recruitment, retests, datasets and plan', async ({ page }) => {
  await signIn(page, 'researcher', { next: '/research/studies' });
  await expect(page.getByRole('heading', { name: 'Studies', exact: true })).toBeVisible();
  await expect(page.getByText('Demo criterion pilot (synthetic)').first()).toBeVisible();
  await shot(page, '02-studies');
  await page.goto('/research/studies/demo-pipeline-11');
  await expect(page.getByText('Protocol versions')).toBeVisible();
  await shot(page, '03-study-design');
  await page.getByRole('tab', { name: 'Recruitment' }).click();
  await expect(page.getByText('Stratified recruitment targets')).toBeVisible();
  await shot(page, '03b-study-recruitment');
  await page.getByRole('tab', { name: 'Retests' }).click();
  await expect(page.getByText(/Retest scheduling/)).toBeVisible();
  await shot(page, '03c-study-retests');
  await page.getByRole('tab', { name: 'Datasets' }).click();
  await expect(page.getByText('demo pipeline snapshot').first()).toBeVisible();
  await page.getByRole('tab', { name: /Analysis plan/ }).click();
  await expect(page.getByText('Registered analysis plans')).toBeVisible();
  await shot(page, '03d-study-plan');
});

test('participants: pseudonymous records, consent and withdrawal', async ({ page }) => {
  await signIn(page, 'researcher', { next: '/research/participants' });
  await expect(page.getByRole('heading', { name: 'Participants' })).toBeVisible();
  await shot(page, '04-participants');
  await page.getByRole('button', { name: pidFor(0), exact: true }).click();
  await expect(page.getByText('Consent history')).toBeVisible();
  await expect(page.getByText('Withdrawal', { exact: true })).toBeVisible();
  await shot(page, '04b-participant-detail', false);
});

test('instruments: registry, items, import with review queue', async ({ page }) => {
  await signIn(page, 'researcher', { next: '/research/instruments' });
  await expect(page.getByRole('heading', { name: 'Instruments' })).toBeVisible();
  await shot(page, '05-instruments');
  await page.goto('/research/instruments/bscs');
  await expect(page.getByText('Licensed source').first()).toBeVisible();
  await shot(page, '05b-instrument-items');
  await page.goto('/research/instruments/imports?instrument=bscs');
  await expect(page.getByText('1 · Administration context')).toBeVisible();
  const header = ['PID', ...Array.from({ length: 13 }, (_, i) => `Q${i + 1}`)].join(',');
  const row = (pid: string, v: string) => [pid, ...Array.from({ length: 13 }, () => v)].join(',');
  const csv = [
    header,
    row(pidFor(1), '3'),
    row(pidFor(2), '4'),
    row('UNKNOWN01', '3'),
    row('', '2'),
    `${pidFor(3)},9,${Array.from({ length: 12 }, () => '1').join(',')}`,
  ].join('\n');
  await page.getByLabel('Import file').setInputFiles({
    name: 'historical-bscs.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await expect(page.getByText('3 · Column mapping')).toBeVisible();
  await expect(page.getByText('Pre-check', { exact: true })).toBeVisible();
  await shot(page, '05c-import-mapping');
  await page.getByRole('button', { name: /Stage import for review/ }).click();
  await expect(page.getByText('Manual review queue')).toBeVisible();
  await shot(page, '05d-import-review');
  await page.getByRole('button', { name: 'Reject' }).first().click();
  await page.getByRole('button', { name: /Commit/ }).click();
  await expect(page.getByText(/^Committed/)).toBeVisible();
});

test('researcher-administered mode: tablet flow without scores', async ({ page }) => {
  await signIn(page, 'administrator', { next: '/research/instruments/bscs/administer' });
  await expect(page.getByRole('heading', { name: /Administer BSCS/ })).toBeVisible();
  await page.getByLabel('Participant id (pid)').fill(pidFor(0));
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.getByText('criterion consent recorded')).toBeVisible();
  await shot(page, '10-administer-setup');
  await page.getByRole('button', { name: /Start administration/ }).click();
  const overlay = page.getByTestId('administer-overlay');
  await expect(overlay).toBeVisible();
  await shot(page, '11-administer-item', false);
  for (let i = 0; i < 20; i += 1) {
    if (await overlay.getByText('Check before saving').isVisible()) break;
    await overlay.getByRole('button', { name: 'Response 4' }).click();
    await page.waitForTimeout(320);
  }
  await expect(overlay.getByText('Check before saving')).toBeVisible();
  await shot(page, '12-administer-review', false);
  await overlay.getByRole('button', { name: 'Save administration' }).click();
  await expect(overlay.getByText('Saved. Thank you.')).toBeVisible();
  await expect(overlay.getByText(/no scores are shown/)).toBeVisible();
  await shot(page, '13-administer-done', false);
});

test('traits: registry with ECD mapping and expected relations', async ({ page }) => {
  await signIn(page, 'researcher', { next: '/research/traits?trait=self_control' });
  await expect(page.getByText('Evidence-centred design')).toBeVisible();
  await expect(page.getByText('Expected relations')).toBeVisible();
  await shot(page, '14-traits');
});

test('models: four-way comparison, holdout and experiments', async ({ page }) => {
  await signIn(page, 'researcher', { next: '/research/models' });
  await expect(page.getByText('Four-way predictive comparison')).toBeVisible();
  await expect(page.getByText(/Observed vs predicted/)).toBeVisible();
  await shot(page, '15-models');
});

test('analytics: distributions, groups and longitudinal', async ({ page }) => {
  await signIn(page, 'analyst', { next: '/research/analytics' });
  await expect(page.getByText(/Distribution ·/)).toBeVisible();
  await shot(page, '16-analytics-distributions');
  await page.getByRole('tab', { name: /Groups/ }).click();
  await expect(page.getByText(/Standardised differences/)).toBeVisible();
  await shot(page, '17-analytics-versions');
  await page.getByRole('tab', { name: 'Longitudinal' }).click();
  await expect(page.getByText(/Retest change for every measure/)).toBeVisible();
  await shot(page, '18-analytics-longitudinal');
});

test('reports: scientific report preview and exports', async ({ page }) => {
  await signIn(page, 'researcher', { next: '/research/reports' });
  await expect(page.getByTestId('report-preview')).toBeVisible();
  await expect(page.getByText('Hypothesis tests')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Report \(HTML\)/ }).click();
  expect((await download).suggestedFilename()).toMatch(/validation-report\.html$/);
  await shot(page, '19-reports', false);
});

test('role gating: field administrators never see validation or models', async ({ page }) => {
  await signIn(page, 'administrator', { next: '/research/instruments' });
  await expect(page.getByRole('heading', { name: 'Instruments' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Instruments' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Validation' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Models' })).toHaveCount(0);
});
