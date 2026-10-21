/**
 * Outbox model shared by the IndexedDB (Dexie) and in-memory implementations (KSK-07, ING-02 client).
 *
 * Rules:
 * - `seq` is allocated in the same transaction as the event row (gapless per session).
 * - Consent first: a session's events are uploadable only after its core `consent.granted` row is
 *   stored; declined / never-consented sessions are purged and nothing is uploaded (fail closed).
 * - Batches are session-ordered, <= 500 events or <= 256 kB, and keep their `batch_id` until the
 *   server answers, so a retry after a timeout is idempotent server-side.
 * - Terminal statuses (`accepted`, `duplicate`, `parked`, `rejected_terminal`) are purged after a grace
 *   period; `retryable` rows stay. Data is never silently dropped.
 */
import type { EventStatus, UploadBatch, UploadBatchResult } from '@shriii/contracts';
import type { Outbox } from '../../core/contracts.ts';

/** Consent state of a stored session. */
export type ConsentState = 'pending' | 'granted' | 'declined';

/** Upload status of a stored event. */
export type RowStatus = 'pending' | 'inflight' | 'acked';

/** A stored session. */
export interface SessionRow {
  readonly sessionId: string;
  nextSeq: number;
  consent: ConsentState;
  /** Creation order (monotonic counter) for session-ordered batches. */
  readonly order: number;
  closed: boolean;
}

/** A stored event. */
export interface EventRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly event: unknown;
  readonly bytes: number;
  status: RowStatus;
  batchId: string | null;
  ackStatus: EventStatus | null;
  ackedAt: number | null;
}

/** A batch awaiting a server answer (kept for idempotent retries). */
export interface BatchRow {
  readonly batchId: string;
  readonly createdAt: number;
  readonly batch: UploadBatch;
  readonly keys: readonly (readonly [string, number])[];
  attempts: number;
}

/** Outbox status for devtools and `device_health`. */
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

/** A stored session that was never closed (the renderer died mid-session). */
export interface OpenSessionInfo {
  readonly sessionId: string;
  readonly consent: ConsentState;
  readonly nextSeq: number;
}

/** Batch size limits (KSK-07). */
export interface BatchLimits {
  readonly maxEvents: number;
  readonly maxBytes: number;
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = { maxEvents: 500, maxBytes: 256 * 1024 };

/** Builds a placeholder/tombstone event for a given seq (used by purge with tombstone). */
export type EventBuilder = (seq: number) => unknown;

/** The kiosk outbox: the contract interface plus lifecycle helpers used by the engine. */
export interface KioskOutbox extends Outbox {
  readonly kioskId: string;
  /** Explicitly set a session's consent state (consent events also set it automatically on append). */
  setConsent(sessionId: string, state: ConsentState): Promise<void>;
  /**
   * Delete a session's local rows. With `tombstone`, a `session_tombstone` event is appended at the
   * next seq and kept for upload (withdrawal after consent); without it the session row is removed.
   */
  purgeSession(sessionId: string, tombstone?: EventBuilder): Promise<void>;
  /** Mark a session finished (no more appends expected). */
  closeSession(sessionId: string): Promise<void>;
  /** Anonymous declined-consent counter (the only trace of a declined session). */
  recordDecline(): Promise<void>;
  /** Count a failed attempt; the batch (and its batch_id) is kept for the next retry. */
  markBatchFailed(batchId: string): Promise<void>;
  /** Delete acknowledged rows older than `graceMs`; returns the number of rows deleted. */
  purgeAcknowledged(graceMs: number): Promise<number>;
  stats(): Promise<OutboxStats>;
  /** Sessions not yet closed (crash recovery at startup), in creation order. */
  openSessions(): Promise<readonly OpenSessionInfo[]>;
  /** A session's stored events in seq order (devtools, NDJSON export, tests). */
  sessionEvents(sessionId: string): Promise<unknown[]>;
}

/** Statuses after which the kiosk no longer needs the row. */
export const TERMINAL_STATUSES: ReadonlySet<EventStatus> = new Set([
  'accepted',
  'duplicate',
  'parked',
  'rejected_terminal',
]);

/** Plan the result of a server answer for one batch: which rows become acked or pending again. */
export function planResult(
  batch: BatchRow,
  result: UploadBatchResult,
): { readonly acked: Map<string, EventStatus>; readonly retry: Set<string> } {
  const byId = new Map<string, EventStatus>(
    result.results.map((r) => [`${r.session_id}#${r.seq}`, r.status]),
  );
  const acked = new Map<string, EventStatus>();
  const retry = new Set<string>();
  for (const [sessionId, seq] of batch.keys) {
    const key = `${sessionId}#${seq}`;
    const status =
      byId.get(key) ??
      (result.duplicate_batch && result.results.length === 0 ? 'duplicate' : undefined);
    if (status !== undefined && TERMINAL_STATUSES.has(status)) acked.set(key, status);
    else retry.add(key);
  }
  return { acked, retry };
}

/** Does this envelope set the session's core consent state? */
export function consentStateOf(event: unknown): ConsentState | null {
  if (event === null || typeof event !== 'object') return null;
  const e = event as { event_type?: unknown; payload?: { consent_kind?: unknown } };
  if (e.payload?.consent_kind !== 'core') return null;
  if (e.event_type === 'consent.granted') return 'granted';
  if (e.event_type === 'consent.declined') return 'declined';
  return null;
}

/** Read `event_id` / `event_type` from a built envelope (validated upstream). */
export function envelopeIds(event: unknown): { eventId: string; eventType: string } {
  const e = event as { event_id?: unknown; event_type?: unknown };
  return {
    eventId: typeof e.event_id === 'string' ? e.event_id : '',
    eventType: typeof e.event_type === 'string' ? e.event_type : 'invalid',
  };
}

/** Split a `<sessionId>#<seq>` row key. */
export function splitKey(key: string): [string, number] {
  const i = key.lastIndexOf('#');
  return [key.slice(0, i), Number(key.slice(i + 1))];
}
