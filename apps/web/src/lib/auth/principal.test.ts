import { describe, expect, it } from 'vitest';
import type { MeResponse } from '@/lib/api/types';
import {
  canAccessStudy,
  hasPermission,
  isStudyScoped,
  principalFromMe,
  satisfies,
  visibleStudies,
} from './principal';

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    sub: 'u1',
    kind: 'user',
    roles: ['researcher'],
    studies: ['*'],
    permissions: ['studies.read', 'validation.read'],
    kiosk_id: null,
    ...overrides,
  };
}

describe('principalFromMe', () => {
  it('drops unknown roles and permissions', () => {
    const p = principalFromMe(
      me({ roles: ['researcher', 'kiosk_device', 'wizard'], permissions: ['studies.read', 'x.y'] }),
    );
    expect(p.roles).toEqual(['researcher']);
    expect([...p.permissions]).toEqual(['studies.read']);
  });
});

describe('study scope', () => {
  it('admins and wildcard scopes see every study', () => {
    expect(canAccessStudy(principalFromMe(me({ roles: ['admin'], studies: [] })), 'S1')).toBe(true);
    expect(canAccessStudy(principalFromMe(me({ studies: ['*'] })), 'S1')).toBe(true);
  });

  it('scoped principals see only their studies', () => {
    const p = principalFromMe(me({ studies: ['S1'] }));
    expect(canAccessStudy(p, 'S1')).toBe(true);
    expect(canAccessStudy(p, 'S2')).toBe(false);
    expect(canAccessStudy(p, null)).toBe(true);
    expect(isStudyScoped(p)).toBe(true);
    expect(
      visibleStudies(p, [{ study_id: 'S1' }, { study_id: 'S2' }]).map((s) => s.study_id),
    ).toEqual(['S1']);
  });

  it('signed-out callers access nothing', () => {
    expect(canAccessStudy(null, 'S1')).toBe(false);
    expect(hasPermission(null, 'studies.read')).toBe(false);
  });
});

describe('satisfies', () => {
  const p = principalFromMe(me({ studies: ['S1'] }));
  it('checks all / any / roles / study', () => {
    expect(satisfies(p, {})).toBe(true);
    expect(satisfies(p, { all: ['studies.read', 'validation.read'] })).toBe(true);
    expect(satisfies(p, { all: ['studies.read', 'admin.settings'] })).toBe(false);
    expect(satisfies(p, { any: ['admin.settings', 'validation.read'] })).toBe(true);
    expect(satisfies(p, { any: ['admin.settings'] })).toBe(false);
    expect(satisfies(p, { roles: ['admin'] })).toBe(false);
    expect(satisfies(p, { roles: ['researcher'] })).toBe(true);
    expect(satisfies(p, { all: ['studies.read'], study: 'S1' })).toBe(true);
    expect(satisfies(p, { all: ['studies.read'], study: 'S2' })).toBe(false);
    expect(satisfies(null, {})).toBe(false);
  });
});
