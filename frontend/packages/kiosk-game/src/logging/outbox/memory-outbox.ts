/**
 * In-memory {@link KioskOutbox} with the same semantics as the Dexie outbox. Used in tests, in
 * environments without IndexedDB (SSR, locked-down browsers) and as the reference implementation.
 */
import type { UploadBatch, UploadBatchResult } from '@shriii/contracts';
import { utf8Length } from '../hash.ts';
import { uuidv7 } from '../uuid.ts';
import { assembleBatch, selectBatchRows } from './batch.ts';
import {
  type BatchLimits,
  type BatchRow,
  type ConsentState,
  consentStateOf,
  DEFAULT_BATCH_LIMITS,
  type EventBuilder,
  type EventRow,
  envelopeIds,
  type KioskOutbox,
  type OpenSessionInfo,
  type OutboxStats,
  planResult,
  type SessionRow,
  splitKey,
} from './types.ts';

/** Options shared by outbox implementations. */
export interface OutboxOptions {
  readonly kioskId: string;
  /** Wall time for `UploadBatch.kiosk_t_wall` (informational). */
  readonly wallTime?: () => string;
  /** ms clock for ack timestamps (purge grace). */
  readonly nowMs?: () => number;
  readonly limits?: BatchLimits;
  readonly newId?: () => string;
}

export class MemoryOutbox implements KioskOutbox {
  readonly kioskId: string;
  private readonly sessions = new Map<string, SessionRow>();
  private readonly events = new Map<string, EventRow[]>();
  private readonly batches = new Map<string, BatchRow>();
  private declined = 0;
  private lastAckAt: number | null = null;
  private order = 0;
  private readonly wallTime: () => string;
  private readonly nowMs: () => number;
  private readonly limits: BatchLimits;
  private readonly newId: () => string;
  /** Serialises mutations like an IndexedDB readwrite transaction would. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: OutboxOptions) {
    this.kioskId = options.kioskId;
    this.wallTime = options.wallTime ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? Date.now;
    this.limits = options.limits ?? DEFAULT_BATCH_LIMITS;
    this.newId = options.newId ?? uuidv7;
  }

  private tx<T>(fn: () => T): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private session(sessionId: string): SessionRow {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { sessionId, nextSeq: 0, consent: 'pending', order: this.order++, closed: false };
      this.sessions.set(sessionId, s);
      this.events.set(sessionId, []);
    }
    return s;
  }

  append(sessionId: string, build: (seq: number) => unknown): Promise<number> {
    return this.tx(() => {
      const s = this.session(sessionId);
      const seq = s.nextSeq;
      const event = build(seq);
      const json = JSON.stringify(event);
      const { eventId, eventType } = envelopeIds(event);
      // Store a structured clone (as IndexedDB would) so later mutation of `event` cannot leak in.
      const row: EventRow = {
        sessionId,
        seq,
        eventId,
        eventType,
        event: JSON.parse(json) as unknown,
        bytes: utf8Length(json),
        status: 'pending',
        batchId: null,
        ackStatus: null,
        ackedAt: null,
      };
      this.events.get(sessionId)?.push(row);
      s.nextSeq = seq + 1;
      const consent = consentStateOf(event);
      if (consent) s.consent = consent;
      return seq;
    });
  }

  nextSeq(sessionId: string): Promise<number> {
    return this.tx(() => this.sessions.get(sessionId)?.nextSeq ?? 0);
  }

  setConsent(sessionId: string, state: ConsentState): Promise<void> {
    return this.tx(() => {
      this.session(sessionId).consent = state;
    });
  }

  nextBatch(): Promise<UploadBatch | null> {
    return this.tx(() => {
      const open = [...this.batches.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (open) return open.batch;
      const ordered = [...this.sessions.values()]
        .filter((s) => s.consent === 'granted')
        .sort((a, b) => a.order - b.order)
        .map((s) => ({
          rows: (this.events.get(s.sessionId) ?? []).filter((r) => r.status === 'pending'),
        }));
      const rows = selectBatchRows(ordered, this.limits);
      if (rows.length === 0) return null;
      const batchId = this.newId();
      const batch = assembleBatch({
        batchId,
        kioskId: this.kioskId,
        kioskTWall: this.wallTime(),
        rows,
      });
      for (const r of rows) {
        r.status = 'inflight';
        r.batchId = batchId;
      }
      this.batches.set(batchId, {
        batchId,
        createdAt: this.nowMs(),
        batch,
        keys: rows.map((r) => [r.sessionId, r.seq] as const),
        attempts: 0,
      });
      return batch;
    });
  }

  private row(sessionId: string, seq: number): EventRow | undefined {
    return this.events.get(sessionId)?.find((r) => r.seq === seq);
  }

  applyResult(result: UploadBatchResult): Promise<void> {
    return this.tx(() => {
      const batch = this.batches.get(result.batch_id);
      if (!batch) return;
      const { acked, retry } = planResult(batch, result);
      const now = this.nowMs();
      for (const [key, status] of acked) {
        const [sessionId, seq] = splitKey(key);
        const r = this.row(sessionId, seq);
        if (!r) continue;
        r.status = 'acked';
        r.ackStatus = status;
        r.ackedAt = now;
        r.batchId = null;
      }
      for (const key of retry) {
        const [sessionId, seq] = splitKey(key);
        const r = this.row(sessionId, seq);
        if (!r) continue;
        r.status = 'pending';
        r.batchId = null;
      }
      if (acked.size > 0) this.lastAckAt = now;
      this.batches.delete(result.batch_id);
    });
  }

  markBatchFailed(batchId: string): Promise<void> {
    return this.tx(() => {
      const b = this.batches.get(batchId);
      if (b) b.attempts += 1;
    });
  }

  purgeSession(sessionId: string, tombstone?: EventBuilder): Promise<void> {
    return this.tx(() => {
      const s = this.sessions.get(sessionId);
      this.dropFromBatches(sessionId);
      this.events.set(sessionId, []);
      if (!s) {
        this.events.delete(sessionId);
        return;
      }
      if (!tombstone) {
        this.sessions.delete(sessionId);
        this.events.delete(sessionId);
        return;
      }
      const seq = s.nextSeq;
      const event = tombstone(seq);
      const json = JSON.stringify(event);
      const { eventId, eventType } = envelopeIds(event);
      this.events.get(sessionId)?.push({
        sessionId,
        seq,
        eventId,
        eventType,
        event: JSON.parse(json) as unknown,
        bytes: utf8Length(json),
        status: 'pending',
        batchId: null,
        ackStatus: null,
        ackedAt: null,
      });
      s.nextSeq = seq + 1;
      s.closed = true;
    });
  }

  /** Remove a session's rows from open batches; the other sessions' rows go back to pending. */
  private dropFromBatches(sessionId: string): void {
    for (const [id, b] of this.batches) {
      if (!b.keys.some(([sid]) => sid === sessionId)) continue;
      for (const [sid, seq] of b.keys) {
        const r = this.row(sid, seq);
        if (r && r.status === 'inflight') {
          r.status = 'pending';
          r.batchId = null;
        }
      }
      this.batches.delete(id);
    }
  }

  closeSession(sessionId: string): Promise<void> {
    return this.tx(() => {
      const s = this.sessions.get(sessionId);
      if (s) s.closed = true;
    });
  }

  recordDecline(): Promise<void> {
    return this.tx(() => {
      this.declined += 1;
    });
  }

  purgeAcknowledged(graceMs: number): Promise<number> {
    return this.tx(() => {
      const cutoff = this.nowMs() - graceMs;
      let deleted = 0;
      for (const [sessionId, rows] of this.events) {
        const keep = rows.filter((r) => !(r.status === 'acked' && (r.ackedAt ?? 0) <= cutoff));
        deleted += rows.length - keep.length;
        this.events.set(sessionId, keep);
        const s = this.sessions.get(sessionId);
        if (s?.closed && keep.length === 0) {
          this.sessions.delete(sessionId);
          this.events.delete(sessionId);
        }
      }
      return deleted;
    });
  }

  pendingCount(): Promise<number> {
    return this.tx(() => {
      let n = 0;
      for (const rows of this.events.values())
        for (const r of rows) if (r.status !== 'acked') n += 1;
      return n;
    });
  }

  stats(): Promise<OutboxStats> {
    return this.tx(() => {
      let pending = 0;
      let inflight = 0;
      let acked = 0;
      for (const rows of this.events.values()) {
        for (const r of rows) {
          if (r.status === 'pending') pending += 1;
          else if (r.status === 'inflight') inflight += 1;
          else acked += 1;
        }
      }
      return {
        pendingEvents: pending,
        inflightEvents: inflight,
        acknowledgedEvents: acked,
        sessions: this.sessions.size,
        sessionsAwaitingConsent: [...this.sessions.values()].filter((s) => s.consent === 'pending')
          .length,
        openBatches: this.batches.size,
        declinedCount: this.declined,
        lastAckAt: this.lastAckAt,
      };
    });
  }

  openSessions(): Promise<readonly OpenSessionInfo[]> {
    return this.tx(() =>
      [...this.sessions.values()]
        .filter((s) => !s.closed)
        .sort((a, b) => a.order - b.order)
        .map((s) => ({ sessionId: s.sessionId, consent: s.consent, nextSeq: s.nextSeq })),
    );
  }

  sessionEvents(sessionId: string): Promise<unknown[]> {
    return this.tx(() => (this.events.get(sessionId) ?? []).map((r) => r.event));
  }
}
