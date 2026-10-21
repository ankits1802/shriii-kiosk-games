import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadGameContent } from '../../engine/content.ts';
import { ParadigmConfigError, ParadigmStateError } from '../common.ts';
import {
  buildRoundPlan,
  createPartnerPolicy,
  endowmentFromConfig,
  fuelPotPlan,
  multiplierFromConfig,
  PublicGoodsGame,
  partnerForTrialType,
  partnerParamsFromConfig,
  settleRound,
  sharePotPlanOptions,
} from '../public-goods.ts';
import { rngFor } from './helpers.ts';

const content = loadGameContent();
const sharePot = content.get('share_pot');
const PARAMS = { cooperativeShare: 0.8, freeRiderMaxTokens: 1, errorTokens: 0 };

describe('partner policies', () => {
  const ctx = { round: 3, endowment: 10, playerHistory: [4, 7], errorRound: false };
  it('cooperative contributes about 80% (+-1 token)', () => {
    for (let s = 0; s < 50; s += 1) {
      const d = createPartnerPolicy('cooperative', PARAMS).decide(ctx, rngFor(s));
      expect(d.tokens).toBeGreaterThanOrEqual(7);
      expect(d.tokens).toBeLessThanOrEqual(9);
      expect(d.isError).toBe(false);
    }
  });
  it('conditional cooperator matches the previous contribution (half on round one)', () => {
    const p = createPartnerPolicy('conditional_cooperator', PARAMS);
    expect(p.decide(ctx, rngFor(1)).tokens).toBe(7);
    expect(p.decide({ ...ctx, playerHistory: [] }, rngFor(1)).tokens).toBe(5);
  });
  it('free rider gives 0..1; error-prone spills on its error round only', () => {
    for (let s = 0; s < 30; s += 1)
      expect(
        createPartnerPolicy('free_rider', PARAMS).decide(ctx, rngFor(s)).tokens,
      ).toBeLessThanOrEqual(1);
    const e = createPartnerPolicy('error_prone', PARAMS);
    const ok = e.decide(ctx, rngFor(2));
    const err = e.decide({ ...ctx, errorRound: true }, rngFor(2));
    expect(ok.isError).toBe(false);
    expect(err).toMatchObject({
      isError: true,
      tokens: 0,
      action: 'spill',
      partnerType: 'error_prone',
    });
    expect(err.intendedTokens).toBe(ok.intendedTokens);
  });
  it('decisions are deterministic by seed (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e6 }),
        fc.constantFrom(
          'cooperative',
          'free_rider',
          'error_prone',
          'conditional_cooperator' as const,
        ),
        (s, type) => {
          const p = createPartnerPolicy(type, PARAMS);
          expect(p.decide(ctx, rngFor(s))).toEqual(p.decide(ctx, rngFor(s)));
        },
      ),
    );
  });
});

describe('round plans', () => {
  it('reads Share-the-Pot counts from the config and satisfies them for every seed (property)', () => {
    const opts = sharePotPlanOptions(sharePot);
    expect(opts).toEqual({ rounds: 8, freeRiderRounds: 3, errorRounds: 1, errorWindow: [4, 6] });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), (s) => {
        const plan = buildRoundPlan(opts, rngFor(s));
        expect(plan).toHaveLength(8);
        expect(plan[0]?.partnerType).toBe('cooperative');
        expect(plan.filter((p) => p.partnerType === 'free_rider')).toHaveLength(3);
        const errs = plan.filter((p) => p.errorRound);
        expect(errs).toHaveLength(1);
        expect(errs[0]?.round).toBeGreaterThanOrEqual(4);
        expect(errs[0]?.round).toBeLessThanOrEqual(6);
        expect(buildRoundPlan(opts, rngFor(s))).toEqual(plan);
      }),
      { numRuns: 300 },
    );
  });
  it('fuel pot: conditional partner with one interior error round', () => {
    for (let s = 0; s < 40; s += 1) {
      const p = fuelPotPlan(6, rngFor(s));
      const e = p.findIndex((x) => x.errorRound);
      expect(e).toBeGreaterThan(0);
      expect(e).toBeLessThan(5);
      expect(p.filter((x) => x.partnerType === 'conditional_cooperator')).toHaveLength(5);
    }
  });
  it('maps engine trial types and rejects impossible plans', () => {
    expect(partnerForTrialType('error_round')).toEqual({
      partnerType: 'error_prone',
      errorRound: true,
    });
    expect(partnerForTrialType('probe_segment')).toBeNull();
    expect(() =>
      buildRoundPlan(
        { rounds: 3, freeRiderRounds: 3, errorRounds: 0, errorWindow: [1, 1] },
        rngFor(1),
      ),
    ).toThrow(ParadigmConfigError);
  });
});

describe('accounting in whole pictured tokens', () => {
  it('default multiplier 2 returns the pot total to each player', () => {
    const s = settleRound(10, 6, 8, 2);
    expect(s).toMatchObject({
      pot: 14,
      returnEach: 14,
      houseTokens: 0,
      playerRoundTotal: 18,
      partnerRoundTotal: 16,
    });
  });
  it('conserves tokens for any multiplier (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.nat(),
        fc.nat(),
        fc.double({ min: 1, max: 3, noNaN: true }),
        (e, a, b, mult) => {
          const p = a % (e + 1);
          const q = b % (e + 1);
          const m = Math.round(mult * 10) / 10;
          const s = settleRound(e, p, q, m);
          expect(Number.isInteger(s.returnEach)).toBe(true);
          expect(s.returnEach * 2 + s.houseTokens).toBeCloseTo(s.multipliedPot, 9);
          expect(s.houseTokens).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
  it('rejects fractional or excessive contributions', () => {
    expect(() => settleRound(10, 11, 0, 2)).toThrow(ParadigmConfigError);
    expect(() => settleRound(10, 1.5, 0, 2)).toThrow(ParadigmConfigError);
  });
});

describe('PublicGoodsGame', () => {
  it('plays a scripted session with payloads that match the contracts', () => {
    const pp = partnerParamsFromConfig(sharePot);
    expect(pp.cooperativeShare.source).toBe('paradigm_default');
    const endowment = endowmentFromConfig(sharePot);
    expect(endowment).toEqual({ value: 10, source: 'constraints', key: 'endowment_tokens' });
    const game = new PublicGoodsGame({
      endowment: endowment.value,
      multiplier: multiplierFromConfig(sharePot).value,
      partner: {
        cooperativeShare: pp.cooperativeShare.value,
        freeRiderMaxTokens: pp.freeRiderMaxTokens.value,
        errorTokens: pp.errorTokens.value,
      },
    });
    const plan = buildRoundPlan(sharePotPlanOptions(sharePot), rngFor(5));
    const rng = rngFor(5, 'partners');
    for (const r of plan) {
      const played = game.playRound(r, 5, { unprompted: r.round % 2 === 0 }, rng);
      expect(played.contribution).toMatchObject({
        round: r.round,
        endowment_tokens: 10,
        contributed_tokens: 5,
      });
      expect(played.partnerAction).toMatchObject({
        round: r.round,
        partner_type: r.partnerType,
        is_error: r.errorRound,
      });
      expect(played.contribution.partner_contributed_tokens).toBe(played.partnerAction.tokens);
    }
    expect(game.log()).toHaveLength(8);
    expect(() =>
      game.playRound(
        plan[0] ?? { partnerType: 'cooperative', errorRound: false },
        11,
        { unprompted: false },
        rng,
      ),
    ).toThrow(ParadigmStateError);
  });
});
