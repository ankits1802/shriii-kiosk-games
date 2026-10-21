/**
 * Logger SDK (ENG-07, ING-01). Builds complete event envelopes, validates them, and writes them to
 * the outbox in strict order.
 *
 * - `seq` is gapless per session: the logger reserves the next seq synchronously (so `log()` can
 *   return a receipt without awaiting storage) and every write goes through one serial queue into
 *   `Outbox.append`, which allocates the same seq in the same transaction as the row. Child loggers
 *   share the queue, so concurrency cannot create gaps or reorderings.
 * - An event that fails validation (strict Ajv in dev, semantic invariants and the privacy guard
 *   always) is replaced by an `invalid` placeholder with the same seq, so `seq` stays gapless.
 * - `t_mono_ms` never decreases; server fields are always null on the kiosk.
 * - Logging never throws into gameplay; storage failures are reported via `onWriteError`.
 */
import {
  checkEventInvariants,
  type EventCondition,
  type EventEnvelope,
  type EventSessionContext,
  type EventTaskPosition,
  type EventType,
  type EventVersions,
  FORBIDDEN_FIELD_NAMES,
  type InvalidPayload,
  type PayloadOf,
} from '@shriii/contracts';
import type {
  Clock,
  EventLogger,
  LoggedEvent,
  LogOptions,
  LogScope,
  Outbox,
} from '../core/contracts.ts';
import { combineTimingFlags } from '../engine/timing.ts';
import { uuidv7 } from './uuid.ts';

/** Validation hook result. */
export type EventValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly schemaPath: string | null; readonly message: string };

/** Pluggable validator (dev: strict Ajv standalone validator; see {@link ajvEventValidator}). */
export type EventValidator = (event: unknown) => EventValidationResult;

/** Minimal Ajv standalone validator surface. */
interface StandaloneLike {
  (data: unknown): boolean;
  errors?:
    | readonly {
        readonly schemaPath: string;
        readonly instancePath: string;
        readonly message?: string;
      }[]
    | null;
}

/** Adapt an Ajv standalone validator (e.g. `validateEventEnvelope`) to an {@link EventValidator}. */
export function ajvEventValidator(validator: StandaloneLike): EventValidator {
  return (event) => {
    if (validator(event)) return { ok: true };
    const first = validator.errors?.[0];
    return {
      ok: false,
      schemaPath: first?.schemaPath ?? null,
      message: first
        ? `${first.instancePath || '/'} ${first.message ?? ''}`.trim()
        : 'schema violation',
    };
  };
}

/** Event types that are never scorable regardless of scope (onboarding/consent, plan §6.1). */
const NEVER_SCORABLE: ReadonlySet<EventType> = new Set<EventType>([
  'session_start',
  'session.context',
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
  'session.abandoned',
  'session_end',
  'session_tombstone',
  'erasure_requested',
  'report.delivered',
  'report.withheld',
  'survey.enjoy',
  'survey.play_again',
  'device_health',
  'invalid',
]);

const FORBIDDEN = new Set<string>(FORBIDDEN_FIELD_NAMES);

/** Path of the first forbidden field name in a payload, or null. */
export function findForbiddenField(value: unknown, path = '/payload'): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = findForbiddenField(v, `${path}/${i}`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN.has(k)) return `${path}/${k}`;
    const hit = findForbiddenField(v, `${path}/${k}`);
    if (hit) return hit;
  }
  return null;
}

/** Options for {@link createSessionLogger}. */
export interface SessionLoggerOptions {
  readonly sessionId: string;
  readonly outbox: Outbox;
  readonly clock: Clock;
  /** Live session context (language, arm and slot change during onboarding). */
  readonly context: () => EventSessionContext;
  readonly versions: EventVersions;
  /** True once core consent is granted; nothing is scorable before. */
  readonly consentGranted: () => boolean;
  /** Strict validator (dev builds); semantic invariants and the privacy guard always run. */
  readonly validate?: EventValidator;
  /** First seq to allocate (from `outbox.nextSeq`; 0 for a new session). */
  readonly firstSeq?: number;
  readonly newId?: () => string;
  /** Called synchronously with every envelope that will be written (placeholders included). */
  readonly onEvent?: (event: EventEnvelope) => void;
  /**
   * True when the trial at `task` was interrupted by a pause (walkaway prompt, KSK-04): every later
   * event of that trial carries `timing.interrupted = true` so it is excluded from latency indicators.
   */
  readonly isInterrupted?: (task: EventTaskPosition) => boolean;
  readonly onWriteError?: (error: unknown, event: EventEnvelope) => void;
}

/** Shared state of a session's logger tree. */
class LoggerCore {
  nextSeq: number;
  lastMono = 0;
  queue: Promise<void> = Promise.resolve();
  invalidCount = 0;
  writeErrors = 0;
  seqMismatches = 0;
  readonly listeners = new Set<(e: EventEnvelope) => void>();
  readonly options: SessionLoggerOptions;
  readonly newId: () => string;

  constructor(options: SessionLoggerOptions) {
    this.options = options;
    this.nextSeq = options.firstSeq ?? 0;
    this.newId = options.newId ?? uuidv7;
    if (options.onEvent) this.listeners.add(options.onEvent);
  }
}

/** The engine's {@link EventLogger}. */
export class SessionEventLogger implements EventLogger {
  readonly sessionId: string;
  readonly scope: LogScope;
  private readonly core: LoggerCore;

  /** Use {@link createSessionLogger}. */
  constructor(core: LoggerCore, scope: LogScope) {
    this.core = core;
    this.sessionId = core.options.sessionId;
    this.scope = scope;
  }

  /** Number of events replaced by `invalid` placeholders so far. */
  get invalidCount(): number {
    return this.core.invalidCount;
  }

  /** Number of failed outbox writes so far. */
  get writeErrorCount(): number {
    return this.core.writeErrors;
  }

  /** Next seq that will be allocated. */
  get nextSeq(): number {
    return this.core.nextSeq;
  }

  /** Observe every envelope (calibration derivation, devtools). */
  onEvent(listener: (event: EventEnvelope) => void): () => void {
    this.core.listeners.add(listener);
    return () => this.core.listeners.delete(listener);
  }

  child(scope: Partial<LogScope>): SessionEventLogger {
    return new SessionEventLogger(this.core, { ...this.scope, ...scope });
  }

  log<T extends EventType>(type: T, payload: PayloadOf<T>, options: LogOptions = {}): LoggedEvent {
    const core = this.core;
    const o = core.options;
    const seq = core.nextSeq;
    core.nextSeq += 1;
    const now = o.clock.now();
    const tMono = Math.round(Math.max(core.lastMono, now) * 1000) / 1000;
    core.lastMono = tMono;
    const task: EventTaskPosition | null =
      options.task !== undefined ? options.task : this.scope.task;
    const condition: EventCondition | null =
      options.condition !== undefined ? options.condition : this.scope.condition;
    const phase = condition?.phase;
    const scorable =
      (options.scorable ?? this.scope.scorable) &&
      task !== null &&
      o.consentGranted() &&
      phase !== 'practice' &&
      phase !== 'warmup' &&
      !NEVER_SCORABLE.has(type);
    const uncertified =
      task !== null && !o.clock.profile.certified ? 'uncertified_timing_profile' : null;
    const eventId = core.newId();
    let envelope: EventEnvelope;
    let valid = true;
    try {
      envelope = {
        schema_version: '1.0',
        event_id: eventId,
        event_type: type,
        seq,
        session_id: o.sessionId,
        context: o.context(),
        versions: o.versions,
        task,
        condition,
        timing: {
          t_mono_ms: tMono,
          kiosk_t_wall: o.clock.wallTime(),
          timing_flag: combineTimingFlags(options.timingFlag, uncertified),
          scorable,
          interrupted:
            (options.interrupted ?? false) || (task !== null && (o.isInterrupted?.(task) ?? false)),
        },
        server: { server_received_at: null, clock_offset_estimate_ms: null, batch_id: null },
        payload,
      } as EventEnvelope;
      const problem = this.check(envelope);
      if (problem) {
        valid = false;
        envelope = this.placeholder(envelope, type, problem.reason, problem.schemaPath);
      }
    } catch (err) {
      valid = false;
      envelope = this.placeholder(null, type, 'logger_error', null, { eventId, seq, tMono });
      void err;
    }
    if (!valid) core.invalidCount += 1;
    for (const l of core.listeners) {
      try {
        l(envelope);
      } catch {
        // Observers must never break logging.
      }
    }
    const toWrite = envelope;
    core.queue = core.queue.then(async () => {
      try {
        await o.outbox.append(o.sessionId, (allocated) => {
          if (allocated === toWrite.seq) return toWrite;
          core.seqMismatches += 1;
          return { ...toWrite, seq: allocated };
        });
      } catch (err) {
        core.writeErrors += 1;
        try {
          o.onWriteError?.(err, toWrite);
        } catch {
          // ignore
        }
      }
    });
    return { eventId, seq, tMonoMs: tMono, valid };
  }

  flush(): Promise<void> {
    return this.core.queue;
  }

  /**
   * Build (but do not write or count) a session-level envelope for an externally allocated seq, e.g.
   * the `session_tombstone` appended by `outbox.purgeSession` after a withdrawal.
   */
  buildDetached<T extends EventType>(type: T, payload: PayloadOf<T>, seq: number): EventEnvelope {
    const o = this.core.options;
    const tMono = Math.round(Math.max(this.core.lastMono, o.clock.now()) * 1000) / 1000;
    this.core.lastMono = tMono;
    return {
      schema_version: '1.0',
      event_id: this.core.newId(),
      event_type: type,
      seq,
      session_id: o.sessionId,
      context: o.context(),
      versions: o.versions,
      task: null,
      condition: null,
      timing: {
        t_mono_ms: tMono,
        kiosk_t_wall: o.clock.wallTime(),
        timing_flag: 'ok',
        scorable: false,
        interrupted: false,
      },
      server: { server_received_at: null, clock_offset_estimate_ms: null, batch_id: null },
      payload,
    } as EventEnvelope;
  }

  private check(
    envelope: EventEnvelope,
  ): { reason: InvalidPayload['reason']; schemaPath: string | null } | null {
    const forbidden = findForbiddenField(envelope.payload);
    if (forbidden) return { reason: 'privacy_guard', schemaPath: forbidden };
    const v = this.core.options.validate?.(envelope);
    if (v && !v.ok) return { reason: 'schema_violation', schemaPath: v.schemaPath };
    const inv = checkEventInvariants(envelope, 'kiosk');
    if (inv.length > 0) return { reason: 'schema_violation', schemaPath: inv[0]?.path ?? null };
    return null;
  }

  private placeholder(
    original: EventEnvelope | null,
    originalType: string,
    reason: InvalidPayload['reason'],
    schemaPath: string | null,
    fallback?: { eventId: string; seq: number; tMono: number },
  ): EventEnvelope {
    const o = this.core.options;
    let context: EventSessionContext;
    try {
      context = original?.context ?? o.context();
    } catch {
      context = {
        participant_pid: null,
        kiosk_id: 'unknown',
        site_id: 'unknown',
        site_mode: 'supervised',
        mode: 'public',
        battery_arm: null,
        slot_form: null,
        language: null,
        player_slot: 1,
        synthetic: false,
      };
    }
    const payload: InvalidPayload = {
      reason,
      original_event_type: /^[a-z][a-z_.]{2,127}$/.test(originalType) ? originalType : null,
      schema_path: schemaPath,
    };
    return {
      schema_version: '1.0',
      event_id: original?.event_id ?? fallback?.eventId ?? this.core.newId(),
      event_type: 'invalid',
      seq: original?.seq ?? fallback?.seq ?? 0,
      session_id: o.sessionId,
      context,
      versions: o.versions,
      task: original?.task ?? null,
      condition: original?.condition ?? null,
      timing: {
        t_mono_ms: original?.timing.t_mono_ms ?? fallback?.tMono ?? 0,
        kiosk_t_wall: original?.timing.kiosk_t_wall ?? o.clock.wallTime(),
        timing_flag: original?.timing.timing_flag ?? 'ok',
        scorable: false,
        interrupted: original?.timing.interrupted ?? false,
      },
      server: { server_received_at: null, clock_offset_estimate_ms: null, batch_id: null },
      payload,
    };
  }
}

/** Session-level scope: no task, no condition, not scorable. */
export const SESSION_SCOPE: LogScope = { task: null, condition: null, scorable: false };

/** Create the root logger of a session. */
export function createSessionLogger(options: SessionLoggerOptions): SessionEventLogger {
  return new SessionEventLogger(new LoggerCore(options), SESSION_SCOPE);
}
