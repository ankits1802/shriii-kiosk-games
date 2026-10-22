/**
 * API endpoints the admin console needs but `backend/api` does not provide yet. The UI shows a
 * "needs API" notice instead of faking data; `shared.test.ts` fails as soon as one of
 * these appears in `backend/api/openapi.json`, so the notice gets replaced by the real call.
 */

export interface MissingEndpoint {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly purpose: string;
  readonly feature: string;
}

export const MISSING_ENDPOINTS = {
  gameDraftCreate: {
    id: 'gameDraftCreate',
    method: 'POST',
    path: '/api/v1/games/{game_id}/versions',
    purpose:
      'Save an edited config as a new draft version (validated server-side against game-config.v1). Until then, download the JSON, commit it under content/games and run Sync.',
    feature: 'ENG-04',
  },
  contentLines: {
    id: 'contentLines',
    method: 'GET',
    path: '/api/v1/admin/content/lines',
    purpose:
      'Voice-line catalogue with per-language recording and ITC state from the server. The console reads content/i18n at build time instead.',
    feature: 'VOX-07',
  },
  lineTransition: {
    id: 'lineTransition',
    method: 'POST',
    path: '/api/v1/admin/content/lines/{line_id}/languages/{language}/transitions',
    purpose:
      'Record an ITC sign-off (role, signer, comment) for one line and language. Until then, use the shriii-i18n XLSX round trip.',
    feature: 'VOX-07',
  },
  audioUpload: {
    id: 'audioUpload',
    method: 'POST',
    path: '/api/v1/admin/content/audio/{line_id}/{language}',
    purpose:
      'Upload a recorded take into the audio manifest slot (server re-measures loudness and duration). Until then, takes go through tools/audio-pipeline.',
    feature: 'VOX-02',
  },
  kioskCommands: {
    id: 'kioskCommands',
    method: 'POST',
    path: '/api/v1/admin/kiosks/{kiosk_id}/commands',
    purpose: 'Queue a remote command (lock, restart, sync, pull scrubbed logs, wipe) for a kiosk.',
    feature: 'KSK-10',
  },
  kioskCommandList: {
    id: 'kioskCommandList',
    method: 'GET',
    path: '/api/v1/admin/kiosks/{kiosk_id}/commands',
    purpose: 'Command history and acknowledgement state per kiosk.',
    feature: 'KSK-10',
  },
  users: {
    id: 'users',
    method: 'GET',
    path: '/api/v1/admin/users',
    purpose:
      'Console users with their roles and study scopes (role grants currently come from the identity provider token).',
    feature: 'PRV-08',
  },
  userGrants: {
    id: 'userGrants',
    method: 'PUT',
    path: '/api/v1/admin/users/{sub}/grants',
    purpose: 'Grant or revoke roles and study-scoped access for a user (audited).',
    feature: 'PRV-08',
  },
  policySign: {
    id: 'policySign',
    method: 'POST',
    path: '/api/v1/admin/policies/{policy_version}/sign',
    purpose:
      'Validate a deployment policy against a DeploymentPolicy schema, enforce two-person approval server-side and sign it with the release-pack key.',
    feature: 'PRV-01',
  },
  retentionPolicy: {
    id: 'retentionPolicy',
    method: 'GET',
    path: '/api/v1/admin/retention/policy',
    purpose:
      'The active retention rules and their sha256 (the console shows the repository copy read at build time).',
    feature: 'PRV-05',
  },
  retentionRuns: {
    id: 'retentionRuns',
    method: 'GET',
    path: '/api/v1/admin/retention/runs',
    purpose: 'History of retention runs with their reports.',
    feature: 'PRV-05',
  },
  legalHolds: {
    id: 'legalHolds',
    method: 'GET',
    path: '/api/v1/admin/legal-holds',
    purpose: 'List active and released legal holds (create and release exist).',
    feature: 'PRV-05',
  },
} as const satisfies Record<string, MissingEndpoint>;

export type MissingEndpointId = keyof typeof MISSING_ENDPOINTS;
