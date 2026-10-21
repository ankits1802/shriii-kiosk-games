import { describe, expect, it } from 'vitest';
import { loadRbacMatrix, permissionsFromSource } from '@/test/rbac';
import { isPermission, PERMISSIONS, USER_ROLES } from './permissions';

describe('permission vocabulary parity with apps/api rbac.py', () => {
  it('lists exactly the Perm enum values (source scan)', () => {
    expect([...PERMISSIONS].sort()).toEqual(permissionsFromSource().sort());
  });

  it('matches the executed Perm enum and role set', () => {
    const matrix = loadRbacMatrix();
    if (!matrix) return; // no Python available: the source scan above still guards drift
    expect([...PERMISSIONS].sort()).toEqual([...matrix.permissions].sort());
    for (const role of USER_ROLES) expect(Object.keys(matrix.roles)).toContain(role);
  });

  it('recognises permission names', () => {
    expect(isPermission('validation.read')).toBe(true);
    expect(isPermission('validation.delete')).toBe(false);
  });
});
