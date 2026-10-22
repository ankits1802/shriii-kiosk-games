import { describe, expect, it } from 'vitest';
import { loadRbacMatrix } from '@/test/rbac';
import { MATRIX_ROLES, permissionGroups, ROLE_PERMISSIONS } from './rbac-matrix';

describe('RBAC matrix mirror', () => {
  it('matches ROLE_PERMISSIONS in backend/api rbac.py exactly', () => {
    const matrix = loadRbacMatrix();
    if (!matrix) return; // no Python: permissions.test.ts still guards the vocabulary
    expect(Object.keys(matrix.roles).sort()).toEqual([...MATRIX_ROLES].sort());
    for (const role of MATRIX_ROLES) {
      expect([...ROLE_PERMISSIONS[role]].sort(), role).toEqual(
        [...(matrix.roles[role] ?? [])].sort(),
      );
    }
    // Spawns Python to execute rbac.py; allow for a slow interpreter start under parallel load.
  }, 60_000);

  it('never lets field administrators read scores (PRV-08)', () => {
    expect(ROLE_PERMISSIONS.administrator.has('scores.read')).toBe(false);
    expect(ROLE_PERMISSIONS.analyst.has('participants.read')).toBe(false);
  });

  it('groups every permission once', () => {
    const all = permissionGroups().flatMap((g) => g.permissions);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(ROLE_PERMISSIONS.admin.size);
  });
});
