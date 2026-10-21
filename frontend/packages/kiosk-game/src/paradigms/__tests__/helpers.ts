import type { GameTrialSpec } from '@shriii/contracts';
import { createSessionRng } from '../../engine/rng.ts';

/** Well-spread 64-bit hex seeds. */
export function seedOf(i: number): string {
  return ((BigInt(i + 1) * 0x9e3779b97f4a7c15n) % (1n << 64n)).toString(16).padStart(16, '0');
}

/** A named stream for paradigm tests. */
export function rngFor(i: number, name = 'paradigm') {
  return createSessionRng(seedOf(i)).stream(name);
}

/** fast-check arbitrary for 16-hex-char seeds is built from integers via seedOf. */
export function params(t: GameTrialSpec): Record<string, unknown> {
  return t.params as Record<string, unknown>;
}

/** A minimal valid trial spec for tests. */
export function baseSpec(overrides: Partial<GameTrialSpec> = {}): GameTrialSpec {
  return {
    schema_version: '1.0',
    trial_id: 'test.block.0',
    module_id: 'test',
    episode_id: null,
    block_id: 'block',
    trial_index: 0,
    trial_type: 'test',
    phase: 'main',
    condition_id: 'standard',
    calibration_level: 'L2',
    response_window_ms: null,
    stimulus_id: null,
    vocabulary: ['tap'],
    voice_vocabulary: [],
    audio_keys: [],
    private_report: false,
    anchor_trial: false,
    form_id: 'form_1',
    probe_group_id: null,
    scorable: true,
    expected_response: null,
    latency_anchor: 'visual_onset',
    timing: { stimulus_duration_ms: null, isi_ms: null, jitter_ms: null },
    params: {},
    ...overrides,
  };
}
