/**
 * Scoring-convention checks shared by the set-2 module tests. The tables mirror
 * `stats/scoring/src/shriii_scoring/conventions.py` (MODULE_TRIAL_TYPES, RESPONSE_CODES, PARAM_KEYS)
 * for the four set-2 modules; the Python verification run (`hub/dev/score_events.py`) checks the same
 * streams against the real indicator engine.
 */
import { checkSessionSequence, type EventEnvelope, validateEvent } from '@shriii/contracts';
import { expect } from 'vitest';

export const TRIAL_TYPES: Readonly<Record<string, readonly string[]>> = {
  share_pot: ['round', 'tone_choice', 'probe'],
  steady_hands: ['target', 'probe'],
  four_stalls: ['choice', 'probe'],
  private_dice: ['report', 'probe'],
};

export const RESPONSE_CODES: Readonly<Record<string, readonly string[] | null>> = {
  round: ['contribute'],
  tone_choice: ['firm', 'neutral', 'warm'],
  target: ['tap'],
  choice: ['stall_a', 'stall_b', 'stall_c', 'stall_d'],
  probe: ['safe', 'risky'],
  report: null,
};

export const PARAM_KEYS: Readonly<Record<string, readonly string[]>> = {
  target: ['distractor'],
  choice: ['repeat_group_id', 'high_variance_stalls'],
  probe: ['repeat_group_id'],
};

/** Envelope validity, gapless seq, closed trials and the scoring conventions for one module. */
export function expectValidModuleStream(
  events: readonly EventEnvelope[],
  params: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  moduleId: string,
): void {
  for (const e of events) {
    const r = validateEvent(e);
    expect(r.ok, `${e.event_type} #${e.seq}: ${JSON.stringify(r)}`).toBe(true);
  }
  expect(checkSessionSequence([...events])).toEqual([]);
  expect(events.filter((e) => e.event_type === 'invalid')).toEqual([]);
  const mine = events.filter((e) => e.task?.module_id === moduleId);
  const starts = mine.filter((e) => e.event_type === 'trial_start');
  const ends = mine.filter((e) => e.event_type === 'trial_end');
  expect(starts.length).toBeGreaterThan(0);
  expect(ends.length).toBe(starts.length);
  const allowed = TRIAL_TYPES[moduleId] ?? [];
  for (const s of starts) {
    const p = s.payload as { trial_type: string };
    expect(allowed, `${moduleId} trial type ${p.trial_type}`).toContain(p.trial_type);
    const tid = s.task?.trial_id as string;
    expect(s.task?.block_id?.startsWith(`${moduleId}.`)).toBe(true);
    expect(tid.startsWith(`${moduleId}.t`)).toBe(true);
    for (const key of PARAM_KEYS[p.trial_type] ?? []) {
      expect(params[tid], `params of ${tid}`).toBeDefined();
      expect(Object.hasOwn(params[tid] ?? {}, key), `${tid} params.${key}`).toBe(true);
    }
  }
  // Responses: one per trial, closed codes, timeouts with null latency, inside their trial.
  const byTrial = new Map<string, EventEnvelope[]>();
  for (const e of mine) {
    const tid = e.task?.trial_id;
    if (!tid) continue;
    byTrial.set(tid, [...(byTrial.get(tid) ?? []), e]);
  }
  for (const [tid, evs] of byTrial) {
    const start = evs.find((e) => e.event_type === 'trial_start');
    const end = evs.find((e) => e.event_type === 'trial_end');
    expect(start, tid).toBeDefined();
    expect(end, tid).toBeDefined();
    expect((end as EventEnvelope).seq).toBe(Math.max(...evs.map((e) => e.seq)));
    const type = (start?.payload as { trial_type: string } | undefined)?.trial_type ?? '';
    const responses = evs.filter((e) => e.event_type === 'response');
    expect(responses.length, `${tid} responses`).toBe(1);
    const r = responses[0]?.payload as {
      response_value: string | null;
      input_mode: string;
      latency_ms: number | null;
    };
    if (r.input_mode === 'timeout') {
      expect(r.response_value).toBeNull();
      expect(r.latency_ms).toBeNull();
    } else {
      const codes = RESPONSE_CODES[type];
      if (codes) expect(codes, `${tid} code`).toContain(r.response_value);
      expect(typeof r.latency_ms).toBe('number');
    }
    const onsets = evs.filter((e) => e.event_type === 'stimulus_onset');
    expect(onsets.length, `${tid} onsets`).toBeGreaterThan(0);
  }
  // Probe segments: four comparable situations with the shared repeat-group ids.
  const probes = starts.filter((s) => (s.payload as { trial_type: string }).trial_type === 'probe');
  expect(probes.length).toBe(4);
  expect(probes.map((p) => params[p.task?.trial_id as string]?.repeat_group_id)).toEqual([
    'probe_situation_0',
    'probe_situation_1',
    'probe_situation_2',
    'probe_situation_3',
  ]);
  for (const p of probes) expect(p.task?.probe_group_id).toBe(`${moduleId}.probe`);
}
