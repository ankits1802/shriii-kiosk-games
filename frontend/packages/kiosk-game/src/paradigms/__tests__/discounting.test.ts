import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadGameContent } from '../../engine/content.ts';
import { ParadigmConfigError, ParadigmStateError } from '../common.ts';
import {
  DelayDiscountingLadder,
  delayLadderConfig,
  EffortDiscountingLadder,
  effortLadderConfig,
  materialiseDelayTrial,
  materialiseEffortTrial,
} from '../discounting.ts';
import { baseSpec, rngFor } from './helpers.ts';

const content = loadGameContent();
const won = content.get('wait_or_now');

describe('delay ladder', () => {
  it('resolves config with provenance (defaults are flagged)', () => {
    const cfg = delayLadderConfig(won);
    // Wait-or-Now states its larger-later amount explicitly (constraints.delay_ll_amount).
    expect(cfg.llAmount).toMatchObject({
      value: won.constraints.delay_ll_amount,
      source: 'constraints',
    });
    expect(cfg.delays.value).toEqual([1, 2, 4, 8]);
    const ladder = new DelayDiscountingLadder(cfg, rngFor(1));
    expect(ladder.trials).toBe(8);
    expect([...ladder.plan].sort()).toEqual([1, 1, 2, 2, 4, 4, 8, 8]);
  });

  it('is deterministic by seed and stays inside its bracket (property)', () => {
    const cfg = delayLadderConfig(won);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        (seed, picks) => {
          const run = () => {
            const l = new DelayDiscountingLadder(cfg, rngFor(seed));
            const offers = [];
            for (const p of picks) {
              offers.push(l.nextOffer());
              l.record(p ? 'wait' : 'now');
            }
            return { offers, log: l.log() };
          };
          const a = run();
          expect(run()).toEqual(a);
          for (const e of a.log) {
            expect(Number.isInteger(e.offeredAmount)).toBe(true);
            expect(e.offeredAmount).toBeGreaterThan(e.bracketBefore[0] - 1);
            expect(e.offeredAmount).toBeLessThanOrEqual(e.bracketBefore[1]);
            expect(e.bracketAfter[0]).toBeGreaterThanOrEqual(e.bracketBefore[0]);
            expect(e.bracketAfter[1]).toBeLessThanOrEqual(e.bracketBefore[1]);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('converges towards a simulated chooser with a known indifference point', () => {
    const cfg = {
      ...delayLadderConfig(won),
      repeats: { value: 4, source: 'argument' as const, key: 'test' },
    };
    const ladder = new DelayDiscountingLadder(cfg, rngFor(7));
    // Hyperbolic chooser: V(LL) = 10 / (1 + k D), k = 0.25.
    const value = (d: number) => 10 / (1 + 0.25 * d);
    while (!ladder.done) {
      const o = ladder.nextOffer();
      ladder.record(o.ssAmount < value(o.llDelay) ? 'wait' : 'now');
    }
    for (const [d, ip] of ladder.indifferencePoints())
      expect(Math.abs(ip - value(d))).toBeLessThanOrEqual(1.25);
    // Indifference decreases with delay for a consistent chooser.
    const pts = [...ladder.indifferencePoints().entries()]
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1]);
    for (let i = 1; i < pts.length; i += 1)
      expect(pts[i]).toBeLessThanOrEqual((pts[i - 1] as number) + 0.5);
  });

  it('a timeout leaves the track unchanged but consumes the trial', () => {
    const l = new DelayDiscountingLadder(delayLadderConfig(won), rngFor(3));
    const o = l.nextOffer();
    expect(l.nextOffer()).toBe(o); // idempotent
    const e = l.record(null);
    expect(e.bracketAfter).toEqual(e.bracketBefore);
    expect(e.nextAmount).toBe(o.ssAmount);
  });

  it('materialises the scoring params', () => {
    const l = new DelayDiscountingLadder(delayLadderConfig(won), rngFor(4));
    const m = materialiseDelayTrial(
      baseSpec({
        module_id: 'wait_or_now',
        trial_type: 'sun_moon_delay',
        voice_vocabulary: ['tap'],
      }),
      l.nextOffer(),
    );
    expect(m.trial_type).toBe('delay_choice');
    expect(m.voice_vocabulary).toEqual(['now', 'wait']);
    expect(Object.keys(m.params)).toEqual(
      expect.arrayContaining(['ss_amount', 'ss_delay', 'll_amount', 'll_delay']),
    );
  });

  it('rejects invalid ladders', () => {
    const cfg = delayLadderConfig(won);
    expect(
      () =>
        new DelayDiscountingLadder(
          { ...cfg, llAmount: { value: 1, source: 'argument', key: 'x' } },
          rngFor(1),
        ),
    ).toThrow(ParadigmConfigError);
    expect(
      () =>
        new DelayDiscountingLadder(
          { ...cfg, delays: { value: [1, 1], source: 'argument', key: 'x' } },
          rngFor(1),
        ),
    ).toThrow(ParadigmConfigError);
  });
});

describe('effort ladder', () => {
  it('takes hold time from the level table and records holds after hard choices only', () => {
    const cfg = effortLadderConfig(won, 'L2');
    expect(cfg.holdMs.value).toEqual([2500, 2500, 2500, 2500]);
    const l = new EffortDiscountingLadder(cfg, rngFor(9));
    const o = l.nextOffer();
    expect(o.hardEffortMs).toBe(2500);
    l.record('easy');
    expect(() => l.recordHold(3000)).toThrow(ParadigmStateError);
    l.nextOffer();
    l.record('hard');
    expect(l.recordHold(2400).completed).toBe(false);
    expect(() => l.recordHold(2600)).toThrow(ParadigmStateError);
    l.nextOffer();
    l.record('hard');
    expect(l.recordHold(2500).completed).toBe(true);
    expect(l.holdLog()).toHaveLength(2);
  });

  it('titrates the easy amount (hard chosen -> easy offer rises)', () => {
    const l = new EffortDiscountingLadder(effortLadderConfig(won, 'L2'), rngFor(2));
    const first = l.nextOffer().easyAmount;
    l.record('hard');
    expect(l.nextOffer().easyAmount).toBeGreaterThan(first);
    const m = materialiseEffortTrial(
      baseSpec({ module_id: 'wait_or_now', trial_type: 'hold_to_earn' }),
      l.nextOffer(),
    );
    expect(m.params).toMatchObject({ hard_effort: 2.5, easy_effort: 0 });
    expect(m.vocabulary).toEqual(['easy', 'hard']);
  });
});
