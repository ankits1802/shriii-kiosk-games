/**
 * Deployment policy (PRV-01) as a versioned, approval-tracked runtime setting.
 *
 * The plan (§1.4) makes every open-question default a signed, versioned `DeploymentPolicy` setting.
 * There is no DeploymentPolicy contract or signing endpoint yet, so this module:
 * - describes the policy keys (type, allowed values, the plan's default, and which are locked);
 * - validates a proposal, including the rejected combinations from PRV-01;
 * - stores proposals in the `deployment_policy` runtime setting (`PUT /api/v1/admin/settings/{key}`,
 *   audited server-side with the previous and new value) with a canonical sha256, a version, the
 *   proposer and approvals (two different people);
 * - leaves `signature` null: signing needs the API (see missing-endpoints.ts → policySign).
 *
 * The plan defaults below seed a first proposal only when the server has no policy. Scientific
 * settings (band count, gate rules, thresholds) are not policy keys: they stay in
 * stats/measurement-model/*.yaml.
 */
import { canonicalJson, compareVersions, isPlainObject, sha256Hex } from '../shared/canonical-json';

export const POLICY_SETTING_KEY = 'deployment_policy';

export type PolicyKind = 'integer' | 'boolean' | 'enum' | 'languages' | 'line' | 'ratio';

export interface PolicyField {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly kind: PolicyKind;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** The plan's default (§1.4); null = must be chosen before approval. */
  readonly planDefault: PolicyValue;
  /** Locked keys cannot be changed in the console (changing them needs preconditions and a code change). */
  readonly locked?: string;
  readonly planRef: string;
}

export type PolicyValue =
  | string
  | number
  | boolean
  | readonly string[]
  | Readonly<Record<string, number>>
  | null;
export type PolicyValues = Readonly<Record<string, PolicyValue>>;

export const POLICY_FIELDS: readonly PolicyField[] = [
  {
    key: 'minimum_age',
    label: 'Minimum age',
    description: 'Selecting an under-18 band ends the session politely and nothing is kept.',
    kind: 'integer',
    planDefault: 18,
    locked: 'Adults only everywhere (DPDP §9); changing it needs the PRV-12 preconditions.',
    planRef: '§1.4, PRV-12',
  },
  {
    key: 'allow_minors',
    label: 'Allow minors',
    description:
      'Verifiable parental consent and no behavioural monitoring of children would be required.',
    kind: 'boolean',
    planDefault: false,
    locked: 'Locked off; changing it needs the PRV-12 preconditions.',
    planRef: '§1.4, PRV-12',
  },
  {
    key: 'enabled_languages',
    label: 'Enabled languages',
    description:
      'Languages offered on the speaking-faces screen. Adding a language needs content only.',
    kind: 'languages',
    planDefault: ['hi-IN', 'mr-IN', 'ta-IN'],
    planRef: '§1.4',
  },
  {
    key: 'site_mode',
    label: 'Site mode',
    description: 'Stages 1–3 run at supervised sites; open public kiosks run in thank-you mode.',
    kind: 'enum',
    options: [
      { value: 'supervised', label: 'Supervised' },
      { value: 'open_public', label: 'Open public' },
    ],
    planDefault: 'supervised',
    planRef: '§1.4, VAL-18',
  },
  {
    key: 'report_mode',
    label: 'Report mode',
    description:
      'Player reports stay off until the battery gate passes and a valid release pack exists (fail closed).',
    kind: 'enum',
    options: [
      { value: 'thank_you', label: 'Thank-you only' },
      { value: 'demo', label: 'Demo (comprehension testing)' },
      { value: 'player_report', label: 'Player report (gated)' },
    ],
    planDefault: 'thank_you',
    planRef: 'REP-01, REP-03',
  },
  {
    key: 'report_use_statement_key',
    label: 'Report use statement',
    description:
      'Voice line spoken in consent saying what the report informs ("personal reflection only").',
    kind: 'line',
    planDefault: null,
    planRef: '§1.4',
  },
  {
    key: 'integrity_dice_mode',
    label: 'Private-dice mode',
    description:
      'Mode (a): the true roll is never logged; integrity is estimated at group level only.',
    kind: 'enum',
    options: [{ value: 'a', label: 'Mode (a): roll never logged, group level only' }],
    planDefault: 'a',
    locked: 'Only mode (a) keeps the privacy claim true; no other mode is defined.',
    planRef: '§1.4, MG-06',
  },
  {
    key: 'partner_disclosure',
    label: 'Scripted partner disclosure',
    description: 'How scripted co-players are introduced. Ethics-board decision.',
    kind: 'enum',
    options: [{ value: 'pretend_helpers', label: 'Introduced as "pretend helpers"' }],
    planDefault: 'pretend_helpers',
    planRef: '§1.4',
  },
  {
    key: 'pathway_mix',
    label: 'Pilot arms',
    description:
      'Arms randomised within quota cells, each with one fixed task order; both arms complete the criterion battery.',
    kind: 'ratio',
    planDefault: { B_fixed: 1, A_narrative: 1 },
    planRef: '§1.4, EPI-05',
  },
  {
    key: 'calibration_policy',
    label: 'Calibration level policy',
    description:
      'Fixed L2 for the criterion cohort; L1 only for practice struggle or an accessibility choice.',
    kind: 'enum',
    options: [
      { value: 'fixed_L2_with_L1_fallback', label: 'Fixed L2 with L1 fallback (pilot)' },
      { value: 'classifier', label: 'Classifier (field)' },
      { value: 'forced', label: 'Forced (counterbalanced subsample)' },
    ],
    planDefault: 'fixed_L2_with_L1_fallback',
    planRef: '§1.4, ENG-10',
  },
  {
    key: 'contact_readback_mode',
    label: 'Phone number confirmation',
    description: 'Never read back through the speakers (onlookers).',
    kind: 'enum',
    options: [
      { value: 'picture_tiles', label: 'Picture-digit tiles on screen' },
      { value: 'headset_audio', label: 'Audio through a headset only' },
    ],
    planDefault: 'picture_tiles',
    planRef: '§1.4',
  },
  {
    key: 'reminder_channel',
    label: 'Retest reminders',
    description:
      'Pre-recorded native-speaker IVR call by default; SMS is optional (non-literate players).',
    kind: 'enum',
    options: [
      { value: 'ivr_call', label: 'IVR call (pre-recorded)' },
      { value: 'sms', label: 'SMS' },
    ],
    planDefault: 'ivr_call',
    planRef: '§1.4',
  },
  {
    key: 'asr_enabled',
    label: 'Closed-vocabulary speech input',
    description:
      'Opt-in per prompt after the ASR bake-off; touch always works. Off until VOX-06 passes.',
    kind: 'boolean',
    planDefault: false,
    planRef: 'VOX-04, VOX-06',
  },
];

export const FIELD_BY_KEY: ReadonlyMap<string, PolicyField> = new Map(
  POLICY_FIELDS.map((f) => [f.key, f]),
);

export interface PolicyApproval {
  readonly by: string;
  readonly at: string;
}

/** The stored setting value. */
export interface PolicyDocument {
  readonly policy_version: string;
  readonly values: PolicyValues;
  readonly status: 'proposed' | 'approved';
  readonly proposed_by: string;
  readonly proposed_at: string;
  readonly approvals: readonly PolicyApproval[];
  /** sha256 of canonical JSON of {policy_version, values}. */
  readonly sha256: string;
  readonly previous_sha256: string | null;
  /** Ed25519 signature once the API can sign policies; null until then. */
  readonly signature: string | null;
  readonly change_note: string;
  /**
   * The approved version this one supersedes, carried in full so a pending proposal never hides the
   * policy in force: kiosks and deployments resolve the effective policy with `effectivePolicy`.
   * One level only (the snapshot's own `last_approved` is dropped).
   */
  readonly last_approved: ApprovedPolicySnapshot | null;
}

export type ApprovedPolicySnapshot = Omit<PolicyDocument, 'last_approved'> & {
  readonly status: 'approved';
};

function snapshotOf(doc: PolicyDocument): ApprovedPolicySnapshot {
  const { last_approved: _dropped, ...rest } = doc;
  return { ...rest, status: 'approved' };
}

/** The approved policy in force: the document itself once approved, else the one it supersedes. */
export function effectivePolicy(
  doc: PolicyDocument | null,
): PolicyDocument | ApprovedPolicySnapshot | null {
  if (!doc) return null;
  return doc.status === 'approved' ? doc : doc.last_approved;
}

export function planDefaults(): Record<string, PolicyValue> {
  return Object.fromEntries(POLICY_FIELDS.map((f) => [f.key, f.planDefault]));
}

export interface PolicyContext {
  /** Languages present in the voice-line catalogue. */
  readonly catalogueLanguages: readonly string[];
  /** Line ids allowed as the report use statement. */
  readonly statementLines: readonly string[];
  /** True when a signed, unexpired release pack exists; null when unknown (not readable). */
  readonly releasePackValid: boolean | null;
}

export interface PolicyIssue {
  readonly key: string | null;
  readonly message: string;
}

/** Validate values field by field and the PRV-01 rejected combinations. */
export function validatePolicy(values: PolicyValues, ctx: PolicyContext): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  for (const f of POLICY_FIELDS) {
    const v = values[f.key];
    if (f.locked && canonicalJson(v ?? null) !== canonicalJson(f.planDefault)) {
      issues.push({ key: f.key, message: `${f.label} is locked: ${f.locked}` });
      continue;
    }
    switch (f.kind) {
      case 'integer':
        if (typeof v !== 'number' || !Number.isInteger(v))
          issues.push({ key: f.key, message: `${f.label} must be a whole number.` });
        break;
      case 'boolean':
        if (typeof v !== 'boolean')
          issues.push({ key: f.key, message: `${f.label} must be on or off.` });
        break;
      case 'enum':
        if (typeof v !== 'string' || !f.options?.some((o) => o.value === v))
          issues.push({ key: f.key, message: `${f.label} has no valid choice.` });
        break;
      case 'languages': {
        const list = Array.isArray(v) ? (v as readonly unknown[]) : [];
        if (list.length === 0)
          issues.push({ key: f.key, message: 'At least one language must be enabled.' });
        const unknown = list.filter(
          (l) => typeof l !== 'string' || !ctx.catalogueLanguages.includes(l),
        );
        if (unknown.length > 0)
          issues.push({
            key: f.key,
            message: `Not in the voice-line catalogue: ${unknown.join(', ')}.`,
          });
        break;
      }
      case 'line':
        if (typeof v !== 'string' || v.length === 0)
          issues.push({ key: f.key, message: `${f.label} must be chosen.` });
        else if (!ctx.statementLines.includes(v))
          issues.push({ key: f.key, message: `${v} is not a catalogue line.` });
        break;
      case 'ratio': {
        const entries = isPlainObject(v) ? Object.entries(v) : [];
        if (entries.length < 1)
          issues.push({ key: f.key, message: `${f.label} needs at least one arm.` });
        if (entries.some(([, n]) => typeof n !== 'number' || !Number.isInteger(n) || n < 1)) {
          issues.push({ key: f.key, message: 'Allocation ratios must be whole numbers ≥ 1.' });
        }
        break;
      }
    }
  }
  if (typeof values.minimum_age === 'number' && values.minimum_age < 18) {
    issues.push({ key: 'minimum_age', message: 'Rejected: minimum age below 18.' });
  }
  if (values.allow_minors === true)
    issues.push({
      key: 'allow_minors',
      message: 'Rejected: allow_minors without the PRV-12 preconditions.',
    });
  if (values.report_mode === 'player_report') {
    if (values.site_mode === 'open_public') {
      issues.push({
        key: 'report_mode',
        message:
          'Rejected: player reports at open public sites need the VAL-18 unattended-mode pass.',
      });
    }
    if (ctx.releasePackValid === false) {
      issues.push({
        key: 'report_mode',
        message: 'Rejected: player_report without a valid release pack.',
      });
    } else if (ctx.releasePackValid === null) {
      issues.push({
        key: 'report_mode',
        message:
          'Rejected: the release pack could not be checked; player_report needs a valid one.',
      });
    }
  }
  return issues;
}

export function policyHash(version: string, values: PolicyValues): Promise<string> {
  return sha256Hex(canonicalJson({ policy_version: version, values }));
}

/** Next minor version (1.4.2 → 1.5.0); first policy is 1.0.0. */
export function nextPolicyVersion(current: string | null): string {
  if (!current) return '1.0.0';
  const [major = 1, minor = 0] = current.split('.').map((p) => Number.parseInt(p, 10) || 0);
  return `${major}.${minor + 1}.0`;
}

/** Parse a stored setting value into a PolicyDocument, or null when it is not one. */
export function parsePolicyDocument(value: unknown): PolicyDocument | null {
  return parseDoc(value, true);
}

function parseDoc(value: unknown, nested: boolean): PolicyDocument | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.policy_version !== 'string' || !isPlainObject(value.values)) return null;
  const approvals = Array.isArray(value.approvals)
    ? value.approvals
        .filter(isPlainObject)
        .map((a) => ({ by: String(a.by ?? ''), at: String(a.at ?? '') }))
    : [];
  return {
    policy_version: value.policy_version,
    values: value.values as PolicyValues,
    status: value.status === 'approved' ? 'approved' : 'proposed',
    proposed_by: String(value.proposed_by ?? ''),
    proposed_at: String(value.proposed_at ?? ''),
    approvals,
    sha256: String(value.sha256 ?? ''),
    previous_sha256: typeof value.previous_sha256 === 'string' ? value.previous_sha256 : null,
    signature: typeof value.signature === 'string' ? value.signature : null,
    change_note: String(value.change_note ?? ''),
    last_approved: nested ? parseSnapshot(value.last_approved) : null,
  };
}

function parseSnapshot(value: unknown): ApprovedPolicySnapshot | null {
  const doc = parseDoc(value, false);
  return doc && doc.status === 'approved' ? snapshotOf(doc) : null;
}

/** Build a new proposal. */
export async function propose(
  values: PolicyValues,
  {
    current,
    actor,
    note,
    now = new Date(),
  }: { current: PolicyDocument | null; actor: string; note: string; now?: Date },
): Promise<PolicyDocument> {
  const version = nextPolicyVersion(current?.policy_version ?? null);
  const lastApproved =
    current?.status === 'approved' ? snapshotOf(current) : (current?.last_approved ?? null);
  return {
    policy_version: version,
    values,
    status: 'proposed',
    proposed_by: actor,
    proposed_at: now.toISOString(),
    approvals: [],
    sha256: await policyHash(version, values),
    previous_sha256: lastApproved?.sha256 ?? null,
    signature: null,
    change_note: note,
    last_approved: lastApproved,
  };
}

export type ApprovalRefusal =
  | 'not_proposed'
  | 'own_proposal'
  | 'already_approved'
  | 'hash_mismatch'
  | 'invalid';

/**
 * Record an approval by `actor`. Two people are needed: the proposer plus a different approver.
 * The hash is re-checked so a tampered value is never approved, and the values are validated again
 * against the context at approval time (e.g. a release pack revoked since the proposal).
 */
export async function approve(
  doc: PolicyDocument,
  actor: string,
  { now = new Date(), ctx }: { now?: Date; ctx?: PolicyContext } = {},
): Promise<
  | { ok: true; doc: PolicyDocument }
  | { ok: false; reason: ApprovalRefusal; issues?: readonly PolicyIssue[] }
> {
  if (doc.status !== 'proposed') return { ok: false, reason: 'not_proposed' };
  const who = actor.trim().toLowerCase();
  if (!who || who === doc.proposed_by.trim().toLowerCase())
    return { ok: false, reason: 'own_proposal' };
  if (doc.approvals.some((a) => a.by.trim().toLowerCase() === who))
    return { ok: false, reason: 'already_approved' };
  if ((await policyHash(doc.policy_version, doc.values)) !== doc.sha256)
    return { ok: false, reason: 'hash_mismatch' };
  if (ctx) {
    const issues = validatePolicy(doc.values, ctx);
    if (issues.length > 0) return { ok: false, reason: 'invalid', issues };
  }
  const approvals = [...doc.approvals, { by: actor, at: now.toISOString() }];
  return { ok: true, doc: { ...doc, approvals, status: 'approved' } };
}

/** Keys whose value differs between two value sets. */
export function changedKeys(a: PolicyValues, b: PolicyValues): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((k) => canonicalJson(a[k] ?? null) !== canonicalJson(b[k] ?? null)).sort();
}

export function sortByVersion(docs: readonly PolicyDocument[]): PolicyDocument[] {
  return [...docs].sort((x, y) => compareVersions(y.policy_version, x.policy_version));
}
