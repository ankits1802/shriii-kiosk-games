import { readFileSync } from 'node:fs';
import { checkSessionSequence, validateEvent } from '@shriii/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOUCH_SPACING_MIN_MM, TOUCH_TARGET_MIN_MM } from '../../../core/contracts.ts';
import { createSessionRng } from '../../../engine/rng.ts';
import { physicalMetrics, rectGap } from '../../../input/metrics.ts';
import { stallGeometry } from '../layout.ts';
import { currentGeneratedText, GENERATED_PATH } from '../params/build-params.ts';
import { HOSTILE_LEVEL_MIN } from '../params/params.generated.ts';
import { buildStallPlan, STALL_ITEMS, type StallTrial } from '../schedule.ts';
import { content, runHeadless } from './helpers.ts';

const config = content.get('stall');

/** Scorer conventions (stats/scoring/src/shriii_scoring/conventions.py). */
const SCORER_TRIAL_TYPES = ['go', 'nogo', 'tone_choice', 'probe'];
const SCORER_CODES: Record<string, readonly (string | null)[]> = {
  go: ['serve', null],
  nogo: ['serve', null],
  tone_choice: ['firm', 'neutral', 'warm', null],
  probe: ['safe', 'risky', null],
};

function plan(seed = '000000000000007b', level: 'L1' | 'L2' | 'L3' = 'L2', form = 'form_1') {
  return buildStallPlan(
    config,
    level,
    createSessionRng(seed).stream('stall').stream('schedule'),
    form,
  );
}

const scorableOf = (trials: readonly StallTrial[]) => trials.filter((t) => t.spec.scorable);

describe('stall plan', () => {
  it('meets every EPI-01 minimum and places exactly one shift inside its window', () => {
    for (const seed of ['0000000000000001', '000000000000007b', 'deadbeefdeadbeef']) {
      const p = plan(seed);
      const s = scorableOf(p.trials);
      const gng = s.filter((t) => t.kind === 'serve');
      const nogo = gng.filter((t) => t.trialType === 'nogo');
      const tones = s.filter((t) => t.kind === 'tone');
      const provocations = tones.filter(
        (t) => t.block.block_id === 'rude_run' && t.toneLevel >= HOSTILE_LEVEL_MIN,
      );
      const feedback = gng.filter((t) => t.kind === 'serve' && t.feedback === 'negative');
      expect(gng.length).toBeGreaterThanOrEqual(config.min_counts.gng ?? 30);
      expect(nogo.length).toBeGreaterThanOrEqual(config.min_counts.nogo ?? 8);
      expect(tones.length).toBeGreaterThanOrEqual(config.min_counts.tone_choices ?? 12);
      expect(provocations.length).toBeGreaterThanOrEqual(config.min_counts.provocations ?? 8);
      expect(new Set(tones.map((t) => t.toneLevel)).size).toBeGreaterThanOrEqual(
        config.min_counts.tone_levels ?? 3,
      );
      expect(feedback.length).toBeGreaterThanOrEqual(config.min_counts.feedback_events ?? 6);
      const shifts = p.trials.filter((t) => t.contextShift);
      expect(shifts).toHaveLength(1);
      const shift = shifts[0];
      expect(shift?.block.block_id).toBe('rude_run');
      const [w0, w1] = config.context_shift?.window ?? [0, 0];
      expect(shift?.spec.trial_index).toBeGreaterThanOrEqual(w0);
      expect(shift?.spec.trial_index).toBeLessThanOrEqual(w1);
      expect(p.contextShiftIndex).toBe(shift?.spec.trial_index);
    }
  });

  it('runs practice first, keeps the configured block order and never scores practice', () => {
    const p = plan();
    expect(p.blockOrder).toEqual(config.blocks.map((b) => b.block_id));
    const practice = p.trials.filter((t) => t.block.block_id === 'practice');
    expect(practice.map((t) => t.trialType)).toEqual(['go', 'nogo']);
    expect(practice.every((t) => !t.spec.scorable)).toBe(true);
    expect(p.trials.slice(0, 2)).toEqual(practice);
  });

  it('maps every item onto the pictured catalogue and every no-go onto spoiled food', () => {
    const p = plan('00000000c0ffee00');
    for (const t of p.trials) {
      if (t.kind !== 'serve') continue;
      expect(STALL_ITEMS).toContain(t.item);
      expect(t.spoiled).toBe(t.trialType === 'nogo');
      expect(t.dontServeReason).toBe(t.trialType === 'nogo' ? 'spoiled' : null);
      expect(t.params.item).toBe(t.item);
      expect(t.stimulusId).toBe(t.spoiled ? `stall.spoiled.${t.item}` : `stall.${t.item}`);
    }
  });

  it('is deterministic and level-independent apart from the level timing', () => {
    const a = plan('0000000000000abc', 'L2');
    const b = plan('0000000000000abc', 'L2');
    expect(a.trials.map((t) => t.stimulusId)).toEqual(b.trials.map((t) => t.stimulusId));
    const l1 = plan('0000000000000abc', 'L1');
    const l3 = plan('0000000000000abc', 'L3');
    const shape = (p: ReturnType<typeof plan>) =>
      p.trials.map((t) => `${t.spec.block_id}:${t.trialType}:${t.stimulusId}:${t.toneLevel}`);
    expect(shape(l1)).toEqual(shape(a));
    expect(shape(l3)).toEqual(shape(a));
    const rush = (p: ReturnType<typeof plan>) =>
      p.trials.find((t) => t.spec.block_id === 'timed_rush' && !t.spec.anchor_trial)?.spec
        .response_window_ms;
    expect(rush(l1)).toBe(config.levels.L1.timing.rush_serve_window_ms);
    expect(rush(a)).toBe(config.levels.L2.timing.rush_serve_window_ms);
    expect(rush(l3)).toBe(config.levels.L3.timing.rush_serve_window_ms);
  });

  it('keeps the rude-run tone levels identical across forms while the scripts differ', () => {
    const f1 = plan('0000000000000101', 'L2', 'form_1').trials.filter(
      (t) => t.block.block_id === 'rude_run',
    );
    const f2 = plan('0000000000000101', 'L2', 'form_2').trials.filter(
      (t) => t.block.block_id === 'rude_run',
    );
    expect(f1.map((t) => t.toneLevel)).toEqual(f2.map((t) => t.toneLevel));
    expect(f1.map((t) => t.stimulusId)).not.toEqual(f2.map((t) => t.stimulusId));
    expect(f1[0]?.toneLevel).toBeGreaterThanOrEqual(HOSTILE_LEVEL_MIN);
  });

  it('gives probes comparable segments and cross-episode situation ids', () => {
    const probes = plan().trials.filter((t) => t.kind === 'probe');
    expect(probes).toHaveLength(4);
    expect(probes.map((t) => (t.kind === 'probe' ? t.probeGroupId : ''))).toEqual([
      'stall.probe_1',
      'stall.probe_1',
      'stall.probe_2',
      'stall.probe_2',
    ]);
    expect(probes.map((t) => t.params.repeat_group_id)).toEqual([
      'probe_situation_0',
      'probe_situation_1',
      'probe_situation_2',
      'probe_situation_3',
    ]);
  });
});

describe('stall geometry', () => {
  for (const [w, h] of [
    [1920, 1080],
    [1080, 1920],
    [1366, 768],
  ] as const) {
    for (const pxPerMm of [96 / 25.4, 4]) {
      it(`keeps targets >= 20 mm, >= 8 mm apart and in the lower two-thirds at ${w}x${h} @ ${pxPerMm.toFixed(2)} px/mm`, () => {
        const g = stallGeometry({ width: w, height: h, metrics: physicalMetrics(pxPerMm) });
        const min = TOUCH_TARGET_MIN_MM * pxPerMm;
        const gap = TOUCH_SPACING_MIN_MM * pxPerMm;
        const groups = [
          [g.plate.rect],
          g.toneFaces.map((f) => f.rect),
          g.probes.map((p) => p.rect),
        ];
        for (const group of groups) {
          for (const r of group) {
            expect(r.width).toBeGreaterThanOrEqual(min - 0.01);
            expect(r.height).toBeGreaterThanOrEqual(min - 0.01);
            expect(r.y).toBeGreaterThanOrEqual(h / 3);
            expect(r.y + r.height).toBeLessThanOrEqual(h);
            expect(r.x).toBeGreaterThanOrEqual(0);
            expect(r.x + r.width).toBeLessThanOrEqual(w);
          }
          for (let i = 0; i < group.length; i++)
            for (let j = i + 1; j < group.length; j++) {
              const a = group[i];
              const b = group[j];
              if (a && b) expect(rectGap(a, b)).toBeGreaterThanOrEqual(gap - 0.01);
            }
        }
        // Distinct choices land in distinct columns of the scorer's 3 x 3 safe-area touch grid.
        const sa = { x: 0, y: h / 3, width: w, height: (h * 2) / 3 };
        const column = (x: number) => Math.min(2, Math.floor(((x - sa.x) / sa.width) * 3));
        for (const group of [g.toneFaces.map((f) => f.rect), g.probes.map((p) => p.rect)]) {
          const cols = group.map((r) => {
            const left = column(r.x + 0.5);
            expect(column(r.x + r.width - 0.5)).toBe(left);
            return left;
          });
          expect(new Set(cols).size).toBe(group.length);
        }
      });
    }
  }
});

describe('stall params', () => {
  it('generated thresholds match the canonical YAML', () => {
    const generated = readFileSync(GENERATED_PATH, 'utf8');
    expect(generated).toBe(currentGeneratedText());
  }, 60_000);
});

describe('stall headless run (scripted bot, real module host)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completes with a valid, gapless event stream that follows the scoring conventions', async () => {
    const run = await runHeadless('?module=stall&level=L2&lang=en-IN&seed=123&bot=1');
    expect(run.result.endedReason).toBe('completed');
    expect(run.result.trialsCompleted).toBe(plan().trials.length);
    const ev = run.events;
    expect(ev.filter((e) => e.event_type === 'invalid')).toEqual([]);
    expect(checkSessionSequence(ev)).toEqual([]);
    for (const e of ev) expect(validateEvent(e).ok, e.event_type).toBe(true);

    const trialEvents = ev.filter((e) => e.task?.trial_id);
    const byTrial = new Map<string, string[]>();
    for (const e of trialEvents) {
      const id = e.task?.trial_id as string;
      byTrial.set(id, [...(byTrial.get(id) ?? []), e.event_type]);
    }
    expect(byTrial.size).toBe(run.result.trialsCompleted);
    for (const [id, types] of byTrial) {
      expect(types[0] === 'trial_start' || types[0] === 'context_shift', id).toBe(true);
      expect(types).toContain('stimulus_onset');
      expect(types.filter((t) => t === 'response')).toHaveLength(1);
      expect(types.at(-1), id).toBe('trial_end');
    }
    for (const e of trialEvents) {
      expect(e.condition?.customer_tone_level, e.event_type).toBeTypeOf('number');
      expect(typeof e.condition?.shift_active).toBe('boolean');
    }
    for (const e of ev.filter((x) => x.event_type === 'trial_start')) {
      const p = e.payload as { trial_type: string };
      expect(SCORER_TRIAL_TYPES).toContain(p.trial_type);
    }
    const typeOf = new Map(
      ev
        .filter((e) => e.event_type === 'trial_start')
        .map((e) => [e.task?.trial_id, (e.payload as { trial_type: string }).trial_type]),
    );
    for (const e of ev.filter((x) => x.event_type === 'response')) {
      const t = typeOf.get(e.task?.trial_id) as string;
      expect(SCORER_CODES[t]).toContain(
        (e.payload as { response_value: string | null }).response_value,
      );
    }
    const shifts = ev.filter((e) => e.event_type === 'context_shift');
    expect(shifts).toHaveLength(1);
    const firstRude = ev.find(
      (e) => e.event_type === 'trial_start' && e.task?.block_id === 'rude_run',
    );
    expect((shifts[0]?.payload as { shift_index: number } | undefined)?.shift_index).toBe(
      firstRude?.task?.trial_index,
    );
    expect(shifts[0]?.payload).toMatchObject({ kind: 'rude_customer_run', announced: false });
    // Raw taps are attributed to their trials (premature / extra taps feed restraint indicators).
    const taps = ev.filter((e) => e.event_type === 'input.raw_tap');
    expect(taps.length).toBeGreaterThan(30);
    expect(taps.every((e) => typeof e.task?.trial_id === 'string')).toBe(true);
    // Practice is never scorable; every rude-run trial carries shift_active.
    for (const e of trialEvents) {
      if (e.condition?.phase === 'practice') expect(e.timing.scorable).toBe(false);
      if (e.task?.block_id === 'rude_run') expect(e.condition?.shift_active).toBe(true);
      if (e.task?.block_id === 'timed_rush')
        expect(e.condition).toMatchObject({ timer: true, noise: true });
    }
    // Probe trials carry their segment id.
    const probeStarts = ev.filter(
      (e) => e.event_type === 'trial_start' && e.task?.block_id === 'probe',
    );
    expect(probeStarts.map((e) => e.task?.probe_group_id)).toEqual([
      'stall.probe_1',
      'stall.probe_1',
      'stall.probe_2',
      'stall.probe_2',
    ]);
  });

  it('logs exact response windows and fixed-paced serving trials', async () => {
    const run = await runHeadless('?module=stall&level=L1&lang=hi-IN&seed=77&bot=1');
    const ev = run.events;
    const onsets = new Map(
      ev
        .filter((e) => e.event_type === 'stimulus_onset')
        .map((e) => [
          e.task?.trial_id,
          (e.payload as { presented_onset_ms: number }).presented_onset_ms,
        ]),
    );
    for (const start of ev.filter((e) => e.event_type === 'trial_start')) {
      const p = start.payload as { trial_type: string; response_window_ms: number | null };
      if (p.trial_type !== 'go' && p.trial_type !== 'nogo') continue;
      const id = start.task?.trial_id;
      const end = ev.find((e) => e.event_type === 'trial_end' && e.task?.trial_id === id);
      const onset = onsets.get(id) as number;
      const resp = ev.find((e) => e.event_type === 'response' && e.task?.trial_id === id);
      const lat = (resp?.payload as { latency_ms: number | null } | undefined)?.latency_ms ?? null;
      if (lat !== null) expect(lat).toBeLessThanOrEqual(p.response_window_ms as number);
      // The trial ends at the end of the window (fixed pacing), within a frame.
      expect((end?.timing.t_mono_ms as number) - onset).toBeGreaterThanOrEqual(
        (p.response_window_ms as number) - 1,
      );
      expect((end?.timing.t_mono_ms as number) - onset).toBeLessThan(
        (p.response_window_ms as number) + 40,
      );
      const expectedWindow =
        start.task?.block_id === 'timed_rush'
          ? config.levels.L1.timing.rush_serve_window_ms
          : config.levels.L1.timing.serve_window_ms;
      if (!start.task?.anchor_trial) expect(p.response_window_ms).toBe(expectedWindow);
    }
  });

  it('ends cleanly with an aborted trial when the player walks away', async () => {
    const run = await runHeadless('?module=stall&seed=5&bot=1', { abortAtMs: 40_000 });
    expect(run.result.endedReason).toBe('explicit_exit');
    const ev = run.events;
    expect(ev.filter((e) => e.event_type === 'invalid')).toEqual([]);
    const ends = ev.filter((e) => e.event_type === 'trial_end');
    expect((ends.at(-1)?.payload as { outcome: string } | undefined)?.outcome).toBe('aborted');
    const moduleEnd = ev.findIndex((e) => e.event_type === 'module_end');
    expect(ev.slice(moduleEnd + 1).every((e) => e.event_type === 'session_end')).toBe(true);
  });

  it('wraps up at the soft cap while keeping every block minimum', async () => {
    // Very long recorded lines push the episode past its soft cap.
    const run = await runHeadless('?module=stall&seed=11&bot=1', { voiceLineMs: 3400 });
    expect(['completed', 'time_cap']).toContain(run.result.endedReason);
    if (run.result.endedReason === 'completed' && run.result.wrappedUp) {
      const ev = run.events;
      for (const b of config.blocks) {
        const n = new Set(
          ev
            .filter((e) => e.event_type === 'trial_end' && e.task?.block_id === b.block_id)
            .map((e) => e.task?.trial_id),
        ).size;
        expect(n, b.block_id).toBeGreaterThanOrEqual(b.min_trials);
      }
    }
  });
});
