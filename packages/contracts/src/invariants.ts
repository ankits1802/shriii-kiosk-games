/**
 * Semantic invariants that the restricted JSON Schema profile cannot express (no if/then/else).
 * Mirrored in python/shriii_contracts (invariants.py); both are exercised by the shared fixtures.
 */
import type { EventEnvelope, GameTrialSpec } from './generated/types.ts';

/** One violated invariant. `code` is stable and suitable for DLQ reason codes. */
export interface InvariantViolation {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** Field names that must never appear in any contract (PLT-02, VOX-04, PRV-03). */
export const FORBIDDEN_FIELD_NAMES = [
  'text',
  'free_text',
  'transcript',
  'audio',
  'asr_alternatives',
] as const;

const NON_SCORABLE_PHASES = new Set(['practice', 'warmup']);

function violation(code: string, path: string, message: string): InvariantViolation {
  return { code, path, message };
}

/**
 * Check one event. `origin` is `kiosk` for events produced on a kiosk (server fields must be null)
 * and `server` for events after ingestion.
 */
export function checkEventInvariants(
  event: EventEnvelope,
  origin: 'kiosk' | 'server' = 'kiosk',
): InvariantViolation[] {
  const v: InvariantViolation[] = [];
  if (origin === 'kiosk') {
    const s = event.server;
    if (
      s.server_received_at !== null ||
      s.clock_offset_estimate_ms !== null ||
      s.batch_id !== null
    ) {
      v.push(
        violation(
          'server_fields_on_kiosk',
          '/server',
          'kiosk events must carry null server fields',
        ),
      );
    }
  }
  if (event.condition && NON_SCORABLE_PHASES.has(event.condition.phase) && event.timing.scorable) {
    v.push(
      violation(
        'practice_scorable',
        '/timing/scorable',
        'practice and warm-up events must be scorable=false',
      ),
    );
  }
  switch (event.event_type) {
    case 'response': {
      const p = event.payload;
      const isTimeout = p.input_mode === 'timeout';
      if (isTimeout !== (p.latency_ms === null)) {
        v.push(
          violation(
            'latency_null_iff_timeout',
            '/payload/latency_ms',
            'latency_ms is null exactly when input_mode is timeout',
          ),
        );
      }
      if (p.latency_ms !== null && p.barge_in !== p.latency_ms < 0) {
        v.push(
          violation(
            'barge_in_sign',
            '/payload/barge_in',
            'barge_in is true exactly when latency_ms is negative',
          ),
        );
      }
      if (isTimeout && p.response_value !== null) {
        v.push(
          violation(
            'timeout_with_value',
            '/payload/response_value',
            'timeouts carry no response_value',
          ),
        );
      }
      const voice = p.input_mode === 'voice' || p.input_mode === 'voice_then_touch_confirm';
      if (!voice && (p.asr_label ?? null) !== null) {
        v.push(
          violation(
            'asr_label_without_voice',
            '/payload/asr_label',
            'asr_label requires a voice input mode',
          ),
        );
      }
      break;
    }
    case 'consent.granted':
    case 'consent.declined':
    case 'optin.archive':
    case 'optin.contact':
    case 'bands.answered':
      if (event.timing.scorable) {
        v.push(
          violation(
            'onboarding_scorable',
            '/timing/scorable',
            'onboarding and consent events are never scorable',
          ),
        );
      }
      break;
    case 'module_start': {
      const p = event.payload;
      if (p.soft_cap_ms > p.hard_cap_ms) {
        v.push(
          violation(
            'caps_order',
            '/payload/soft_cap_ms',
            'soft_cap_ms must not exceed hard_cap_ms',
          ),
        );
      }
      break;
    }
    default:
      break;
  }
  return v;
}

/**
 * Check ordering invariants over one session's events (ENG-01, ENG-07, ING-05): a single session,
 * gapless `seq` from 0, unique `event_id`, non-decreasing `t_mono_ms`, session_start first.
 */
export function checkSessionSequence(events: readonly EventEnvelope[]): InvariantViolation[] {
  const v: InvariantViolation[] = [];
  if (events.length === 0) return v;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const sessionId = sorted[0]?.session_id;
  const seen = new Set<string>();
  let lastMono = Number.NEGATIVE_INFINITY;
  sorted.forEach((e, i) => {
    if (e.session_id !== sessionId) {
      v.push(violation('mixed_sessions', `/${i}/session_id`, 'events from more than one session'));
    }
    if (e.seq !== i) {
      v.push(violation('seq_gap', `/${i}/seq`, `expected seq ${i}, found ${e.seq}`));
    }
    if (seen.has(e.event_id)) {
      v.push(violation('duplicate_event_id', `/${i}/event_id`, 'duplicate event_id'));
    }
    seen.add(e.event_id);
    if (e.timing.t_mono_ms < lastMono) {
      v.push(violation('mono_decreasing', `/${i}/timing/t_mono_ms`, 't_mono_ms decreased'));
    }
    lastMono = e.timing.t_mono_ms;
  });
  if (sorted[0]?.event_type !== 'session_start') {
    v.push(
      violation('missing_session_start', '/0/event_type', 'first event must be session_start'),
    );
  }
  return v;
}

/** voiceOptions must be a subset of touchOptions for every SayOrTouch prompt (VOX-04 AC). */
export function checkTrialSpecInvariants(spec: GameTrialSpec): InvariantViolation[] {
  const touch = new Set(spec.vocabulary);
  const extra = spec.voice_vocabulary.filter((code) => !touch.has(code));
  const v: InvariantViolation[] = [];
  if (extra.length > 0) {
    v.push(
      violation(
        'voice_not_subset_of_touch',
        '/voice_vocabulary',
        `not in vocabulary: ${extra.join(', ')}`,
      ),
    );
  }
  if (spec.private_report && spec.voice_vocabulary.length > 0) {
    v.push(
      violation('private_report_voice', '/voice_vocabulary', 'private reports are touch only'),
    );
  }
  if (spec.anchor_trial && !spec.scorable) {
    v.push(violation('anchor_not_scorable', '/anchor_trial', 'anchor trials must be scorable'));
  }
  if ((spec.phase === 'practice' || spec.phase === 'warmup') && spec.scorable) {
    v.push(
      violation('practice_scorable', '/scorable', 'practice and warm-up trials are never scorable'),
    );
  }
  return v;
}

/**
 * Recursively list every `properties` key in a JSON Schema whose name is forbidden. Used by tests
 * to enforce that no contract can carry free text, transcripts or audio.
 */
export function findForbiddenFieldNames(schema: unknown, path = '#'): string[] {
  const hits: string[] = [];
  if (Array.isArray(schema)) {
    schema.forEach((s, i) => {
      hits.push(...findForbiddenFieldNames(s, `${path}/${i}`));
    });
    return hits;
  }
  if (schema === null || typeof schema !== 'object') return hits;
  for (const [k, sub] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'properties' && sub !== null && typeof sub === 'object') {
      for (const [name, propSchema] of Object.entries(sub as Record<string, unknown>)) {
        if ((FORBIDDEN_FIELD_NAMES as readonly string[]).includes(name)) {
          hits.push(`${path}/properties/${name}`);
        }
        hits.push(...findForbiddenFieldNames(propSchema, `${path}/properties/${name}`));
      }
    } else {
      hits.push(...findForbiddenFieldNames(sub, `${path}/${k}`));
    }
  }
  return hits;
}
