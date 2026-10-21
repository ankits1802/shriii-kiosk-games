import {
  checkSessionSequence,
  type EventEnvelope,
  type UploadBatch,
  type UploadBatchResult,
  validateEvent,
} from '@shriii/contracts';
import { validateUploadBatch } from '@shriii/contracts/validators/upload-batch';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Canonical } from '../hash.ts';
import { DexieOutbox } from '../outbox/dexie-outbox.ts';
import { MemoryOutbox } from '../outbox/memory-outbox.ts';
import type { KioskOutbox } from '../outbox/types.ts';
import { BatchUploader, backoffDelay, DEFAULT_BACKOFF } from '../uploader.ts';
import { uuidv7 } from '../uuid.ts';
import { testLogger } from './helpers.ts';

const opened: DexieOutbox[] = [];
afterEach(async () => {
  for (const o of opened.splice(0)) await o.destroy();
});

const factories: Record<string, () => KioskOutbox> = {
  memory: () => new MemoryOutbox({ kioskId: 'kiosk-test' }),
  dexie: () => {
    const o = new DexieOutbox({
      kioskId: 'kiosk-test',
      dbName: `outbox-${uuidv7()}`,
      indexedDB: new IDBFactory(),
      IDBKeyRange,
    });
    opened.push(o);
    return o;
  },
};

const TASK = {
  episode_id: null,
  module_id: 'dont_tap',
  block_id: 'main',
  trial_id: 'dont_tap.main.0',
  trial_index: 4,
  form_id: 'form_1',
  anchor_trial: false,
};
const CONDITION = {
  phase: 'main' as const,
  condition_id: 'standard',
  shift_active: false,
  timer: false,
  noise: false,
  calibration_level: 'L2' as const,
  variant_seed: null,
};

function consentEvents(logger: ReturnType<typeof testLogger>): void {
  logger.log('session_start', {
    seed: '0123456789abcdef',
    rng_algorithm: 'pcg32',
    refresh_hz: 60,
    arm_source: 'forced',
    stratum: null,
    slot_form: null,
  });
  logger.log('consent.granted', {
    consent_kind: 'core',
    tap_confirmed: true,
    consent_script_id: 'consent.core.v1',
    consent_version_hash: '0'.repeat(64),
    replay_counts: [0],
    policy_version: '1.0.0',
  });
}

function okResult(
  batch: UploadBatch,
  status: 'accepted' | 'duplicate' | 'retryable' = 'accepted',
): UploadBatchResult {
  const results = batch.session_chunks.flatMap((c) =>
    c.encryption === 'none_dev'
      ? c.events.map((e) => ({
          event_id: e.event_id,
          session_id: e.session_id,
          seq: e.seq,
          status,
          reason_code: null,
        }))
      : [],
  );
  return {
    schema_version: '1.0',
    batch_id: batch.batch_id,
    server_received_at: '2026-10-21T10:00:00.000Z',
    clock_offset_estimate_ms: 0,
    duplicate_batch: false,
    results,
    summary: {
      accepted: status === 'accepted' ? results.length : 0,
      duplicate: status === 'duplicate' ? results.length : 0,
      parked: 0,
      rejected_terminal: 0,
      retryable: status === 'retryable' ? results.length : 0,
    },
  };
}

for (const [name, make] of Object.entries(factories)) {
  describe(`EventLogger + ${name} outbox`, () => {
    it('writes valid, gapless envelopes in order under concurrent logging from child loggers', async () => {
      const outbox = make();
      const logger = testLogger(outbox);
      consentEvents(logger);
      const children = Array.from({ length: 5 }, () =>
        logger.child({ task: TASK, condition: CONDITION, scorable: true }),
      );
      // Interleave synchronous logs with awaited microtasks from several "modules".
      await Promise.all(
        children.map(async (c, k) => {
          for (let i = 0; i < 40; i += 1) {
            c.log('ui.replay', { target_id: `t${k}.${i}` });
            if (i % 7 === 0) await Promise.resolve();
          }
        }),
      );
      await logger.flush();
      const events = (await outbox.sessionEvents(logger.sessionId)) as EventEnvelope[];
      expect(events).toHaveLength(202);
      expect(checkSessionSequence(events)).toEqual([]);
      for (const e of events) expect(validateEvent(e).ok).toBe(true);
      expect(events.filter((e) => e.timing.scorable).length).toBe(200);
      expect(await outbox.nextSeq(logger.sessionId)).toBe(202);
    });

    it('replaces invalid events with an invalid placeholder keeping the same seq', async () => {
      const outbox = make();
      const logger = testLogger(outbox);
      consentEvents(logger);
      const r = logger.log('response', {
        stimulus_id: null,
        response_value: 'tap',
        correctness: true,
        input_mode: 'timeout', // invariant: timeout must have null latency/value
        latency_ms: 300,
        latency_anchor: 'visual_onset',
        barge_in: false,
        hold_ms: null,
        tap_count: 1,
        revisions: [],
        touch_xy_norm: null,
      });
      const bad = logger.log('ui.replay', { target_id: 'UPPER CASE' });
      const privacy = logger.log('ui.replay', { target_id: 'x', transcript: 'hello' } as never);
      logger.log('ui.replay', { target_id: 'ok' });
      await logger.flush();
      expect([r.valid, bad.valid, privacy.valid]).toEqual([false, false, false]);
      const events = (await outbox.sessionEvents(logger.sessionId)) as EventEnvelope[];
      expect(checkSessionSequence(events)).toEqual([]);
      expect(events.map((e) => e.event_type)).toEqual([
        'session_start',
        'consent.granted',
        'invalid',
        'invalid',
        'invalid',
        'ui.replay',
      ]);
      const placeholders = events.filter((e) => e.event_type === 'invalid');
      expect(placeholders.map((e) => e.seq)).toEqual([r.seq, bad.seq, privacy.seq]);
      for (const p of placeholders) expect(validateEvent(p).ok).toBe(true);
      expect(placeholders[2]?.payload).toMatchObject({
        reason: 'privacy_guard',
        original_event_type: 'ui.replay',
      });
      expect(JSON.stringify(events)).not.toContain('hello');
    });

    it('keeps practice/warm-up and pre-consent events non-scorable', async () => {
      const outbox = make();
      const consent = { granted: false };
      const logger = testLogger(outbox, { consent });
      const scoped = logger.child({ task: TASK, condition: CONDITION, scorable: true });
      scoped.log('ui.replay', { target_id: 'a' });
      consent.granted = true;
      scoped.log('ui.replay', { target_id: 'b' });
      scoped.log(
        'ui.replay',
        { target_id: 'c' },
        { condition: { ...CONDITION, phase: 'practice' } },
      );
      await logger.flush();
      const events = (await outbox.sessionEvents(logger.sessionId)) as EventEnvelope[];
      expect(events.map((e) => e.timing.scorable)).toEqual([false, true, false]);
      expect(events[1]?.timing.timing_flag).toBe('uncertified_timing_profile');
    });

    it('holds sessions without consent and uploads consented ones first-to-last', async () => {
      const outbox = make();
      const noConsent = testLogger(outbox);
      noConsent.log('ui.replay', { target_id: 'x' });
      const a = testLogger(outbox);
      consentEvents(a);
      for (let i = 0; i < 3; i += 1) a.log('ui.replay', { target_id: `a${i}` });
      const b = testLogger(outbox);
      consentEvents(b);
      await Promise.all([noConsent.flush(), a.flush(), b.flush()]);
      const batch = await outbox.nextBatch();
      expect(batch).not.toBeNull();
      if (!batch) return;
      expect(validateUploadBatch(batch)).toBe(true);
      expect(batch.session_chunks.map((c) => c.session_id)).toEqual([a.sessionId, b.sessionId]);
      expect(batch.sha256).toBe(sha256Canonical(batch.session_chunks));
      expect(batch.event_count).toBe(7);
      const first = batch.session_chunks[0];
      if (first?.encryption === 'none_dev')
        expect(first.events[1]?.event_type).toBe('consent.granted');
      // Idempotent retry: an unanswered batch is returned again with the same batch_id.
      const again = await outbox.nextBatch();
      expect(again?.batch_id).toBe(batch.batch_id);
      await outbox.applyResult(okResult(batch));
      expect(await outbox.nextBatch()).toBeNull();
      expect(await outbox.pendingCount()).toBe(1); // the unconsented row stays local
      expect((await outbox.stats()).sessionsAwaitingConsent).toBe(1);
    });

    it('re-queues retryable events and purges acknowledged rows after the grace period', async () => {
      const outbox = make();
      const a = testLogger(outbox);
      consentEvents(a);
      await a.flush();
      const batch = await outbox.nextBatch();
      if (!batch) throw new Error('no batch');
      await outbox.applyResult(okResult(batch, 'retryable'));
      const retry = await outbox.nextBatch();
      expect(retry?.batch_id).not.toBe(batch.batch_id);
      expect(retry?.event_count).toBe(2);
      if (!retry) return;
      await outbox.applyResult(okResult(retry, 'duplicate'));
      await outbox.closeSession(a.sessionId);
      expect(await outbox.pendingCount()).toBe(0);
      expect(await outbox.purgeAcknowledged(0)).toBe(2);
      expect((await outbox.stats()).sessions).toBe(0);
    });

    it('splits batches at <= 500 events / <= 256 kB and keeps seq order', async () => {
      const outbox = make();
      const a = testLogger(outbox);
      consentEvents(a);
      for (let i = 0; i < 620; i += 1) a.log('ui.replay', { target_id: `r${i}` });
      await a.flush();
      const seen: number[] = [];
      for (let guard = 0; guard < 10; guard += 1) {
        const batch = await outbox.nextBatch();
        if (!batch) break;
        expect(batch.event_count).toBeLessThanOrEqual(500);
        const bytes = new TextEncoder().encode(
          JSON.stringify(
            batch.session_chunks.flatMap((c) => (c.encryption === 'none_dev' ? c.events : [])),
          ),
        ).length;
        expect(bytes).toBeLessThanOrEqual(256 * 1024 + 1024);
        for (const c of batch.session_chunks)
          if (c.encryption === 'none_dev') seen.push(...c.events.map((e) => e.seq));
        await outbox.applyResult(okResult(batch));
      }
      expect(seen).toEqual(Array.from({ length: 622 }, (_, i) => i));
    }, 60_000);

    it('caps a batch at 500 small events', async () => {
      const outbox = make();
      const sid = uuidv7();
      await outbox.append(sid, (seq) => ({
        event_id: uuidv7(),
        event_type: 'consent.granted',
        seq,
        payload: { consent_kind: 'core' },
      }));
      for (let i = 0; i < 700; i += 1)
        await outbox.append(sid, (seq) => ({ event_id: uuidv7(), event_type: 'x', seq }));
      const batch = await outbox.nextBatch();
      expect(batch?.event_count).toBe(500);
    }, 60_000);

    it('purges a declined session entirely, and a withdrawn one down to a tombstone', async () => {
      const outbox = make();
      const declined = testLogger(outbox);
      declined.log('ui.replay', { target_id: 'x' });
      await declined.flush();
      await outbox.purgeSession(declined.sessionId);
      await outbox.recordDecline();
      expect(await outbox.sessionEvents(declined.sessionId)).toEqual([]);
      const withdrawn = testLogger(outbox);
      consentEvents(withdrawn);
      await withdrawn.flush();
      await outbox.nextBatch(); // in flight when the player withdraws
      await outbox.purgeSession(withdrawn.sessionId, (seq) =>
        withdrawn.buildDetached(
          'session_tombstone',
          { reason: 'withdrawal', covers_seq_upto: 1 },
          seq,
        ),
      );
      const left = (await outbox.sessionEvents(withdrawn.sessionId)) as EventEnvelope[];
      expect(left.map((e) => [e.event_type, e.seq])).toEqual([['session_tombstone', 2]]);
      expect(validateEvent(left[0]).ok).toBe(true);
      const batch = await outbox.nextBatch();
      expect(batch?.event_count).toBe(1);
      expect((await outbox.stats()).declinedCount).toBe(1);
    });

    it('allocates gapless seq under concurrent raw appends', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 40 }), async (n) => {
          const outbox = make();
          const sid = uuidv7();
          const seqs = await Promise.all(
            Array.from({ length: n }, () =>
              outbox.append(sid, (seq) => ({ event_id: uuidv7(), event_type: 'x', seq })),
            ),
          );
          expect([...seqs].sort((x, y) => x - y)).toEqual(Array.from({ length: n }, (_, i) => i));
          const stored = (await outbox.sessionEvents(sid)) as { seq: number }[];
          expect(stored.map((e) => e.seq)).toEqual(Array.from({ length: n }, (_, i) => i));
        }),
        { numRuns: name === 'dexie' ? 10 : 50 },
      );
    });
  });
}

describe('BatchUploader', () => {
  it('computes exponential backoff with jitter within [1 s, 15 min]', () => {
    expect(backoffDelay(1, DEFAULT_BACKOFF, () => 0)).toBe(500);
    expect(backoffDelay(1, DEFAULT_BACKOFF, () => 1)).toBe(1000);
    expect(backoffDelay(5, DEFAULT_BACKOFF, () => 1)).toBe(16000);
    expect(backoffDelay(40, DEFAULT_BACKOFF, () => 1)).toBe(15 * 60 * 1000);
  });

  it('is disabled without an API base; the queue persists', async () => {
    const outbox = new MemoryOutbox({ kioskId: 'kiosk-test' });
    const up = new BatchUploader({ outbox, apiBase: '' });
    expect(up.current.state).toBe('disabled');
    expect(await up.uploadOnce()).toEqual({ kind: 'skipped', reason: 'disabled' });
  });

  it('retries a failed batch with the same batch_id, then applies the result', async () => {
    const outbox = new MemoryOutbox({ kioskId: 'kiosk-test' });
    const a = testLogger(outbox);
    consentEvents(a);
    await a.flush();
    const sent: UploadBatch[] = [];
    let fail = true;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://api.test/api/v1/events/batch');
      const batch = JSON.parse(String(init?.body)) as UploadBatch;
      sent.push(batch);
      if (fail) throw new TypeError('offline');
      return new Response(JSON.stringify(okResult(batch)), { status: 200 });
    }) as typeof fetch;
    const up = new BatchUploader({
      outbox,
      apiBase: 'http://api.test/',
      fetch: fetchImpl,
      random: () => 0.5,
    });
    const r1 = await up.uploadOnce();
    expect(r1.kind).toBe('failed');
    expect(up.current.consecutiveFailures).toBe(1);
    fail = false;
    const r2 = await up.uploadOnce();
    expect(r2.kind).toBe('sent');
    expect(sent[0]?.batch_id).toBe(sent[1]?.batch_id);
    expect(await outbox.pendingCount()).toBe(0);
    expect(up.current.consecutiveFailures).toBe(0);
    expect((await up.uploadOnce()).kind).toBe('empty');
  });

  it('does nothing while paused and stops on 426', async () => {
    const outbox = new MemoryOutbox({ kioskId: 'kiosk-test' });
    const a = testLogger(outbox);
    consentEvents(a);
    await a.flush();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('', { status: 426 });
    }) as typeof fetch;
    const up = new BatchUploader({ outbox, apiBase: 'http://api.test', fetch: fetchImpl });
    up.pause();
    expect((await up.uploadOnce()).kind).toBe('skipped');
    expect(calls).toBe(0);
    up.resume();
    expect((await up.uploadOnce()).kind).toBe('blocked');
    expect(up.current.state).toBe('blocked_upgrade_required');
    expect(await outbox.pendingCount()).toBe(2); // data kept
  });

  it('a replayed batch (server duplicate) acknowledges once', async () => {
    const outbox = new MemoryOutbox({ kioskId: 'kiosk-test' });
    const a = testLogger(outbox);
    consentEvents(a);
    await a.flush();
    const batch = await outbox.nextBatch();
    if (!batch) throw new Error('no batch');
    for (let i = 0; i < 5; i += 1)
      await outbox.applyResult(okResult(batch, i === 0 ? 'accepted' : 'duplicate'));
    expect((await outbox.stats()).acknowledgedEvents).toBe(2);
  });
});
