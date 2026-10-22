/**
 * Server-only (build-time) inputs for the settings page: the retention rules file the API runs
 * (backend/api/src/shriii_api/config/retention.yaml) and the catalogue languages and line ids the
 * deployment-policy editor validates against. Replace with API reads once
 * `GET /api/v1/admin/retention/policy` exists.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { findRepoRoot } from '../content/load-content.server';

export const RETENTION_PATH = 'backend/api/src/shriii_api/config/retention.yaml';
const CATALOGUE_PATH = 'content/i18n/lines.yaml';

export interface RetentionRule {
  readonly id: string;
  readonly dataClass: string;
  readonly description: string;
  readonly ttlDays: number | null;
  readonly enabled: boolean;
}

export interface SettingsInputs {
  readonly retention: {
    readonly path: string;
    readonly version: string;
    readonly sha256: string;
    readonly rules: readonly RetentionRule[];
  };
  readonly catalogueLanguages: readonly string[];
  /** Consent and report line ids (choices for the report use statement). */
  readonly statementLines: readonly string[];
}

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

export function loadSettingsInputs(root: string = findRepoRoot()): SettingsInputs {
  const bytes = readFileSync(join(/*turbopackIgnore: true*/ root, RETENTION_PATH));
  const ret = parse(bytes.toString('utf8')) as unknown;
  const r = isRaw(ret) ? ret : {};
  const rules: RetentionRule[] = (Array.isArray(r.rules) ? r.rules : []).filter(isRaw).map((x) => ({
    id: String(x.id ?? ''),
    dataClass: String(x.data_class ?? ''),
    description: String(x.description ?? ''),
    ttlDays: typeof x.ttl_days === 'number' ? x.ttl_days : null,
    enabled: x.enabled !== false,
  }));
  const cat = parse(
    readFileSync(join(/*turbopackIgnore: true*/ root, CATALOGUE_PATH), 'utf8'),
  ) as unknown;
  const c = isRaw(cat) ? cat : {};
  const lines = (Array.isArray(c.lines) ? c.lines : []).filter(isRaw);
  return {
    retention: {
      path: RETENTION_PATH,
      version: String(r.version ?? ''),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      rules,
    },
    catalogueLanguages: Array.isArray(c.languages)
      ? c.languages.filter((l): l is string => typeof l === 'string')
      : [],
    statementLines: lines
      .filter((l) => l.category === 'consent' || l.category === 'report')
      .map((l) => String(l.id ?? ''))
      .filter(Boolean),
  };
}
