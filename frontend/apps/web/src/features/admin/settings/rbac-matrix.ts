/**
 * Role → permission matrix, mirrored from backend/api rbac.py (ROLE_PERMISSIONS) for the read-only
 * matrix view. `rbac-matrix.test.ts` executes rbac.py and fails on any drift. The API remains the
 * authority on every request.
 */
import { PERMISSIONS, type Permission } from '@/lib/auth/permissions';

export const MATRIX_ROLES = [
  'admin',
  'researcher',
  'administrator',
  'analyst',
  'kiosk_device',
] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

const RESEARCH_READ: readonly Permission[] = [
  'sessions.read',
  'games.read',
  'instruments.read',
  'features.read',
  'datasets.read',
  'validation.read',
  'models.read',
  'norms.read',
  'gates.read',
  'studies.read',
  'jobs.read',
];

export const ROLE_PERMISSIONS: Readonly<Record<MatrixRole, ReadonlySet<Permission>>> = {
  admin: new Set(PERMISSIONS),
  researcher: new Set<Permission>([
    ...RESEARCH_READ,
    'sessions.write',
    'sessions.invalidate',
    'events.read_raw',
    'participants.create',
    'participants.read',
    'participants.link',
    'participants.withdraw',
    'consent.write',
    'consent.read',
    'contact.write',
    'erasure.request',
    'instruments.write',
    'responses.write',
    'responses.read',
    'scores.read',
    'imports.write',
    'features.run',
    'datasets.write',
    'validation.run',
    'models.write',
    'norms.write',
    'reports.generate',
    'reports.read',
    'reports.manage',
    'studies.write',
    'studies.enroll',
    'jobs.write',
  ]),
  administrator: new Set<Permission>([
    'sessions.write',
    'sessions.read',
    'games.read',
    'participants.create',
    'participants.read',
    'participants.link',
    'participants.withdraw',
    'consent.write',
    'contact.write',
    'erasure.request',
    'instruments.read',
    'responses.write',
    'reports.generate',
    'studies.read',
    'studies.enroll',
  ]),
  analyst: new Set<Permission>([...RESEARCH_READ, 'validation.run', 'models.write', 'jobs.write']),
  kiosk_device: new Set<Permission>([
    'events.ingest',
    'sessions.write',
    'games.read',
    'gates.read',
    'reports.generate',
    'kiosk.heartbeat',
    'erasure.request',
    'participants.link',
  ]),
};

/** Permission groups by resource prefix (`studies.read` → `studies`), in vocabulary order. */
export function permissionGroups(): {
  readonly group: string;
  readonly permissions: readonly Permission[];
}[] {
  const out = new Map<string, Permission[]>();
  for (const p of PERMISSIONS) {
    const g = p.split('.')[0] ?? p;
    out.set(g, [...(out.get(g) ?? []), p]);
  }
  return [...out].map(([group, permissions]) => ({ group, permissions }));
}

/** Permissions that read identifiable or score-bearing data (shown with a marker in the matrix). */
export const SENSITIVE: ReadonlySet<Permission> = new Set<Permission>([
  'events.read_raw',
  'participants.read',
  'consent.read',
  'contact.write',
  'scores.read',
  'erasure.execute',
  'audit.read',
]);
