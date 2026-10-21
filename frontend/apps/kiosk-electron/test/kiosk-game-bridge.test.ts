/**
 * The real kiosk-game logger and crash recovery run unchanged on the renderer-side IpcOutbox, with
 * every call structured-cloned into the real main-process handlers and SQLite outbox — the exact
 * path the Electron kiosk uses (minus Electron's IPC transport itself, covered by the smoke test).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkSessionSequence, type EventEnvelope, validateEvent } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import {
  ajvEventValidator,
  createSessionLogger,
  type KioskOutbox,
  recoverInterruptedSessions,
  SessionClock,
  uuidv7,
} from '@shriii/kiosk-game';
import { SqliteOutbox } from '@shriii/outbox-sqlite';
import { generateKek, generateRecipientKeyPair, RecipientKeyRing } from '@shriii/session-crypto';
import { describe, expect, it } from 'vitest';
import { createHandlers } from '../src/main/ipc-handlers.ts';
import { IpcOutbox } from '../src/renderer-bridge/ipc-outbox.ts';
import { IPC, type ShriiiKioskBridge } from '../src/shared/ipc-contract.ts';

const validate = ajvEventValidator(validateEventEnvelope);

function bridgeFor(handlers: ReturnType<typeof createHandlers>): ShriiiKioskBridge {
  const call = (ch: string, p?: unknown) => handlers[ch]?.(structuredClone(p)) as Promise<never>;
  return {
    platform: 'electron',
    getInfo: () => Promise.reject(new Error('unused')),
    relaunchToAttract: () => undefined,
    reportState: () => undefined,
    onPowerEvent: () => () => undefined,
    outbox: {
      appendAt: (sessionId, seq, event) => call(IPC.outboxAppendAt, { sessionId, seq, event }),
      nextSeq: (sessionId) => call(IPC.outboxNextSeq, { sessionId }),
      setConsent: (sessionId, state) => call(IPC.outboxSetConsent, { sessionId, state }),
      purgeSession: (sessionId, tombstone) =>
        call(IPC.outboxPurgeSession, { sessionId, tombstone: tombstone ?? null }),
      closeSession: (sessionId) => call(IPC.outboxCloseSession, { sessionId }),
      recordDecline: () => call(IPC.outboxRecordDecline),
      stats: () => call(IPC.outboxStats),
      openSessions: () => call(IPC.outboxOpenSessions),
      sessionEvents: (sessionId) => call(IPC.outboxSessionEvents, { sessionId }),
      pendingCount: () => call(IPC.outboxPendingCount),
      health: () => call(IPC.outboxHealth),
    },
    printer: {
      printReport: () => call(IPC.printerPrint, {}),
      status: () => call(IPC.printerStatus),
    },
  };
}

describe('kiosk-game on the Electron bridge', () => {
  it('logs, crashes, recovers with crash_recovery and keeps a gapless valid sequence', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bridge-'));
    const backend = generateRecipientKeyPair('b1');
    const sqlite = new SqliteOutbox({
      kioskId: 'kiosk-test',
      path: path.join(dir, 'o.db'),
      encryption: {
        mode: 'sealed',
        kek: generateKek(),
        recipients: new RecipientKeyRing([
          { kid: 'b1', publicKey: backend.publicKey, notBefore: 0, notAfter: null },
        ]),
      },
    });
    try {
      const outbox = new IpcOutbox(
        bridgeFor(createHandlers({ outbox: sqlite, printer: null })),
        'kiosk-test',
      ) as unknown as KioskOutbox;
      const sessionId = uuidv7();
      let t = 0;
      const logger = createSessionLogger({
        sessionId,
        outbox,
        clock: new SessionClock({
          anchorPerfMs: 0,
          platform: { perfNow: () => (t += 3), wallNow: () => 1_760_000_000_000 + t },
        }),
        context: () => ({
          participant_pid: null,
          kiosk_id: 'kiosk-test',
          site_id: 'site-test',
          site_mode: 'supervised',
          mode: 'pilot',
          battery_arm: 'B_fixed',
          slot_form: 'four_stalls',
          language: 'hi-IN',
          player_slot: 1,
          synthetic: true,
        }),
        versions: {
          app_version: '0.1.0',
          bundle_hash: 'a'.repeat(64),
          audio_manifest_hash: null,
          variant_pack_id: null,
          scoring_dict_version: '0.1.0',
          indicator_set_version: '0.1.0',
          protocol_version: null,
          policy_version: '1.0.0',
          release_pack_version: null,
          device_profile_id: 'dev-browser',
          hardware_sku: 'dev-browser',
          timing_profile_version: 'uncertified-dev',
        },
        consentGranted: () => true,
        validate,
      });
      logger.log('session_start', {
        seed: '0123456789abcdef',
        rng_algorithm: 'pcg32',
        refresh_hz: 60,
        arm_source: 'forced',
        stratum: null,
        slot_form: 'four_stalls',
      });
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
      await logger.flush();
      // Renderer dies; a fresh renderer (new IpcOutbox) runs recovery.
      const fresh = new IpcOutbox(
        bridgeFor(createHandlers({ outbox: sqlite, printer: null })),
        'kiosk-test',
      ) as unknown as KioskOutbox;
      const report = await recoverInterruptedSessions(fresh, { validate });
      expect(report.abandoned).toEqual([sessionId]);
      const events = (await sqlite.sessionEvents(sessionId)) as EventEnvelope[];
      expect(events.map((e) => e.event_type).slice(-2)).toEqual([
        'session.abandoned',
        'session_end',
      ]);
      for (const e of events) expect(validateEvent(e).ok).toBe(true);
      expect(checkSessionSequence(events)).toEqual([]);
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
