/**
 * Turn a completed administration into contract records:
 * - `CriterionResponse` rows (contracts/schemas/criterion-response.v1.schema.json), one per
 *   performance measure registered for `card_sort_criterion.session` in
 *   content/instruments/card-sort-criterion.yaml;
 * - `CriterionScaleScore` rows (criterion-scale-score.v1) for the registry subscales plus the
 *   extended Heaton measures (kept on the device and in exports; the server rescores layer 3);
 * - the `AdministrationIn` body for POST /api/v1/assessment-responses (backend/api/openapi.json).
 * Every record is validated with the generated strict contract validators before it is queued.
 */

import {
  type CriterionResponse,
  type CriterionScaleScore,
  validateCriterionResponseRecord,
  validateCriterionScaleScoreRecord,
} from '@shriii/contracts';
import { uuid4 } from '../data/crypto.ts';
import type { AdministrationIn, OutboxItem, SessionRecord } from '../data/types.ts';
import { type CardSortScores, SCORING_ALGORITHM_VERSION } from '../domain/scoring.ts';

export const INSTRUMENT_ID = 'card_sort_criterion';
export const INSTRUMENT_VERSION = '1.0.0';
export const KEY_VERSION = '1.0.0';
export const SESSION_ITEM = 'card_sort_criterion.session';
export const CONTRACT_MINOR = '1.0';

/** Measures the registry accepts for `card_sort_criterion.session` (sent to the API). */
export const SUBMITTED_MEASURES = [
  'perseverative_errors',
  'categories_completed',
  'trials_administered',
] as const;
type SubmittedMeasure = (typeof SUBMITTED_MEASURES)[number];

/** Registry subscales (scored server-side too) followed by device-only extended measures. */
export const SCALES = [
  'perseverative_errors',
  'categories_completed',
  'perseverative_responses',
  'non_perseverative_errors',
  'total_errors',
  'failure_to_maintain_set',
  'trials_to_first_category',
  'conceptual_level_responses',
] as const;
export type ScaleId = (typeof SCALES)[number];

type Summary = Omit<CardSortScores, 'trials'>;

function measureValue(scores: Summary, m: SubmittedMeasure): number {
  switch (m) {
    case 'perseverative_errors':
      return scores.perseverativeErrors;
    case 'categories_completed':
      return scores.categoriesCompleted;
    case 'trials_administered':
      return scores.trialsAdministered;
  }
}

function scaleValue(scores: Summary, s: ScaleId): number | null {
  switch (s) {
    case 'perseverative_errors':
      return scores.perseverativeErrors;
    case 'categories_completed':
      return scores.categoriesCompleted;
    case 'perseverative_responses':
      return scores.perseverativeResponses;
    case 'non_perseverative_errors':
      return scores.nonPerseverativeErrors;
    case 'total_errors':
      return scores.totalErrors;
    case 'failure_to_maintain_set':
      return scores.failureToMaintainSet;
    case 'trials_to_first_category':
      return scores.trialsToFirstCategory;
    case 'conceptual_level_responses':
      return scores.conceptualLevelResponses;
  }
}

export class RecordValidationError extends Error {
  constructor(
    readonly record: string,
    readonly issues: readonly { path: string; message: string }[],
  ) {
    super(
      `${record} failed contract validation: ${issues.map((i) => `${i.path || '/'} ${i.message}`).join('; ')}`,
    );
    this.name = 'RecordValidationError';
  }
}

export interface BuiltRecords {
  readonly administration: AdministrationIn;
  readonly criterion_responses: CriterionResponse[];
  readonly criterion_scale_scores: CriterionScaleScore[];
}

export function buildRecords(session: SessionRecord, recordedAt: string): BuiltRecords {
  const scores = session.scores;
  if (session.status !== 'completed' || !scores)
    throw new Error('only completed administrations are synced');
  const languageVersion = session.language.toLowerCase();

  const responses: CriterionResponse[] = SUBMITTED_MEASURES.map((m) => ({
    schema_version: CONTRACT_MINOR,
    response_id: uuid4(),
    pid: session.pid,
    study_id: session.studyId,
    wave: session.wave,
    occasion_id: session.occasionId,
    instrument_id: INSTRUMENT_ID,
    instrument_version: INSTRUMENT_VERSION,
    language_version: languageVersion,
    block: 'performance',
    item_id: `${SESSION_ITEM}.${m}`,
    raw_response: measureValue(scores, m),
    response_latency_ms: null,
    administration_mode: 'read_aloud',
    administrator_id: session.administratorId,
    rater_role: 'self',
    rated_pid: null,
    device_id: session.deviceId,
    audio_version: session.audioVersion,
    attention_check: false,
    source: 'in_app',
    recorded_at: recordedAt,
    supersedes_id: null,
  }));
  for (const r of responses) {
    const res = validateCriterionResponseRecord(r);
    if (!res.ok) throw new RecordValidationError(`CriterionResponse ${r.item_id}`, res.errors);
  }

  const runId = uuid4();
  const sourceIds = responses.map((r) => r.response_id);
  const scaleScores: CriterionScaleScore[] = SCALES.map((s) => {
    const value = scaleValue(scores, s);
    const flags: string[] = [];
    if (value === null) flags.push('first_category_not_achieved');
    if (
      scores.trialsAdministered < session.protocol.deckSize &&
      scores.categoriesCompleted < session.protocol.maxCategories
    )
      flags.push('incomplete_administration');
    return {
      schema_version: CONTRACT_MINOR,
      score_id: uuid4(),
      pid: session.pid,
      study_id: session.studyId,
      wave: session.wave,
      occasion_id: session.occasionId,
      instrument_id: INSTRUMENT_ID,
      instrument_version: INSTRUMENT_VERSION,
      scale_id: s,
      score: value,
      score_type: 'count',
      n_answered: 1,
      n_items: 1,
      key_version: KEY_VERSION,
      algorithm_version: SCORING_ALGORITHM_VERSION,
      prorated: false,
      planned_missing: false,
      na_reason: null,
      flags,
      source_response_ids: sourceIds,
      scoring_run_id: runId,
      data_snapshot_id: null,
      computed_at: recordedAt,
    };
  });
  for (const s of scaleScores) {
    const res = validateCriterionScaleScoreRecord(s);
    if (!res.ok) throw new RecordValidationError(`CriterionScaleScore ${s.scale_id}`, res.errors);
  }

  const administration: AdministrationIn = {
    pid: session.pid,
    study_id: session.studyId,
    wave: session.wave,
    occasion_id: session.occasionId,
    instrument_id: INSTRUMENT_ID,
    instrument_version: INSTRUMENT_VERSION,
    language: session.language,
    block: 'performance',
    administration_mode: 'read_aloud',
    administrator_id: session.administratorId,
    device_id: session.deviceId,
    audio_version: session.audioVersion,
    site_mode: 'supervised',
    rater_role: 'self',
    rated_pid: null,
    planned_missing_items: [],
    responses: responses.map((r) => ({
      item_id: r.item_id,
      raw_response: r.raw_response,
      response_latency_ms: r.response_latency_ms,
    })),
  };
  return { administration, criterion_responses: responses, criterion_scale_scores: scaleScores };
}

export function newOutboxItem(session: SessionRecord, now: Date): OutboxItem {
  const at = now.toISOString();
  return {
    id: session.sessionId,
    sessionId: session.sessionId,
    kind: 'criterion_administration',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    lastHttpStatus: null,
    createdAt: at,
    updatedAt: at,
    syncedAt: null,
    serverScoringRunId: null,
    payload: buildRecords(session, at),
  };
}
