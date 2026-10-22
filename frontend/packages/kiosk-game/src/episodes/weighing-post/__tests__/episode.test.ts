import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkSessionSequence, type EventEnvelope, validateEvent } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import type { Application, Container } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtKit, Layout, ModuleResult } from '../../../core/contracts.ts';
import { SessionClock } from '../../../engine/clock.ts';
import { loadGameContent } from '../../../engine/content.ts';
import { parseModuleHarnessParams, runModuleHarness } from '../../../engine/dev-harness.ts';
import { SilentAudioService, SilentVoiceService } from '../../../engine/fallbacks/silent-audio.ts';
import type { PlayServices } from '../../../engine/module-host.ts';
import { GameModuleRegistry } from '../../../engine/registry.ts';
import { DomInputService } from '../../../input/input-service.ts';
import { physicalMetrics } from '../../../input/metrics.ts';
import { ajvEventValidator } from '../../../logging/event-logger.ts';
import { FORBIDDEN_TRUE_OUTCOME_KEYS } from '../../../paradigms/private-report.ts';
import type { EpisodePlan } from '../schedule.ts';
import { WeighingPostEpisode } from '../WeighingPostEpisode.ts';

const content = loadGameContent();

/** A certified test profile: timing flags then reflect real lateness only, as on a certified SKU. */
const CERTIFIED = {
  version: 'test-certified',
  certified: true,
  displayOffsetMs: 0,
  audioOutputOffsetMs: 0,
  touchOffsetMs: 0,
  refreshHz: 60,
} as const;

function makeClock(): SessionClock {
  return new SessionClock({
    anchorPerfMs: Date.now(),
    profile: CERTIFIED,
    platform: {
      perfNow: () => Date.now(),
      wallNow: () => Date.now(),
      requestFrame: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    },
  });
}

function services(
  clock: SessionClock,
  width: number,
  height: number,
  voice: SilentVoiceService,
): { services: PlayServices; input: DomInputService } {
  const metrics = physicalMetrics();
  const layout: Layout = {
    width,
    height,
    safeArea: { x: 0, y: 0, width, height },
    orientation: width >= height ? 'landscape' : 'portrait',
    metrics,
    onChange: () => () => undefined,
  };
  const input = new DomInputService({
    clock,
    metrics,
    element: null,
    stageSize: () => ({ width, height }),
    strictTargets: true,
    voice,
  });
  return {
    input,
    services: {
      app: {} as Application,
      layout,
      audio: new SilentAudioService(clock),
      voice,
      input,
      art: {} as ArtKit,
      createStage: () => ({}) as Container,
      releaseStage: () => undefined,
    },
  };
}

interface RunOut {
  readonly result: ModuleResult;
  readonly events: EventEnvelope[];
  readonly plan: EpisodePlan;
  readonly params: Record<string, Readonly<Record<string, unknown>>>;
  readonly sessionId: string;
}

async function playthrough(opts: {
  readonly seed: number;
  readonly width?: number;
  readonly height?: number;
  readonly lineMs?: number;
  readonly form?: string;
}): Promise<RunOut> {
  const clock = makeClock();
  const voice = new SilentVoiceService(clock, { lineMs: opts.lineMs ?? 700 });
  const { services: svc, input } = services(clock, opts.width ?? 1920, opts.height ?? 1080, voice);
  let plan: EpisodePlan | null = null;
  let episode: WeighingPostEpisode | null = null;
  const registry = new GameModuleRegistry({
    weighing_post: () => {
      episode = new WeighingPostEpisode({ onPlan: (p) => (plan = p) });
      return episode;
    },
  });
  const params = parseModuleHarnessParams(
    `?module=weighing_post&level=L2&lang=en-IN&seed=${opts.seed}&bot=1${opts.form ? `&form=${opts.form}` : ''}`,
    content,
  );
  if (!params) throw new Error('params');
  const run = runModuleHarness(params, {
    content,
    registry,
    services: svc,
    clock,
    validate: ajvEventValidator(validateEventEnvelope),
  });
  input.setLogger(run.logger);
  await vi.advanceTimersByTimeAsync(420_000);
  const result = await run.result;
  const events = await run.events();
  if (!plan || !episode) throw new Error('episode did not initialise');
  const ep = episode as WeighingPostEpisode;
  return { result, events, plan, params: ep.trialParams(), sessionId: run.sessionId };
}

function trialsOf(events: readonly EventEnvelope[]): Map<string, EventEnvelope[]> {
  const m = new Map<string, EventEnvelope[]>();
  for (const e of events) {
    const id = e.task?.trial_id;
    if (!id) continue;
    const list = m.get(id) ?? [];
    list.push(e);
    m.set(id, list);
  }
  return m;
}

function payloadOf(e: EventEnvelope): Record<string, unknown> {
  return e.payload as unknown as Record<string, unknown>;
}

describe('WeighingPostEpisode headless playthrough (EPI-02)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completes with a valid, gapless event stream meeting every plan AC', async () => {
    const { result, events, plan, params, sessionId } = await playthrough({ seed: 123 });
    expect(result.endedReason).toBe('completed');
    expect(result.contextShiftIndex).toBe(plan.shiftIndex);
    expect(checkSessionSequence(events)).toEqual([]);
    for (const e of events) {
      const v = validateEvent(e);
      expect(v.ok, `${e.event_type}: ${JSON.stringify(v)}`).toBe(true);
    }
    expect(events.filter((e) => e.event_type === 'invalid')).toEqual([]);

    const starts = events.filter((e) => e.event_type === 'trial_start');
    const type = (e: EventEnvelope): string => String(payloadOf(e).trial_type);
    const scorableWeigh = starts.filter((e) => type(e) === 'weigh_decision' && e.timing.scorable);
    expect(scorableWeigh.length).toBeGreaterThanOrEqual(12);
    for (const k of ['bribe', 'overpayment', 'assistant_mistake', 'fraud_found']) {
      expect(starts.filter((e) => type(e) === k).length, k).toBeGreaterThanOrEqual(3);
    }
    expect(starts.filter((e) => type(e) === 'gamble_inspection')).toHaveLength(3);
    expect(starts.filter((e) => type(e) === 'luck_token')).toHaveLength(4);
    expect(starts.filter((e) => type(e) === 'probe')).toHaveLength(4);
    // Practice is never scorable.
    const practice = starts.filter((e) => e.condition?.phase === 'practice');
    expect(practice).toHaveLength(1);
    expect(practice.every((e) => !e.timing.scorable)).toBe(true);

    // Exactly one announced new-market-rule shift, at the scheduled index, before >= 6 post trials.
    const shifts = events.filter((e) => e.event_type === 'context_shift');
    expect(shifts).toHaveLength(1);
    expect(payloadOf(shifts[0] as EventEnvelope)).toMatchObject({
      kind: 'new_market_rule',
      announced: true,
      shift_index: plan.shiftIndex,
    });
    const post = scorableWeigh.filter((e) => (e.task?.trial_index ?? 0) >= (plan.shiftIndex ?? 0));
    expect(post.length).toBeGreaterThanOrEqual(6);

    // Each trial: start -> onset -> response -> end, in order; responses carry closed codes.
    const byTrial = trialsOf(events);
    for (const s of starts) {
      const list = byTrial.get(s.task?.trial_id ?? '') ?? [];
      const kinds = list
        .map((e): string => e.event_type)
        .filter((k) => k !== 'input.raw_tap' && k !== 'context_shift');
      expect(kinds[0], s.task?.trial_id ?? undefined).toBe('trial_start');
      expect(kinds).toContain('stimulus_onset');
      expect(kinds.at(-1)).toBe('trial_end');
      const resp = list.filter((e) => e.event_type === 'response');
      expect(resp).toHaveLength(1);
      const r = payloadOf(resp[0] as EventEnvelope);
      const v = r.response_value;
      if (v !== null) {
        const t = type(s);
        const allowed: Record<string, string[]> = {
          weigh_decision: ['approve', 'warn', 'fine'],
          bribe: ['accept', 'decline'],
          overpayment: ['return', 'keep'],
          assistant_mistake: ['self', 'assistant', 'shared', 'chance'],
          fraud_found: ['self', 'assistant', 'shared'],
          gamble_inspection: ['gamble', 'inspect'],
          luck_token: ['face_1', 'face_2', 'face_3', 'face_4', 'face_5', 'face_6'],
          probe: ['safe', 'risky'],
        };
        expect(allowed[t], t).toContain(v);
        expect(typeof r.latency_ms).toBe('number');
      } else {
        expect(r.input_mode).toBe('timeout');
        expect(r.latency_ms).toBeNull();
      }
      // Onset precedes the response.
      const onset = list.find((e) => e.event_type === 'stimulus_onset');
      expect(onset && resp[0] && onset.seq < resp[0].seq).toBe(true);
    }

    // Credit/blame allocations for every answered allocation dilemma.
    const allocs = events.filter((e) => e.event_type === 'credit_allocation');
    const answeredAlloc = starts.filter((s) => {
      const t = type(s);
      if (t !== 'assistant_mistake' && t !== 'fraud_found') return false;
      const r = (byTrial.get(s.task?.trial_id ?? '') ?? []).find(
        (e) => e.event_type === 'response',
      );
      return r !== undefined && payloadOf(r).response_value !== null;
    });
    expect(allocs).toHaveLength(answeredAlloc.length);

    // Private reports: only the reported value, never a true outcome, anywhere.
    const reports = events.filter((e) => e.event_type === 'report');
    expect(reports.length).toBeGreaterThan(0);
    for (const r of reports) {
      expect(Object.keys(payloadOf(r)).sort()).toEqual(
        ['headset', 'onlooker_reported', 'report_context', 'report_index', 'reported_value'].sort(),
      );
    }
    const text = JSON.stringify(events);
    for (const k of FORBIDDEN_TRUE_OUTCOME_KEYS) expect(text).not.toContain(`"${k}"`);
    expect(JSON.stringify(params)).not.toMatch(/true_roll|true_outcome/);

    // Inspect-more taps are on-target taps of the live decision.
    const inspects = events.filter(
      (e) =>
        e.event_type === 'input.raw_tap' &&
        payloadOf(e).target_id === 'weighing_post.inspect_more' &&
        payloadOf(e).classification === 'on_target',
    );
    expect(inspects.length).toBeGreaterThan(0);

    // Probe segments: two comparable segments of two trials.
    const probeGroups = starts
      .filter((e) => type(e) === 'probe')
      .map((e) => e.task?.probe_group_id);
    expect(probeGroups).toEqual([
      'weighing_post.probe_1',
      'weighing_post.probe_1',
      'weighing_post.probe_2',
      'weighing_post.probe_2',
    ]);

    // Scorer params exist for every trial.
    for (const s of starts) expect(params[s.task?.trial_id ?? '']).toBeDefined();

    // Budget: the scripted session stays within the hard cap.
    expect(result.durationMs).toBeLessThanOrEqual(content.get('weighing_post').budget.hard_cap_ms);

    const out = process.env.WP_EXPORT;
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
      writeFileSync(
        out.replace(/\.ndjson$/, '.params.json'),
        JSON.stringify({ [sessionId]: params }, null, 1),
      );
    }
  }, 60_000);

  it('is deterministic for a seed (same plan, same choices) and differs across forms', async () => {
    const a = await playthrough({ seed: 77 });
    const b = await playthrough({ seed: 77 });
    const strip = (ev: EventEnvelope[]) =>
      ev
        .filter((e) => e.event_type === 'response' || e.event_type === 'trial_start')
        .map((e) => [
          e.task?.trial_id,
          e.event_type,
          payloadOf(e).response_value ?? payloadOf(e).trial_type,
        ]);
    expect(strip(a.events)).toEqual(strip(b.events));
    const f2 = await playthrough({ seed: 77, form: 'form_2' });
    expect(f2.plan.newRule.id).not.toBe(a.plan.newRule.id);
  }, 90_000);

  it('runs in portrait with strict touch-target checks', async () => {
    const { result, events } = await playthrough({ seed: 9, width: 1080, height: 1920, lineMs: 0 });
    expect(result.endedReason).toBe('completed');
    expect(events.filter((e) => e.event_type === 'invalid')).toEqual([]);
  }, 60_000);
});
