/**
 * The paradigm generators plugged into the engine's DataDrivenTrialScheduler: every produced spec is
 * contract-valid, deterministic by seed, carries the scoring param keys, and satisfies the paradigm
 * minimums at every level and form.
 */
import { checkTrialSpecInvariants, type GameTrialSpec } from '@shriii/contracts';
import { validateGameTrialSpec } from '@shriii/contracts/validators/game-trial-spec';
import { describe, expect, it } from 'vitest';
import type { ModuleId } from '../../core/contracts.ts';
import { loadGameContent } from '../../engine/content.ts';
import { createSessionRng } from '../../engine/rng.ts';
import { DataDrivenTrialScheduler, type TrialOverrideGenerator } from '../../engine/scheduler.ts';
import { maxPumpsByColour, withBalloonParams } from '../bart.ts';
import { cardSortOverrides, type Matches } from '../card-sort.ts';
import { dontTapOverrides } from '../go-nogo.ts';
import { steadyHandsOverrides } from '../held-free.ts';
import { sharePotOverrides } from '../public-goods.ts';
import { forkOverrides } from '../reversal.ts';
import { stallOverrides } from '../stall-queue.ts';
import {
  buildTowerProblemSet,
  towerOverrides,
  towerProblemSetOptions,
  verifyProblem,
} from '../tower.ts';
import { weighingPostOverrides } from '../weighing-post.ts';
import { params, seedOf } from './helpers.ts';

const content = loadGameContent();
const LEVELS = ['L1', 'L2', 'L3'] as const;
const FORMS = ['form_1', 'form_2'] as const;
const SEEDS = 120;
// Test values for YAML parameters (scoring_params.yaml: tone.hostile_level_min, feedback_recovery.window_trials).
const HOSTILE_MIN = 3;
const FEEDBACK_WINDOW = 3;

function generatorFor(id: ModuleId, level: (typeof LEVELS)[number]): TrialOverrideGenerator {
  switch (id) {
    case 'dont_tap':
      return dontTapOverrides;
    case 'steady_hands':
      return steadyHandsOverrides;
    case 'card_sort':
      return cardSortOverrides();
    case 'tower':
      return towerOverrides(level);
    case 'share_pot':
      return sharePotOverrides;
    case 'stall':
      return stallOverrides({ hostileLevelMin: HOSTILE_MIN, feedbackWindow: FEEDBACK_WINDOW });
    case 'weighing_post':
      return weighingPostOverrides();
    case 'road_home':
      return forkOverrides();
    default:
      throw new Error(`no generator for ${id}`);
  }
}

function build(
  id: ModuleId,
  seed: number,
  level: (typeof LEVELS)[number],
  form: string,
): readonly GameTrialSpec[] {
  const scheduler = new DataDrivenTrialScheduler({ generators: { [id]: generatorFor(id, level) } });
  return scheduler.schedule(
    content.get(id),
    level,
    createSessionRng(seedOf(seed)).stream(id).stream('schedule'),
    form,
  );
}

function forEachSchedule(
  id: ModuleId,
  check: (trials: readonly GameTrialSpec[], level: string, form: string) => void,
): void {
  for (let s = 0; s < SEEDS; s += 1) {
    for (const level of LEVELS) {
      const form = FORMS[s % 2] as string;
      const trials = build(id, s, level, form);
      for (const t of trials) {
        expect(
          validateGameTrialSpec(t),
          `${t.trial_id}: ${JSON.stringify(validateGameTrialSpec.errors?.[0])}`,
        ).toBe(true);
        expect(checkTrialSpecInvariants(t)).toEqual([]);
      }
      check(trials, level, form);
    }
  }
}

const MODULES: ModuleId[] = [
  'dont_tap',
  'steady_hands',
  'card_sort',
  'tower',
  'share_pot',
  'stall',
  'weighing_post',
  'road_home',
];

describe('paradigm generators in the engine scheduler', () => {
  it.each(MODULES)('%s: deterministic by seed', (id) => {
    expect(build(id, 11, 'L2', 'form_1')).toEqual(build(id, 11, 'L2', 'form_1'));
  });

  it('dont_tap: feedback param on every go/no-go trial', () => {
    forEachSchedule('dont_tap', (trials) => {
      for (const t of trials)
        if (t.trial_type === 'go' || t.trial_type === 'nogo')
          expect(params(t).feedback).toBe('none');
    });
  });

  it('steady_hands: every non-probe trial is a tap target with a distractor flag', () => {
    forEachSchedule('steady_hands', (trials) => {
      for (const t of trials.filter(
        (x) => x.trial_type === 'target' || x.trial_type === 'distractor',
      )) {
        const p = params(t);
        expect(typeof p.distractor).toBe('boolean');
        expect(t.expected_response).toBe('tap');
        if (p.distractor) {
          expect(p.distractor_offset_ms as number).toBeGreaterThanOrEqual(0);
          expect(
            (p.distractor_offset_ms as number) + (p.distractor_ms as number),
          ).toBeLessThanOrEqual(p.target_ms as number);
        } else expect(p.distractor_offset_ms).toBeNull();
      }
    });
  });

  it('card_sort: rule, previous_rule and informative matches; expected response is the rule pile', () => {
    forEachSchedule('card_sort', (trials) => {
      const sorts = trials.filter((t) => t.trial_type !== 'probe_segment');
      for (const t of sorts) {
        const p = params(t);
        const m = p.matches as Matches;
        expect(['colour_pattern', 'shape', 'count']).toContain(p.rule);
        expect(t.expected_response).toBe(m[p.rule as keyof Matches]);
        if (p.previous_rule !== null)
          expect(m[p.previous_rule as keyof Matches]).not.toBe(m[p.rule as keyof Matches]);
      }
      const post = sorts.filter((t) => params(t).previous_rule !== null);
      expect(post.length).toBeGreaterThanOrEqual(20);
    });
  });

  it('tower: proven problems in form order with the scoring params', () => {
    forEachSchedule('tower', (trials, _level, form) => {
      const set = buildTowerProblemSet(towerProblemSetOptions(content.get('tower'), form));
      for (const p of set) expect(verifyProblem(p).ok).toBe(true);
      const items = trials.filter(
        (t) => t.trial_type === 'solvable' || t.trial_type === 'unsolvable',
      );
      expect(items).toHaveLength(6);
      const solvableMoves = items
        .filter((t) => t.trial_type === 'solvable')
        .map((t) => params(t).min_moves);
      expect(solvableMoves).toEqual([2, 3, 4, 5]);
      for (const t of items) {
        expect(typeof params(t).problem_id).toBe('string');
        expect(typeof params(t).skip_icon_ms).toBe('number');
        expect(typeof params(t).cap_ms).toBe('number');
        if (t.trial_type === 'unsolvable') expect(params(t).min_moves).toBeUndefined();
      }
      expect(new Set(items.map((t) => params(t).problem_id)).size).toBe(6);
    });
  });

  it('share_pot: partner params match the scheduled round type', () => {
    forEachSchedule('share_pot', (trials) => {
      const rounds = trials.filter((t) =>
        ['cooperative', 'free_rider', 'error_round'].includes(t.trial_type),
      );
      expect(rounds.filter((t) => params(t).partner_type === 'free_rider')).toHaveLength(3);
      expect(rounds.filter((t) => params(t).error_round === true)).toHaveLength(1);
    });
  });

  it('stall: feedback events, provocations and tone levels meet their minimums', () => {
    const cfg = content.get('stall');
    forEachSchedule('stall', (trials) => {
      const service = trials.filter((t) => t.block_id === 'service');
      const fbIdx = service
        .map((t, i) => (params(t).feedback === 'negative' ? i : -1))
        .filter((i) => i >= 0);
      expect(fbIdx.length).toBeGreaterThanOrEqual(cfg.min_counts.feedback_events as number);
      for (const i of fbIdx) expect(i + FEEDBACK_WINDOW).toBeLessThan(service.length);
      const tones = trials.filter((t) => t.trial_type === 'tone_choice');
      expect(tones.length).toBeGreaterThanOrEqual(cfg.min_counts.tone_choices as number);
      const levels = new Set(tones.map((t) => params(t).customer_tone_level));
      expect(levels.size).toBeGreaterThanOrEqual(cfg.min_counts.tone_levels as number);
      const provocations = tones.filter((t) => params(t).provocation === true);
      expect(provocations.length).toBeGreaterThanOrEqual(cfg.min_counts.provocations as number);
      const rude = trials.filter((t) => t.block_id === 'rude_run');
      expect(params(rude[0] as GameTrialSpec).provocation).toBe(true);
      for (const t of tones) expect(t.vocabulary).toEqual(['warm', 'neutral', 'firm']);
    });
  });

  it('weighing_post: rule-aware items, post-shift compliance params, dilemma vocabularies', () => {
    forEachSchedule('weighing_post', (trials, _l, form) => {
      const weigh = trials.filter((t) => t.trial_type === 'weigh');
      for (const t of weigh) {
        const p = params(t);
        expect(p.compliant_responses).toEqual([t.expected_response]);
        expect(p.rule_id).toBe(
          t.block_id === 'decisions_post'
            ? form === 'form_1'
              ? 'new_rule.zero_tolerance'
              : 'new_rule.both_directions'
            : 'base',
        );
        expect([0, 1]).toContain(p.required_inspections);
      }
      expect(weigh.filter((t) => t.block_id === 'decisions_post').length).toBeGreaterThanOrEqual(6);
      for (const t of trials.filter((x) => x.trial_type === 'bribe')) {
        expect(t.vocabulary).toEqual(['accept', 'decline']);
        expect(t.voice_vocabulary).toEqual([]);
      }
    });
  });

  it('road_home: reversal-block forks carry rule_option / old_rule_option', () => {
    forEachSchedule('road_home', (trials) => {
      const forks = trials.filter((t) => t.block_id === 'reversal');
      expect(forks.length).toBeGreaterThanOrEqual(10);
      for (const t of forks) {
        const p = params(t);
        expect(['left', 'right']).toContain(p.rule_option);
        expect(p.old_rule_option).not.toBe(p.rule_option);
        expect(p.rule_cue).toBe('orange_flag');
      }
    });
  });

  it('balloon: schedule post-processing gives stratified explosion points per scheduled colour', () => {
    const cfg = content.get('balloon');
    const scheduler = new DataDrivenTrialScheduler();
    for (let s = 0; s < SEEDS; s += 1) {
      for (const level of LEVELS) {
        const root = createSessionRng(seedOf(s)).stream('balloon');
        const trials = scheduler.schedule(cfg, level, root.stream('schedule'), 'form_1');
        const max = maxPumpsByColour(cfg, level);
        const out = withBalloonParams(
          trials,
          { low_risk: max.low_risk.value, high_risk: max.high_risk.value },
          root.stream('table'),
        );
        expect(
          withBalloonParams(
            trials,
            { low_risk: max.low_risk.value, high_risk: max.high_risk.value },
            root.stream('table'),
          ),
        ).toEqual(out);
        for (const t of out) {
          expect(validateGameTrialSpec(t)).toBe(true);
          if (t.trial_type === 'low_risk' || t.trial_type === 'high_risk') {
            const p = params(t);
            expect(p.risk_colour).toBe(t.trial_type);
            expect(p.explosion_point as number).toBeGreaterThanOrEqual(1);
            expect(p.explosion_point as number).toBeLessThanOrEqual(p.max_pumps as number);
          }
        }
        for (const colour of ['low_risk', 'high_risk'] as const) {
          const pts = out
            .filter((t) => t.trial_type === colour)
            .map((t) => params(t).explosion_point as number);
          const n = pts.length;
          const m = colour === 'low_risk' ? max.low_risk.value : max.high_risk.value;
          const sorted = [...pts].sort((a, b) => a - b);
          sorted.forEach((p, k) => {
            expect(p).toBeGreaterThanOrEqual(Math.floor((k * m) / n) + 1);
            expect(p).toBeLessThanOrEqual(Math.floor(((k + 1) * m) / n));
          });
        }
      }
    }
  });
});
