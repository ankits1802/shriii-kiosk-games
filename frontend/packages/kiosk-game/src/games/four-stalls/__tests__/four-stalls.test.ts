import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionRng } from '../../../engine/rng.ts';
import { expectValidModuleStream } from '../../hub/__tests__/conventions.ts';
import { content, runHeadless, trialStarts } from '../../hub/__tests__/headless.ts';
import { fourStallsGeometry } from '../geometry.ts';
import { buildDeck, buildFourStallsPlan, placeErrands, STALL_CODES } from '../plan.ts';

const config = content.get('four_stalls');

describe('Four Stalls plan (MG-09)', () => {
  it('places >= 10 repeated identical errands, never back to back, never first', () => {
    for (let s = 1; s <= 200; s++) {
      const plan = buildFourStallsPlan(
        config,
        createSessionRng(s.toString(16).padStart(16, '0')).stream('p'),
        22,
      );
      const errands = plan.trials.filter((t) => t.kind === 'errand');
      expect(errands.length).toBe(config.planned_counts.repeat_probes);
      expect(errands.length).toBeGreaterThanOrEqual(10);
      const groups = new Map<string, number>();
      for (const e of errands)
        groups.set(e.repeatGroupId as string, (groups.get(e.repeatGroupId as string) ?? 0) + 1);
      expect([...groups.values()].every((n) => n === 3)).toBe(true);
      expect(plan.trials.slice(0, 4).every((t) => t.kind === 'own')).toBe(true);
      for (let i = 1; i < plan.trials.length; i++) {
        const a = plan.trials[i - 1]?.repeatGroupId;
        const b = plan.trials[i]?.repeatGroupId;
        if (a && b) expect(a).not.toBe(b);
      }
      expect(plan.highVariance).toHaveLength(2);
      for (const hv of plan.highVariance) {
        const lv = STALL_CODES.find((c) => !plan.highVariance.includes(c));
        expect(plan.expected[hv]).toBeLessThan(
          plan.expected[lv as (typeof STALL_CODES)[number]] as number,
        );
      }
    }
  });

  it('builds decks with exact loss counts per run of ten picks', () => {
    const deck = buildDeck(30, [3, 4], [6, 8], 0.4, createSessionRng('0000000000000003'));
    for (let k = 0; k < 3; k++)
      expect(deck.slice(k * 10, k * 10 + 10).filter((c) => c.loss > 0)).toHaveLength(4);
    expect(deck.every((c) => c.gain >= 3 && c.gain <= 4)).toBe(true);
    expect(() => placeErrands(5, 4, 3, 0, createSessionRng('0000000000000004'))).toThrow();
  });

  it('is reproducible from the seed', () => {
    const a = buildFourStallsPlan(config, createSessionRng('000000000000beef').stream('p'), 30);
    const b = buildFourStallsPlan(config, createSessionRng('000000000000beef').stream('p'), 30);
    expect(a).toEqual(b);
  });

  it('keeps stall targets >= 40 mm and >= 8 mm apart in both orientations', () => {
    const pxPerMm = 96 / 25.4;
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
    ] as const) {
      const g = fourStallsGeometry({
        width: w,
        height: h,
        orientation: w > h ? 'landscape' : 'portrait',
        metrics: { pxPerMm },
      });
      for (const r of g.targets)
        expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(40 * pxPerMm - 0.5);
      for (let i = 0; i < 4; i++)
        for (let j = i + 1; j < 4; j++) {
          const a = g.targets[i];
          const b = g.targets[j];
          if (!a || !b) continue;
          const gap = Math.max(
            b.x - (a.x + a.width),
            a.x - (b.x + b.width),
            b.y - (a.y + a.height),
            a.y - (b.y + b.height),
          );
          expect(gap).toBeGreaterThanOrEqual(8 * pxPerMm);
        }
    }
  });
});

describe('Four Stalls headless bot run', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completes with choice trials carrying repeat groups and high-variance stalls', async () => {
    const run = await runHeadless({ modules: ['four_stalls'], seed: '0000000000000301' });
    expect(run.invalidEvents).toBe(0);
    expect(run.results[0]?.endedReason).toBe('completed');
    expect(run.results[0]?.durationMs).toBeLessThanOrEqual(config.budget.hard_cap_ms);
    expectValidModuleStream(run.events, run.params, 'four_stalls');
    const choices = trialStarts(run.events, 'four_stalls').filter(
      (s) => s.task?.block_id === 'four_stalls.choices',
    );
    expect(choices).toHaveLength(config.blocks.find((b) => b.block_id === 'choices')?.trials ?? 0);
    const repeats = choices.filter((s) => run.params[s.task?.trial_id as string]?.repeat_group_id);
    expect(repeats.length).toBeGreaterThanOrEqual(10);
    const hv = run.params[choices[0]?.task?.trial_id as string]?.high_variance_stalls as string[];
    expect(hv).toHaveLength(2);
    // Own purchases record the realised payoff; errands do not pay the player.
    for (const s of choices) {
      const p = run.params[s.task?.trial_id as string] ?? {};
      if (p.repeat_group_id) expect(p.net).toBeUndefined();
    }
    for (const s of choices) {
      expect((s.payload as { response_window_ms: number }).response_window_ms).toBe(
        config.levels.L2.timing.choice_window_ms,
      );
    }
  });
});
