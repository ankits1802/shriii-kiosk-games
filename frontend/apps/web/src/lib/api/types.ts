/**
 * Friendly aliases over the generated OpenAPI types (`src/generated/api-schema.ts`, produced by
 * `pnpm --filter web api:generate` from `backend/api/openapi.json`). Import API shapes from here so a
 * regenerated schema only needs fixing in one place.
 */
import type { components, operations, paths } from '@/generated/api-schema';

export type { components, operations, paths };

export type Schemas = components['schemas'];
export type Schema<K extends keyof Schemas> = Schemas[K];

export type MeResponse = Schemas['MeResponse'];
export type TokenResponse = Schemas['TokenResponse'];
export type DevLoginRequest = Schemas['DevLoginRequest'];
export type ErrorResponse = Schemas['ErrorResponse'];

/** Roles a dev login may request (the kiosk device role never logs in with a user JWT). */
export type DevLoginRole = DevLoginRequest['roles'][number];

/** Every API path, e.g. `/api/v1/studies/{study_id}`. */
export type ApiPath = keyof paths;
