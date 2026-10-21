import { describe, expect, it } from 'vitest';
import { loadRbacMatrix } from '@/test/rbac';
import { isPermission, type UserRole } from './auth/permissions';
import { type Principal, principalFromMe } from './auth/principal';
import {
  ALL_NAV_ITEMS,
  breadcrumbs,
  canOpen,
  defaultLanding,
  navItemFor,
  routeRequirement,
  visibleNav,
} from './nav';

/** Spec section 1 routes for the console. */
const SPEC_ROUTES = [
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
];

const matrix = loadRbacMatrix();

function principalFor(role: UserRole): Principal {
  if (!matrix) throw new Error('python unavailable');
  return principalFromMe({
    sub: `dev-${role}`,
    kind: 'user',
    roles: [role],
    studies: ['*'],
    permissions: (matrix.roles[role] ?? []).filter(isPermission),
    kiosk_id: null,
  });
}

function hrefs(p: Principal): string[] {
  return visibleNav(p).flatMap((s) => s.items.map((i) => i.href));
}

describe('route registry', () => {
  it('covers exactly the spec console routes', () => {
    expect(ALL_NAV_ITEMS.map((i) => i.href).sort()).toEqual([...SPEC_ROUTES].sort());
  });

  it('resolves nested paths to their owning item', () => {
    expect(navItemFor('/research/studies/abc/cohorts')?.href).toBe('/research/studies');
    expect(navItemFor('/research')?.href).toBe('/research');
    expect(navItemFor('/research/unknown')).toBeNull();
    expect(navItemFor('/admin/kiosks/k1')?.href).toBe('/admin/kiosks');
  });

  it('guards admin landing and gallery routes too', () => {
    expect(routeRequirement('/admin')).not.toBeNull();
    expect(routeRequirement('/design-system')).toEqual({});
    expect(routeRequirement('/elsewhere')).toBeNull();
  });

  it('builds breadcrumbs', () => {
    expect(breadcrumbs('/research/studies/S-001')).toEqual([
      { href: '/research', label: 'Research' },
      { href: '/research/studies', label: 'Studies' },
      { href: '/research/studies/S-001', label: 'S-001' },
    ]);
    expect(breadcrumbs('/admin/kiosks').map((c) => c.label)).toEqual(['Admin', 'Kiosks']);
  });
});

describe.skipIf(!matrix)('role-aware navigation (against the real API matrix)', () => {
  it('admin sees every research and admin page', () => {
    expect(hrefs(principalFor('admin')).sort()).toEqual([...SPEC_ROUTES].sort());
  });

  it('researcher sees all research pages and no admin pages', () => {
    const h = hrefs(principalFor('researcher'));
    expect(h.filter((x) => x.startsWith('/research')).sort()).toEqual(
      SPEC_ROUTES.filter((r) => r.startsWith('/research')).sort(),
    );
    expect(h.some((x) => x.startsWith('/admin'))).toBe(false);
  });

  it('field administrator cannot reach score-bearing pages (PRV-08)', () => {
    const p = principalFor('administrator');
    expect(hrefs(p)).toEqual([
      '/research',
      '/research/studies',
      '/research/participants',
      '/research/instruments',
    ]);
    for (const route of [
      '/research/validation',
      '/research/models',
      '/research/analytics',
      '/research/traits',
      '/research/reports',
    ]) {
      expect(canOpen(p, route)).toBe(false);
    }
  });

  it('analyst sees de-identified layers only: no participants, no admin', () => {
    const p = principalFor('analyst');
    const h = hrefs(p);
    expect(h).not.toContain('/research/participants');
    expect(h).toContain('/research/validation');
    expect(h).toContain('/research/reports');
    expect(h.some((x) => x.startsWith('/admin'))).toBe(false);
    expect(canOpen(p, '/research/participants/P1')).toBe(false);
  });

  it('lands each role on its first permitted page', () => {
    expect(defaultLanding(principalFor('analyst'))).toBe('/research');
    expect(defaultLanding(principalFor('administrator'))).toBe('/research');
  });
});

describe('principal without console permissions', () => {
  it('lands on /no-access', () => {
    const p = principalFromMe({
      sub: 'x',
      kind: 'user',
      roles: [],
      studies: [],
      permissions: [],
      kiosk_id: null,
    });
    expect(visibleNav(p)).toEqual([]);
    expect(defaultLanding(p)).toBe('/no-access');
    expect(canOpen(null, '/research')).toBe(false);
  });
});
