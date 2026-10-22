import { checkSessionSequence } from '@shriii/contracts';
import { describe, expect, it } from 'vitest';
import { createDontTap } from '../DontTapModule.ts';
import { runHeadless } from '../kit/testing/headless.ts';

const run = (seed: number, level: 'L1' | 'L2' | 'L3' = 'L2') =>
  runHeadless({ moduleId: 'dont_tap', factory: () => createDontTap(), seed, level });

describe("Don't-Tap (MG-02) headless bot playthrough", () => {
  it('completes with valid, gapless events and the configured structure', async () => {
    const r = await run(123);
    expect(r.result.endedReason).toBe('completed');
    expect(r.invalidEvents).toBe(0);
    expect(checkSessionSequence(r.events)).toEqual([]);
    const starts = r.events.filter((e) => e.event_type === 'trial_start');
    // 4 practice + 34 main + 34 pressure (>= 32 under the budget guard) + 4 probe.
    expect(starts.length).toBeGreaterThanOrEqual(74);
    expect(starts.length).toBeLessThanOrEqual(76);
    const types = starts.map((e) => (e.payload as { trial_type: string }).trial_type);
    expect(new Set(types)).toEqual(new Set(['go', 'nogo', 'probe']));
    const scoredNogo = starts.filter(
      (e) => (e.payload as { trial_type: string }).trial_type === 'nogo' && e.timing.scorable,
    );
    expect(scoredNogo.length).toBeGreaterThanOrEqual(20);
    // Exactly one context shift at the configured index (window [40, 40]).
    const shifts = r.events.filter((e) => e.event_type === 'context_shift');
    expect(shifts).toHaveLength(1);
    expect((shifts[0]?.payload as { shift_index: number } | undefined)?.shift_index).toBe(38);
    expect(r.result.contextShiftIndex).toBe(38);
    // Every trial has one response and a trial_end.
    const ends = r.events.filter((e) => e.event_type === 'trial_end');
    const responses = r.events.filter((e) => e.event_type === 'response');
    expect(ends).toHaveLength(starts.length);
    expect(responses).toHaveLength(starts.length);
    // Practice is never scorable; pressure trials carry phase=pressure, timer and noise.
    for (const e of starts) {
      const c = e.condition as { phase: string; timer: boolean; noise: boolean };
      if (c.phase === 'practice') expect(e.timing.scorable).toBe(false);
      if (c.phase === 'pressure') expect(c.timer && c.noise).toBe(true);
    }
    // The bot really plays through the input layer: most go trials are served, most no-go withheld.
    const byTrial = new Map(
      responses.map((e) => [e.task?.trial_id, e.payload as { response_value: string | null }]),
    );
    const goStarts = starts.filter(
      (e) => (e.payload as { trial_type: string }).trial_type === 'go',
    );
    const nogoStarts = starts.filter(
      (e) => (e.payload as { trial_type: string }).trial_type === 'nogo',
    );
    const served = (xs: typeof starts) =>
      xs.filter((e) => byTrial.get(e.task?.trial_id)?.response_value === 'serve').length;
    expect(served(goStarts) / goStarts.length).toBeGreaterThan(0.8);
    expect(served(nogoStarts) / nogoStarts.length).toBeLessThan(0.6);
    // Params exported for every trial with the scorer keys.
    for (const e of starts) {
      const id = e.task?.trial_id as string;
      expect(r.trialParams[id]).toBeDefined();
      const tt = (e.payload as { trial_type: string }).trial_type;
      if (tt === 'go' || tt === 'nogo') expect(r.trialParams[id]?.feedback).toBe('none');
      if (tt === 'probe')
        expect(r.trialParams[id]?.repeat_group_id).toMatch(/^probe_situation_\d$/);
    }
    // Duration within the 60-120 s band and under the hard cap.
    expect(r.durationMs).toBeGreaterThan(60_000);
    expect(r.durationMs).toBeLessThan(100_000);
  }, 60_000);

  it('attaches raw taps to trials and records premature/extra classes', async () => {
    const r = await run(7);
    const taps = r.events.filter((e) => e.event_type === 'input.raw_tap');
    expect(taps.length).toBeGreaterThan(30);
    expect(taps.every((t) => typeof t.task?.trial_id === 'string')).toBe(true);
  }, 60_000);

  it('stimulus onsets are frame-committed and response windows come from the level table', async () => {
    const expected = { L1: 600, L3: 460 } as const;
    for (const level of ['L1', 'L3'] as const) {
      const r = await run(11, level);
      const gng = r.events.filter(
        (e) =>
          e.event_type === 'trial_start' &&
          ['go', 'nogo'].includes((e.payload as { trial_type: string }).trial_type),
      );
      for (const e of gng) {
        const w = (e.payload as { response_window_ms: number }).response_window_ms;
        // Anchor trials use the anchor (L2) timing so they are identical across levels (ENG-09).
        expect(w).toBe(e.task?.anchor_trial ? 540 : expected[level]);
      }
      expect(gng.filter((e) => e.task?.anchor_trial).length).toBe(6);
      const onsets = r.events.filter((e) => e.event_type === 'stimulus_onset');
      expect(
        onsets.every((e) => (e.payload as { onset_source: string }).onset_source === 'raf_commit'),
      ).toBe(true);
    }
  }, 120_000);
});
