import type { EventEnvelope } from '@shriii/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectValidModuleStream } from '../../hub/__tests__/conventions.ts';
import { content, runHeadless, trialStarts } from '../../hub/__tests__/headless.ts';
import { steadyHandsGeometry } from '../geometry.ts';
import { HoldPadTracker } from '../pad.ts';

const config = content.get('steady_hands');

describe('Steady Hands geometry', () => {
  it('keeps the lamp and plate targets large and apart in both orientations', () => {
    const pxPerMm = 96 / 25.4;
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
    ] as const) {
      const g = steadyHandsGeometry({
        width: w,
        height: h,
        orientation: w > h ? 'landscape' : 'portrait',
        metrics: { pxPerMm },
      });
      expect(g.lamp.width).toBeGreaterThanOrEqual(40 * pxPerMm);
      expect(g.pad.height).toBeGreaterThanOrEqual(20 * pxPerMm);
      expect(g.pad.y).toBeGreaterThan(g.lamp.y + g.lamp.height + 8 * pxPerMm);
      expect(g.pad.y + g.pad.height).toBeLessThanOrEqual(h);
    }
  });
});

describe('HoldPadTracker', () => {
  it('summarises holds over a window (held through, lifted early, never held)', () => {
    const t = new HoldPadTracker({ now: () => 0, ctx: {} } as never);
    t.pressed(1, 100);
    expect(t.window(200, 700)).toEqual({ holdMs: 500, completed: true, liftedMs: null });
    t.lifted(1, 650);
    expect(t.window(200, 700)).toMatchObject({ holdMs: 450, completed: false, liftedMs: 650 });
    expect(t.window(800, 900)).toEqual({ holdMs: 0, completed: false, liftedMs: null });
    t.pressed(2, 820);
    expect(t.window(800, 900)).toMatchObject({ holdMs: 80, completed: false });
  });
});

describe('Steady Hands headless bot run (MG-08)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs counterbalanced free/held blocks with an announced shift and logs restraint evidence', async () => {
    const run = await runHeadless({ modules: ['steady_hands'], seed: '0000000000000201' });
    expect(run.invalidEvents).toBe(0);
    const res = run.results[0];
    expect(res?.endedReason).toBe('completed');
    expect(res?.durationMs).toBeLessThanOrEqual(config.budget.hard_cap_ms);
    expectValidModuleStream(run.events, run.params, 'steady_hands');
    const starts = trialStarts(run.events, 'steady_hands');
    const targets = starts.filter(
      (s) => (s.payload as { trial_type: string }).trial_type === 'target',
    );
    const free = targets.filter((s) => s.task?.block_id === 'steady_hands.free');
    const held = targets.filter((s) => s.task?.block_id === 'steady_hands.held');
    expect(free.length).toBeGreaterThanOrEqual(config.min_counts.free ?? 26);
    expect(held.length).toBeGreaterThanOrEqual(config.min_counts.held ?? 26);
    // Practice comes first and is unscored.
    expect(
      targets.slice(0, 2).every((s) => s.condition?.phase === 'practice' && !s.timing.scorable),
    ).toBe(true);
    // Response windows are exactly the level table's target duration.
    const targetMs = config.levels.L2.timing.target_ms;
    for (const s of targets)
      expect((s.payload as { response_window_ms: number }).response_window_ms).toBe(targetMs);
    // Seeded distractor share within each block (params.distractor).
    const share = (list: EventEnvelope[]): number =>
      list.filter((s) => run.params[s.task?.trial_id as string]?.distractor === true).length /
      list.length;
    expect(share(free)).toBeCloseTo(config.constraints.distractor_share as number, 1);
    // Announced shift at the first trial of the second block.
    const shift = run.events.find((e) => e.event_type === 'context_shift');
    const firstSecond = [...free, ...held].sort(
      (a, b) => (a.task?.trial_index ?? 0) - (b.task?.trial_index ?? 0),
    );
    const secondBlockId = firstSecond.at(-1)?.task?.block_id;
    const firstOfSecond = targets.find((s) => s.task?.block_id === secondBlockId);
    expect(shift?.payload).toMatchObject({
      announced: true,
      shift_index: firstOfSecond?.task?.trial_index,
    });
    expect((shift?.payload as { kind: string } | undefined)?.kind).toBe(
      secondBlockId === 'steady_hands.held' ? 'held_block' : 'free_block',
    );
    // Held trials carry an input.hold (the plate is the instructed rest, never an unneeded tap).
    for (const s of held) {
      const tid = s.task?.trial_id as string;
      expect(
        run.events.filter((e) => e.task?.trial_id === tid && e.event_type === 'input.hold'),
      ).toHaveLength(1);
    }
    // The resting hand never turns an answer into multi-touch interference.
    expect(
      run.events.filter(
        (e) =>
          e.event_type === 'input.raw_tap' &&
          (e.payload as { classification: string }).classification === 'multi_touch_interference',
      ),
    ).toEqual([]);
    // Distractor onsets are logged as their own stimulus onsets inside the trial.
    const distractorOnsets = run.events.filter(
      (e) =>
        e.event_type === 'stimulus_onset' &&
        String((e.payload as { stimulus_id: string }).stimulus_id).startsWith(
          'steady_hands.distractor.',
        ),
    );
    expect(distractorOnsets.length).toBeGreaterThan(10);
    // Unneeded taps happen and are attributed to trials (the bot sometimes taps again).
    const unneeded = run.events.filter(
      (e) =>
        e.event_type === 'input.raw_tap' &&
        e.task?.trial_id &&
        ['extra', 'premature', 'during_isi'].includes(
          (e.payload as { classification: string }).classification,
        ),
    );
    expect(unneeded.length).toBeGreaterThan(0);
  });

  it('keeps block minimums when a wrap-up is requested at the soft cap', async () => {
    const cfg = structuredClone(config);
    cfg.budget = { ...cfg.budget, soft_cap_ms: 25_000 };
    const patched = {
      ...content,
      get: (id: Parameters<typeof content.get>[0]) =>
        id === 'steady_hands' ? cfg : content.get(id),
    };
    const run = await runHeadless({
      modules: ['steady_hands'],
      seed: '0000000000000202',
      content: patched,
    });
    expect(run.results[0]?.endedReason).toBe('completed');
    expect(run.results[0]?.wrappedUp).toBe(true);
    const starts = trialStarts(run.events, 'steady_hands');
    for (const b of ['free', 'held'] as const) {
      const n = starts.filter((s) => s.task?.block_id === `steady_hands.${b}`).length;
      expect(n).toBeGreaterThanOrEqual(config.min_counts[b] ?? 26);
      expect(n).toBeLessThan(28);
    }
  });
});
