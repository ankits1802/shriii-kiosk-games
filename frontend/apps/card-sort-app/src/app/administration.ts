import { uuid4 } from '../data/crypto.ts';
import type { CardSortStore } from '../data/store.ts';
import type { LanguageTag, SessionRecord, TrialRecord } from '../data/types.ts';
import { createEngine, type EngineState, replay } from '../domain/engine.ts';
import { isValidPid } from '../domain/pid.ts';
import { type ProtocolConfig, validateProtocol } from '../domain/protocol.ts';
import { scoreCardSort } from '../domain/scoring.ts';
import { newOutboxItem } from '../sync/records.ts';

export const IDENTIFIER = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;

export interface StartInput {
  readonly pid: string;
  readonly pidSource: 'qr' | 'typed';
  readonly studyId: string;
  readonly occasionId: string;
  readonly wave: number;
  readonly language: LanguageTag;
  readonly protocol: ProtocolConfig;
  readonly administratorId: string;
  readonly deviceId: string;
  readonly audioVersion: string | null;
}

/** Problems with the start form (empty = can start). */
export function validateStart(input: StartInput): string[] {
  const errors: string[] = [];
  if (!isValidPid(input.pid))
    errors.push('Participant code is not valid (check character mismatch).');
  if (!IDENTIFIER.test(input.studyId)) errors.push('Study id must be a lower-case identifier.');
  if (!IDENTIFIER.test(input.occasionId))
    errors.push('Occasion id must be a lower-case identifier.');
  if (!IDENTIFIER.test(input.administratorId))
    errors.push('Administrator id must be a lower-case identifier.');
  if (!IDENTIFIER.test(input.deviceId)) errors.push('Device id must be a lower-case identifier.');
  if (!Number.isInteger(input.wave) || input.wave < 1) errors.push('Wave must be 1 or more.');
  errors.push(...validateProtocol(input.protocol));
  return errors;
}

export async function startAdministration(
  store: CardSortStore,
  input: StartInput,
  now = new Date(),
): Promise<{ session: SessionRecord; engine: EngineState }> {
  const errors = validateStart(input);
  if (errors.length) throw new Error(errors.join(' '));
  const session: SessionRecord = {
    sessionId: uuid4(),
    pid: input.pid,
    studyId: input.studyId,
    occasionId: input.occasionId,
    wave: input.wave,
    language: input.language,
    protocol: input.protocol,
    administratorId: input.administratorId,
    deviceId: input.deviceId,
    audioVersion: input.audioVersion,
    pidSource: input.pidSource,
    status: 'in_progress',
    startedAt: now.toISOString(),
    endedAt: null,
    abortReason: null,
    scores: null,
  };
  await store.saveSession(session);
  await store.audit(input.administratorId, 'session_started', {
    session_id: session.sessionId,
    pid_source: input.pidSource,
    study_id: input.studyId,
    occasion_id: input.occasionId,
    language: input.language,
    protocol_id: input.protocol.protocolId,
    deck_size: input.protocol.deckSize,
    rule_sequence: input.protocol.ruleSequence,
  });
  return { session, engine: createEngine(input.protocol) };
}

export async function recordTrial(
  store: CardSortStore,
  session: SessionRecord,
  trial: TrialRecord,
): Promise<void> {
  await store.appendTrial(session.sessionId, trial);
}

/** Score, close the session and queue its records for sync. */
export async function completeAdministration(
  store: CardSortStore,
  session: SessionRecord,
  engine: EngineState,
  now = new Date(),
): Promise<SessionRecord> {
  const { trials: _detail, ...scores } = scoreCardSort(session.protocol, engine.trials);
  const done: SessionRecord = {
    ...session,
    status: 'completed',
    endedAt: now.toISOString(),
    scores,
  };
  await store.saveSession(done);
  const item = newOutboxItem(done, now);
  await store.putOutbox(item);
  await store.audit(session.administratorId, 'session_completed', {
    session_id: session.sessionId,
    trials: scores.trialsAdministered,
    categories_completed: scores.categoriesCompleted,
  });
  await store.audit(session.administratorId, 'records_queued', {
    session_id: session.sessionId,
    outbox_id: item.id,
    criterion_responses: item.payload.criterion_responses.length,
    criterion_scale_scores: item.payload.criterion_scale_scores.length,
  });
  return done;
}

export async function abortAdministration(
  store: CardSortStore,
  session: SessionRecord,
  engine: EngineState,
  reason: string,
  actor: string,
  now = new Date(),
): Promise<SessionRecord> {
  const { trials: _detail, ...scores } = scoreCardSort(session.protocol, engine.trials);
  const aborted: SessionRecord = {
    ...session,
    status: 'aborted',
    endedAt: now.toISOString(),
    abortReason: reason,
    scores,
  };
  await store.saveSession(aborted);
  await store.audit(actor, 'session_aborted', {
    session_id: session.sessionId,
    reason,
    trials: engine.trials.length,
  });
  return aborted;
}

export async function resumeAdministration(
  store: CardSortStore,
  sessionId: string,
  actor: string,
): Promise<{ session: SessionRecord; engine: EngineState }> {
  const session = await store.getSession(sessionId);
  if (session?.status !== 'in_progress') throw new Error('no in-progress session');
  const engine = replay(session.protocol, await store.listTrials(sessionId));
  await store.audit(actor, 'session_resumed', {
    session_id: sessionId,
    trials: engine.trials.length,
  });
  return { session, engine };
}
