/**
 * Network-level mock of the FastAPI endpoints the shell uses. Tokens are unsigned JWT-shaped
 * strings carrying roles/studies; `/auth/me` answers with the permissions the real RBAC matrix
 * (apps/api rbac.py, executed by Python) grants those roles.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

export type Role = 'admin' | 'researcher' | 'administrator' | 'analyst';

const RBAC_PY = fileURLToPath(new URL('../../api/src/shriii_api/auth/rbac.py', import.meta.url));
const SCRIPT = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("rbac", sys.argv[1])
mod = importlib.util.module_from_spec(spec); sys.modules["rbac"] = mod; spec.loader.exec_module(mod)
print(json.dumps({r.value: sorted(p.value for p in ps) for r, ps in mod.ROLE_PERMISSIONS.items()}))
`;

function loadMatrix(): Record<string, string[]> {
  for (const exe of ['python', 'python3']) {
    const res = spawnSync(exe, ['-c', SCRIPT, RBAC_PY], { encoding: 'utf8' });
    if (res.status === 0) return JSON.parse(res.stdout) as Record<string, string[]>;
  }
  throw new Error('Python is required to read the RBAC matrix for the e2e API mock');
}

const MATRIX = loadMatrix();

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function fakeToken(
  sub: string,
  roles: string[],
  studies: string[],
): { token: string; exp: number } {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return { token: `${b64url({ alg: 'none' })}.${b64url({ sub, roles, studies, exp })}.mock`, exp };
}

function claimsOf(
  auth: string | undefined,
): { sub: string; roles: string[]; studies: string[] } | null {
  const token = auth?.replace(/^Bearer\s+/i, '') ?? '';
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export const STUDIES = [
  {
    study_id: 'S-PILOT',
    code: 'PILOT-1',
    name: 'Criterion pilot (hi-IN, mr-IN)',
    stage: 'criterion_pilot',
    status: 'recruiting',
    requires_prereg: true,
    prereg_id: null,
    current_protocol_version: '1.0',
    description: null,
    config: {},
    target_sample: 700,
    power_record: {},
    frozen_at: null,
    created_by: 'dev-researcher',
    created_at: '2026-10-01T09:00:00Z',
  },
];

export async function mockApi(page: Page): Promise<void> {
  await page.route('**/readyz', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        checks: { database: 'ok', identity_database: 'ok', migration: 'mock' },
      },
    }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path === '/api/v1/auth/dev-login' && req.method() === 'POST') {
      const body = req.postDataJSON() as { sub: string; roles: string[]; studies: string[] | null };
      const { token, exp } = fakeToken(body.sub, body.roles, body.studies ?? ['*']);
      return route.fulfill({
        json: { access_token: token, token_type: 'bearer', expires_at: exp },
      });
    }
    const claims = claimsOf(req.headers().authorization);
    if (!claims) {
      return route.fulfill({
        status: 401,
        json: { detail: { code: 'unauthenticated', message: 'missing token' } },
      });
    }
    const permissions = [...new Set(claims.roles.flatMap((r) => MATRIX[r] ?? []))].sort();
    if (path === '/api/v1/auth/me') {
      return route.fulfill({
        json: {
          sub: claims.sub,
          kind: 'user',
          roles: claims.roles,
          studies: claims.studies,
          permissions,
          kiosk_id: null,
        },
      });
    }
    if (path === '/api/v1/studies' && req.method() === 'GET') {
      if (!permissions.includes('studies.read')) {
        return route.fulfill({
          status: 403,
          json: { detail: { code: 'forbidden', message: 'studies.read' } },
        });
      }
      const visible = STUDIES.filter(
        (s) =>
          claims.roles.includes('admin') ||
          claims.studies.includes('*') ||
          claims.studies.includes(s.study_id),
      );
      return route.fulfill({ json: visible });
    }
    return route.fulfill({ status: 404, json: { detail: 'not mocked' } });
  });
}

/** Sign in through the real login form with the given role. */
export async function signIn(
  page: Page,
  role: Role,
  opts: { sub?: string; next?: string } = {},
): Promise<void> {
  await page.goto(opts.next ? `/login?next=${encodeURIComponent(opts.next)}` : '/login');
  const form = page.getByRole('form', { name: 'Development sign-in' });
  await expect(form).toBeVisible();
  await form.getByLabel('Subject').fill(opts.sub ?? `dev-${role}`);
  for (const r of ['admin', 'researcher', 'administrator', 'analyst'] as const) {
    const box = form.getByRole('checkbox', { name: new RegExp(`^${LABELS[r]}`) });
    const want = r === role;
    if (((await box.getAttribute('data-state')) === 'checked') !== want) await box.click();
  }
  await form.getByRole('button', { name: 'Sign in' }).click();
}

export const LABELS: Record<Role, string> = {
  admin: 'Administrator \\(system\\)',
  researcher: 'Researcher',
  administrator: 'Field administrator',
  analyst: 'Analyst \\(de-identified\\)',
};

export const test = base.extend<{ mockedPage: Page }>({
  mockedPage: async ({ page }, use) => {
    await mockApi(page);
    await use(page);
  },
});

export { expect };
