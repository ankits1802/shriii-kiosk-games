import { expect, type Role, signIn, test } from './fixtures';

/** Expected sidebar per role (spec section 1 routes x backend/api RBAC). */
const EXPECTED_NAV: Record<Role, string[]> = {
  admin: [
    '/research',
    '/research/studies',
    '/research/participants',
    '/research/instruments',
    '/research/traits',
    '/research/validation',
    '/research/models',
    '/research/analytics',
    '/research/reports',
    '/admin/games',
    '/admin/content',
    '/admin/kiosks',
    '/admin/settings',
  ],
  researcher: [
    '/research',
    '/research/studies',
    '/research/participants',
    '/research/instruments',
    '/research/traits',
    '/research/validation',
    '/research/models',
    '/research/analytics',
    '/research/reports',
  ],
  administrator: [
    '/research',
    '/research/studies',
    '/research/participants',
    '/research/instruments',
  ],
  analyst: [
    '/research',
    '/research/studies',
    '/research/instruments',
    '/research/traits',
    '/research/validation',
    '/research/models',
    '/research/analytics',
    '/research/reports',
  ],
};

const FORBIDDEN: Record<Role, string | null> = {
  admin: null,
  researcher: '/admin/settings',
  administrator: '/research/validation',
  analyst: '/research/participants',
};

test.describe('login', () => {
  test('redirects to sign-in, signs in with the dev provider and returns to the page', async ({
    mockedPage: page,
  }) => {
    await page.goto('/research/studies');
    await expect(page).toHaveURL(/\/login\?next=%2Fresearch%2Fstudies/);
    await signIn(page, 'researcher', { next: '/research/studies' });
    await expect(page).toHaveURL(/\/research\/studies$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Studies' })).toBeVisible();
    await expect(page.getByTestId('user-menu')).toContainText('dev-researcher');
  });

  test('shows the overview with access summary and signs out', async ({ mockedPage: page }) => {
    await signIn(page, 'researcher');
    await expect(page).toHaveURL(/\/research$/);
    await expect(page.getByRole('heading', { name: 'Research overview' })).toBeVisible();
    await expect(page.getByTestId('access-card')).toContainText('Researcher');
    await expect(page.getByText('PILOT-1')).toBeVisible();
    await page.getByTestId('user-menu').click();
    await page.getByTestId('sign-out').click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/research');
    await expect(page).toHaveURL(/\/login\?next=%2Fresearch/);
  });

  test('reports API errors on the login form', async ({ page }) => {
    await page.route('**/api/v1/auth/dev-login', (route) =>
      route.fulfill({
        status: 403,
        json: { detail: { code: 'forbidden', message: 'dev login is disabled' } },
      }),
    );
    await signIn(page, 'analyst');
    await expect(page.getByTestId('login-error')).toContainText('dev login is disabled');
  });
});

test.describe('navigation per role', () => {
  for (const role of Object.keys(EXPECTED_NAV) as Role[]) {
    test(`${role} sees exactly the permitted sections`, async ({ mockedPage: page }) => {
      await signIn(page, role);
      await expect(page).toHaveURL(/\/research$/);
      const nav = page.getByRole('navigation', { name: 'Console' }).first();
      await expect(nav).toBeVisible();
      const links = nav.locator('a[data-testid^="nav-"]');
      await expect(links).toHaveCount(EXPECTED_NAV[role].length);
      expect(await links.evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual(
        EXPECTED_NAV[role],
      );

      // Every permitted page renders inside the shell.
      const last = EXPECTED_NAV[role][EXPECTED_NAV[role].length - 1] as string;
      await nav.locator(`a[href="${last}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${last}$`));
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator(`a[href="${last}"][aria-current="page"]`).first()).toBeVisible();

      const forbidden = FORBIDDEN[role];
      if (forbidden) {
        await page.goto(forbidden);
        await expect(page.getByTestId('forbidden')).toBeVisible();
      }
    });
  }

  test('study-scoped principals only see their studies', async ({ mockedPage: page }) => {
    await page.goto('/login');
    const form = page.getByRole('form', { name: 'Development sign-in' });
    await form.getByLabel('Study scope (optional)').fill('S-OTHER');
    await form.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Research overview' })).toBeVisible();
    await expect(page.getByTestId('access-card')).toContainText('S-OTHER');
    await expect(page.getByText('No studies registered yet.')).toBeVisible();
  });
});
