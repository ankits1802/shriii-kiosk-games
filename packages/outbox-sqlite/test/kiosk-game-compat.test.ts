/**
 * Drop-in compatibility: the real kiosk-game logger, crash recovery and uploader run unchanged on
 * the SQLite outbox, and every uploaded batch validates against the UploadBatch contract and
 * decrypts to schema-valid, gapless event envelopes with the backend private key.
 */
import { join } from 'node:path';
import {
  checkSessionSequence,
  type EventEnvelope,
  type UploadBatch,
  type UploadBatchResult,
  validateEvent,
} from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import { validateUploadBatch } from '@shriii/contracts/validators/upload-batch';
import {
  ajvEventValidator,
  BatchUploader,
  createSessionLogger,
  type KioskOutbox,
  recoverInterruptedSessions,
  SessionClock,
} from '@shriii/kiosk-game';
import { decryptChunk, openDek } from '@shriii/session-crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { SqliteOutbox } from '../src/sqlite-outbox.ts';
import { harness, tempDir, uuidv7 } from './helpers.ts';

const validate = ajvEventValidator(validateEventEnvelope);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function logger(outbox: KioskOutbox, sessionId: string, consentGranted: boolean) {
  let t = 0;
  const clock = new SessionClock({
    anchorPerfMs: 0,
    platform: { perfNow: () => (t += 5), wallNow: () => 1_760_000_000_000 + t },
  });
  return createSessionLogger({
    sessionId,
    outbox,
    clock,
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
    consentGranted: () => consentGranted,
    validate,
  });
}

function playUntilCrash(l: ReturnType<typeof logger>, consent: boolean): void {
  l.log('session_start', {
    seed: '0123456789abcdef',
    rng_algorithm: 'pcg32',
    refresh_hz: 60,
    arm_source: 'forced',
    stratum: null,
    slot_form: 'four_stalls',
  });
  l.log('session.state_changed', {
    from_state: 'attract',
    to_state: 'languageSelect',
    trigger: 'touch_start',
  });
  if (!consent) return;
  l.log('consent.granted', {
    consent_kind: 'core',
    tap_confirmed: true,
    consent_script_id: 'consent.v1',
    consent_version_hash: '0'.repeat(64),
    replay_counts: [0],
    policy_version: '1.0.0',
  });
  l.log('session.state_changed', { from_state: 'bands', to_state: 'play', trigger: 'warmup_done' });
}

function setup(): { outbox: SqliteOutbox; h: ReturnType<typeof harness> } {
  const h = harness();
  const t = tempDir();
  const outbox = h.open(join(t.dir, 'compat.db'));
  cleanups.push(() => {
    outbox.close();
    t.cleanup();
  });
  return { outbox, h };
}

describe('kiosk-game integration on the SQLite outbox', () => {
  it('logger + crash recovery + uploader round-trip through encryption', async () => {
    const { outbox, h } = setup();
    const k: KioskOutbox = outbox;
    const crashed = uuidv7();
    const unconsented = uuidv7();
    const a = logger(k, crashed, true);
    playUntilCrash(a, true);
    const b = logger(k, unconsented, false);
    playUntilCrash(b, false);
    await Promise.all([a.flush(), b.flush()]);

    const report = await recoverInterruptedSessions(k, { validate });
    expect(report.abandoned).toEqual([crashed]);
    expect(report.purged).toEqual([unconsented]);

    const received: UploadBatch[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const batch = JSON.parse(String(init?.body)) as UploadBatch;
      received.push(batch);
      const results: UploadBatchResult['results'] = [];
      for (const c of batch.session_chunks) {
        if (c.encryption !== 'x25519_sealed_aes256gcm') throw new Error('expected encryption');
        const dek = openDek({ sealed: c.sealed_dek, sessionId: c.session_id, privateKeys: h.privateKeys });
        const events = decryptChunk(
          dek,
          { sessionId: c.session_id, firstSeq: c.first_seq, lastSeq: c.last_seq, eventCount: c.event_count },
          c,
        ) as EventEnvelope[];
        for (const e of events) {
          results.push({ event_id: e.event_id, session_id: e.session_id, seq: e.seq, status: 'accepted', reason_code: null });
        }
      }
      const body: UploadBatchResult = {
        schema_version: '1.0',
        batch_id: batch.batch_id,
        server_received_at: new Date().toISOString(),
        clock_offset_estimate_ms: 0,
        duplicate_batch: false,
        results,
        summary: { accepted: results.length, duplicate: 0, parked: 0, rejected_terminal: 0, retryable: 0 },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const uploader = new BatchUploader({ outbox: k, apiBase: 'http://api.test', fetch: fakeFetch });
    const outcome = await uploader.uploadOnce();
    expect(outcome.kind).toBe('sent');
    expect(await k.pendingCount()).toBe(0);
    expect(received).toHaveLength(1);
    const batch = received[0];
    if (!batch) throw new Error('no batch');
    expect(validateUploadBatch(batch)).toBe(true);

    const chunk = batch.session_chunks[0];
    if (!chunk || chunk.encryption !== 'x25519_sealed_aes256gcm') throw new Error('chunk');
    const events = decryptChunk(
      openDek({ sealed: chunk.sealed_dek, sessionId: chunk.session_id, privateKeys: h.privateKeys }),
      { sessionId: chunk.session_id, firstSeq: chunk.first_seq, lastSeq: chunk.last_seq, eventCount: chunk.event_count },
      chunk,
    ) as EventEnvelope[];
    expect(events.map((e) => e.event_type).slice(-2)).toEqual(['session.abandoned', 'session_end']);
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    expect(checkSessionSequence(events)).toEqual([]);
    expect(await uploader.uploadOnce()).toEqual({ kind: 'empty' });
  });
});
