import type { AjvErrorObject, StandaloneValidator } from './generated/validators/index.js';

/** Outcome of validating an unknown value against a contract. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

/** A single validation failure, simplified from Ajv's error object. */
export interface ValidationIssue {
  /** JSON pointer into the validated instance (e.g. `/payload/latency_ms`). */
  readonly path: string;
  /** JSON pointer into the schema that failed (stored in the DLQ as `schema_path`). */
  readonly schemaPath: string;
  /** Failing JSON Schema keyword. */
  readonly keyword: string;
  /** Human-readable message for developers and DLQ triage (never shown to players). */
  readonly message: string;
}

function toIssues(errors: readonly AjvErrorObject[] | null | undefined): ValidationIssue[] {
  if (!errors || errors.length === 0) {
    return [{ path: '', schemaPath: '', keyword: 'unknown', message: 'validation failed' }];
  }
  return errors.map((e) => ({
    path: e.instancePath,
    schemaPath: e.schemaPath,
    keyword: e.keyword,
    message: e.message ?? e.keyword,
  }));
}

/** Run a standalone validator and return a discriminated result instead of mutating state. */
export function runValidator<T>(
  validator: StandaloneValidator<T>,
  data: unknown,
): ValidationResult<T> {
  if (validator(data)) return { ok: true, value: data };
  return { ok: false, errors: toIssues(validator.errors) };
}

/** Error thrown by {@link assertValid}. */
export class ContractValidationError extends Error {
  readonly contract: string;
  readonly issues: readonly ValidationIssue[];

  constructor(contract: string, issues: readonly ValidationIssue[]) {
    const first = issues[0];
    super(
      `${contract} failed validation: ${first ? `${first.path || '/'} ${first.message}` : 'unknown'}`,
    );
    this.name = 'ContractValidationError';
    this.contract = contract;
    this.issues = issues;
  }
}

/** Validate and return the typed value, or throw {@link ContractValidationError}. */
export function assertValid<T>(
  contract: string,
  validator: StandaloneValidator<T>,
  data: unknown,
): T {
  const result = runValidator(validator, data);
  if (!result.ok) throw new ContractValidationError(contract, result.errors);
  return result.value;
}
