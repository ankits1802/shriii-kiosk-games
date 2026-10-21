/**
 * Outbox policy: capacity quota, unsynced-age alert, batch limits and retention (KSK-07). The values
 * live in `config/outbox-policy.yaml`; this module parses and validates them and computes health.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface OutboxPolicy {
  readonly capacity: {
    readonly designDays: number;
    readonly expectedSessionsPerDay: number;
    readonly expectedBytesPerSession: number;
    readonly headroomFactor: number;
    readonly maxDbBytes: number | null;
    readonly minFreeDiskBytes: number;
    readonly warnFraction: number;
  };
  readonly alerts: { readonly unsyncedAgeDays: number };
  readonly upload: {
    readonly maxEventsPerBatch: number;
    readonly maxBatchBytes: number;
    readonly ackGraceHours: number;
  };
  readonly retention: { readonly unconsentedMaxAgeHours: number };
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

/** URL of the packaged default policy (copy it next to a bundled build and pass its path). */
export const DEFAULT_POLICY_URL = new URL('../config/outbox-policy.yaml', import.meta.url);

class PolicyError extends Error {
  constructor(message: string) {
    super(`outbox policy: ${message}`);
    this.name = 'PolicyError';
  }
}

function section(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = root[key];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new PolicyError(`missing section ${key}`);
  }
  return v as Record<string, unknown>;
}

function num(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  integer = false,
): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new PolicyError(`${key} must be a number in [${min}, ${max}]`);
  }
  if (integer && !Number.isInteger(v)) throw new PolicyError(`${key} must be an integer`);
  return v;
}

/** Parse and validate a policy YAML document. */
export function parseOutboxPolicy(text: string): OutboxPolicy {
  const root = parse(text) as unknown;
  if (root === null || typeof root !== 'object') throw new PolicyError('not a mapping');
  const r = root as Record<string, unknown>;
  const cap = section(r, 'capacity');
  const alerts = section(r, 'alerts');
  const upload = section(r, 'upload');
  const retention = section(r, 'retention');
  const maxDb = cap.max_db_bytes;
  if (maxDb !== null && (typeof maxDb !== 'number' || !(maxDb > 0))) {
    throw new PolicyError('max_db_bytes must be null or a positive number');
  }
  const policy: OutboxPolicy = {
    capacity: {
      designDays: num(cap, 'design_days', 1, 365, true),
      expectedSessionsPerDay: num(cap, 'expected_sessions_per_day', 1, 10_000),
      expectedBytesPerSession: num(cap, 'expected_bytes_per_session', 1_000, 1e9),
      headroomFactor: num(cap, 'headroom_factor', 1, 10),
      maxDbBytes: maxDb as number | null,
      minFreeDiskBytes: num(cap, 'min_free_disk_bytes', 0, 1e13),
      warnFraction: num(cap, 'warn_fraction', 0.1, 1),
    },
    alerts: { unsyncedAgeDays: num(alerts, 'unsynced_age_days', 0.01, 365) },
    upload: {
      maxEventsPerBatch: num(upload, 'max_events_per_batch', 1, 500, true),
      maxBatchBytes: num(upload, 'max_batch_bytes', 1024, 256 * 1024, true),
      ackGraceHours: num(upload, 'ack_grace_hours', 0, 24 * 90),
    },
    retention: {
      unconsentedMaxAgeHours: num(retention, 'unconsented_max_age_hours', 0.01, 24 * 30),
    },
  };
  if (policy.alerts.unsyncedAgeDays >= policy.capacity.designDays) {
    throw new PolicyError('unsynced_age_days must be below design_days');
  }
  return policy;
}

export function loadOutboxPolicy(path: string | URL = DEFAULT_POLICY_URL): OutboxPolicy {
  return parseOutboxPolicy(readFileSync(path, 'utf8'));
}

/** Stored-bytes quota: explicit ceiling, or design days x sessions/day x bytes/session x headroom. */
export function quotaBytes(policy: OutboxPolicy): number {
  const c = policy.capacity;
  return (
    c.maxDbBytes ??
    Math.round(c.designDays * c.expectedSessionsPerDay * c.expectedBytesPerSession * c.headroomFactor)
  );
}

/** Maximum stored (not yet purged) sessions before new sessions stop. */
export function quotaSessions(policy: OutboxPolicy): number {
  const c = policy.capacity;
  return Math.ceil(c.designDays * c.expectedSessionsPerDay * c.headroomFactor);
}

export type OutboxAlert =
  | 'unsynced_age_exceeded'
  | 'capacity_warning'
  | 'capacity_full'
  | 'disk_low'
  | 'no_recipient_key';

export interface OutboxHealth {
  readonly storedBytes: number;
  readonly quotaBytes: number;
  readonly storedSessions: number;
  readonly quotaSessions: number;
  readonly unsyncedEvents: number;
  readonly unsyncedSessions: number;
  /** Wall-clock ms of the oldest unsynced consented event, or null. */
  readonly oldestUnsyncedAt: number | null;
  readonly oldestUnsyncedAgeMs: number | null;
  readonly freeDiskBytes: number | null;
  /** False when a new session must not start (quota reached, disk low, no key). */
  readonly canStartSession: boolean;
  readonly alerts: readonly OutboxAlert[];
}

export interface HealthInputs {
  readonly storedBytes: number;
  readonly storedSessions: number;
  readonly unsyncedEvents: number;
  readonly unsyncedSessions: number;
  readonly oldestUnsyncedAt: number | null;
  readonly freeDiskBytes: number | null;
  readonly hasRecipientKey: boolean;
}

export function evaluateHealth(
  policy: OutboxPolicy,
  inputs: HealthInputs,
  nowMs: number,
): OutboxHealth {
  const qb = quotaBytes(policy);
  const qs = quotaSessions(policy);
  const alerts: OutboxAlert[] = [];
  const age = inputs.oldestUnsyncedAt === null ? null : Math.max(0, nowMs - inputs.oldestUnsyncedAt);
  if (age !== null && age >= policy.alerts.unsyncedAgeDays * DAY_MS) {
    alerts.push('unsynced_age_exceeded');
  }
  const full = inputs.storedBytes >= qb || inputs.storedSessions >= qs;
  if (full) alerts.push('capacity_full');
  else if (
    inputs.storedBytes >= qb * policy.capacity.warnFraction ||
    inputs.storedSessions >= qs * policy.capacity.warnFraction
  ) {
    alerts.push('capacity_warning');
  }
  const diskLow =
    inputs.freeDiskBytes !== null && inputs.freeDiskBytes < policy.capacity.minFreeDiskBytes;
  if (diskLow) alerts.push('disk_low');
  if (!inputs.hasRecipientKey) alerts.push('no_recipient_key');
  return {
    storedBytes: inputs.storedBytes,
    quotaBytes: qb,
    storedSessions: inputs.storedSessions,
    quotaSessions: qs,
    unsyncedEvents: inputs.unsyncedEvents,
    unsyncedSessions: inputs.unsyncedSessions,
    oldestUnsyncedAt: inputs.oldestUnsyncedAt,
    oldestUnsyncedAgeMs: age,
    freeDiskBytes: inputs.freeDiskBytes,
    canStartSession: !full && !diskLow && inputs.hasRecipientKey,
    alerts,
  };
}
