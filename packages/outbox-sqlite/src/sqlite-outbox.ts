/**
 * SQLite outbox for the Electron main process (KSK-07). Drop-in for the Dexie outbox: implements the
 * `KioskOutbox` surface used by the kiosk-game logger, crash recovery and uploader.
 *
 * Guarantees:
 * - **WAL + synchronous=FULL**: a committed event survives a crash or power cut; a crash mid-write
 *   loses at most the in-flight event and never corrupts the database.
 * - **Gapless seq**: `seq` comes from `sessions.next_seq` inside the same `BEGIN IMMEDIATE`
 *   transaction that inserts the event row.
 * - **Per-session encryption**: every event payload is stored AES-256-GCM encrypted with the
 *   session DEK; the DEK is kept wrapped with the device KEK and sealed to the backend key (HPKE).
 *   Purging a session deletes its wrapped DEK (crypto-shredding) with `secure_delete` on.
 * - **Consent first**: only sessions whose core `consent.granted` is stored are uploadable; batches are
 *   session-ordered and a session's first chunk contains its consent event. Sessions that end, are
 *   abandoned or go stale without consent are purged and never uploaded.
 * - **Idempotent batches**: a batch keeps its `batch_id` and exact body until the server answers.
 * - **Capacity**: new sessions stop at the quota (policy YAML); data is never silently dropped.
 */
import {
  DecryptionError,
  decryptRecord,
  encryptChunk,
  encryptRecord,
  generateDek,
  type RecipientKeyRing,
  sealDek,
  unwrapDekLocal,
  utf8,
  wipe,
  wrapDekLocal,
} from '@shriii/session-crypto';
import type { OpenDatabase, SqlDatabase, SqlStatement, SqlValue } from './driver.ts';
import { openNodeSqlite } from './driver.ts';
import {
  evaluateHealth,
  HOUR_MS,
  loadOutboxPolicy,
  type OutboxHealth,
  type OutboxPolicy,
} from './policy.ts';
import { migrate } from './schema.ts';
import {
  type ConsentState,
  consentStateOf,
  type EventBuilder,
  envelopeIds,
  type KioskOutboxApi,
  type OpenSessionInfo,
  OutboxFullError,
  type OutboxStats,
  SeqConflictError,
  TERMINAL_STATUSES,
  type UploadBatch,
  type UploadBatchResult,
} from './types.ts';
import { sha256Canonical, utf8Length, uuidv7 } from './util.ts';

export type OutboxEncryption =
  | {
      readonly mode: 'sealed';
      /** 32-byte device key-encryption key (Electron safeStorage / TPM). */
      readonly kek: Uint8Array;
      readonly recipients: RecipientKeyRing;
    }
  | { readonly mode: 'none_dev' };

export interface SqliteOutboxOptions {
  readonly kioskId: string;
  /** Database file path (`:memory:` for tests). */
  readonly path: string;
  readonly encryption: OutboxEncryption;
  readonly policy?: OutboxPolicy;
  readonly open?: OpenDatabase;
  /** Wall-clock ms (ack timestamps, ages, key validity). */
  readonly nowMs?: () => number;
  /** ISO wall time for `UploadBatch.kiosk_t_wall`. */
  readonly wallTime?: () => string;
  readonly newId?: () => string;
  /** Free disk bytes at the database location, or null when unknown. */
  readonly freeDiskBytes?: () => number | null;
}

interface SessionDbRow {
  session_id: string;
  ord: number;
  created_at: number;
  next_seq: number;
  consent: ConsentState;
  closed: number;
  encryption: 'sealed' | 'none_dev';
}

interface EventMetaRow {
  session_id: string;
  seq: number;
  event_type: string;
  bytes: number;
}

interface KeyRow {
  wrapped_dek: Uint8Array;
  sealed_dek: string;
  kid: string;
}

/** Rows chosen for a batch, grouped into contiguous runs per session. */
interface Run {
  readonly sessionId: string;
  readonly rows: EventMetaRow[];
}

export class SqliteOutbox implements KioskOutboxApi {
  readonly kioskId: string;
  readonly journalMode: string;
  private readonly db: SqlDatabase;
  private encryption: OutboxEncryption;
  private readonly policy: OutboxPolicy;
  private readonly nowMs: () => number;
  private readonly wallTime: () => string;
  private readonly newId: () => string;
  private readonly freeDisk: () => number | null;
  private readonly statements = new Map<string, SqlStatement>();
  private readonly dekCache = new Map<string, Uint8Array>();
  private closed = false;

  constructor(options: SqliteOutboxOptions) {
    this.kioskId = options.kioskId;
    this.encryption = options.encryption;
    if (options.encryption.mode === 'sealed' && options.encryption.kek.length !== 32) {
      throw new RangeError('KEK must be 32 bytes');
    }
    this.policy = options.policy ?? loadOutboxPolicy();
    this.nowMs = options.nowMs ?? Date.now;
    this.wallTime = options.wallTime ?? (() => new Date(this.nowMs()).toISOString());
    this.newId = options.newId ?? (() => uuidv7(this.nowMs()));
    this.freeDisk = options.freeDiskBytes ?? (() => null);
    this.db = (options.open ?? openNodeSqlite)(options.path);
    try {
      this.journalMode = migrate(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /* ------------------------------------------------------------------------------------------- *
   * Infrastructure
   * ------------------------------------------------------------------------------------------- */

  private stmt(sql: string): SqlStatement {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private run(sql: string, ...params: SqlValue[]): number {
    return Number(this.stmt(sql).run(...params).changes);
  }

  private get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  /** Run `fn` in one write transaction (BEGIN IMMEDIATE ... COMMIT; ROLLBACK on error). */
  private tx<T>(fn: () => T): T {
    if (this.closed) throw new Error('outbox is closed');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already be gone (e.g. SQLITE_FULL); nothing more to undo.
      }
      throw error;
    }
  }

  private meta(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  private session(sessionId: string): SessionDbRow | undefined {
    return this.get<SessionDbRow>('SELECT * FROM sessions WHERE session_id = ?', sessionId);
  }

  /* ------------------------------------------------------------------------------------------- *
   * Keys
   * ------------------------------------------------------------------------------------------- */

  private sealedConfig(): Extract<OutboxEncryption, { mode: 'sealed' }> {
    if (this.encryption.mode !== 'sealed') throw new Error('outbox is not in sealed mode');
    return this.encryption;
  }

  private dekFor(sessionId: string): Uint8Array {
    const cached = this.dekCache.get(sessionId);
    if (cached) return cached;
    const row = this.get<KeyRow>(
      'SELECT wrapped_dek, sealed_dek, kid FROM session_keys WHERE session_id = ?',
      sessionId,
    );
    if (!row) throw new DecryptionError(`no key for session ${sessionId}`);
    const dek = unwrapDekLocal(this.sealedConfig().kek, sessionId, new Uint8Array(row.wrapped_dek));
    this.dekCache.set(sessionId, dek);
    return dek;
  }

  private forgetDek(sessionId: string): void {
    const dek = this.dekCache.get(sessionId);
    if (dek) wipe(dek);
    this.dekCache.delete(sessionId);
  }

  /** Current sealed DEK for upload, re-sealed to the current backend key if its key was retired. */
  private sealedDekForUpload(sessionId: string): string {
    const cfg = this.sealedConfig();
    const row = this.get<KeyRow>(
      'SELECT wrapped_dek, sealed_dek, kid FROM session_keys WHERE session_id = ?',
      sessionId,
    );
    if (!row) throw new DecryptionError(`no key for session ${sessionId}`);
    const now = this.nowMs();
    if (cfg.recipients.isSealable(row.kid, now)) return row.sealed_dek;
    const recipient = cfg.recipients.current(now);
    const sealed = sealDek({ dek: this.dekFor(sessionId), sessionId, recipient });
    this.run(
      'UPDATE session_keys SET sealed_dek = ?, kid = ?, sealed_at = ? WHERE session_id = ?',
      sealed,
      recipient.kid,
      now,
      sessionId,
    );
    return sealed;
  }

  /** Replace the backend recipient keys (signed policy update). Pending DEKs re-seal lazily. */
  setRecipients(recipients: RecipientKeyRing): void {
    const cfg = this.sealedConfig();
    this.encryption = { ...cfg, recipients };
  }

  /** Re-wrap every stored DEK under a new device KEK in one transaction. */
  rotateKek(newKek: Uint8Array): number {
    if (newKek.length !== 32) throw new RangeError('KEK must be 32 bytes');
    const cfg = this.sealedConfig();
    const count = this.tx(() => {
      const rows = this.all<{ session_id: string; wrapped_dek: Uint8Array }>(
        'SELECT session_id, wrapped_dek FROM session_keys',
      );
      for (const r of rows) {
        const dek = unwrapDekLocal(cfg.kek, r.session_id, new Uint8Array(r.wrapped_dek));
        this.run(
          'UPDATE session_keys SET wrapped_dek = ? WHERE session_id = ?',
          wrapDekLocal(newKek, r.session_id, dek),
          r.session_id,
        );
        wipe(dek);
      }
      return rows.length;
    });
    this.encryption = { ...cfg, kek: newKek };
    return count;
  }

  /* ------------------------------------------------------------------------------------------- *
   * Append
   * ------------------------------------------------------------------------------------------- */

  private createSession(sessionId: string): SessionDbRow {
    const health = this.healthSync();
    if (!health.canStartSession) {
      throw new OutboxFullError(health.alerts.join(',') || 'capacity');
    }
    const ord = Number(this.meta('session_order') ?? '0');
    this.setMeta('session_order', String(ord + 1));
    const now = this.nowMs();
    const mode = this.encryption.mode;
    this.run(
      'INSERT INTO sessions (session_id, ord, created_at, encryption) VALUES (?, ?, ?, ?)',
      sessionId,
      ord,
      now,
      mode,
    );
    if (this.encryption.mode === 'sealed') {
      const recipient = this.encryption.recipients.current(now);
      const dek = generateDek();
      this.run(
        'INSERT INTO session_keys (session_id, wrapped_dek, sealed_dek, kid, sealed_at) VALUES (?, ?, ?, ?, ?)',
        sessionId,
        wrapDekLocal(this.encryption.kek, sessionId, dek),
        sealDek({ dek, sessionId, recipient }),
        recipient.kid,
        now,
      );
      this.dekCache.set(sessionId, dek);
    }
    return {
      session_id: sessionId,
      ord,
      created_at: now,
      next_seq: 0,
      consent: 'pending',
      closed: 0,
      encryption: mode,
    };
  }

  private insertEvent(s: SessionDbRow, seq: number, event: unknown): void {
    const json = JSON.stringify(event);
    if (json === undefined) throw new TypeError('event is not JSON-serialisable');
    const { eventId, eventType } = envelopeIds(event);
    const payload =
      s.encryption === 'sealed'
        ? encryptRecord(this.dekFor(s.session_id), s.session_id, seq, json)
        : utf8(json);
    const now = this.nowMs();
    this.run(
      `INSERT INTO events (session_id, seq, event_id, event_type, payload, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      s.session_id,
      seq,
      eventId,
      eventType,
      payload,
      utf8Length(json),
      now,
    );
    const consent = consentStateOf(event);
    this.run(
      'UPDATE sessions SET next_seq = ?, consent = COALESCE(?, consent) WHERE session_id = ?',
      seq + 1,
      consent,
      s.session_id,
    );
    const e = event as { event_type?: unknown; payload?: { consent_kind?: unknown } | null };
    const kind = e.payload?.consent_kind;
    if (typeof kind === 'string' && typeof e.event_type === 'string') {
      const state = e.event_type.split('.')[1];
      if (state === 'granted' || state === 'declined' || state === 'withdrawn') {
        this.run(
          'INSERT INTO consents (session_id, seq, kind, state, recorded_at) VALUES (?, ?, ?, ?, ?)',
          s.session_id,
          seq,
          kind,
          state,
          now,
        );
      }
    }
  }

  /** Append with a seq-aware builder (the kiosk-game logger contract). */
  appendSync(sessionId: string, build: (seq: number) => unknown): number {
    return this.tx(() => {
      const s = this.session(sessionId) ?? this.createSession(sessionId);
      const seq = s.next_seq;
      this.insertEvent(s, seq, build(seq));
      return seq;
    });
  }

  /**
   * Append an event built by a remote caller for `expectedSeq` (IPC from the renderer). Throws
   * {@link SeqConflictError} unless `expectedSeq` is exactly the session's next gapless seq.
   */
  appendAtSync(sessionId: string, expectedSeq: number, event: unknown): number {
    return this.tx(() => {
      const s = this.session(sessionId) ?? this.createSession(sessionId);
      if (s.next_seq !== expectedSeq) throw new SeqConflictError(sessionId, s.next_seq, expectedSeq);
      this.insertEvent(s, expectedSeq, event);
      return expectedSeq;
    });
  }

  async append(sessionId: string, build: (seq: number) => unknown): Promise<number> {
    return this.appendSync(sessionId, build);
  }

  async appendAt(sessionId: string, expectedSeq: number, event: unknown): Promise<number> {
    return this.appendAtSync(sessionId, expectedSeq, event);
  }

  async nextSeq(sessionId: string): Promise<number> {
    return this.session(sessionId)?.next_seq ?? 0;
  }

  async setConsent(sessionId: string, state: ConsentState): Promise<void> {
    this.tx(() => {
      if (!this.session(sessionId)) this.createSession(sessionId);
      this.run('UPDATE sessions SET consent = ? WHERE session_id = ?', state, sessionId);
    });
  }

  /* ------------------------------------------------------------------------------------------- *
   * Batches
   * ------------------------------------------------------------------------------------------- */

  private selectRuns(): Run[] {
    const { maxEventsPerBatch: maxEvents, maxBatchBytes: maxBytes } = this.policy.upload;
    const sessions = this.all<{ session_id: string }>(
      "SELECT session_id FROM sessions WHERE consent = 'granted' ORDER BY ord",
    );
    const picked: EventMetaRow[] = [];
    let bytes = 0;
    outer: for (const { session_id } of sessions) {
      const rows = this.all<EventMetaRow>(
        `SELECT session_id, seq, event_type, bytes FROM events
         WHERE session_id = ? AND status = 'pending' ORDER BY seq LIMIT ?`,
        session_id,
        maxEvents - picked.length,
      );
      if (rows.length === 0) continue;
      // Consent first: the session's first upload must reach its unacknowledged consent event.
      const consent = this.get<{ seq: number; status: string }>(
        `SELECT c.seq AS seq, e.status AS status FROM consents c
         JOIN events e ON e.session_id = c.session_id AND e.seq = c.seq
         WHERE c.session_id = ? AND c.kind = 'core' AND c.state = 'granted'
         ORDER BY c.seq LIMIT 1`,
        session_id,
      );
      if (consent && consent.status === 'pending' && picked.length > 0) {
        const prefix = rows.filter((r) => r.seq <= consent.seq);
        const prefixBytes = prefix.reduce((n, r) => n + r.bytes, 0);
        const reachesConsent = prefix.some((r) => r.seq === consent.seq);
        if (!reachesConsent || bytes + prefixBytes > maxBytes) break;
      }
      for (const row of rows) {
        if (picked.length >= maxEvents) break outer;
        if (picked.length > 0 && bytes + row.bytes > maxBytes) break outer;
        picked.push(row);
        bytes += row.bytes;
      }
    }
    const runs: Run[] = [];
    for (const row of picked) {
      const last = runs.at(-1);
      const prev = last?.rows.at(-1);
      if (last && prev && last.sessionId === row.session_id && prev.seq + 1 === row.seq) {
        last.rows.push(row);
      } else {
        runs.push({ sessionId: row.session_id, rows: [row] });
      }
    }
    return runs;
  }

  private decodePayload(s: { session_id: string; encryption: string }, seq: number, payload: Uint8Array): string {
    return s.encryption === 'sealed'
      ? decryptRecord(this.dekFor(s.session_id), s.session_id, seq, payload)
      : new TextDecoder().decode(payload);
  }

  private runEvents(run: Run, s: SessionDbRow): unknown[] {
    const first = run.rows[0]?.seq ?? 0;
    const last = run.rows.at(-1)?.seq ?? 0;
    const rows = this.all<{ seq: number; payload: Uint8Array }>(
      'SELECT seq, payload FROM events WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq',
      run.sessionId,
      first,
      last,
    );
    return rows.map((r) => JSON.parse(this.decodePayload(s, r.seq, new Uint8Array(r.payload))) as unknown);
  }

  nextBatchSync(): UploadBatch | null {
    return this.tx(() => {
      const open = this.get<{ body: string }>(
        'SELECT body FROM batches ORDER BY created_at, batch_id LIMIT 1',
      );
      if (open) return JSON.parse(open.body) as UploadBatch;
      const runs = this.selectRuns();
      if (runs.length === 0) return null;
      const chunks: Record<string, unknown>[] = [];
      let eventCount = 0;
      for (const run of runs) {
        const s = this.session(run.sessionId);
        if (!s) continue;
        const events = this.runEvents(run, s);
        const firstSeq = run.rows[0]?.seq ?? 0;
        const lastSeq = run.rows.at(-1)?.seq ?? 0;
        eventCount += events.length;
        if (s.encryption === 'sealed') {
          const header = { sessionId: s.session_id, firstSeq, lastSeq, eventCount: events.length };
          const body = encryptChunk(this.dekFor(s.session_id), header, events);
          chunks.push({
            encryption: 'x25519_sealed_aes256gcm',
            session_id: s.session_id,
            sealed_dek: this.sealedDekForUpload(s.session_id),
            nonce: body.nonce,
            ciphertext: body.ciphertext,
            first_seq: firstSeq,
            last_seq: lastSeq,
            event_count: events.length,
          });
        } else {
          chunks.push({
            encryption: 'none_dev',
            session_id: s.session_id,
            first_seq: firstSeq,
            last_seq: lastSeq,
            event_count: events.length,
            events,
          });
        }
      }
      const batchId = this.newId();
      const batch = {
        schema_version: '1.0',
        batch_id: batchId,
        kiosk_id: this.kioskId,
        kiosk_t_wall: this.wallTime(),
        sha256: sha256Canonical(chunks),
        event_count: eventCount,
        session_chunks: chunks,
      } as unknown as UploadBatch;
      this.run(
        'INSERT INTO batches (batch_id, created_at, body) VALUES (?, ?, ?)',
        batchId,
        this.nowMs(),
        JSON.stringify(batch),
      );
      for (const run of runs) {
        this.run(
          `UPDATE events SET status = 'inflight', batch_id = ?
           WHERE session_id = ? AND seq BETWEEN ? AND ? AND status = 'pending'`,
          batchId,
          run.sessionId,
          run.rows[0]?.seq ?? 0,
          run.rows.at(-1)?.seq ?? 0,
        );
      }
      return batch;
    });
  }

  async nextBatch(): Promise<UploadBatch | null> {
    return this.nextBatchSync();
  }

  applyResultSync(result: UploadBatchResult): void {
    this.tx(() => {
      if (!this.get('SELECT 1 FROM batches WHERE batch_id = ?', result.batch_id)) return;
      const statuses = new Map(result.results.map((r) => [`${r.session_id}#${r.seq}`, r.status]));
      const wholeDuplicate = result.duplicate_batch && result.results.length === 0;
      const rows = this.all<{ session_id: string; seq: number }>(
        'SELECT session_id, seq FROM events WHERE batch_id = ?',
        result.batch_id,
      );
      const now = this.nowMs();
      let acked = 0;
      for (const r of rows) {
        const status = statuses.get(`${r.session_id}#${r.seq}`) ?? (wholeDuplicate ? 'duplicate' : undefined);
        if (status !== undefined && TERMINAL_STATUSES.has(status)) {
          this.run(
            `UPDATE events SET status = 'acked', ack_status = ?, acked_at = ?, batch_id = NULL
             WHERE session_id = ? AND seq = ?`,
            status,
            now,
            r.session_id,
            r.seq,
          );
          acked += 1;
        } else {
          this.run(
            "UPDATE events SET status = 'pending', batch_id = NULL WHERE session_id = ? AND seq = ?",
            r.session_id,
            r.seq,
          );
        }
      }
      if (acked > 0) this.setMeta('last_ack_at', String(now));
      this.run('DELETE FROM batches WHERE batch_id = ?', result.batch_id);
    });
  }

  async applyResult(result: UploadBatchResult): Promise<void> {
    this.applyResultSync(result);
  }

  async markBatchFailed(batchId: string): Promise<void> {
    this.tx(() => {
      this.run(
        'UPDATE batches SET attempts = attempts + 1, last_attempt_at = ? WHERE batch_id = ?',
        this.nowMs(),
        batchId,
      );
    });
  }

  /* ------------------------------------------------------------------------------------------- *
   * Purge and lifecycle
   * ------------------------------------------------------------------------------------------- */

  /** Dissolve open batches containing a session; other sessions' rows return to pending. */
  private dissolveBatchesOf(sessionId: string): void {
    const ids = this.all<{ batch_id: string }>(
      'SELECT DISTINCT batch_id FROM events WHERE session_id = ? AND batch_id IS NOT NULL',
      sessionId,
    );
    for (const { batch_id } of ids) {
      this.run(
        "UPDATE events SET status = 'pending', batch_id = NULL WHERE batch_id = ?",
        batch_id,
      );
      this.run('DELETE FROM batches WHERE batch_id = ?', batch_id);
    }
  }

  private purgeSessionInTx(sessionId: string, tombstone?: EventBuilder): void {
    const s = this.session(sessionId);
    if (!s) return;
    this.dissolveBatchesOf(sessionId);
    this.run('DELETE FROM events WHERE session_id = ?', sessionId);
    this.run('DELETE FROM consents WHERE session_id = ?', sessionId);
    if (tombstone && s.consent === 'granted') {
      const seq = s.next_seq;
      this.insertEvent(s, seq, tombstone(seq));
      this.run('UPDATE sessions SET closed = 1, closed_at = ? WHERE session_id = ?', this.nowMs(), sessionId);
      return;
    }
    // Nothing of this session was ever uploadable (or the caller wants no trace): crypto-shred.
    this.run('DELETE FROM sessions WHERE session_id = ?', sessionId);
    this.forgetDek(sessionId);
  }

  async purgeSession(sessionId: string, tombstone?: EventBuilder): Promise<void> {
    this.tx(() => this.purgeSessionInTx(sessionId, tombstone));
  }

  /**
   * Close a session. A session without granted core consent (declined, walked away or abandoned
   * before consent) is purged entirely; a consented session keeps its events for upload.
   */
  async closeSession(sessionId: string): Promise<void> {
    this.tx(() => {
      const s = this.session(sessionId);
      if (!s) return;
      if (s.consent !== 'granted') {
        this.purgeSessionInTx(sessionId);
        return;
      }
      this.run(
        'UPDATE sessions SET closed = 1, closed_at = COALESCE(closed_at, ?) WHERE session_id = ?',
        this.nowMs(),
        sessionId,
      );
    });
    this.forgetDek(sessionId);
  }

  async recordDecline(): Promise<void> {
    this.tx(() => this.setMeta('declined_count', String(Number(this.meta('declined_count') ?? '0') + 1)));
  }

  /** Delete acknowledged rows older than the grace period and finished sessions with no rows. */
  purgeAcknowledgedSync(graceMs: number = this.policy.upload.ackGraceHours * HOUR_MS): number {
    return this.tx(() => {
      const cutoff = this.nowMs() - graceMs;
      const deleted = this.run(
        "DELETE FROM events WHERE status = 'acked' AND acked_at <= ?",
        cutoff,
      );
      const empty = this.all<{ session_id: string }>(
        `SELECT s.session_id FROM sessions s WHERE s.closed = 1
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.session_id)`,
      );
      for (const { session_id } of empty) {
        this.run('DELETE FROM sessions WHERE session_id = ?', session_id);
        this.forgetDek(session_id);
      }
      return deleted;
    });
  }

  async purgeAcknowledged(graceMs: number): Promise<number> {
    return this.purgeAcknowledgedSync(graceMs);
  }

  /** Purge sessions that never reached consent within the retention window (stale / abandoned). */
  purgeStaleUnconsentedSync(): string[] {
    return this.tx(() => {
      const cutoff = this.nowMs() - this.policy.retention.unconsentedMaxAgeHours * HOUR_MS;
      const stale = this.all<{ session_id: string }>(
        "SELECT session_id FROM sessions WHERE consent != 'granted' AND created_at <= ?",
        cutoff,
      );
      for (const { session_id } of stale) this.purgeSessionInTx(session_id);
      return stale.map((r) => r.session_id);
    });
  }

  /** Periodic maintenance: stale unconsented purge, acknowledged purge, WAL checkpoint. */
  maintenance(): { purgedSessions: string[]; purgedRows: number } {
    const purgedSessions = this.purgeStaleUnconsentedSync();
    const purgedRows = this.purgeAcknowledgedSync();
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    return { purgedSessions, purgedRows };
  }

  /* ------------------------------------------------------------------------------------------- *
   * Queries
   * ------------------------------------------------------------------------------------------- */

  async pendingCount(): Promise<number> {
    return (
      this.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE status IN ('pending', 'inflight')")
        ?.n ?? 0
    );
  }

  async stats(): Promise<OutboxStats> {
    const count = (sql: string): number => this.get<{ n: number }>(sql)?.n ?? 0;
    const lastAck = this.meta('last_ack_at');
    return {
      pendingEvents: count("SELECT COUNT(*) AS n FROM events WHERE status = 'pending'"),
      inflightEvents: count("SELECT COUNT(*) AS n FROM events WHERE status = 'inflight'"),
      acknowledgedEvents: count("SELECT COUNT(*) AS n FROM events WHERE status = 'acked'"),
      sessions: count('SELECT COUNT(*) AS n FROM sessions'),
      sessionsAwaitingConsent: count("SELECT COUNT(*) AS n FROM sessions WHERE consent = 'pending'"),
      openBatches: count('SELECT COUNT(*) AS n FROM batches'),
      declinedCount: Number(this.meta('declined_count') ?? '0'),
      lastAckAt: lastAck === undefined ? null : Number(lastAck),
    };
  }

  async openSessions(): Promise<readonly OpenSessionInfo[]> {
    return this.all<{ session_id: string; consent: ConsentState; next_seq: number }>(
      'SELECT session_id, consent, next_seq FROM sessions WHERE closed = 0 ORDER BY ord',
    ).map((r) => ({ sessionId: r.session_id, consent: r.consent, nextSeq: r.next_seq }));
  }

  async sessionEvents(sessionId: string): Promise<unknown[]> {
    const s = this.session(sessionId);
    if (!s) return [];
    return this.all<{ seq: number; payload: Uint8Array }>(
      'SELECT seq, payload FROM events WHERE session_id = ? ORDER BY seq',
      sessionId,
    ).map((r) => JSON.parse(this.decodePayload(s, r.seq, new Uint8Array(r.payload))) as unknown);
  }

  /** Capacity / sync health for the heartbeat and the attract-screen start gate. */
  healthSync(): OutboxHealth {
    const stored = this.get<{ bytes: number | null; n: number }>(
      'SELECT SUM(bytes) AS bytes, COUNT(*) AS n FROM events',
    );
    const unsynced = this.get<{ n: number; sessions: number; oldest: number | null }>(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT e.session_id) AS sessions, MIN(e.created_at) AS oldest
       FROM events e JOIN sessions s ON s.session_id = e.session_id
       WHERE e.status != 'acked' AND s.consent = 'granted'`,
    );
    let hasRecipientKey = true;
    if (this.encryption.mode === 'sealed') {
      try {
        this.encryption.recipients.current(this.nowMs());
      } catch {
        hasRecipientKey = false;
      }
    }
    return evaluateHealth(
      this.policy,
      {
        storedBytes: stored?.bytes ?? 0,
        storedSessions: this.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n ?? 0,
        unsyncedEvents: unsynced?.n ?? 0,
        unsyncedSessions: unsynced?.sessions ?? 0,
        oldestUnsyncedAt: unsynced?.oldest ?? null,
        freeDiskBytes: this.freeDisk(),
        hasRecipientKey,
      },
      this.nowMs(),
    );
  }

  async health(): Promise<OutboxHealth> {
    return this.healthSync();
  }

  canStartSession(): boolean {
    return this.healthSync().canStartSession;
  }

  /** `PRAGMA integrity_check` plus seq invariants; returns problems (empty when healthy). */
  integrityCheck(): string[] {
    const problems: string[] = [];
    const rows = this.all<{ integrity_check: string }>('PRAGMA integrity_check');
    for (const r of rows) if (r.integrity_check !== 'ok') problems.push(r.integrity_check);
    const fk = this.all<Record<string, unknown>>('PRAGMA foreign_key_check');
    if (fk.length > 0) problems.push(`foreign_key_check: ${fk.length} violations`);
    const bad = this.all<{ session_id: string }>(
      `SELECT s.session_id FROM sessions s JOIN events e ON e.session_id = s.session_id
       GROUP BY s.session_id HAVING MAX(e.seq) >= MAX(s.next_seq)`,
    );
    for (const b of bad) problems.push(`seq beyond next_seq in ${b.session_id}`);
    return problems;
  }

  /** Truncate the WAL into the main file (before an app update or controlled shutdown). */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    if (this.closed) return;
    for (const id of [...this.dekCache.keys()]) this.forgetDek(id);
    this.statements.clear();
    this.db.close();
    this.closed = true;
  }
}
