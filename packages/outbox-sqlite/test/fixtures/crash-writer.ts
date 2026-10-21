/**
 * Child process for the crash-safety tests: appends events to random sessions as fast as possible
 * (plus consent, batches and acks) and reports each committed (session, seq) on stdout. The parent
 * kills it with SIGKILL at a random moment and verifies the database.
 *
 *   node crash-writer.ts <dbPath> <kekHex> <backendPubHex> <sessionIdsCsv> <seed>
 */
import { writeSync } from 'node:fs';
import { fromHex, RecipientKeyRing } from '@shriii/session-crypto';
import { SqliteOutbox } from '../../src/sqlite-outbox.ts';

const [dbPath, kekHex, pubHex, sessionsCsv, seedText] = process.argv.slice(2);
if (!dbPath || !kekHex || !pubHex || !sessionsCsv || !seedText) {
  throw new Error('usage: crash-writer <db> <kek> <pub> <sessions> <seed>');
}
const sessions = sessionsCsv.split(',');
let state = Number(seedText) >>> 0 || 1;
const rand = (): number => {
  // xorshift32: deterministic per seed, good enough for workload shaping.
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state / 0x1_0000_0000;
};

const outbox = new SqliteOutbox({
  kioskId: 'kiosk-crash',
  path: dbPath,
  encryption: {
    mode: 'sealed',
    kek: fromHex(kekHex),
    recipients: new RecipientKeyRing([
      { kid: 'backend-1', publicKey: fromHex(pubHex), notBefore: 0, notAfter: null },
    ]),
  },
});

writeSync(1, 'ready\n');
for (;;) {
  const sid = sessions[Math.floor(rand() * sessions.length)] ?? sessions[0] ?? '';
  const r = rand();
  if (r < 0.03) {
    // Upload cycle: build a batch and acknowledge half of it (exercises the other transactions).
    const batch = outbox.nextBatchSync();
    if (batch) {
      const results = (batch.session_chunks as unknown as { session_id: string; first_seq: number; last_seq: number }[])
        .flatMap((c) =>
          Array.from({ length: c.last_seq - c.first_seq + 1 }, (_, i) => ({
            event_id: '01928c6e-7d3a-7b2c-8f00-000000000000',
            session_id: c.session_id,
            seq: c.first_seq + i,
            status: rand() < 0.5 ? ('accepted' as const) : ('retryable' as const),
            reason_code: null,
          })),
        );
      outbox.applyResultSync({
        schema_version: '1.0',
        batch_id: batch.batch_id,
        server_received_at: new Date().toISOString(),
        clock_offset_estimate_ms: null,
        duplicate_batch: false,
        results,
        summary: { accepted: 0, duplicate: 0, parked: 0, rejected_terminal: 0, retryable: 0 },
      });
      writeSync(1, 'batch\n');
    }
    continue;
  }
  const size = Math.floor(rand() * 4000);
  const seq = outbox.appendSync(sid, (s) => ({
    event_id: `e-${sid}-${s}`,
    session_id: sid,
    seq: s,
    event_type: s === 1 ? 'consent.granted' : 'trial.response',
    payload: s === 1 ? { consent_kind: 'core', tap_confirmed: true } : { pad: 'p'.repeat(size) },
  }));
  writeSync(1, `${sid} ${seq}\n`);
}
