import { join } from 'node:path';
import type { UploadBatchResult } from '@shriii/contracts';
import { validateUploadBatch } from '@shriii/contracts/validators/upload-batch';
import {
  DecryptionError,
  decryptChunk,
  generateKek,
  generateRecipientKeyPair,
  openDek,
  parseSealedDek,
  RecipientKeyRing,
} from '@shriii/session-crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeSqlite } from '../src/driver.ts';
import { DAY_MS, HOUR_MS, loadOutboxPolicy, quotaBytes } from '../src/policy.ts';
import { SqliteOutbox } from '../src/sqlite-outbox.ts';
import { OutboxFullError, SeqConflictError, type UploadBatch } from '../src/types.ts';
import { sha256Canonical } from '../src/util.ts';
import {
  appendMany,
  consentDeclined,
  consentedSession,
  consentGranted,
  ev,
  harness,
  policyWith,
  T0,
  tempDir,
  uuidv7,
} from './helpers.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function setup(extra: Parameters<ReturnType<typeof harness>['open']>[1] = {}) {
  const h = harness();
  const t = tempDir();
  const path = join(t.dir, 'outbox.db');
  const outbox = h.open(path, extra);
  cleanups.push(() => {
    outbox.close();
    t.cleanup();
  });
  return { h, outbox, path, dir: t.dir };
}

type EncryptedChunk = {
  encryption: string;
  session_id: string;
  sealed_dek: string;
  nonce: string;
  ciphertext: string;
  first_seq: number;
  last_seq: number;
  event_count: number;
};

function decryptBatch(batch: UploadBatch, keys: (kid: string) => Uint8Array | undefined) {
  return (batch.session_chunks as unknown as EncryptedChunk[]).map((c) => {
    const dek = openDek({ sealed: c.sealed_dek, sessionId: c.session_id, privateKeys: keys });
    return decryptChunk(
      dek,
      {
        sessionId: c.session_id,
        firstSeq: c.first_seq,
        lastSeq: c.last_seq,
        eventCount: c.event_count,
      },
      c,
    ) as { seq: number; event_type: string; session_id: string }[];
  });
}

function ackAll(
  batch: UploadBatch,
  status: 'accepted' | 'retryable' = 'accepted',
): UploadBatchResult {
  const results = decryptBatchIds(batch).map(({ sessionId, seq }) => ({
    event_id: '01928c6e-7d3a-7b2c-8f00-000000000000',
    session_id: sessionId,
    seq,
    status,
    reason_code: null,
  }));
  return {
    schema_version: '1.0',
    batch_id: batch.batch_id,
    server_received_at: new Date(T0).toISOString(),
    clock_offset_estimate_ms: null,
    duplicate_batch: false,
    results,
    summary: { accepted: 0, duplicate: 0, parked: 0, rejected_terminal: 0, retryable: 0 },
  } as UploadBatchResult;
}

function decryptBatchIds(batch: UploadBatch): { sessionId: string; seq: number }[] {
  const out: { sessionId: string; seq: number }[] = [];
  for (const c of batch.session_chunks as unknown as EncryptedChunk[]) {
    for (let s = c.first_seq; s <= c.last_seq; s += 1)
      out.push({ sessionId: c.session_id, seq: s });
  }
  return out;
}

describe('storage basics', () => {
  it('runs in WAL mode with the schema migrated', () => {
    const { outbox } = setup();
    expect(outbox.journalMode).toBe('wal');
    expect(outbox.integrityCheck()).toEqual([]);
  });

  it('allocates gapless seqs per session and persists across reopen', async () => {
    const { h, outbox, path } = setup();
    const a = uuidv7();
    const b = uuidv7();
    await appendMany(outbox, a, 3);
    await appendMany(outbox, b, 2);
    await appendMany(outbox, a, 2);
    expect(await outbox.nextSeq(a)).toBe(5);
    expect(await outbox.nextSeq(b)).toBe(2);
    expect(await outbox.nextSeq(uuidv7())).toBe(0);
    outbox.close();
    const reopened = h.open(path);
    cleanups.push(() => reopened.close());
    const events = (await reopened.sessionEvents(a)) as { seq: number }[];
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(await reopened.pendingCount()).toBe(7);
  });

  it('encrypts payloads at rest (no plaintext in the database file)', async () => {
    const { outbox, path } = setup();
    const sid = uuidv7();
    await appendMany(outbox, sid, 3, () => ({ marker: 'PLAINTEXT-CANARY-123' }));
    outbox.checkpoint();
    const raw = openNodeSqlite(path);
    const rows = raw.prepare('SELECT payload FROM events').all() as { payload: Uint8Array }[];
    raw.close();
    for (const r of rows) {
      expect(Buffer.from(r.payload).toString('latin1')).not.toContain('PLAINTEXT-CANARY');
    }
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(path).toString('latin1')).not.toContain('PLAINTEXT-CANARY');
  });

  it('refuses to read with the wrong device KEK', async () => {
    const { h, outbox, path } = setup();
    const sid = uuidv7();
    await appendMany(outbox, sid, 1);
    outbox.close();
    const wrong = new SqliteOutbox({
      kioskId: 'kiosk-test',
      path,
      encryption: { mode: 'sealed', kek: generateKek(), recipients: h.ring },
    });
    cleanups.push(() => wrong.close());
    await expect(wrong.sessionEvents(sid)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('appendAt enforces the next gapless seq', async () => {
    const { outbox } = setup();
    const sid = uuidv7();
    expect(await outbox.appendAt(sid, 0, ev(sid, 0))).toBe(0);
    await expect(outbox.appendAt(sid, 2, ev(sid, 2))).rejects.toBeInstanceOf(SeqConflictError);
    await expect(outbox.appendAt(sid, 0, ev(sid, 0))).rejects.toMatchObject({ expected: 1 });
    expect(await outbox.appendAt(sid, 1, ev(sid, 1))).toBe(1);
  });

  it('a throwing builder rolls back without consuming a seq', async () => {
    const { outbox } = setup();
    const sid = uuidv7();
    await appendMany(outbox, sid, 1);
    await expect(
      outbox.append(sid, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await appendMany(outbox, sid, 1);
    expect(((await outbox.sessionEvents(sid)) as { seq: number }[]).map((e) => e.seq)).toEqual([
      0, 1,
    ]);
  });

  it('also runs unencrypted in none_dev mode', async () => {
    const t = tempDir();
    const outbox = new SqliteOutbox({
      kioskId: 'kiosk-dev',
      path: join(t.dir, 'dev.db'),
      encryption: { mode: 'none_dev' },
    });
    cleanups.push(() => {
      outbox.close();
      t.cleanup();
    });
    const sid = await consentedSession(outbox as never, 1);
    const batch = await outbox.nextBatch();
    expect(batch?.session_chunks[0]?.encryption).toBe('none_dev');
    expect(batch?.session_chunks[0]?.session_id).toBe(sid);
  });
});

describe('consent-first upload ordering', () => {
  it('never uploads a session without granted core consent', async () => {
    const { outbox } = setup();
    const sid = uuidv7();
    await appendMany(outbox, sid, 4);
    expect(await outbox.nextBatch()).toBeNull();
    const declined = uuidv7();
    await appendMany(outbox, declined, 1);
    await outbox.append(declined, (s) => consentDeclined(declined, s));
    expect(await outbox.nextBatch()).toBeNull();
  });

  it('uploads sessions in creation order with the consent event in the first chunk', async () => {
    const { h, outbox } = setup();
    const first = await consentedSession(outbox, 3);
    const second = await consentedSession(outbox, 2);
    const batch = await outbox.nextBatch();
    if (!batch) throw new Error('expected a batch');
    expect(validateUploadBatch(batch)).toBe(true);
    expect(batch.event_count).toBe(6 + 5);
    expect(batch.sha256).toBe(sha256Canonical(batch.session_chunks));
    const chunks = decryptBatch(batch, h.privateKeys);
    expect(chunks.map((c) => c[0]?.session_id)).toEqual([first, second]);
    for (const c of chunks) {
      expect(c.map((e) => e.seq)).toEqual(c.map((_, i) => i));
      expect(c.some((e) => e.event_type === 'consent.granted')).toBe(true);
    }
  });

  it('stops a batch before a session whose consent prefix would not fit', async () => {
    const policy = policyWith((p) => {
      (p.upload as Record<string, unknown>).max_events_per_batch = 8;
    });
    const { h, outbox } = setup({ policy });
    const a = await consentedSession(outbox, 3); // 6 events
    const b = await consentedSession(outbox, 3); // consent at seq 2: needs 3 more slots, only 2 left
    const first = await outbox.nextBatch();
    if (!first) throw new Error('batch');
    expect(decryptBatch(first, h.privateKeys).map((c) => c[0]?.session_id)).toEqual([a]);
    await outbox.applyResult(ackAll(first));
    const second = await outbox.nextBatch();
    if (!second) throw new Error('batch');
    const chunks = decryptBatch(second, h.privateKeys);
    expect(chunks[0]?.[0]?.session_id).toBe(b);
    expect(chunks[0]?.some((e) => e.event_type === 'consent.granted')).toBe(true);
  });

  it('respects the byte limit', async () => {
    const policy = policyWith((p) => {
      (p.upload as Record<string, unknown>).max_batch_bytes = 4096;
    });
    const { outbox } = setup({ policy });
    const sid = uuidv7();
    await outbox.append(sid, (s) => consentGranted(sid, s));
    await appendMany(outbox, sid, 30, () => ({ blob: 'x'.repeat(400) }));
    const batch = await outbox.nextBatch();
    expect(batch?.event_count).toBeLessThan(31);
    expect(batch?.event_count).toBeGreaterThan(1);
  });
});

describe('idempotent batches and results', () => {
  it('returns the identical batch until the server answers', async () => {
    const { outbox } = setup();
    await consentedSession(outbox);
    const a = await outbox.nextBatch();
    await outbox.markBatchFailed(a?.batch_id ?? '');
    const b = await outbox.nextBatch();
    expect(b).toEqual(a);
    expect((await outbox.stats()).openBatches).toBe(1);
  });

  it('acks terminal statuses, re-queues retryable rows and splits non-contiguous runs', async () => {
    const { h, outbox } = setup();
    const sid = await consentedSession(outbox, 5); // seq 0..7
    const batch = await outbox.nextBatch();
    if (!batch) throw new Error('batch');
    const result = ackAll(batch);
    // seq 4 and 6 retryable, the rest accepted.
    result.results.forEach((r) => {
      if (r.seq === 4 || r.seq === 6) (r as { status: string }).status = 'retryable';
    });
    await outbox.applyResult(result);
    expect(await outbox.pendingCount()).toBe(2);
    const retry = await outbox.nextBatch();
    if (!retry) throw new Error('retry batch');
    expect(retry.batch_id).not.toBe(batch.batch_id);
    const chunks = decryptBatch(retry, h.privateKeys);
    expect(chunks.map((c) => c.map((e) => e.seq))).toEqual([[4], [6]]);
    expect(chunks.every((c) => c[0]?.session_id === sid)).toBe(true);
    expect(validateUploadBatch(retry)).toBe(true);
  });

  it('treats a duplicate batch answer without per-event results as all duplicate', async () => {
    const { outbox } = setup();
    await consentedSession(outbox, 1);
    const batch = await outbox.nextBatch();
    if (!batch) throw new Error('batch');
    await outbox.applyResult({ ...ackAll(batch), duplicate_batch: true, results: [] });
    expect(await outbox.pendingCount()).toBe(0);
    expect((await outbox.stats()).acknowledgedEvents).toBe(4);
  });

  it('ignores results for unknown batches (late replay)', async () => {
    const { outbox } = setup();
    await consentedSession(outbox, 1);
    const batch = await outbox.nextBatch();
    if (!batch) throw new Error('batch');
    await outbox.applyResult(ackAll(batch));
    await outbox.applyResult(ackAll(batch));
    expect((await outbox.stats()).acknowledgedEvents).toBe(4);
  });

  it('purges acknowledged rows after the grace period and drops finished sessions', async () => {
    const { h, outbox } = setup();
    const sid = await consentedSession(outbox, 1);
    await outbox.closeSession(sid);
    const batch = await outbox.nextBatch();
    if (!batch) throw new Error('batch');
    await outbox.applyResult(ackAll(batch));
    expect(await outbox.purgeAcknowledged(HOUR_MS)).toBe(0);
    h.clock.advance(HOUR_MS);
    expect(await outbox.purgeAcknowledged(HOUR_MS)).toBe(4);
    expect((await outbox.stats()).sessions).toBe(0);
  });
});

describe('purge rules', () => {
  it('closing an unconsented (abandoned / declined) session purges it and its key', async () => {
    const { outbox, path } = setup();
    const sid = uuidv7();
    await appendMany(outbox, sid, 3);
    await outbox.closeSession(sid);
    const declined = uuidv7();
    await outbox.append(declined, (s) => consentDeclined(declined, s));
    await outbox.closeSession(declined);
    await outbox.recordDecline();
    const stats = await outbox.stats();
    expect(stats.sessions).toBe(0);
    expect(stats.pendingEvents).toBe(0);
    expect(stats.declinedCount).toBe(1);
    const raw = openNodeSqlite(path);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM session_keys').get()).toEqual({ n: 0 });
    raw.close();
  });

  it('closing a consented session keeps it for upload', async () => {
    const { outbox } = setup();
    const sid = await consentedSession(outbox, 2);
    await outbox.closeSession(sid);
    expect(await outbox.openSessions()).toEqual([]);
    expect(await outbox.pendingCount()).toBe(5);
  });

  it('withdrawal purges events, dissolves open batches and keeps only a tombstone', async () => {
    const { h, outbox } = setup();
    const a = await consentedSession(outbox, 2);
    const b = await consentedSession(outbox, 2);
    const batch = await outbox.nextBatch();
    expect(batch).not.toBeNull();
    await outbox.purgeSession(a, (seq) => ev(a, seq, 'session_tombstone', { reason: 'withdrawn' }));
    const stats = await outbox.stats();
    expect(stats.openBatches).toBe(0);
    expect(stats.inflightEvents).toBe(0);
    expect((await outbox.sessionEvents(a)) as { seq: number; event_type: string }[]).toMatchObject([
      { seq: 5, event_type: 'session_tombstone' },
    ]);
    const next = await outbox.nextBatch();
    if (!next) throw new Error('batch');
    const chunks = decryptBatch(next, h.privateKeys);
    expect(chunks.map((c) => [c[0]?.session_id, c.length])).toEqual([
      [a, 1],
      [b, 5],
    ]);
  });

  it('purges stale unconsented sessions on maintenance but keeps consented ones', async () => {
    const { h, outbox } = setup();
    const stale = uuidv7();
    await appendMany(outbox, stale, 2);
    const kept = await consentedSession(outbox, 1);
    h.clock.advance(3 * HOUR_MS);
    const { purgedSessions } = outbox.maintenance();
    expect(purgedSessions).toEqual([stale]);
    expect((await outbox.openSessions()).map((s) => s.sessionId)).toEqual([kept]);
  });
});

describe('capacity and sync health', () => {
  it('derives a 30-day quota from the policy YAML', () => {
    const p = loadOutboxPolicy();
    expect(p.capacity.designDays).toBe(30);
    expect(p.alerts.unsyncedAgeDays).toBe(7);
    expect(quotaBytes(p)).toBe(30 * 80 * 600000 * 1.5);
  });

  it('raises the unsynced alert after 7 days and never drops data', async () => {
    const { h, outbox } = setup();
    await consentedSession(outbox, 2);
    expect(outbox.healthSync().alerts).toEqual([]);
    h.clock.advance(7 * DAY_MS - 1);
    expect(outbox.healthSync().alerts).not.toContain('unsynced_age_exceeded');
    h.clock.advance(1);
    const health = outbox.healthSync();
    expect(health.alerts).toContain('unsynced_age_exceeded');
    expect(health.oldestUnsyncedAgeMs).toBe(7 * DAY_MS);
    expect(health.unsyncedEvents).toBe(5);
    expect(health.canStartSession).toBe(true);
  });

  it('stops new sessions at the quota but keeps accepting events for existing ones', async () => {
    const policy = policyWith((p) => {
      (p.capacity as Record<string, unknown>).max_db_bytes = 2000;
    });
    const { outbox } = setup({ policy });
    const sid = uuidv7();
    await appendMany(outbox, sid, 30, () => ({ pad: 'y'.repeat(100) }));
    const health = outbox.healthSync();
    expect(health.alerts).toContain('capacity_full');
    expect(outbox.canStartSession()).toBe(false);
    await expect(outbox.append(uuidv7(), (s) => ev('x', s))).rejects.toBeInstanceOf(
      OutboxFullError,
    );
    await appendMany(outbox, sid, 1);
    expect(await outbox.nextSeq(sid)).toBe(31);
  });

  it('warns before full and stops on low disk', async () => {
    const policy = policyWith((p) => {
      (p.capacity as Record<string, unknown>).max_db_bytes = 10_000;
    });
    let free = 10 * 1024 ** 3;
    const { outbox } = setup({ policy, freeDiskBytes: () => free });
    await appendMany(outbox, uuidv7(), 8, () => ({ pad: 'z'.repeat(1000) }));
    expect(outbox.healthSync().alerts).toEqual(['capacity_warning']);
    free = 100;
    expect(outbox.healthSync().alerts).toContain('disk_low');
    expect(outbox.canStartSession()).toBe(false);
  });
});

describe('key rotation', () => {
  it('re-seals DEKs of unsynced sessions when their backend key is retired', async () => {
    const { h, outbox } = setup();
    const sid = await consentedSession(outbox, 1);
    const next = generateRecipientKeyPair('backend-2');
    const rotateAt = T0 + DAY_MS;
    outbox.setRecipients(
      new RecipientKeyRing([
        {
          kid: 'backend-1',
          publicKey: h.backend.publicKey,
          notBefore: T0 - 1000,
          notAfter: rotateAt,
        },
        {
          kid: 'backend-2',
          publicKey: next.publicKey,
          notBefore: rotateAt - HOUR_MS,
          notAfter: null,
        },
      ]),
    );
    // New sessions use the newest valid key once it is valid.
    h.clock.advance(DAY_MS - HOUR_MS / 2);
    const newer = await consentedSession(outbox, 1);
    h.clock.advance(HOUR_MS);
    const batch = await outbox.nextBatch();
    if (!batch) throw new Error('batch');
    const chunks = batch.session_chunks as unknown as EncryptedChunk[];
    expect(chunks.map((c) => [c.session_id, parseSealedDek(c.sealed_dek).kid])).toEqual([
      [sid, 'backend-2'],
      [newer, 'backend-2'],
    ]);
    const keys = (kid: string) => (kid === 'backend-2' ? next.privateKey : undefined);
    expect(decryptBatch(batch, keys).map((c) => c.length)).toEqual([4, 4]);
  });

  it('re-wraps all DEKs under a new device KEK', async () => {
    const { h, outbox, path } = setup();
    const sid = await consentedSession(outbox, 2);
    const newKek = generateKek();
    expect(outbox.rotateKek(newKek)).toBe(1);
    outbox.close();
    const reopened = new SqliteOutbox({
      kioskId: 'kiosk-test',
      path,
      encryption: { mode: 'sealed', kek: newKek, recipients: h.ring },
      nowMs: h.clock.now,
    });
    cleanups.push(() => reopened.close());
    expect(((await reopened.sessionEvents(sid)) as unknown[]).length).toBe(5);
  });

  it('cannot start sessions without a valid backend key', async () => {
    const { h } = setup();
    const t = tempDir();
    const outbox = h.open(join(t.dir, 'nokey.db'), {
      nowMs: () => T0 - 10_000,
    });
    cleanups.push(() => {
      outbox.close();
      t.cleanup();
    });
    expect(outbox.healthSync().alerts).toContain('no_recipient_key');
    await expect(outbox.append(uuidv7(), (s) => ev('x', s))).rejects.toBeInstanceOf(
      OutboxFullError,
    );
  });
});
