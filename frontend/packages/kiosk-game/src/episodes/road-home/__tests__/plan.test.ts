import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadGameContent } from '../../../engine/content.ts';
import { createSessionRng } from '../../../engine/rng.ts';
import { buildRoadHomePlan, type ForkChoiceTrial } from '../plan.ts';
import { RoadHomeConfigError, resolveSettings } from '../settings.ts';

const config = loadGameContent().get('road_home');
const seedOf = (i: number): string =>
  ((BigInt(i + 1) * 0x9e3779b97f4a7c15n) % (1n << 64n)).toString(16).padStart(16, '0');
const plan = (seed = 1, level: 'L1' | 'L2' | 'L3' = 'L2', form = 'form_1') =>
  buildRoadHomePlan(config, level, createSessionRng(seedOf(seed)).stream('plan'), form);

/** Scorer conventions (stats/scoring conventions.py): required params and closed codes. */
const PARAM_KEYS: Readonly<Record<string, readonly string[]>> = {
  errand_map: ['map_id', 'optimal_order', 'optimal_cost', 'optimal_fuel', 'n_errands'],
  optional_opportunity: ['mentioning_lines'],
  fork_choice: ['rule_option', 'old_rule_option'],
  blocked_route: ['map_id', 'post_block_optimal_cost'],
  probe: ['repeat_group_id'],
};
const CODES: Readonly<Record<string, readonly string[]>> = {
  optional_opportunity: ['take', 'skip'],
  fork_choice: ['left', 'right'],
  blocked_route: ['fallback'],
  fuel_round: ['contribute'],
  probe: ['safe', 'risky'],
};

function forksOf(p: ReturnType<typeof plan>): ForkChoiceTrial[] {
  return p.trials.filter((t): t is ForkChoiceTrial => t.kind === 'fork_choice');
}

// Plans run the exact errand-tour solver for every map; allow for loaded CI runners.
describe('Road Home plan (ENG-09, EPI-03)', { timeout: 60_000 }, () => {
  it('follows the config blocks with the scorer trial types, codes and params', () => {
    const p = plan();
    const blocks = config.blocks.map((b) => b.block_id);
    expect([...new Set(p.trials.map((t) => t.spec.block_id))]).toEqual(blocks);
    for (const b of config.blocks) {
      expect(p.trials.filter((t) => t.spec.block_id === b.block_id)).toHaveLength(b.trials);
    }
    p.trials.forEach((t, i) => {
      expect(t.spec.trial_index).toBe(i);
      expect(t.spec.module_id).toBe('road_home');
      expect(t.spec.episode_id).toBe('road_home');
      for (const k of PARAM_KEYS[t.spec.trial_type] ?? []) {
        expect(t.spec.params, `${t.spec.trial_id}.${k}`).toHaveProperty(k);
      }
      const codes = CODES[t.spec.trial_type];
      if (codes) for (const v of t.spec.vocabulary) expect(codes).toContain(v);
      expect(t.spec.scorable).toBe(t.spec.block_id !== 'practice');
      expect(t.spec.latency_anchor).toBe('visual_onset');
      expect(t.spec.voice_vocabulary).toEqual([]);
    });
    const count = (type: string) => p.trials.filter((t) => t.spec.trial_type === type).length;
    expect(count('errand_map')).toBe(config.planned_counts.maps);
    expect(count('optional_opportunity')).toBe(config.planned_counts.optional_opportunities);
    expect(count('blocked_route')).toBe(config.planned_counts.blocked_events);
    expect(count('fuel_round')).toBe(config.planned_counts.fuel_rounds);
    expect(count('effort_hold')).toBe(config.planned_counts.effort_holds);
    // Optional opportunities are never mentioned by any line (unprompted by design, SCR-07).
    for (const t of p.trials.filter((x) => x.kind === 'optional_opportunity')) {
      expect((t.spec.params as { mentioning_lines: unknown[] }).mentioning_lines).toEqual([]);
    }
  });

  it('places the unannounced reversal inside the context-shift window at the first reversed fork', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 }), (seed) => {
        const p = plan(seed);
        const [w0, w1] = config.context_shift?.window ?? [0, 0];
        expect(p.shiftIndex).toBeGreaterThanOrEqual(w0);
        expect(p.shiftIndex).toBeLessThanOrEqual(w1);
        const forks = forksOf(p);
        const first = forks.find((f) => f.fork.reversed);
        if (!first) throw new Error('no reversed fork');
        expect(first.spec.trial_index).toBe(p.shiftIndex);
        expect((first.spec.params as { context_shift?: boolean }).context_shift).toBe(true);
        for (const f of forks) expect(f.fork.reversed).toBe(f.spec.trial_index >= p.shiftIndex);
        // Lantern sides balanced within each phase (a side bias cannot pass for rule learning).
        for (const rev of [false, true]) {
          const sides = forks.filter((f) => f.fork.reversed === rev).map((f) => f.fork.blueSide);
          const left = sides.filter((s) => s === 'left').length;
          expect(Math.abs(left - (sides.length - left))).toBeLessThanOrEqual(1);
        }
        // Before the reversal the lantern branch is right; after it, the unlit branch.
        for (const f of forks) {
          expect(f.fork.ruleOption === f.fork.blueSide).toBe(!f.fork.reversed);
          expect(f.spec.params).toMatchObject({
            rule_option: f.fork.ruleOption,
            old_rule_option: f.fork.oldRuleOption,
          });
        }
      }),
      { numRuns: 60 },
    );
  });

  it('scripts the fodder partner: cooperative baseline, free riders with follow-up rounds, one error', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 }), (seed) => {
        const rounds = plan(seed).trials.flatMap((t) => (t.kind === 'fuel_round' ? [t.round] : []));
        expect(rounds[0]?.partnerType).toBe('cooperative');
        expect(rounds.at(-1)?.partnerType).toBe('cooperative');
        const errors = rounds.filter((r) => r.errorRound);
        expect(errors).toHaveLength(1);
        const [e0, e1] = config.constraints.fuel_error_round_window as [number, number];
        expect(errors[0]?.round).toBeGreaterThanOrEqual(e0);
        expect(errors[0]?.round).toBeLessThanOrEqual(e1);
        const riders = rounds.filter((r) => r.partnerType === 'free_rider');
        expect(riders).toHaveLength(config.constraints.fuel_free_rider_rounds as number);
        for (const r of riders) expect(r.round).toBeLessThan(rounds.length - 1);
      }),
      { numRuns: 60 },
    );
  });

  it('uses two comparable probe segments with repeat ids shared across episodes', () => {
    const probes = plan().trials.filter((t) => t.kind === 'probe');
    expect(probes.map((t) => t.spec.probe_group_id)).toEqual([
      'road_home.probe_1',
      'road_home.probe_1',
      'road_home.probe_2',
      'road_home.probe_2',
    ]);
    expect(
      probes.map((t) => (t.spec.params as { repeat_group_id: string }).repeat_group_id),
    ).toEqual(['probe_situation_0', 'probe_situation_1', 'probe_situation_2', 'probe_situation_3']);
    const budget = config.blocks.find((b) => b.block_id === 'probe')?.budget_trial_ms;
    for (const t of probes) {
      expect(t.spec.anchor_trial).toBe(true);
      expect(t.spec.response_window_ms).toBe(budget);
    }
  });

  it('reads every window from the level table and keeps the structure identical across levels', () => {
    const a = plan(5, 'L1');
    const b = plan(5, 'L3');
    expect(a.trials.map((t) => t.spec.trial_type)).toEqual(b.trials.map((t) => t.spec.trial_type));
    expect(a.shiftIndex).toBe(b.shiftIndex);
    for (const [p, level] of [
      [a, 'L1'],
      [b, 'L3'],
    ] as const) {
      const timing = config.levels[level].timing;
      for (const t of p.trials) {
        if (t.kind === 'fork_choice') expect(t.spec.response_window_ms).toBe(timing.step_window_ms);
        if (t.kind === 'optional_opportunity') {
          expect(t.spec.response_window_ms).toBe(timing.optional_window_ms);
        }
        if (t.kind === 'fuel_round') expect(t.spec.response_window_ms).toBe(timing.fuel_window_ms);
        if (t.kind === 'effort_hold') {
          expect(t.spec.response_window_ms).toBe(timing.uphill_window_ms);
          expect(t.requiredMs).toBe(timing.hold_required_ms);
        }
        if (t.kind === 'errand_map') {
          expect(t.map.nodes).toHaveLength(timing.map_nodes as number);
          expect(t.map.fuelBudget).toBe(timing.fuel_units);
        }
      }
    }
  });

  it('is a pure function of the seed (trial params regenerate for the scorer join)', () => {
    expect(JSON.stringify(plan(9).trialParams)).toBe(JSON.stringify(plan(9).trialParams));
    expect(JSON.stringify(plan(9).trialParams)).not.toBe(JSON.stringify(plan(10).trialParams));
    const total = config.blocks.reduce((a, b) => a + b.trials, 0);
    expect(Object.keys(plan(9).trialParams)).toHaveLength(total);
    expect(plan(9, 'L2', 'form_2').formId).toBe('form_2');
  });

  it('fails closed on a broken config', () => {
    const broken = {
      ...config,
      constraints: { ...config.constraints, errand_block_pattern: ['nonsense'] },
    };
    expect(() => resolveSettings(broken, 'L2')).toThrow(RoadHomeConfigError);
    const timing: Record<string, number | undefined> = { ...config.levels.L2.timing };
    delete timing.optional_window_ms;
    const noWindow = {
      ...config,
      levels: { ...config.levels, L2: { ...config.levels.L2, timing } },
    };
    expect(() => resolveSettings(noWindow, 'L2')).toThrow(/optional_window_ms/);
    expect(() => resolveSettings({ ...config, module_id: 'stall' }, 'L2')).toThrow(
      RoadHomeConfigError,
    );
    const fewKinds = {
      ...config,
      constraints: { ...config.constraints, optional_kinds: ['shrine_lamp'] },
    };
    expect(() =>
      buildRoadHomePlan(fewKinds, 'L2', createSessionRng(seedOf(1)).stream('plan'), 'form_1'),
    ).toThrow(/optional_kinds/);
  });
});
