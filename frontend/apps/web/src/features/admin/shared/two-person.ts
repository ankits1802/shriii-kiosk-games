/**
 * Two-person rule for approvals (games, content versions, policy). The API enforces it for games and
 * content versions (`two_person_rule`, 422); this mirrors it so the form explains the problem before
 * the request is sent.
 */

export interface ApproverCheck {
  readonly approvers: readonly string[];
  readonly errors: readonly string[];
}

/** Normalise names (trim, collapse spaces) and drop blanks. */
export function normaliseApprovers(raw: readonly string[]): string[] {
  return raw.map((s) => s.trim().replace(/\s+/g, ' ')).filter((s) => s.length > 0);
}

/**
 * Check a set of approvers.
 * @param minimum distinct approvers required (2 everywhere in this system)
 * @param exclude names that may not approve (e.g. the proposer of a policy when it must be reviewed
 *   by someone else)
 */
export function checkApprovers(
  raw: readonly string[],
  { minimum = 2, exclude = [] }: { minimum?: number; exclude?: readonly string[] } = {},
): ApproverCheck {
  const approvers = normaliseApprovers(raw);
  const errors: string[] = [];
  const lower = approvers.map((a) => a.toLowerCase());
  const distinct = new Set(lower);
  if (distinct.size !== lower.length) errors.push('Each approver must be a different person.');
  if (distinct.size < minimum) errors.push(`Approval needs ${minimum} distinct named approvers.`);
  const banned = new Set(exclude.map((e) => e.trim().toLowerCase()));
  const clash = approvers.filter((a) => banned.has(a.toLowerCase()));
  if (clash.length > 0) errors.push(`${clash.join(', ')} cannot approve this item.`);
  return { approvers: [...new Set(approvers)], errors };
}
