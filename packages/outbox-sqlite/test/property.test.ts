/**
 * Property test: under random interleavings of appends, conflicting remote appends, consent, batch
 * building, partial acknowledgements and session closes, every stored session keeps a gapless
 * 0..next_seq-1 sequence, nothing unconsented is ever uploaded, and integrity holds.
 */
import type { UploadBatchResult } from '@shriii/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { consentGranted, ev, harness, uuidv7 } from './helpers.ts';

const SESSIONS = [uuidv7(), uuidv7(), uuidv7()];

const op = fc.oneof(
  fc.record({ kind: fc.constant('append' as const), s: fc.nat(2) }),
  fc.record({ kind: fc.constant('appendAt' as const), s: fc.nat(2), delta: fc.integer({ min: -1, max: 1 }) }),
  fc.record({ kind: fc.constant('consent' as const), s: fc.nat(2) }),
  fc.record({ kind: fc.constant('batch' as const), ackMask: fc.nat(255) }),
  fc.record({ kind: fc.constant('close' as const), s: fc.nat(2) }),
);

describe('outbox invariants (property)', () => {
  it('keeps gapless sequences and consent-first uploads', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 80 }), async (ops) => {
        const h = harness();
        const outbox = h.open(':memory:');
        const consented = new Set<string>();
        try {
          for (const o of ops) {
            switch (o.kind) {
              case 'append': {
                const sid = SESSIONS[o.s] ?? '';
                await outbox.append(sid, (seq) => ev(sid, seq));
                break;
              }
              case 'appendAt': {
                const sid = SESSIONS[o.s] ?? '';
                const next = await outbox.nextSeq(sid);
                const seq = Math.max(0, next + o.delta);
                const result = outbox.appendAt(sid, seq, ev(sid, seq));
                if (seq === next) await result;
                else await expect(result).rejects.toThrow(/seq conflict/);
                break;
              }
              case 'consent': {
                const sid = SESSIONS[o.s] ?? '';
                await outbox.append(sid, (seq) => consentGranted(sid, seq));
                consented.add(sid);
                break;
              }
              case 'batch': {
                const batch = await outbox.nextBatch();
                if (!batch) break;
                const results: UploadBatchResult['results'] = [];
                let bit = 0;
                for (const c of batch.session_chunks) {
                  expect(consented.has(c.session_id)).toBe(true);
                  for (let s = c.first_seq; s <= c.last_seq; s += 1) {
                    const accepted = ((o.ackMask >> bit % 8) & 1) === 1;
                    bit += 1;
                    results.push({
                      event_id: '01928c6e-7d3a-7b2c-8f00-000000000000',
                      session_id: c.session_id,
                      seq: s,
                      status: accepted ? 'accepted' : 'retryable',
                      reason_code: null,
                    });
                  }
                }
                await outbox.applyResult({
                  schema_version: '1.0',
                  batch_id: batch.batch_id,
                  server_received_at: new Date().toISOString(),
                  clock_offset_estimate_ms: null,
                  duplicate_batch: false,
                  results,
                  summary: { accepted: 0, duplicate: 0, parked: 0, rejected_terminal: 0, retryable: 0 },
                });
                break;
              }
              case 'close': {
                const sid = SESSIONS[o.s] ?? '';
                await outbox.closeSession(sid);
                if (!consented.has(sid)) expect(await outbox.nextSeq(sid)).toBe(0);
                break;
              }
            }
          }
          expect(outbox.integrityCheck()).toEqual([]);
          for (const sid of SESSIONS) {
            const next = await outbox.nextSeq(sid);
            const seqs = ((await outbox.sessionEvents(sid)) as { seq: number }[]).map((e) => e.seq);
            expect(seqs).toEqual(Array.from({ length: next }, (_, i) => i));
          }
        } finally {
          outbox.close();
        }
      }),
      { numRuns: 150 },
    );
  });
});
