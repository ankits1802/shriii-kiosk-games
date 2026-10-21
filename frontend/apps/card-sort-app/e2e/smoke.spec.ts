import { expect, type Page, test } from '@playwright/test';

const PIN = '246810';
// 7K3M9QX2A + Luhn mod-32 check character (see test/pid.test.ts).
const BODY = '7K3M9QX2A';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function checkChar(body: string): string {
  let factor = 2;
  let total = 0;
  for (const ch of [...body].reverse()) {
    const addend = factor * CROCKFORD.indexOf(ch);
    factor = factor === 2 ? 1 : 2;
    total += Math.floor(addend / 32) + (addend % 32);
  }
  return CROCKFORD[(32 - (total % 32)) % 32] as string;
}
const PID = BODY + checkChar(BODY);
const COLOURS = ['red', 'green', 'yellow', 'blue'];

async function unlock(page: Page) {
  await page.getByTestId('pin-unlock').getByLabel('PIN').fill(PIN);
  await page.getByRole('button', { name: 'Unlock' }).click();
}

test('administer a full 64-card criterion card sort offline and keep it queued', async ({
  page,
}) => {
  await page.goto('/?feedbackMs=0');

  // First run: PIN, then device settings (no API URL: records stay queued on the device).
  const setPin = page.getByTestId('pin-set');
  await setPin.getByLabel('PIN', { exact: true }).fill(PIN);
  await setPin.getByLabel('Confirm PIN').fill(PIN);
  await page.getByRole('button', { name: 'Save PIN' }).click();
  await page.getByLabel('Administrator id').fill('admin.e2e');
  await page.getByLabel('Device id').fill('tablet-e2e');
  await page.getByLabel('Default study id').fill('s2');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByTestId('home')).toBeVisible();

  // A mistyped participant code is rejected by the check character.
  await page.getByTestId('new-administration').click();
  const wrong = PID.slice(0, -1) + (PID.endsWith('0') ? '1' : '0');
  await page.getByLabel('Participant code').fill(wrong);
  await page.getByTestId('start-submit').click();
  await expect(page.getByText('Participant code is not valid')).toBeVisible();
  await page.getByLabel('Participant code').fill(PID.toLowerCase());
  await page.getByTestId('start-submit').click();

  await expect(page.getByTestId('instructions')).toBeVisible();
  await page.getByTestId('begin-test').click();

  // Participant screen: four key cards and one response card, no reading needed.
  const screen = page.getByTestId('test-screen');
  await expect(screen).toBeVisible();
  await expect(page.locator('.key-card')).toHaveCount(4);
  // Sort every card by colour: completes the first category, then perseverates to the end of the deck.
  for (let i = 1; i <= 64; i++) {
    await expect(screen).toHaveAttribute('data-trial', String(i));
    const id = await page.getByTestId('response-card').locator('svg').getAttribute('data-card');
    const colour = id?.split('-')[0] ?? 'red';
    await page.getByTestId(`key-${COLOURS.indexOf(colour)}`).click();
    if (i < 64) await expect(screen).toHaveAttribute('data-trial', String(i + 1));
  }

  await expect(page.getByTestId('finished-screen')).toBeVisible();
  await page.getByRole('button', { name: 'Administrator' }).click();
  await unlock(page);
  await expect(page.getByTestId('summary')).toContainText('64 cards administered');
  await expect(page.getByTestId('summary')).not.toContainText('perseverative');
  await page.getByTestId('summary-done').click();
  await expect(page.getByTestId('outbox-summary')).toHaveText(
    '1 pending · 0 need attention · 0 synced',
  );

  // Survives a reload (IndexedDB in the browser build; SQLite on the tablet).
  await page.reload();
  await unlock(page);
  await expect(page.getByTestId('outbox-summary')).toHaveText(
    '1 pending · 0 need attention · 0 synced',
  );
  await expect(page.getByTestId('session-row').first()).toContainText('completed');
  await expect(page.getByTestId('session-row').first()).toContainText(PID);

  await page.getByRole('button', { name: 'Audit trail' }).click();
  await expect(page.getByTestId('audit-verify')).toContainText('Hash chain intact');
  await expect(page.getByTestId('audit')).toContainText('records_queued');
});
