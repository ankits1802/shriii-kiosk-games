import { describe, expect, it } from 'vitest';
import { loadGameContent } from '../../engine/content.ts';
import { ParadigmStateError } from '../common.ts';
import { buildForkSequence, classifyForkChoice, forkTrial, reversalSummary } from '../reversal.ts';
import {
  buildRudeRun,
  calmToneSequence,
  drawServeCustomer,
  placeFeedbackEvents,
  rudeRunToneSequence,
  stallToneConfig,
} from '../stall-queue.ts';
import {
  BASE_RULE,
  classifyWeighDecision,
  correctDecision,
  creditAllocationPayload,
  drawWeighItem,
  newRuleForForm,
  resolveGamble,
  selfShareOf,
  type WeighRule,
} from '../weighing-post.ts';
import { rngFor } from './helpers.ts';

const content = loadGameContent();
const stall = content.get('stall');
const HOSTILE_MIN = 3; // test value; production reads tone.hostile_level_min from scoring_params.yaml

describe('fork rule reversal', () => {
  it('balanced cue sides, reversal at the shift index, deterministic', () => {
    for (let s = 0; s < 100; s += 1) {
      const seq = buildForkSequence(16, 6, rngFor(s));
      expect(buildForkSequence(16, 6, rngFor(s))).toEqual(seq);
      expect(seq.findIndex((t) => t.reversed)).toBe(6);
      const pre = seq.slice(0, 6).filter((t) => t.blueSide === 'left').length;
      const post = seq.slice(6).filter((t) => t.blueSide === 'left').length;
      expect(pre).toBe(3);
      expect(post).toBe(5);
      let run = 1;
      for (let i = 1; i < 6; i += 1) {
        run = seq[i]?.blueSide === seq[i - 1]?.blueSide ? run + 1 : 1;
        expect(run).toBeLessThanOrEqual(3);
      }
    }
  });

  it('classifies perseveration only after the reversal and computes reacquisition', () => {
    const pre = forkTrial(0, 'left', false);
    expect(pre).toMatchObject({ ruleOption: 'left', oldRuleOption: 'right', ruleCue: 'blue_flag' });
    const post = forkTrial(1, 'left', true);
    expect(post).toMatchObject({
      ruleOption: 'right',
      oldRuleOption: 'left',
      ruleCue: 'orange_flag',
    });
    expect(classifyForkChoice(pre, 'right')).toEqual({
      correct: false,
      perseverative: false,
      timeout: false,
    });
    expect(classifyForkChoice(post, 'left')).toEqual({
      correct: false,
      perseverative: true,
      timeout: false,
    });
    const seq = [
      forkTrial(0, 'left', false),
      forkTrial(1, 'right', true),
      forkTrial(2, 'left', true),
      forkTrial(3, 'right', true),
      forkTrial(4, 'left', true),
      forkTrial(5, 'left', true),
    ];
    // Old-rule choices twice, then correct x3 (reached at the 5th post trial).
    const choices = ['left', 'right', 'left', 'left', 'right', 'right'] as const;
    const s = reversalSummary(seq, [...choices], 3);
    expect(s).toEqual({
      postTrials: 5,
      perseverativeErrors: 2,
      trialsToReacquire: 5,
      reached: true,
    });
  });
});

describe('weighing post', () => {
  const rule: WeighRule = { id: 't', approveWithin: 0, warnWithin: 1, shortWeightOnly: true };
  it.each([
    [5, 5, 'approve'],
    [5, 4, 'approve'], // under-declared: buyer not cheated
    [5, 6, 'warn'],
    [5, 7, 'fine'],
  ] as const)('true %i declared %i -> %s', (t, d, expected) => {
    expect(correctDecision({ trueWeight: t, declaredWeight: d }, rule)).toBe(expected);
  });

  it('new market rules differ per form and are diagnostic against the base rule', () => {
    const r1 = newRuleForForm('form_1');
    const r2 = newRuleForForm('form_2');
    expect(r1.id).not.toBe(r2.id);
    expect(correctDecision({ trueWeight: 5, declaredWeight: 6 }, r1)).toBe('fine'); // zero tolerance
    expect(correctDecision({ trueWeight: 5, declaredWeight: 3 }, r2)).toBe('fine'); // both directions
    for (let s = 0; s < 200; s += 1) {
      const rule2 = s % 2 ? r1 : r2;
      const item = drawWeighItem(rngFor(s), { rule: rule2, diagnosticAgainst: BASE_RULE });
      expect(correctDecision(item, rule2)).not.toBe(correctDecision(item, BASE_RULE));
      expect(item.declaredWeight).toBeGreaterThanOrEqual(1);
    }
  });

  it('classifies decisions with inspection accounting', () => {
    const item = { good: 'rice_sack' as const, trueWeight: 5, declaredWeight: 6, ambiguous: true };
    expect(
      classifyWeighDecision(item, BASE_RULE, { decision: 'warn', inspections: 3, revisions: 1 }),
    ).toEqual({
      decision: 'warn',
      correct: true,
      inspections: 3,
      requiredInspections: 1,
      excessInspections: 2,
      revisions: 1,
    });
    expect(
      classifyWeighDecision(item, BASE_RULE, { decision: null, inspections: 0, revisions: 0 })
        .correct,
    ).toBeNull();
  });

  it('credit/blame payloads carry the self share; gamble resolution is seeded', () => {
    expect(creditAllocationPayload('fraud_found', 'self')).toEqual({
      allocation_context: 'fraud_found',
      outcome: 'success',
      target: 'self',
      self_share: 1,
    });
    expect(creditAllocationPayload('assistant_mistake', 'shared').self_share).toBe(0.5);
    expect(selfShareOf('chance')).toBe(0);
    expect(() => creditAllocationPayload('fraud_found', 'chance')).toThrow(ParadigmStateError);
    expect(resolveGamble('inspect', 1, rngFor(1))).toBe('safe');
    expect(resolveGamble('gamble', 1, rngFor(1))).toBe('caught');
    expect(resolveGamble('gamble', 0.5, rngFor(9))).toBe(resolveGamble('gamble', 0.5, rngFor(9)));
  });
});

describe('stall queue', () => {
  const tone = stallToneConfig(stall);
  it('reads tone levels 0..4 and options from the config', () => {
    expect(tone.levels).toEqual([0, 1, 2, 3, 4]);
    expect(tone.options).toEqual(['warm', 'neutral', 'firm']);
  });

  it('rude run: equal tone-level sequence across forms, form-specific scripts, starts hostile', () => {
    const provocations = stall.planned_counts.provocations as number;
    const a = buildRudeRun({
      configId: stall.config_id,
      formId: 'form_1',
      length: 12,
      provocations,
      levels: tone.levels,
      hostileMin: HOSTILE_MIN,
    });
    const b = buildRudeRun({
      configId: stall.config_id,
      formId: 'form_2',
      length: 12,
      provocations,
      levels: tone.levels,
      hostileMin: HOSTILE_MIN,
    });
    expect(a.map((c) => c.toneLevel)).toEqual(b.map((c) => c.toneLevel));
    expect(a.map((c) => c.scriptId)).not.toEqual(b.map((c) => c.scriptId));
    expect(a.filter((c) => c.provocation)).toHaveLength(11);
    expect(a[0]?.provocation).toBe(true);
    expect(new Set(a.map((c) => c.toneLevel))).toEqual(new Set([2, 3, 4]));
    expect(rudeRunToneSequence(stall.config_id, 12, 11, tone.levels, HOSTILE_MIN)).toEqual(
      a.map((c) => c.toneLevel),
    );
  });

  it('calm tone sequence is balanced below the hostile threshold', () => {
    const seq = calmToneSequence(8, tone.levels, HOSTILE_MIN, rngFor(1));
    expect(seq.every((l) => l < HOSTILE_MIN)).toBe(true);
    const counts = [0, 1, 2].map((l) => seq.filter((x) => x === l).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('feedback events keep a complete recovery window and a minimum gap (property over seeds)', () => {
    for (let s = 0; s < 300; s += 1) {
      const pos = placeFeedbackEvents(18, 8, 3, 2, rngFor(s));
      expect(pos).toHaveLength(8);
      for (let i = 1; i < pos.length; i += 1)
        expect((pos[i] as number) - (pos[i - 1] as number)).toBeGreaterThanOrEqual(2);
      expect(pos[pos.length - 1] as number).toBeLessThanOrEqual(18 - 1 - 3);
      expect(pos[0] as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('serving customers: no-go items carry a don’t-serve reason; customers are calm', () => {
    for (let s = 0; s < 50; s += 1) {
      const go = drawServeCustomer('go', tone.levels, rngFor(s));
      const nogo = drawServeCustomer('nogo', tone.levels, rngFor(s));
      expect(go.dontServeReason).toBeNull();
      expect(['spoiled', 'out_of_turn']).toContain(nogo.dontServeReason);
      expect(go.toneLevel).toBeLessThan(2);
    }
  });
});
