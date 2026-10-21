/**
 * @shriii/contracts — canonical SHRIII contracts.
 *
 * - JSON Schema 2020-12 files under `schemas/` are canonical (import them via
 *   `@shriii/contracts/schemas/<name>.v1.schema.json`).
 * - Types, constants and Ajv standalone validators under `src/generated/` are generated from them
 *   (`pnpm --filter @shriii/contracts generate`; `build` fails on drift).
 * - `validateX` validators are strict (writers: unknown properties rejected); `readX` validators are
 *   tolerant (readers: unknown properties of minor N+1 accepted).
 *
 * Bundle-size note: size-sensitive code (the kiosk logger) should import a single validator module,
 * e.g. `import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope'`.
 */

export * from './api.ts';
export * from './events.ts';
export * from './generated/constants.ts';
export type * from './generated/types.ts';
export * from './generated/validators/index.js';
export * from './invariants.ts';
export * from './validate.ts';
