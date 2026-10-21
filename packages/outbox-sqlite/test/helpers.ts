import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateKek,
  generateRecipientKeyPair,
  RecipientKeyRing,
} from '@shriii/session-crypto';
import { parseOutboxPolicy, loadOutboxPolicy, type OutboxPolicy } from '../src/policy.ts';
import { SqliteOutbox, type SqliteOutboxOptions } from '../src/sqlite-outbox.ts';
import { uuidv7 } from '../src/util.ts';

export const T0 = Date.parse('2026-10-21T08:00:00Z');

export function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-sqlite-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function mockClock(start = T0): { now: () => number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

export interface Harness {
  readonly backend: ReturnType<typeof generateRecipientKeyPair>;
  readonly kek: Uint8Array;
  readonly ring: RecipientKeyRing;
  readonly clock: ReturnType<typeof mockClock>;
  open(path: string, extra?: Partial<SqliteOutboxOptions>): SqliteOutbox;
  privateKeys(kid: string): Uint8Array | undefined;
}

export function harness(): Harness {
  const backend = generateRecipientKeyPair('backend-1');
  const kek = generateKek();
  const ring = new RecipientKeyRing([
    { kid: backend.kid, publicKey: backend.publicKey, notBefore: T0 - 1000, notAfter: null },
  ]);
  const clock = mockClock();
  return {
    backend,
    kek,
    ring,
    clock,
    open: (path, extra = {}) =>
      new SqliteOutbox({
        kioskId: 'kiosk-test',
        path,
        encryption: { mode: 'sealed', kek, recipients: ring },
        nowMs: clock.now,
        ...extra,
      }),
    privateKeys: (kid) => (kid === backend.kid ? backend.privateKey : undefined),
  };
}

export function policyWith(patch: (p: Record<string, Record<string, unknown>>) => void): OutboxPolicy {
  const base = loadOutboxPolicy();
  const raw: Record<string, Record<string, unknown>> = {
    capacity: {
      design_days: base.capacity.designDays,
      expected_sessions_per_day: base.capacity.expectedSessionsPerDay,
      expected_bytes_per_session: base.capacity.expectedBytesPerSession,
      headroom_factor: base.capacity.headroomFactor,
      max_db_bytes: base.capacity.maxDbBytes,
      min_free_disk_bytes: base.capacity.minFreeDiskBytes,
      warn_fraction: base.capacity.warnFraction,
    },
    alerts: { unsynced_age_days: base.alerts.unsyncedAgeDays },
    upload: {
      max_events_per_batch: base.upload.maxEventsPerBatch,
      max_batch_bytes: base.upload.maxBatchBytes,
      ack_grace_hours: base.upload.ackGraceHours,
    },
    retention: { unconsented_max_age_hours: base.retention.unconsentedMaxAgeHours },
  };
  patch(raw);
  return parseOutboxPolicy(JSON.stringify(raw));
}

/** A minimal envelope-shaped event (the outbox only reads event_id/event_type/payload.consent_kind). */
export function ev(
  sessionId: string,
  seq: number,
  type = 'session.state_changed',
  payload: Record<string, unknown> = { note: `event ${seq}` },
): Record<string, unknown> {
  return { event_id: uuidv7(), session_id: sessionId, seq, event_type: type, payload };
}

export const consentGranted = (sessionId: string, seq: number): Record<string, unknown> =>
  ev(sessionId, seq, 'consent.granted', { consent_kind: 'core', tap_confirmed: true });

export const consentDeclined = (sessionId: string, seq: number): Record<string, unknown> =>
  ev(sessionId, seq, 'consent.declined', { consent_kind: 'core' });

/** Append `n` events through the seq-aware builder. */
export async function appendMany(
  outbox: SqliteOutbox,
  sessionId: string,
  n: number,
  payload?: (seq: number) => Record<string, unknown>,
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await outbox.append(sessionId, (seq) =>
      ev(sessionId, seq, 'session.state_changed', payload?.(seq) ?? { note: `event ${seq}` }),
    );
  }
}

/** A consented session: 2 pre-consent events, consent at seq 2, then `n` more events. */
export async function consentedSession(outbox: SqliteOutbox, n = 3): Promise<string> {
  const sid = uuidv7();
  await appendMany(outbox, sid, 2);
  await outbox.append(sid, (seq) => consentGranted(sid, seq));
  await appendMany(outbox, sid, n);
  return sid;
}

export { uuidv7 };
