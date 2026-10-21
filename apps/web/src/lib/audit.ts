/**
 * Who/when extraction for audit-friendly record display. API records name their actor and time
 * differently (`created_by`, `recorded_by`, `linked_by`, `approved_by`, `updated_by`;
 * `created_at`, `updated_at`, ...). This normalises them so every record can show "who, when".
 */

export interface AuditInfo {
  /** e.g. "Created", "Recorded", "Linked", "Approved", "Updated". */
  readonly verb: string;
  readonly actor: string | null;
  readonly at: string | null;
  /** Last change, when the record carries one distinct from creation. */
  readonly updated: { readonly actor: string | null; readonly at: string | null } | null;
}

const ACTOR_FIELDS: readonly [field: string, verb: string][] = [
  ['created_by', 'Created'],
  ['recorded_by', 'Recorded'],
  ['linked_by', 'Linked'],
  ['approved_by', 'Approved'],
  ['actor', 'Changed'],
];

const TIME_FIELDS: readonly string[] = ['created_at', 'recorded_at', 'decided_at', 'occurred_at'];

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function auditInfo(record: Readonly<Record<string, unknown>>): AuditInfo | null {
  let verb = 'Created';
  let actor: string | null = null;
  for (const [field, v] of ACTOR_FIELDS) {
    const value = str(record[field]);
    if (value) {
      actor = value;
      verb = v;
      break;
    }
  }
  let at: string | null = null;
  for (const field of TIME_FIELDS) {
    const value = str(record[field]);
    if (value) {
      at = value;
      break;
    }
  }
  const updatedBy = str(record.updated_by);
  const updatedAt = str(record.updated_at);
  if (!actor && !at && (updatedBy || updatedAt)) {
    return { verb: 'Updated', actor: updatedBy, at: updatedAt, updated: null };
  }
  if (!actor && !at) return null;
  const updated =
    (updatedBy || updatedAt) && (updatedAt !== at || updatedBy !== actor)
      ? { actor: updatedBy, at: updatedAt }
      : null;
  return { verb, actor, at, updated };
}
