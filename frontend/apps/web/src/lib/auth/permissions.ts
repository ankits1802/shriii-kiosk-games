/**
 * Permission and role vocabulary, mirrored from the API's RBAC module
 * (`backend/api/src/shriii_api/auth/rbac.py`, PRV-08). The API is the authority: the UI reads the
 * caller's effective permissions from `GET /api/v1/auth/me` and only uses these names to decide what
 * to show. A unit test (`permissions.test.ts`) fails if this list drifts from rbac.py.
 */

export const PERMISSIONS = [
  'sessions.write',
  'sessions.read',
  'sessions.invalidate',
  'events.ingest',
  'events.read_raw',
  'games.read',
  'games.write',
  'participants.create',
  'participants.read',
  'participants.link',
  'participants.withdraw',
  'consent.write',
  'consent.read',
  'contact.write',
  'erasure.request',
  'erasure.execute',
  'instruments.read',
  'instruments.write',
  'responses.write',
  'responses.read',
  'scores.read',
  'imports.write',
  'features.read',
  'features.run',
  'datasets.read',
  'datasets.write',
  'validation.read',
  'validation.run',
  'models.read',
  'models.write',
  'norms.read',
  'norms.write',
  'reports.generate',
  'reports.read',
  'reports.manage',
  'gates.read',
  'gates.write',
  'studies.read',
  'studies.write',
  'studies.enroll',
  'jobs.read',
  'jobs.write',
  'kiosk.heartbeat',
  'admin.kiosks',
  'admin.content',
  'admin.settings',
  'audit.read',
  'retention.run',
  'dead_letter.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/** Human roles (the `kiosk_device` role authenticates with device tokens, never in this app). */
export const USER_ROLES = ['admin', 'researcher', 'administrator', 'analyst'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrator (system)',
  researcher: 'Researcher',
  administrator: 'Field administrator',
  analyst: 'Analyst (de-identified)',
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin: 'All permissions, unscoped: operations, content, kiosks, settings and audit.',
  researcher: 'Studies, participants, instruments, validation, models and reports.',
  administrator: 'Runs sessions and the criterion battery. Cannot read scores.',
  analyst: 'De-identified research layers only: no linkage, consent, raw events or identity.',
};

/** Wildcard study scope carried by unscoped principals. */
export const ALL_STUDIES = '*';
