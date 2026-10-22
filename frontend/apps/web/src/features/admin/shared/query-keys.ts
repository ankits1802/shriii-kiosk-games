/** TanStack Query keys for the admin console (prefix-invalidated after mutations). */
export const adminKeys = {
  games: () => ['admin', 'games'] as const,
  gameVersions: (gameId: string) => ['admin', 'games', gameId, 'versions'] as const,
  gameVersion: (gameId: string, version: string) =>
    ['admin', 'games', gameId, 'versions', version] as const,
  sessionPlan: () => ['admin', 'games', 'session-plan'] as const,
  contentVersions: () => ['admin', 'content-versions'] as const,
  kiosks: () => ['admin', 'kiosks'] as const,
  deployments: () => ['admin', 'deployments'] as const,
  systemEvents: () => ['admin', 'system-events'] as const,
  deadLetterSummary: () => ['admin', 'dead-letters', 'summary'] as const,
  settings: () => ['admin', 'settings'] as const,
  audit: (filters: Readonly<Record<string, unknown>>) => ['admin', 'audit', filters] as const,
  auditAll: () => ['admin', 'audit'] as const,
  erasure: () => ['admin', 'erasure-requests'] as const,
  gates: () => ['admin', 'gates'] as const,
  releasePack: () => ['admin', 'release-pack'] as const,
};
