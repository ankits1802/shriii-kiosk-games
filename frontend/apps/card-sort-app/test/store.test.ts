import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  abortAdministration,
  recordTrial,
  resumeAdministration,
  startAdministration,
} from '../src/app/administration.ts';
import { IndexedDbKv } from '../src/data/idb.ts';
import { AppendOnlyViolation, type KvBackend, MemoryKv } from '../src/data/kv.ts';
import { CardSortStore, MAX_PIN_FAILURES } from '../src/data/store.ts';
import { respond } from '../src/domain/engine.ts';
import { START } from './helpers.ts';

const backends: [string, () => KvBackend][] = [
  ['memory', () => new MemoryKv()],
  ['indexeddb', () => new IndexedDbKv(`test-${Math.random()}`)],
];

describe.each(backends)('%s backend', (_name, make) => {
  it('stores, lists by prefix in key order, and keeps append-only tables append-only', async () => {
    const kv = make();
    await kv.open();
    await kv.put('trials', 's1:0002', { i: 2 });
    await kv.put('trials', 's1:0001', { i: 1 });
    await kv.put('trials', 's2:0001', { i: 9 });
    expect(await kv.list('trials', 's1:')).toEqual([{ i: 1 }, { i: 2 }]);
    await expect(kv.put('trials', 's1:0001', { i: 1 })).rejects.toBeInstanceOf(AppendOnlyViolation);
    await kv.put('settings', 'x', 1);
    await kv.put('settings', 'x', 2);
    expect(await kv.get('settings', 'x')).toBe(2);
    expect(await kv.get('settings', 'missing')).toBeUndefined();
  });

  it('keeps a verifiable hash-chained audit trail', async () => {
    const store = new CardSortStore(make());
    await store.init();
    await Promise.all([
      store.audit('a', 'one'),
      store.audit('a', 'two', { n: 2 }),
      store.audit('b', 'three'),
    ]);
    const entries = await store.listAudit();
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
    expect(await store.verifyAudit()).toEqual({ ok: true, brokenAt: null, entries: 3 });
  });
});

describe('tamper detection', () => {
  it('detects an edited audit entry', async () => {
    const kv = new MemoryKv();
    const store = new CardSortStore(kv);
    await store.init();
    await store.audit('a', 'one');
    await store.audit('a', 'two');
    // Bypass the append-only guard to simulate tampering with the underlying table.
    const tables = (kv as unknown as { tables: Map<string, Map<string, string>> }).tables;
    const audit = tables.get('audit') as Map<string, string>;
    const [key, raw] = [...audit.entries()][0] as [string, string];
    audit.set(key, raw.replace('"one"', '"edited"'));
    expect((await store.verifyAudit()).brokenAt).toBe(1);
  });
});

describe('administrator PIN', () => {
  it('verifies, counts failures and locks out', async () => {
    let now = new Date('2026-10-22T10:00:00Z');
    const store = new CardSortStore(new MemoryKv(), () => now);
    await store.init();
    await expect(store.setPin('12')).rejects.toThrow();
    await store.setPin('246810');
    expect(await store.checkPin('246810')).toEqual({ ok: true });
    for (let i = 1; i < MAX_PIN_FAILURES; i++)
      expect((await store.checkPin('000000')).ok).toBe(false);
    const locked = await store.checkPin('000000');
    expect(locked.ok).toBe(false);
    expect(locked.ok === false && locked.lockedUntil).toBeTruthy();
    expect((await store.checkPin('246810')).ok).toBe(false); // still locked out
    now = new Date('2026-10-22T10:02:00Z');
    expect(await store.checkPin('246810')).toEqual({ ok: true });
  });
});

describe('administration lifecycle', () => {
  it('persists every trial and resumes an interrupted administration', async () => {
    const store = new CardSortStore(new MemoryKv());
    await store.init();
    const { session, engine } = await startAdministration(store, START);
    let state = engine;
    for (let i = 0; i < 5; i++) {
      const next = respond(state, 0, 800, new Date().toISOString());
      await recordTrial(store, session, next.trial);
      state = next.state;
    }
    const resumed = await resumeAdministration(store, session.sessionId, 'admin.asha');
    expect(resumed.engine.trials).toHaveLength(5);
    expect(resumed.engine.categoriesCompleted).toBe(state.categoriesCompleted);
    expect(resumed.engine.run).toBe(state.run);

    const aborted = await abortAdministration(
      store,
      session,
      state,
      'participant_withdrew',
      'admin.asha',
    );
    expect(aborted.status).toBe('aborted');
    expect(await store.listOutbox()).toHaveLength(0); // partial administrations are never synced
    const events = (await store.listAudit()).map((e) => e.event);
    expect(events).toEqual(['session_started', 'session_resumed', 'session_aborted']);
  });

  it('rejects an invalid participant code', async () => {
    const store = new CardSortStore(new MemoryKv());
    await store.init();
    await expect(startAdministration(store, { ...START, pid: 'ABCDEF1234' })).rejects.toThrow(
      /Participant code/,
    );
  });
});
