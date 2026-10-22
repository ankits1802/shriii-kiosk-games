import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadGameContent } from '../../engine/content.ts';
import { ParadigmConfigError } from '../common.ts';
import {
  buildGoNoGoStream,
  classifyGngTrial,
  classifyWindowTaps,
  type GngKind,
  gngResponseFields,
  gngStreamStats,
  goNoGoBlockOptions,
  resolveNogoCount,
  type TapInput,
} from '../go-nogo.ts';
import { buildHeldFreeBlock, classifyHeldFreeTrial, heldFreeBlockOptions } from '../held-free.ts';
import { rngFor } from './helpers.ts';

const content = loadGameContent();
const dontTap = content.get('dont_tap');
const THRESHOLD = 150; // test value; production reads constraints.premature_threshold_ms

describe('go/no-go streams', () => {
  it('reads every option from the config (main and pressure ISI differ)', () => {
    const main = dontTap.blocks.find((b) => b.block_id === 'main');
    const pressure = dontTap.blocks.find((b) => b.block_id === 'pressure');
    if (!main || !pressure) throw new Error('config blocks missing');
    const m = goNoGoBlockOptions(dontTap, 'L2', main);
    const p = goNoGoBlockOptions(dontTap, 'L2', pressure);
    expect(m).toMatchObject({
      trials: main.trials,
      nogoShare: 0.3,
      minNogo: dontTap.planned_counts.nogo_per_block,
      maxConsecutiveNogo: 2,
    });
    expect(m.isiMs).toBe(dontTap.levels.L2.timing.isi_ms);
    expect(p.isiMs).toBe(dontTap.levels.L2.timing.pressure_isi_ms);
    expect(m.isiJitterMs).toBe(dontTap.levels.L2.timing.isi_jitter_ms);
    expect(resolveNogoCount(m)).toBe(11);
  });

  it('is deterministic by seed and satisfies counts, run limit and jitter bounds (property)', () => {
    const opts = goNoGoBlockOptions(dontTap, 'L2', { trials: 36, phase: 'main' });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (i) => {
        const a = buildGoNoGoStream(opts, rngFor(i));
        const b = buildGoNoGoStream(opts, rngFor(i));
        expect(a).toEqual(b);
        const s = gngStreamStats(a);
        expect(s.nogo).toBe(11);
        expect(s.go).toBe(25);
        expect(s.maxNogoRun).toBeLessThanOrEqual(2);
        for (const t of a) {
          expect(t.jitterMs).toBeGreaterThanOrEqual(0);
          expect(t.jitterMs).toBeLessThanOrEqual(opts.isiJitterMs);
          expect(t.effectiveIsiMs).toBe(t.isiMs + t.jitterMs);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('different seeds give different orders', () => {
    const opts = goNoGoBlockOptions(dontTap, 'L2', { trials: 36, phase: 'main' });
    const orders = new Set(
      Array.from({ length: 50 }, (_, i) =>
        buildGoNoGoStream(opts, rngFor(i))
          .map((s) => s.kind[0])
          .join(''),
      ),
    );
    expect(orders.size).toBeGreaterThan(45);
  });

  it('fails closed when the run limit is infeasible', () => {
    expect(() =>
      buildGoNoGoStream(
        {
          trials: 6,
          nogoCount: 5,
          maxConsecutiveNogo: 1,
          stimulusMs: 500,
          responseWindowMs: 500,
          isiMs: 500,
          isiJitterMs: 0,
        },
        rngFor(1),
      ),
    ).toThrow(ParadigmConfigError);
  });
});

describe('tap classification table', () => {
  const window = { onsetMs: 1000, responseWindowMs: 500 };
  const tap = (tMs: number, onTarget = true, filtered?: TapInput['filtered']): TapInput =>
    filtered ? { tMs, onTarget, filtered } : { tMs, onTarget };

  it.each([
    // taps, expected classifications
    [[tap(900)], ['during_isi']],
    [[tap(1600)], ['during_isi']],
    [[tap(1050)], ['premature']],
    [[tap(1149.9)], ['premature']],
    [[tap(1150)], ['on_target']],
    [[tap(1500)], ['on_target']],
    [[tap(1200, false)], ['off_target']],
    [
      [tap(1200, false), tap(1300)],
      ['off_target', 'on_target'],
    ],
    [
      [tap(1200), tap(1250), tap(1260, false)],
      ['on_target', 'extra', 'extra'],
    ],
    [[tap(1200, true, 'palm')], ['filtered_palm']],
    [[tap(1200, true, 'multi_touch_interference')], ['multi_touch_interference']],
    [
      [tap(1300), tap(1200)],
      ['on_target', 'extra'],
    ], // order-independent input
  ] as const)('%# classifies taps', (taps, expected) => {
    const c = classifyWindowTaps(window, taps, THRESHOLD);
    expect(c.taps.map((t) => t.classification)).toEqual(expected);
  });

  it.each([
    ['go', true, 'correct', true, 'hit'],
    ['go', false, 'omission', false, 'miss'],
    ['nogo', true, 'commission', false, 'false_alarm'],
    ['nogo', false, 'correct', true, 'correct_rejection'],
  ] as const)('%s responded=%s -> %s', (kind, responded, outcome, correctness, sdt) => {
    const taps = responded ? [{ tMs: 1300, onTarget: true }] : [];
    const c = classifyGngTrial(kind as GngKind, window, taps, THRESHOLD);
    expect(c.outcome).toBe(outcome);
    expect(c.correctness).toBe(correctness);
    expect(c.signalDetection).toBe(sdt);
    const r = gngResponseFields(c);
    expect(r.response_value).toBe(responded ? 'serve' : null);
    expect(r.input_mode).toBe(responded ? 'touch' : 'timeout');
    expect(r.latency_ms).toBe(responded ? 300 : null);
  });

  it('a premature tap on a no-go trial is still a commission (and counted as premature)', () => {
    const c = classifyGngTrial('nogo', window, [{ tMs: 1040, onTarget: true }], THRESHOLD);
    expect(c.outcome).toBe('commission');
    expect(c.prematureCount).toBe(1);
    expect(c.unneededCount).toBe(1);
  });

  it('counts every tap class consistently (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ tMs: fc.double({ min: 0, max: 3000, noNaN: true }), onTarget: fc.boolean() }),
          {
            maxLength: 12,
          },
        ),
        (taps) => {
          const c = classifyWindowTaps(window, taps, THRESHOLD);
          expect(c.taps).toHaveLength(taps.length);
          expect(c.taps.filter((t) => t.committing).length).toBeLessThanOrEqual(1);
          const committed = c.committing;
          if (committed) {
            expect(committed.tap.onTarget).toBe(true);
            expect(committed.tap.tMs).toBeGreaterThanOrEqual(1000);
            expect(committed.tap.tMs).toBeLessThanOrEqual(1500);
            for (const t of c.taps) {
              if (t.tap.tMs > committed.tap.tMs && t.tap.tMs <= 1500)
                expect(t.classification).toBe('extra');
            }
          }
          expect(c.unneededCount).toBe(c.prematureCount + c.duringIsiCount + c.extraCount);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('held vs free classification', () => {
  const window = { onsetMs: 2000, responseWindowMs: 600 };
  it('an early hold break in the held block is an unneeded action', () => {
    const c = classifyHeldFreeTrial(
      { condition: 'held', distractor: true },
      window,
      [{ tMs: 2300, onTarget: true }],
      150,
      {
        releasedAtMs: 1900,
      },
    );
    expect(c.holdBrokenEarly).toBe(true);
    expect(c.unneededActions).toBe(1);
    expect(c.outcome).toBe('correct');
  });
  it('a release for the response is not early; free blocks ignore the pad', () => {
    const held = classifyHeldFreeTrial(
      { condition: 'held', distractor: false },
      window,
      [{ tMs: 2300, onTarget: true }],
      150,
      {
        releasedAtMs: 2250,
      },
    );
    expect(held.holdBrokenEarly).toBe(false);
    const free = classifyHeldFreeTrial({ condition: 'free', distractor: false }, window, [], 150, {
      releasedAtMs: 100,
    });
    expect(free.holdBrokenEarly).toBe(false);
    expect(free.outcome).toBe('omission');
  });
  it('builds seeded blocks from the config with the configured distractor share', () => {
    const cfg = content.get('steady_hands');
    const opts = heldFreeBlockOptions(cfg, 'L2', 'held', 30);
    for (let i = 0; i < 100; i += 1) {
      const b = buildHeldFreeBlock(opts, rngFor(i));
      expect(buildHeldFreeBlock(opts, rngFor(i))).toEqual(b);
      expect(b.filter((x) => x.distractor)).toHaveLength(9);
      for (const x of b) {
        expect(x.condition).toBe('held');
        if (x.distractor) {
          expect((x.distractorOffsetMs as number) + (x.distractorMs as number)).toBeLessThanOrEqual(
            x.targetMs,
          );
        }
      }
    }
  });
});
