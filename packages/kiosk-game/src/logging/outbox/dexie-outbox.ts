/**
 * IndexedDB (Dexie) {@link KioskOutbox} for the browser build (KSK-07; SQLite adapter later in
 * Electron behind the same interface). Every mutation runs in one readwrite transaction, so `seq`
 * allocation and the event row commit atomically; concurrent appends are serialised by IndexedDB.
 * Data survives reloads, app updates and offline periods.
 */
import type { UploadBatch, UploadBatchResult } from '@shriii/contracts';
import { Dexie, type Table } from 'dexie';
import { utf8Length } from '../hash.ts';
import { uuidv7 } from '../uuid.ts';
import { assembleBatch, selectBatchRows } from './batch.ts';
import type { OutboxOptions } from './memory-outbox.ts';
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
} from './types.ts';

interface MetaRow {
  readonly key: string;
  value: number;
}

/** Dexie schema (version 1). */
class OutboxDatabase extends Dexie {
  sessions!: Table<SessionRow, string>;
  events!: Table<EventRow, [string, number]>;
  batches!: Table<BatchRow, string>;
  meta!: Table<MetaRow, string>;

  constructor(name: string, indexedDB?: IDBFactory, keyRange?: typeof IDBKeyRange) {
    super(name, indexedDB && keyRange ? { indexedDB, IDBKeyRange: keyRange } : undefined);
    this.version(1).stores({
      sessions: 'sessionId, order, consent',
      events: '[sessionId+seq], sessionId, eventId, status, batchId',
      batches: 'batchId, createdAt',
      meta: 'key',
    });
  }
}

export interface DexieOutboxOptions extends OutboxOptions {
  /** IndexedDB database name (default `shriii-outbox`). */
  readonly dbName?: string;
  /** Injected IndexedDB implementation (tests: fake-indexeddb). */
  readonly indexedDB?: IDBFactory;
  readonly IDBKeyRange?: typeof IDBKeyRange;
}

export class DexieOutbox implements KioskOutbox {
  readonly kioskId: string;
  private readonly db: OutboxDatabase;
  private readonly wallTime: () => string;
  private readonly nowMs: () => number;
  private readonly limits: BatchLimits;
  private readonly newId: () => string;

  constructor(options: DexieOutboxOptions) {
    this.kioskId = options.kioskId;
    this.db = new OutboxDatabase(
      options.dbName ?? 'shriii-outbox',
      options.indexedDB,
      options.IDBKeyRange,
    );
    this.wallTime = options.wallTime ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? Date.now;
    this.limits = options.limits ?? DEFAULT_BATCH_LIMITS;
    this.newId = options.newId ?? uuidv7;
  }

  /** Open eagerly (surfaces quota/blocked errors at startup rather than mid-session). */
  async open(): Promise<void> {
    await this.db.open();
  }

  close(): void {
    this.db.close();
  }

  /** Delete the whole database (tests and factory reset). */
  async destroy(): Promise<void> {
    await this.db.delete();
  }

  private async ensureSession(sessionId: string): Promise<SessionRow> {
    const existing = await this.db.sessions.get(sessionId);
    if (existing) return existing;
    const counter = (await this.db.meta.get('session_order'))?.value ?? 0;
    await this.db.meta.put({ key: 'session_order', value: counter + 1 });
    const row: SessionRow = {
      sessionId,
      nextSeq: 0,
      consent: 'pending',
      order: counter,
      closed: false,
    };
    await this.db.sessions.add(row);
    return row;
  }

  private makeRow(sessionId: string, seq: number, event: unknown): EventRow {
    const json = JSON.stringify(event);
    const { eventId, eventType } = envelopeIds(event);
    return {
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
  }

  append(sessionId: string, build: (seq: number) => unknown): Promise<number> {
    return this.db.transaction('rw', this.db.sessions, this.db.events, this.db.meta, async () => {
      const s = await this.ensureSession(sessionId);
      const seq = s.nextSeq;
      const event = build(seq);
      await this.db.events.add(this.makeRow(sessionId, seq, event));
      const consent = consentStateOf(event);
      await this.db.sessions.update(sessionId, {
        nextSeq: seq + 1,
        ...(consent ? { consent } : {}),
      });
      return seq;
    });
  }

  async nextSeq(sessionId: string): Promise<number> {
    return (await this.db.sessions.get(sessionId))?.nextSeq ?? 0;
  }

  setConsent(sessionId: string, state: ConsentState): Promise<void> {
    return this.db.transaction('rw', this.db.sessions, this.db.meta, async () => {
      await this.ensureSession(sessionId);
      await this.db.sessions.update(sessionId, { consent: state });
    });
  }

  nextBatch(): Promise<UploadBatch | null> {
    return this.db.transaction(
      'rw',
      this.db.sessions,
      this.db.events,
      this.db.batches,
      async () => {
        const open = await this.db.batches.orderBy('createdAt').first();
        if (open) return open.batch;
        const sessions = (await this.db.sessions.orderBy('order').toArray()).filter(
          (s) => s.consent === 'granted',
        );
        const ordered: { rows: EventRow[] }[] = [];
        let budget = this.limits.maxEvents;
        for (const s of sessions) {
          if (budget <= 0) break;
          const rows = (
            await this.db.events
              .where('[sessionId+seq]')
              .between([s.sessionId, Dexie.minKey], [s.sessionId, Dexie.maxKey])
              .toArray()
          ).filter((r) => r.status === 'pending');
          ordered.push({ rows });
          budget -= rows.length;
        }
        const rows = selectBatchRows(ordered, this.limits);
        if (rows.length === 0) return null;
        const batchId = this.newId();
        const batch = assembleBatch({
          batchId,
          kioskId: this.kioskId,
          kioskTWall: this.wallTime(),
          rows,
        });
        await this.db.events.bulkPut(
          rows.map((r) => ({ ...r, status: 'inflight' as const, batchId })),
        );
        await this.db.batches.add({
          batchId,
          createdAt: this.nowMs(),
          batch,
          keys: rows.map((r) => [r.sessionId, r.seq] as const),
          attempts: 0,
        });
        return batch;
      },
    );
  }

  applyResult(result: UploadBatchResult): Promise<void> {
    return this.db.transaction('rw', this.db.events, this.db.batches, this.db.meta, async () => {
      const batch = await this.db.batches.get(result.batch_id);
      if (!batch) return;
      const { acked, retry } = planResult(batch, result);
      const now = this.nowMs();
      const keys = batch.keys.map(([sid, seq]) => [sid, seq] as [string, number]);
      const rows = await this.db.events.bulkGet(keys);
      const updated: EventRow[] = [];
      for (const row of rows) {
        if (!row) continue;
        const key = `${row.sessionId}#${row.seq}`;
        const status = acked.get(key);
        if (status !== undefined)
          updated.push({ ...row, status: 'acked', ackStatus: status, ackedAt: now, batchId: null });
        else if (retry.has(key)) updated.push({ ...row, status: 'pending', batchId: null });
      }
      await this.db.events.bulkPut(updated);
      if (acked.size > 0) await this.db.meta.put({ key: 'last_ack_at', value: now });
      await this.db.batches.delete(result.batch_id);
    });
  }

  markBatchFailed(batchId: string): Promise<void> {
    return this.db.transaction('rw', this.db.batches, async () => {
      const b = await this.db.batches.get(batchId);
      if (b) await this.db.batches.update(batchId, { attempts: b.attempts + 1 });
    });
  }

  purgeSession(sessionId: string, tombstone?: EventBuilder): Promise<void> {
    return this.db.transaction(
      'rw',
      this.db.sessions,
      this.db.events,
      this.db.batches,
      async () => {
        // Open batches containing this session are dissolved; other sessions' rows go back to pending.
        for (const b of await this.db.batches.toArray()) {
          if (!b.keys.some(([sid]) => sid === sessionId)) continue;
          for (const [sid, seq] of b.keys) {
            if (sid !== sessionId)
              await this.db.events.update([sid, seq], { status: 'pending', batchId: null });
          }
          await this.db.batches.delete(b.batchId);
        }
        await this.db.events.where('sessionId').equals(sessionId).delete();
        const s = await this.db.sessions.get(sessionId);
        if (!s) return;
        if (!tombstone) {
          await this.db.sessions.delete(sessionId);
          return;
        }
        const seq = s.nextSeq;
        await this.db.events.add(this.makeRow(sessionId, seq, tombstone(seq)));
        await this.db.sessions.update(sessionId, { nextSeq: seq + 1, closed: true });
      },
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.db.sessions.update(sessionId, { closed: true });
  }

  recordDecline(): Promise<void> {
    return this.db.transaction('rw', this.db.meta, async () => {
      const n = (await this.db.meta.get('declined_count'))?.value ?? 0;
      await this.db.meta.put({ key: 'declined_count', value: n + 1 });
    });
  }

  purgeAcknowledged(graceMs: number): Promise<number> {
    return this.db.transaction('rw', this.db.sessions, this.db.events, async () => {
      const cutoff = this.nowMs() - graceMs;
      const stale = await this.db.events
        .where('status')
        .equals('acked')
        .filter((r) => (r.ackedAt ?? 0) <= cutoff)
        .primaryKeys();
      await this.db.events.bulkDelete(stale);
      for (const s of await this.db.sessions.toArray()) {
        if (!s.closed) continue;
        const left = await this.db.events.where('sessionId').equals(s.sessionId).count();
        if (left === 0) await this.db.sessions.delete(s.sessionId);
      }
      return stale.length;
    });
  }

  async pendingCount(): Promise<number> {
    return this.db.events.where('status').anyOf('pending', 'inflight').count();
  }

  async stats(): Promise<OutboxStats> {
    return this.db.transaction(
      'r',
      this.db.sessions,
      this.db.events,
      this.db.batches,
      this.db.meta,
      async () => {
        const [pending, inflight, acked, sessions, awaiting, openBatches, declined, lastAck] =
          await Promise.all([
            this.db.events.where('status').equals('pending').count(),
            this.db.events.where('status').equals('inflight').count(),
            this.db.events.where('status').equals('acked').count(),
            this.db.sessions.count(),
            this.db.sessions.where('consent').equals('pending').count(),
            this.db.batches.count(),
            this.db.meta.get('declined_count'),
            this.db.meta.get('last_ack_at'),
          ]);
        return {
          pendingEvents: pending,
          inflightEvents: inflight,
          acknowledgedEvents: acked,
          sessions,
          sessionsAwaitingConsent: awaiting,
          openBatches,
          declinedCount: declined?.value ?? 0,
          lastAckAt: lastAck?.value ?? null,
        };
      },
    );
  }

  async openSessions(): Promise<readonly OpenSessionInfo[]> {
    const rows = await this.db.sessions.orderBy('order').toArray();
    return rows
      .filter((s) => !s.closed)
      .map((s) => ({ sessionId: s.sessionId, consent: s.consent, nextSeq: s.nextSeq }));
  }

  async sessionEvents(sessionId: string): Promise<unknown[]> {
    const rows = await this.db.events
      .where('[sessionId+seq]')
      .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey])
      .toArray();
    return rows.map((r) => r.event);
  }
}
