/**
 * Crash recovery at kiosk startup (ENG-07, KSK-01, KSK-02 crash policy: abandon, keep consented
 * events, no resume).
 *
 * A session whose renderer died is still open in the outbox. On the next start:
 * - consent never granted (or declined): the session is purged entirely; nothing is ever uploaded
 *   (fail closed, ONB-02);
 * - consent granted and the session already ended (`session_end` / `session_tombstone` stored):
 *   it is simply closed;
 * - otherwise `session.abandoned{reason:'crash_recovery'}`, an updated `session.context` (when one was
 *   logged) and `session_end{reason:'crash_recovery'}` are appended at the next gapless seqs, and the
 *   session is closed so its consented events upload normally.
 *
 * Recovery envelopes reuse the last stored event's context and versions; `t_mono_ms` repeats the last
 * stored value (it never decreases) and the payload's `elapsed_ms` is that session time.
 */
import {
  checkEventInvariants,
  type EventEnvelope,
  type EventType,
  type InvalidPayload,
  type PayloadOf,
  type SessionContext,
  type SessionState,
} from '@shriii/contracts';
import { formatWallTime } from '../engine/clock.ts';
import { type EventValidator, findForbiddenField } from './event-logger.ts';
import type { KioskOutbox } from './outbox/types.ts';
import { uuidv7 } from './uuid.ts';

export interface RecoveryOptions {
  /** Sessions to leave alone (e.g. one started by this renderer). */
  readonly exclude?: ReadonlySet<string>;
  /** Strict validator (dev builds); invariants and the privacy guard always run. */
  readonly validate?: EventValidator;
  readonly newId?: () => string;
  readonly wallTime?: () => string;
}

export interface RecoveryReport {
  /** Sessions purged because consent was never granted. */
  readonly purged: readonly string[];
  /** Sessions that received `session.abandoned{crash_recovery}` + `session_end`. */
  readonly abandoned: readonly string[];
  /** Sessions that had already ended and were only closed. */
  readonly closed: readonly string[];
  /** Sessions whose recovery failed (left open for the next start). */
  readonly failed: readonly { readonly sessionId: string; readonly error: string }[];
}

const SESSION_STATES: ReadonlySet<string> = new Set<SessionState>([
  'attract',
  'languageSelect',
  'consent',
  'bands',
  'practiceWarmup',
  'play',
  'report',
  'survey',
  'contactOptIn',
  'farewell',
  'wipe',
]);

function isEnvelope(value: unknown): value is EventEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Partial<EventEnvelope>;
  return (
    typeof e.event_type === 'string' &&
    typeof e.seq === 'number' &&
    typeof e.session_id === 'string' &&
    typeof e.context === 'object' &&
    typeof e.versions === 'object' &&
    typeof e.timing === 'object'
  );
}

/** Recoveries in progress per kiosk: concurrent callers (React StrictMode remounts) share one pass. */
const inflight = new Map<string, Promise<RecoveryReport>>();

/** Close or abandon every session a previous renderer left open. Never throws. */
export function recoverInterruptedSessions(
  outbox: KioskOutbox,
  options: RecoveryOptions = {},
): Promise<RecoveryReport> {
  const running = inflight.get(outbox.kioskId);
  if (running) return running;
  const pass = recover(outbox, options).finally(() => inflight.delete(outbox.kioskId));
  inflight.set(outbox.kioskId, pass);
  return pass;
}

async function recover(outbox: KioskOutbox, options: RecoveryOptions): Promise<RecoveryReport> {
  const purged: string[] = [];
  const abandoned: string[] = [];
  const closed: string[] = [];
  const failed: { sessionId: string; error: string }[] = [];
  let open: Awaited<ReturnType<KioskOutbox['openSessions']>>;
  try {
    open = await outbox.openSessions();
  } catch (err) {
    return { purged, abandoned, closed, failed: [{ sessionId: '*', error: message(err) }] };
  }
  for (const info of open) {
    if (options.exclude?.has(info.sessionId)) continue;
    try {
      if (info.consent !== 'granted') {
        await outbox.purgeSession(info.sessionId);
        purged.push(info.sessionId);
        continue;
      }
      const events = (await outbox.sessionEvents(info.sessionId)).filter(isEnvelope);
      if (
        events.some((e) => e.event_type === 'session_end' || e.event_type === 'session_tombstone')
      ) {
        await outbox.closeSession(info.sessionId);
        closed.push(info.sessionId);
        continue;
      }
      const last = events.at(-1);
      if (!last) {
        // Consent granted but no rows survived: nothing to recover; close the empty session.
        await outbox.closeSession(info.sessionId);
        closed.push(info.sessionId);
        continue;
      }
      await appendRecoveryEvents(outbox, info.sessionId, events, last, options);
      await outbox.closeSession(info.sessionId);
      abandoned.push(info.sessionId);
    } catch (err) {
      failed.push({ sessionId: info.sessionId, error: message(err) });
    }
  }
  return { purged, abandoned, closed, failed };
}

async function appendRecoveryEvents(
  outbox: KioskOutbox,
  sessionId: string,
  events: readonly EventEnvelope[],
  last: EventEnvelope,
  options: RecoveryOptions,
): Promise<void> {
  const tMono = events.reduce((m, e) => Math.max(m, e.timing.t_mono_ms), 0);
  let lastState: SessionState = 'attract';
  let moduleId: string | null = null;
  let trialId: string | null = null;
  let context: SessionContext | null = null;
  for (const e of events) {
    if (e.event_type === 'session.state_changed') {
      const to = (e.payload as { to_state?: unknown }).to_state;
      if (typeof to === 'string' && SESSION_STATES.has(to)) lastState = to as SessionState;
    } else if (e.event_type === 'session.context') {
      context = (e.payload as { context: SessionContext }).context;
    }
    if (e.task) {
      moduleId = e.task.module_id;
      trialId = e.task.trial_id;
    }
  }
  const elapsed = Math.round(tMono);
  const build = <T extends EventType>(type: T, payload: PayloadOf<T>, seq: number): EventEnvelope =>
    checked(
      {
        schema_version: last.schema_version,
        event_id: (options.newId ?? uuidv7)(),
        event_type: type,
        seq,
        session_id: sessionId,
        context: last.context,
        versions: last.versions,
        task: null,
        condition: null,
        timing: {
          t_mono_ms: tMono,
          kiosk_t_wall: (options.wallTime ?? (() => formatWallTime(Date.now())))(),
          timing_flag: 'ok',
          scorable: false,
          interrupted: false,
        },
        server: { server_received_at: null, clock_offset_estimate_ms: null, batch_id: null },
        payload,
      } as EventEnvelope,
      options.validate,
    );
  await outbox.append(sessionId, (seq) =>
    build(
      'session.abandoned',
      {
        last_state: lastState,
        module_id: moduleId,
        trial_id: trialId,
        elapsed_ms: elapsed,
        reason: 'crash_recovery',
      },
      seq,
    ),
  );
  if (context) {
    const updated: SessionContext = {
      ...context,
      language: context.language ?? last.context.language,
      completion: 'abandoned',
      walkaway_point: { state: lastState, module_id: moduleId, trial_id: trialId },
    };
    await outbox.append(sessionId, (seq) => build('session.context', { context: updated }, seq));
  }
  await outbox.append(sessionId, (seq) =>
    build('session_end', { reason: 'crash_recovery', duration_ms: elapsed }, seq),
  );
}

/** Same validation as the logger: a failing envelope becomes an `invalid` placeholder (same seq). */
function checked(envelope: EventEnvelope, validate: EventValidator | undefined): EventEnvelope {
  let reason: InvalidPayload['reason'] | null = null;
  let schemaPath: string | null = null;
  const forbidden = findForbiddenField(envelope.payload);
  if (forbidden) {
    reason = 'privacy_guard';
    schemaPath = forbidden;
  } else {
    const v = validate?.(envelope);
    if (v && !v.ok) {
      reason = 'schema_violation';
      schemaPath = v.schemaPath;
    } else {
      const inv = checkEventInvariants(envelope, 'kiosk');
      if (inv.length > 0) {
        reason = 'schema_violation';
        schemaPath = inv[0]?.path ?? null;
      }
    }
  }
  if (reason === null) return envelope;
  const payload: InvalidPayload = {
    reason,
    original_event_type: envelope.event_type,
    schema_path: schemaPath,
  };
  return { ...envelope, event_type: 'invalid', payload } as EventEnvelope;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
