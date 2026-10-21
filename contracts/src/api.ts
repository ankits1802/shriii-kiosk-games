import type {
  ConsentArtefact,
  ContentManifest,
  CriterionResponse,
  CriterionScaleScore,
  EventEnvelope,
  GameTrialSpec,
  ReleasePack,
  ReportArtefact,
  SessionContext,
  UploadBatch,
  UploadBatchResult,
} from './generated/types.ts';
import {
  readEventEnvelope,
  readUploadBatch,
  validateConsentArtefact,
  validateContentManifest,
  validateCriterionResponse,
  validateCriterionScaleScore,
  validateEventEnvelope,
  validateGameTrialSpec,
  validateReleasePack,
  validateReportArtefact,
  validateSessionContext,
  validateUploadBatch,
  validateUploadBatchResult,
} from './generated/validators/index.js';
import { runValidator, type ValidationResult } from './validate.ts';

/** Strictly validate an outgoing event (kiosk writer path). */
export const validateEvent = (data: unknown): ValidationResult<EventEnvelope> =>
  runValidator(validateEventEnvelope, data);

/** Tolerantly validate an incoming event (backend/reader path; minor N+1 fields allowed). */
export const readEvent = (data: unknown): ValidationResult<EventEnvelope> =>
  runValidator(readEventEnvelope, data);

/** Strictly validate an UploadBatch. */
export const validateBatch = (data: unknown): ValidationResult<UploadBatch> =>
  runValidator(validateUploadBatch, data);

/** Tolerantly validate an UploadBatch. */
export const readBatch = (data: unknown): ValidationResult<UploadBatch> =>
  runValidator(readUploadBatch, data);

/** Validate an UploadBatchResult (server response). */
export const validateBatchResult = (data: unknown): ValidationResult<UploadBatchResult> =>
  runValidator(validateUploadBatchResult, data);

/** Validate a SessionContext. */
export const validateSessionContextRecord = (data: unknown): ValidationResult<SessionContext> =>
  runValidator(validateSessionContext, data);

/** Validate a ContentManifest. */
export const validateManifest = (data: unknown): ValidationResult<ContentManifest> =>
  runValidator(validateContentManifest, data);

/** Validate a GameTrialSpec (also run checkTrialSpecInvariants). */
export const validateTrialSpec = (data: unknown): ValidationResult<GameTrialSpec> =>
  runValidator(validateGameTrialSpec, data);

/** Validate a CriterionResponse. */
export const validateCriterionResponseRecord = (
  data: unknown,
): ValidationResult<CriterionResponse> => runValidator(validateCriterionResponse, data);

/** Validate a CriterionScaleScore. */
export const validateCriterionScaleScoreRecord = (
  data: unknown,
): ValidationResult<CriterionScaleScore> => runValidator(validateCriterionScaleScore, data);

/** Validate a ConsentArtefact. */
export const validateConsent = (data: unknown): ValidationResult<ConsentArtefact> =>
  runValidator(validateConsentArtefact, data);

/** Validate a ReportArtefact. */
export const validateReport = (data: unknown): ValidationResult<ReportArtefact> =>
  runValidator(validateReportArtefact, data);

/** Validate a ReleasePack's shape. Signature and expiry checks are separate and mandatory. */
export const validateReleasePackRecord = (data: unknown): ValidationResult<ReleasePack> =>
  runValidator(validateReleasePack, data);
