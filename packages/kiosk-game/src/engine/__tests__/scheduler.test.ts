import { checkTrialSpecInvariants, type GameConfig, type GameTrialSpec } from '@shriii/contracts';
import { validateGameTrialSpec } from '@shriii/contracts/validators/game-trial-spec';
import { describe, expect, it } from 'vitest';
import type { ModuleId } from '../../core/contracts.ts';
import { loadGameContent } from '../content.ts';
import { createSessionRng } from '../rng.ts';
import { DataDrivenTrialScheduler, ScheduleConstraintError } from '../scheduler.ts';

const content = loadGameContent();
const scheduler = new DataDrivenTrialScheduler();
const LEVELS = ['L1', 'L2', 'L3'] as const;
const ALL = [...content.configs.keys()] as ModuleId[];

function seedOf(i: number): string {
  return ((BigInt(i) * 0x9e3779b97f4a7c15n) % (1n << 64n)).toString(16).padStart(16, '0');
}

function build(id: ModuleId, seed: string, level: (typeof LEVELS)[number] = 'L2', form = 'form_1') {
  return scheduler.build(
    content.get(id),
    level,
    createSessionRng(seed).stream(id).stream('schedule'),
    form,
  );
}

function withoutLevel(t: GameTrialSpec): Omit<GameTrialSpec, 'calibration_level'> {
  const { calibration_level: _ignored, ...rest } = t;
  return rest;
}

describe('DataDrivenTrialScheduler', () => {
  it('schedules every module at every level, satisfying all constraints (500 seeds each)', () => {
    for (const id of ALL) {
      for (let i = 0; i < 500; i += 1) {
        for (const level of LEVELS) {
          const r = build(id, seedOf(i), level, i % 2 === 0 ? 'form_1' : 'form_2');
          const cfg = content.get(id);
          expect(r.trials.length).toBe(Object.values(r.blockLengths).reduce((a, b) => a + b, 0));
          for (const b of cfg.blocks)
            expect(r.blockLengths[b.block_id]).toBeGreaterThanOrEqual(b.min_trials);
          for (const [key, value] of Object.entries(r.counts)) {
            expect(value, `${id} ${key}`).toBeGreaterThanOrEqual(cfg.min_counts[key] ?? 0);
          }
          if (cfg.context_shift) {
            expect(r.contextShiftIndex).not.toBeNull();
            expect(r.contextShiftIndex).toBeGreaterThanOrEqual(cfg.context_shift.window[0]);
            expect(r.contextShiftIndex).toBeLessThanOrEqual(cfg.context_shift.window[1]);
            const marked = r.trials.filter(
              (t) => (t.params as { context_shift?: boolean }).context_shift,
            );
            expect(marked.map((t) => t.trial_index)).toEqual([r.contextShiftIndex]);
          }
        }
      }
    }
  }, 300_000);

  it("Don't-Tap satisfies its constraints over 10k seeds", () => {
    const cfg = content.get('dont_tap');
    for (let i = 0; i < 10_000; i += 1) {
      const r = build('dont_tap', seedOf(i + 77));
      for (const block of ['main', 'pressure']) {
        const seq = r.trials.filter((t) => t.block_id === block).map((t) => t.trial_type);
        let run = 0;
        for (const t of seq) {
          run = t === 'nogo' ? run + 1 : 0;
          expect(run).toBeLessThanOrEqual(Number(cfg.constraints.max_consecutive_nogo));
        }
        expect(seq.filter((t) => t === 'nogo').length).toBe(cfg.planned_counts.nogo_per_block);
      }
      expect(r.counts.go).toBe(cfg.planned_counts.go);
      expect(r.contextShiftIndex).toBe(40);
      expect(r.trials.filter((t) => t.anchor_trial && t.block_id !== 'probe').length).toBe(
        cfg.constraints.anchor_trials,
      );
    }
  }, 300_000);

  it('is reproducible: same seed, level and form give identical schedules', () => {
    for (const id of ALL) {
      const a = build(id, 'feedfacecafebeef', 'L1', 'form_2');
      const b = build(id, 'feedfacecafebeef', 'L1', 'form_2');
      expect(a).toEqual(b);
      expect(JSON.stringify(a.trials)).toBe(JSON.stringify(b.trials));
    }
  });

  it('different seeds give different orders', () => {
    const a = build('dont_tap', seedOf(1))
      .trials.map((t) => t.trial_type)
      .join();
    const b = build('dont_tap', seedOf(2))
      .trials.map((t) => t.trial_type)
      .join();
    expect(a).not.toBe(b);
  });

  it('keeps types and order level-independent; anchors are identical across levels', () => {
    for (const id of ALL) {
      const byLevel = LEVELS.map((l) => build(id, seedOf(99), l));
      const types = byLevel.map((r) => r.trials.map((t) => `${t.trial_id}:${t.trial_type}`).join());
      expect(types[0]).toBe(types[1]);
      expect(types[1]).toBe(types[2]);
      const anchors = byLevel.map((r) => r.trials.filter((t) => t.anchor_trial).map(withoutLevel));
      expect(anchors[0]).toEqual(anchors[1]);
      expect(anchors[1]).toEqual(anchors[2]);
      for (const r of byLevel)
        for (const t of r.trials.filter((x) => x.anchor_trial)) expect(t.scorable).toBe(true);
    }
  });

  it('timing comes from the level table', () => {
    const cfg = content.get('dont_tap');
    for (const level of LEVELS) {
      const r = build('dont_tap', seedOf(5), level);
      const main = r.trials.find((t) => t.block_id === 'main' && !t.anchor_trial);
      expect(main?.response_window_ms).toBe(cfg.levels[level].timing.response_window_ms);
      expect(main?.timing.stimulus_duration_ms).toBe(cfg.levels[level].timing.stimulus_ms);
      const pressure = r.trials.find((t) => t.block_id === 'pressure' && !t.anchor_trial);
      expect(pressure?.timing.isi_ms).toBe(cfg.levels[level].timing.pressure_isi_ms);
      const jitter = cfg.levels[level].timing.isi_jitter_ms ?? 0;
      for (const t of r.trials.filter((x) => !x.anchor_trial)) {
        expect(t.timing.jitter_ms ?? 0).toBeGreaterThanOrEqual(0);
        expect(t.timing.jitter_ms ?? 0).toBeLessThanOrEqual(jitter);
      }
    }
  });

  it('produces valid GameTrialSpecs (schema + invariants), practice never scorable', () => {
    for (const id of ALL) {
      for (const t of build(id, seedOf(3)).trials) {
        const ok = validateGameTrialSpec(t);
        expect(ok, `${t.trial_id}: ${JSON.stringify(validateGameTrialSpec.errors?.[0])}`).toBe(
          true,
        );
        expect(checkTrialSpecInvariants(t)).toEqual([]);
        if (t.phase === 'practice' || t.phase === 'warmup') expect(t.scorable).toBe(false);
        if (t.private_report) expect(t.voice_vocabulary).toEqual([]);
      }
    }
  });

  it('randomises the Card Sort switch position within its window', () => {
    const starts = new Set<number>();
    for (let i = 0; i < 300; i += 1) {
      const r = build('card_sort', seedOf(i));
      starts.add(r.contextShiftIndex ?? -1);
      expect(r.blockLengths.initial_rule).toBeGreaterThanOrEqual(8);
      expect(r.blockLengths.initial_rule).toBeLessThanOrEqual(12);
    }
    expect([...starts].every((s) => s >= 11 && s <= 15)).toBe(true);
    expect(starts.size).toBe(5);
  });

  it('fixes the Tower problem order per form across sessions', () => {
    const order = (seed: string, form: string) =>
      build('tower', seed, 'L2', form)
        .trials.filter((t) => t.block_id === 'problems')
        .map((t) => t.trial_type)
        .join();
    expect(order(seedOf(1), 'form_1')).toBe(order(seedOf(2), 'form_1'));
    const r = build('tower', seedOf(1));
    expect(r.counts.solvable).toBe(4);
    expect(r.counts.unsolvable).toBe(2);
  });

  it('places the Share-the-Pot partner error inside its window', () => {
    for (let i = 0; i < 300; i += 1) {
      const r = build('share_pot', seedOf(i));
      const errors = r.trials.filter((t) => t.trial_type === 'error_round');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.trial_index).toBeGreaterThanOrEqual(4);
      expect(errors[0]?.trial_index).toBeLessThanOrEqual(6);
      expect(r.contextShiftIndex).toBe(errors[0]?.trial_index);
      expect(r.trials.filter((t) => t.trial_type === 'free_rider')).toHaveLength(3);
    }
  });

  it('counterbalances the Steady Hands free/held block order', () => {
    const orders = new Set<string>();
    for (let i = 0; i < 50; i += 1)
      orders.add(build('steady_hands', seedOf(i)).blockOrder.join('>'));
    expect(orders).toEqual(new Set(['practice>free>held>probe', 'practice>held>free>probe']));
  });

  it('uses identical probe trials across modules (cross-module style segments)', () => {
    const probes = (id: ModuleId) =>
      build(id, seedOf(8))
        .trials.filter((t) => t.probe_group_id !== null)
        .map((t) => ({ g: t.probe_group_id, s: t.stimulus_id, p: t.params }));
    expect(probes('dont_tap')).toEqual(probes('balloon'));
    expect(probes('stall')).toEqual(probes('tower'));
  });

  it('fails closed when a config cannot be satisfied', () => {
    const bad: GameConfig = structuredClone(content.get('dont_tap'));
    (bad.constraints as Record<string, unknown>).max_consecutive_nogo = 0;
    expect(() => scheduler.build(bad, 'L2', createSessionRng(seedOf(1)), 'form_1')).toThrow(
      ScheduleConstraintError,
    );
    const late: GameConfig = structuredClone(content.get('stall'));
    if (late.context_shift) late.context_shift.window = [10, 12];
    expect(() => scheduler.build(late, 'L2', createSessionRng(seedOf(1)), 'form_1')).toThrow(
      /context shift/,
    );
  });

  it('applies module trial generators from a level-independent stream', () => {
    const custom = new DataDrivenTrialScheduler({
      generators: {
        balloon: ({ trial, rng }) =>
          trial.trial_type === 'high_risk' || trial.trial_type === 'low_risk'
            ? {
                stimulus_id: `balloon.${trial.trial_type}`,
                params: { explosion_point: rng.int(1, 32) },
              }
            : {},
      },
    });
    const run = (level: 'L1' | 'L3') =>
      custom.build(
        content.get('balloon'),
        level,
        createSessionRng(seedOf(4)).stream('balloon'),
        'form_1',
      ).trials;
    const l1 = run('L1').map((t) => t.params);
    expect(l1).toEqual(run('L3').map((t) => t.params));
    expect(
      run('L1').some(
        (t) => (t.params as { explosion_point?: number }).explosion_point !== undefined,
      ),
    ).toBe(true);
  });
});
