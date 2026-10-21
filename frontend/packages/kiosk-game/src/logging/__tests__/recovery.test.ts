import { checkSessionSequence, type EventEnvelope, validateEvent } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { ajvEventValidator } from '../event-logger.ts';
import { DexieOutbox } from '../outbox/dexie-outbox.ts';
import { MemoryOutbox } from '../outbox/memory-outbox.ts';
import type { KioskOutbox } from '../outbox/types.ts';
import { recoverInterruptedSessions } from '../recovery.ts';
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

const validate = ajvEventValidator(validateEventEnvelope);

function startSession(logger: ReturnType<typeof testLogger>): void {
  logger.log('session_start', {
    seed: '0123456789abcdef',
    rng_algorithm: 'pcg32',
    refresh_hz: 60,
    arm_source: 'forced',
    stratum: null,
    slot_form: 'four_stalls',
  });
  logger.log('session.state_changed', {
    from_state: 'attract',
    to_state: 'languageSelect',
    trigger: 'touch_start',
  });
}

function grantConsent(logger: ReturnType<typeof testLogger>): void {
  logger.log('consent.granted', {
    consent_kind: 'core',
    tap_confirmed: true,
    consent_script_id: 'consent.v1',
    consent_version_hash: '0'.repeat(64),
    replay_counts: [0],
    policy_version: '1.0.0',
  });
  logger.log('session.state_changed', {
    from_state: 'bands',
    to_state: 'play',
    trigger: 'warmup_done',
  });
}

for (const [name, make] of Object.entries(factories)) {
  describe(`crash recovery (ENG-07, KSK-01) — ${name}`, () => {
    it('abandons a consented open session with crash_recovery and keeps its events', async () => {
      const outbox = make();
      const sessionId = uuidv7();
      const logger = testLogger(outbox, { sessionId });
      startSession(logger);
      grantConsent(logger);
      await logger.flush();
      // The renderer dies here: no session_end, session never closed.

      const report = await recoverInterruptedSessions(outbox, { validate });
      expect(report.abandoned).toEqual([sessionId]);
      expect(report.failed).toEqual([]);

      const events = (await outbox.sessionEvents(sessionId)) as EventEnvelope[];
      const types = events.map((e) => e.event_type);
      expect(types.slice(-2)).toEqual(['session.abandoned', 'session_end']);
      const abandoned = events.at(-2)?.payload as { reason: string; last_state: string };
      expect(abandoned.reason).toBe('crash_recovery');
      expect(abandoned.last_state).toBe('play');
      const end = events.at(-1)?.payload as { reason: string };
      expect(end.reason).toBe('crash_recovery');
      for (const e of events) expect(validateEvent(e).ok).toBe(true);
      expect(checkSessionSequence(events)).toEqual([]);

      // Closed now: a second pass does nothing, and the session uploads normally.
      const again = await recoverInterruptedSessions(outbox, { validate });
      expect(again.abandoned).toEqual([]);
      const batch = await outbox.nextBatch();
      expect(batch?.event_count).toBe(events.length);
    });

    it('purges an open session that never reached consent (fail closed)', async () => {
      const outbox = make();
      const sessionId = uuidv7();
      const logger = testLogger(outbox, { sessionId, consent: { granted: false } });
      startSession(logger);
      await logger.flush();

      const report = await recoverInterruptedSessions(outbox, { validate });
      expect(report.purged).toEqual([sessionId]);
      expect(await outbox.sessionEvents(sessionId)).toEqual([]);
      expect(await outbox.nextBatch()).toBeNull();
      expect((await outbox.stats()).sessions).toBe(0);
    });

    it('only closes sessions that already ended, and skips excluded sessions', async () => {
      const outbox = make();
      const ended = uuidv7();
      const live = uuidv7();
      const a = testLogger(outbox, { sessionId: ended });
      startSession(a);
      grantConsent(a);
      a.log('session_end', { reason: 'completed', duration_ms: 1000 });
      const b = testLogger(outbox, { sessionId: live });
      startSession(b);
      grantConsent(b);
      await Promise.all([a.flush(), b.flush()]);
      const before = (await outbox.sessionEvents(ended)).length;

      const report = await recoverInterruptedSessions(outbox, {
        validate,
        exclude: new Set([live]),
      });
      expect(report.closed).toEqual([ended]);
      expect(report.abandoned).toEqual([]);
      expect((await outbox.sessionEvents(ended)).length).toBe(before);
      expect((await outbox.openSessions()).map((s) => s.sessionId)).toEqual([live]);
    });

    it('concurrent recoveries (StrictMode remount) append the crash events once', async () => {
      const outbox = make();
      const sessionId = uuidv7();
      const logger = testLogger(outbox, { sessionId });
      startSession(logger);
      grantConsent(logger);
      await logger.flush();
      await Promise.all([
        recoverInterruptedSessions(outbox, { validate }),
        recoverInterruptedSessions(outbox, { validate }),
      ]);
      const events = (await outbox.sessionEvents(sessionId)) as EventEnvelope[];
      expect(events.filter((e) => e.event_type === 'session_end')).toHaveLength(1);
      expect(checkSessionSequence(events)).toEqual([]);
    });
  });
}
