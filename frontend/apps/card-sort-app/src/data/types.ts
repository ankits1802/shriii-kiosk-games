import type { CriterionResponse, CriterionScaleScore } from '@shriii/contracts';
import type { TrialRecord } from '../domain/engine.ts';
import type { ProtocolConfig } from '../domain/protocol.ts';
import type { CardSortScores } from '../domain/scoring.ts';

export type LanguageTag = 'en-IN' | 'hi-IN' | 'mr-IN' | 'ta-IN';

export type SessionStatus = 'in_progress' | 'completed' | 'aborted';

export interface SessionRecord {
  readonly sessionId: string;
  readonly pid: string;
  readonly studyId: string;
  readonly occasionId: string;
  readonly wave: number;
  readonly language: LanguageTag;
  readonly protocol: ProtocolConfig;
  readonly administratorId: string;
  readonly deviceId: string;
  readonly audioVersion: string | null;
  readonly pidSource: 'qr' | 'typed';
  readonly status: SessionStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly abortReason: string | null;
  /** Summary scores (per-trial detail dropped); null until the session ends. */
  readonly scores: Omit<CardSortScores, 'trials'> | null;
}

export type { TrialRecord };

/** Body of POST /api/v1/assessment-responses (backend/api/openapi.json `AdministrationIn`). */
export interface AdministrationIn {
  pid: string;
  study_id: string;
  wave: number;
  occasion_id: string;
  instrument_id: string;
  instrument_version: string | null;
  language: string;
  block: 'performance';
  administration_mode: 'self' | 'read_aloud';
  administrator_id: string | null;
  device_id: string;
  audio_version: string | null;
  site_mode: 'supervised';
  rater_role: 'self';
  rated_pid: null;
  planned_missing_items: string[];
  responses: { item_id: string; raw_response: number | null; response_latency_ms: number | null }[];
}

export type OutboxStatus = 'pending' | 'synced' | 'rejected';

export interface OutboxItem {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: 'criterion_administration';
  readonly status: OutboxStatus;
  readonly attempts: number;
  /** Epoch ms before which the item is not retried automatically. */
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  /** HTTP status of the last attempt (null = network failure / never sent). */
  readonly lastHttpStatus: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly syncedAt: string | null;
  readonly serverScoringRunId: string | null;
  readonly payload: {
    readonly administration: AdministrationIn;
    readonly criterion_responses: readonly CriterionResponse[];
    readonly criterion_scale_scores: readonly CriterionScaleScore[];
  };
}

export interface AuditEntry {
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  readonly event: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly prevHash: string;
  readonly hash: string;
}

export interface DeviceSettings {
  readonly apiBaseUrl: string;
  readonly deviceToken: string;
  readonly deviceId: string;
  readonly administratorId: string;
  readonly defaultStudyId: string;
  readonly defaultLanguage: LanguageTag;
  readonly audioVersion: string | null;
}
