/**
 * Outbox types. {@link KioskOutboxApi} is structurally identical to `KioskOutbox` in
 * `packages/kiosk-game/src/logging/outbox/types.ts` (which extends the `Outbox` contract in
 * `packages/kiosk-game/src/core/contracts.ts`), so the SQLite outbox is a drop-in replacement for the
 * Dexie outbox behind the logger, crash recovery and uploader. The compatibility test in
 * `test/kiosk-game-compat.test.ts` runs the real kiosk-game logger and recovery against it.
 */
import type { EventStatus, UploadBatch, UploadBatchResult } from '@shriii/contracts';
import type { Outbox } from '@shriii/kiosk-game/core/contracts';

export type ConsentState = 'pending' | 'granted' | 'declined';
export type RowStatus = 'pending' | 'inflight' | 'acked';

export interface OutboxStats {
  readonly pendingEvents: number;
  readonly inflightEvents: number;
  readonly acknowledgedEvents: number;
  readonly sessions: number;
  readonly sessionsAwaitingConsent: number;
  readonly openBatches: number;
  readonly declinedCount: number;
  readonly lastAckAt: number | null;
}

export interface OpenSessionInfo {
  readonly sessionId: string;
  readonly consent: ConsentState;
  readonly nextSeq: number;
}

export type EventBuilder = (seq: number) => unknown;

export interface KioskOutboxApi extends Outbox {
  readonly kioskId: string;
  setConsent(sessionId: string, state: ConsentState): Promise<void>;
  purgeSession(sessionId: string, tombstone?: EventBuilder): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  recordDecline(): Promise<void>;
  markBatchFailed(batchId: string): Promise<void>;
  purgeAcknowledged(graceMs: number): Promise<number>;
  stats(): Promise<OutboxStats>;
  openSessions(): Promise<readonly OpenSessionInfo[]>;
  sessionEvents(sessionId: string): Promise<unknown[]>;
}

export type { EventStatus, UploadBatch, UploadBatchResult };

/** Statuses after which the kiosk no longer needs the row (purged after the grace period). */
export const TERMINAL_STATUSES: ReadonlySet<EventStatus> = new Set<EventStatus>([
  'accepted',
  'duplicate',
  'parked',
  'rejected_terminal',
]);

/** Thrown by {@link SqliteOutbox.appendAt} when the caller's seq is not the next gapless seq. */
export class SeqConflictError extends Error {
  readonly expected: number;
  constructor(sessionId: string, expected: number, got: number) {
    super(`seq conflict for ${sessionId}: expected ${expected}, got ${got}`);
    this.name = 'SeqConflictError';
    this.expected = expected;
  }
}

/** Thrown when a new session would exceed the capacity quota or no recipient key is valid. */
export class OutboxFullError extends Error {
  constructor(reason: string) {
    super(`outbox cannot accept a new session: ${reason}`);
    this.name = 'OutboxFullError';
  }
}

/** Does this envelope set the session's core consent state? */
export function consentStateOf(event: unknown): ConsentState | null {
  if (event === null || typeof event !== 'object') return null;
  const e = event as { event_type?: unknown; payload?: { consent_kind?: unknown } | null };
  if (e.payload?.consent_kind !== 'core') return null;
  if (e.event_type === 'consent.granted') return 'granted';
  if (e.event_type === 'consent.declined') return 'declined';
  return null;
}

export function envelopeIds(event: unknown): { eventId: string; eventType: string } {
  const e = (event ?? {}) as { event_id?: unknown; event_type?: unknown };
  return {
    eventId: typeof e.event_id === 'string' ? e.event_id : '',
    eventType: typeof e.event_type === 'string' ? e.event_type : 'invalid',
  };
}
