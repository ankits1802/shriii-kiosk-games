import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintProfile } from '../scripts/generate.ts';
import { validateEventEnvelope as directValidate } from '../src/generated/validators/event-envelope.js';
import * as validators from '../src/generated/validators/index.js';
import {
  CONSTRUCT_IDS,
  checkEventInvariants,
  checkSessionSequence,
  checkTrialSpecInvariants,
  EVENT_TYPES,
  type EventEnvelope,
  findForbiddenFieldNames,
  type GameTrialSpec,
  makeEvent,
  readEvent,
  readEventEnvelope,
  type StandaloneValidator,
  validateEvent,
} from '../src/index.ts';
import {
  fixturesRoot,
  listSchemaFiles,
  loadFixtures,
  packageRoot,
  readJson,
  schemasRoot,
} from './fixtures.ts';

const toPascal = (kebab: string): string =>
  kebab
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');

function strictFor(contract: string): StandaloneValidator<unknown> {
  const v = (validators as Record<string, unknown>)[`validate${toPascal(contract)}`];
  if (typeof v !== 'function') throw new Error(`no strict validator for ${contract}`);
  return v as StandaloneValidator<unknown>;
}

function readerFor(contract: string): StandaloneValidator<unknown> {
  const v = (validators as Record<string, unknown>)[`read${toPascal(contract)}`];
  if (typeof v !== 'function') throw new Error(`no reader validator for ${contract}`);
  return v as StandaloneValidator<unknown>;
}

describe('schema profile', () => {
  it.each(listSchemaFiles())('%s is within the restricted profile', (file) => {
    expect(lintProfile(file, readJson(join(schemasRoot, file)) as never)).toEqual([]);
  });

  it('the profile linter rejects banned keywords and undiscriminated oneOf', () => {
    const bad = { if: { type: 'string' }, oneOf: [{ type: 'string' }, { type: 'number' }] };
    const errors = lintProfile('bad.json', bad);
    expect(errors.some((e) => e.includes('"if"'))).toBe(true);
    expect(errors.some((e) => e.includes('oneOf without discriminator'))).toBe(true);
  });

  it.each(listSchemaFiles())('%s has no free-text/transcript/audio field names', (file) => {
    expect(findForbiddenFieldNames(readJson(join(schemasRoot, file)))).toEqual([]);
  });

  it('generated code is in sync with the schemas (no drift)', () => {
    const out = execFileSync(
      process.execPath,
      [join(packageRoot, 'scripts', 'generate.ts'), '--check'],
      {
        encoding: 'utf8',
      },
    );
    expect(out).toContain('up to date');
  }, 120_000);
});

describe('catalogue', () => {
  it('covers every event type from plan section 6.1', () => {
    const required = [
      'session_start',
      'session.state_changed',
      'language_selected',
      'language_switched',
      'consent.granted',
      'consent.declined',
      'optin.archive',
      'optin.contact',
      'bands.answered',
      'practice.summary',
      'calibration_result',
      'module_start',
      'module_end',
      'trial_start',
      'stimulus_onset',
      'prompt_audio_end',
      'prompt_window_open',
      'prompt_window_close',
      'response',
      'asr_result',
      'input.raw_tap',
      'input.hold',
      'trial_end',
      'context_shift',
      'move',
      'route_step',
      'contribution',
      'pump',
      'report',
      'partner_action',
      'turn_event',
      'credit_allocation',
      'idle',
      'walkaway.prompted',
      'walkaway.resumed',
      'session.abandoned',
      'instruction_replay',
      'ui.replay',
      'audio.played',
      'env.noise_dbfs',
      'env.headset',
      'a11y.profile',
      'onlooker_reported',
      'researcher_annotation',
      'invalid',
      'report.delivered',
      'report.withheld',
      'survey.enjoy',
      'survey.play_again',
      'erasure_requested',
      'session_tombstone',
      'device_health',
      'session_end',
      'session.context',
    ];
    expect([...EVENT_TYPES].sort()).toEqual([...required].sort());
  });

  it('has exactly 17 constructs', () => {
    expect(CONSTRUCT_IDS).toHaveLength(17);
  });

  it('has a valid fixture for every event type', () => {
    const names = new Set(
      loadFixtures('valid')
        .filter((f) => f.contract === 'event-envelope')
        .map((f) => (f.data as EventEnvelope).event_type),
    );
    for (const t of EVENT_TYPES) expect(names.has(t), t).toBe(true);
  });
});

describe('fixtures', () => {
  const valid = loadFixtures('valid');
  const invalid = loadFixtures('invalid');
  const forward = loadFixtures('forward-compat');

  it('has fixtures for every public contract', () => {
    const contracts = new Set(valid.map((f) => f.contract));
    for (const c of [
      'event-envelope',
      'upload-batch',
      'upload-batch-result',
      'session-context',
      'content-manifest',
      'game-trial-spec',
      'criterion-response',
      'criterion-scale-score',
      'consent-artefact',
      'report-artefact',
      'release-pack',
    ]) {
      expect(contracts.has(c), c).toBe(true);
    }
  });

  it.each(valid.map((f) => [`${f.contract}/${f.name}`, f] as const))(
    'valid: %s passes strict and reader',
    (_n, f) => {
      const strict = strictFor(f.contract);
      expect(strict(f.data), JSON.stringify(strict.errors)).toBe(true);
      expect(readerFor(f.contract)(f.data)).toBe(true);
    },
  );

  it.each(invalid.map((f) => [`${f.contract}/${f.name}`, f] as const))(
    'invalid: %s fails strict and reader',
    (_n, f) => {
      expect(strictFor(f.contract)(f.data)).toBe(false);
      expect(readerFor(f.contract)(f.data)).toBe(false);
    },
  );

  it.each(forward.map((f) => [`${f.contract}/${f.name}`, f] as const))(
    'forward-compat: %s is accepted by readers and rejected by writers',
    (_n, f) => {
      expect(readerFor(f.contract)(f.data)).toBe(true);
      expect(strictFor(f.contract)(f.data)).toBe(false);
    },
  );

  it('kiosk-produced valid events satisfy the semantic invariants', () => {
    for (const f of valid.filter(
      (x) => x.contract === 'event-envelope' && !x.name.includes('server_ingested'),
    )) {
      expect(checkEventInvariants(f.data as EventEnvelope), f.name).toEqual([]);
    }
  });

  it('the minimal session is gapless, ordered and starts with session_start', () => {
    const events = readJson(
      join(fixturesRoot, 'sessions', 'minimal-session.json'),
    ) as EventEnvelope[];
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    expect(checkSessionSequence(events)).toEqual([]);
    const gapped = events.filter((e) => e.seq !== 4);
    expect(checkSessionSequence(gapped).map((v) => v.code)).toContain('seq_gap');
    const swapped = events.map((e) =>
      e.seq === 6 ? { ...e, timing: { ...e.timing, t_mono_ms: 1 } } : e,
    );
    expect(checkSessionSequence(swapped).map((v) => v.code)).toContain('mono_decreasing');
  });
});

describe('invariants', () => {
  const response = loadFixtures('valid').find((f) => f.name === 'response')?.data as EventEnvelope;

  it('flags a non-null latency on a timeout and a sign/barge_in mismatch', () => {
    const e = structuredClone(response) as Extract<EventEnvelope, { event_type: 'response' }>;
    e.payload.input_mode = 'timeout';
    expect(checkEventInvariants(e).map((v) => v.code)).toContain('latency_null_iff_timeout');
    const b = structuredClone(response) as Extract<EventEnvelope, { event_type: 'response' }>;
    b.payload.latency_ms = -50;
    expect(checkEventInvariants(b).map((v) => v.code)).toContain('barge_in_sign');
  });

  it('flags server fields on kiosk-origin events', () => {
    const e = structuredClone(response);
    e.server = { ...e.server, server_received_at: '2026-10-21T00:00:00Z' };
    expect(checkEventInvariants(e, 'kiosk').map((v) => v.code)).toContain('server_fields_on_kiosk');
    expect(checkEventInvariants(e, 'server').map((v) => v.code)).not.toContain(
      'server_fields_on_kiosk',
    );
  });

  it('requires voice vocabulary to be a subset of touch vocabulary', () => {
    const spec = readJson(
      join(fixturesRoot, 'valid', 'game-trial-spec', 'weighing_say_or_touch.json'),
    ) as GameTrialSpec;
    expect(checkTrialSpecInvariants(spec)).toEqual([]);
    expect(
      checkTrialSpecInvariants({ ...spec, voice_vocabulary: ['approve', 'bribe'] }).map(
        (v) => v.code,
      ),
    ).toContain('voice_not_subset_of_touch');
    expect(
      checkTrialSpecInvariants({ ...spec, private_report: true }).map((v) => v.code),
    ).toContain('private_report_voice');
  });
});

describe('API', () => {
  it('validateEvent returns typed values or issues with schema paths', () => {
    const ok = validateEvent(readJson(join(fixturesRoot, 'valid', 'event-envelope', 'pump.json')));
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.value.event_type === 'pump') expect(ok.value.payload.balloon_index).toBe(5);
    const bad = validateEvent(
      readJson(join(fixturesRoot, 'invalid', 'event-envelope', 'bad_input_mode.json')),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]?.schemaPath).toBeTruthy();
  });

  it('readEvent tolerates minor N+1 fields', () => {
    const f = readJson(
      join(fixturesRoot, 'forward-compat', 'event-envelope', 'minor_version_bump.json'),
    );
    expect(readEvent(f).ok).toBe(true);
    expect(readEventEnvelope(f)).toBe(true);
    expect(validateEvent(f).ok).toBe(false);
  });

  it('the per-contract validator module matches the barrel export', () => {
    const f = readJson(join(fixturesRoot, 'valid', 'event-envelope', 'trial_end.json'));
    expect(directValidate(f)).toBe(true);
  });

  it('makeEvent produces a valid event from common fields and a payload', () => {
    const base = readJson(
      join(fixturesRoot, 'valid', 'event-envelope', 'idle.json'),
    ) as EventEnvelope;
    const { event_type: _t, payload: _p, ...common } = base;
    const e = makeEvent(common, 'survey.play_again', { answer: 'no' });
    expect(validateEvent(e).ok).toBe(true);
  });
});
