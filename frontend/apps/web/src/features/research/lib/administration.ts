/**
 * Researcher-administered criterion battery (spec section 5; BUILD_DECISIONS "criterion capture").
 *
 * Pure planning and submission logic for the tablet administration screen:
 * - which items are presented and which are planned missing (rotating blocks A/B/C: items of the
 *   other forms are planned missing, as the demo pipeline and the scoring engine expect);
 * - performance instruments expand into `<item>.<measure>` entries;
 * - copyrighted item wording is never in the registry: an optional licensed source file loaded on the
 *   device supplies wording and administration-file keys (attention-check instructed responses,
 *   Tower-of-London minimum moves) for this session only, never uploaded;
 * - the submission body for POST /assessment-responses.
 */
import { asArray, asNumber, asRecord, asString } from '../api/types';

export const ROTATING_BLOCKS = ['A', 'B', 'C'] as const;
export type AdministrationBlock =
  | 'X'
  | 'A'
  | 'B'
  | 'C'
  | 'performance'
  | 'teamwork'
  | 'retest_short';

const ADMIN_BLOCKS: readonly AdministrationBlock[] = [
  'X',
  'A',
  'B',
  'C',
  'performance',
  'teamwork',
  'retest_short',
];

export interface ResponseAnchor {
  readonly value: number;
  readonly labelKey: string | null;
  readonly pictogramId: string | null;
}

export interface ResponseScale {
  readonly type: string;
  readonly min: number | null;
  readonly max: number | null;
  readonly anchors: readonly ResponseAnchor[];
}

export interface PlanItem {
  /** Id submitted to the API: `<item_id>` or `<item_id>.<measure>`. */
  readonly responseId: string;
  readonly itemId: string;
  readonly number: number;
  readonly measure: string | null;
  readonly block: string;
  readonly reverseKeyed: boolean;
  readonly attentionCheck: boolean;
  readonly placeholderText: string;
  readonly sourceReference: string | null;
  /** Performance measures need an administration-file key (minimum moves). */
  readonly needsKey: boolean;
}

export interface AdministrationPlan {
  readonly instrumentId: string;
  readonly version: string;
  readonly scale: ResponseScale;
  readonly items: readonly PlanItem[];
  readonly plannedMissing: readonly string[];
  readonly block: AdministrationBlock;
  readonly audioAssisted: boolean;
  readonly instructionsKey: string | null;
  readonly modes: readonly string[];
  readonly estimatedMinutes: number | null;
  readonly publicKioskAllowed: boolean;
}

export function readScale(definition: Readonly<Record<string, unknown>>): ResponseScale {
  const s = asRecord(definition.response_scale);
  return {
    type: asString(s.type) ?? 'likert',
    min: asNumber(s.min),
    max: asNumber(s.max),
    anchors: asArray(s.anchors).map((a) => {
      const r = asRecord(a);
      return {
        value: asNumber(r.value) ?? 0,
        labelKey: asString(r.label_key),
        pictogramId: asString(r.pictogram_id),
      };
    }),
  };
}

/** Raw registry items of an instrument definition. */
export function definitionItems(definition: Readonly<Record<string, unknown>>) {
  return asArray(definition.items).map((raw) => {
    const it = asRecord(raw);
    const source = asRecord(it.item_text_source);
    return {
      itemId: asString(it.item_id) ?? '',
      number: asNumber(it.number) ?? 0,
      block: asString(it.block) ?? 'X',
      reverseKeyed: it.reverse_keyed === true,
      attentionCheck: it.attention_check === true,
      subscales: asArray(it.subscales).map(String),
      measures: asArray(it.measures).map(String),
      placeholderText: asString(it.item_text) ?? '',
      sourceReference: asString(source.reference),
      sourceKind: asString(source.kind),
    };
  });
}

/**
 * Build the administration plan for one person. `personBlock` is the participant's rotating form
 * (enrollment `criterion_block`); items in the other rotating forms are planned missing.
 */
export function buildPlan(
  instrumentId: string,
  version: string,
  definition: Readonly<Record<string, unknown>>,
  personBlock: 'A' | 'B' | 'C' | null,
): AdministrationPlan {
  const items = definitionItems(definition).filter((i) => i.itemId);
  const admin = asRecord(definition.administration);
  const rotating = (b: string) => (ROTATING_BLOCKS as readonly string[]).includes(b);
  const plannedMissing = items
    .filter((i) => rotating(i.block) && i.block !== personBlock)
    .map((i) => i.itemId)
    .sort();
  const presented = items
    .filter((i) => !plannedMissing.includes(i.itemId))
    .sort((a, b) => a.number - b.number);
  const planItems: PlanItem[] = presented.flatMap((i): PlanItem[] => {
    const base = {
      itemId: i.itemId,
      number: i.number,
      block: i.block,
      reverseKeyed: i.reverseKeyed,
      attentionCheck: i.attentionCheck,
      placeholderText: i.placeholderText,
      sourceReference: i.sourceReference,
    };
    if (i.measures.length === 0) {
      return [{ ...base, responseId: i.itemId, measure: null, needsKey: false }];
    }
    return i.measures.map((m) => ({
      ...base,
      responseId: `${i.itemId}.${m}`,
      measure: m,
      needsKey: m === 'moves',
    }));
  });
  const hasRotating = items.some((i) => rotating(i.block));
  const firstBlock = items.find((i) => !rotating(i.block))?.block ?? 'X';
  const fallback: AdministrationBlock = (ADMIN_BLOCKS as readonly string[]).includes(firstBlock)
    ? (firstBlock as AdministrationBlock)
    : 'X';
  return {
    instrumentId,
    version,
    scale: readScale(definition),
    items: planItems,
    plannedMissing,
    block: hasRotating && personBlock ? personBlock : fallback,
    audioAssisted: admin.audio_assisted === true,
    instructionsKey: asString(admin.instructions_key),
    modes: asArray(admin.modes).map(String),
    estimatedMinutes: asNumber(admin.estimated_minutes),
    publicKioskAllowed: admin.public_kiosk_allowed === true,
  };
}

/** Wording and keys from the licensed source file (kept in memory on this device only). */
export interface LicensedEntry {
  readonly text: Readonly<Record<string, string>>;
  readonly expectedResponse: number | null;
}
export type LicensedSource = ReadonlyMap<string, LicensedEntry>;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parse a licensed source file. Accepted forms:
 * - JSON `{ "items": { "<item_id>": { "text": { "hi-IN": "..." } | "...", "expected_response": 3 } } }`
 * - CSV with header `item_id,language,text,expected_response` (language/text/expected optional).
 */
export function parseLicensedSource(content: string): LicensedSource {
  const trimmed = content.trim();
  const map = new Map<string, { text: Record<string, string>; expectedResponse: number | null }>();
  const entry = (id: string) => {
    let e = map.get(id);
    if (!e) {
      e = { text: {}, expectedResponse: null };
      map.set(id, e);
    }
    return e;
  };
  if (trimmed.startsWith('{')) {
    const doc = asRecord(JSON.parse(trimmed) as unknown);
    for (const [id, raw] of Object.entries(asRecord(doc.items))) {
      const r = asRecord(raw);
      const e = entry(id);
      if (typeof r.text === 'string') e.text['*'] = r.text;
      for (const [lang, t] of Object.entries(asRecord(r.text))) {
        if (typeof t === 'string') e.text[lang] = t;
      }
      e.expectedResponse = asNumber(r.expected_response);
    }
    return map;
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  const header = parseCsvLine(lines[0] ?? '').map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idCol = col('item_id');
  if (idCol < 0) throw new Error('The licensed source file needs an item_id column.');
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const id = cells[idCol];
    if (!id) continue;
    const e = entry(id);
    const text = col('text') >= 0 ? cells[col('text')] : undefined;
    const lang = col('language') >= 0 ? cells[col('language')] || '*' : '*';
    if (text) e.text[lang] = text;
    const exp = col('expected_response') >= 0 ? cells[col('expected_response')] : undefined;
    if (exp !== undefined && exp !== '') {
      const n = Number(exp);
      if (Number.isFinite(n)) e.expectedResponse = n;
    }
  }
  return map;
}

/** Wording for an item in a language (falls back to the language-neutral entry, then the placeholder). */
export function itemWording(
  item: PlanItem,
  language: string,
  source: LicensedSource | null,
): { text: string; licensed: boolean } {
  const e = source?.get(item.itemId);
  const t = e?.text[language] ?? e?.text['*'];
  return t ? { text: t, licensed: true } : { text: item.placeholderText, licensed: false };
}

/** Administration-file key for a response id (attention instructed answer or minimum moves). */
export function expectedResponse(item: PlanItem, source: LicensedSource | null): number | null {
  if (!source) return null;
  if (item.measure === 'moves') return source.get(item.itemId)?.expectedResponse ?? null;
  if (item.attentionCheck)
    return (
      source.get(item.responseId)?.expectedResponse ??
      source.get(item.itemId)?.expectedResponse ??
      null
    );
  return null;
}

export interface AnswerState {
  readonly value: number | null;
  /** Time from item presentation to the (last) answer. */
  readonly latencyMs: number | null;
  /** Explicitly skipped (participant declined). */
  readonly skipped: boolean;
}

export interface Progress {
  readonly total: number;
  readonly answered: number;
  readonly skipped: number;
  readonly remaining: number;
  readonly share: number;
}

export function progress(
  plan: AdministrationPlan,
  answers: ReadonlyMap<string, AnswerState>,
): Progress {
  let answered = 0;
  let skipped = 0;
  for (const item of plan.items) {
    const a = answers.get(item.responseId);
    if (a?.skipped) skipped += 1;
    else if (a && a.value !== null) answered += 1;
  }
  const total = plan.items.length;
  return {
    total,
    answered,
    skipped,
    remaining: total - answered - skipped,
    share: total ? (answered + skipped) / total : 1,
  };
}

/** Values outside the response scale are rejected before they reach the API. */
export function isValidValue(scale: ResponseScale, item: PlanItem, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (item.measure !== null) return value >= 0;
  if (scale.min !== null && value < scale.min) return false;
  if (scale.max !== null && value > scale.max) return false;
  return true;
}

export interface SubmissionContext {
  readonly pid: string;
  readonly studyId: string;
  readonly occasionId: string;
  readonly wave: number;
  readonly language: string;
  readonly mode: 'self' | 'read_aloud';
  readonly administratorId: string;
  readonly deviceId: string;
  readonly audioVersion: string | null;
  readonly raterRole: 'self' | 'partner' | 'administrator' | 'observer';
  readonly ratedPid: string | null;
}

export interface SubmissionIssue {
  readonly responseId: string;
  readonly message: string;
}

/** Problems that would make the API reject the administration, checked before submitting. */
export function submissionIssues(
  plan: AdministrationPlan,
  answers: ReadonlyMap<string, AnswerState>,
  source: LicensedSource | null,
  ctx: SubmissionContext,
): SubmissionIssue[] {
  const issues: SubmissionIssue[] = [];
  if (!ctx.pid.trim()) issues.push({ responseId: '', message: 'Enter the participant id.' });
  if (!ctx.administratorId.trim())
    issues.push({ responseId: '', message: 'Enter the administrator id.' });
  if (
    ctx.raterRole === 'partner' &&
    (!ctx.ratedPid?.trim() || ctx.ratedPid.trim() === ctx.pid.trim())
  )
    issues.push({ responseId: '', message: 'Partner ratings need the rated participant id.' });
  for (const item of plan.items) {
    const a = answers.get(item.responseId);
    if (item.needsKey && a && a.value !== null && expectedResponse(item, source) === null) {
      issues.push({
        responseId: item.responseId,
        message: `${item.responseId} needs the minimum moves from the administration file.`,
      });
    }
  }
  if (!plan.items.some((i) => (answers.get(i.responseId)?.value ?? null) !== null))
    issues.push({ responseId: '', message: 'No item has a response yet.' });
  return issues;
}

/** POST /assessment-responses body (AdministrationIn). Skipped items are sent as explicit nulls. */
export function buildSubmission(
  plan: AdministrationPlan,
  answers: ReadonlyMap<string, AnswerState>,
  source: LicensedSource | null,
  ctx: SubmissionContext,
) {
  const responses = plan.items
    .filter((i) => answers.has(i.responseId))
    .map((i) => {
      const a = answers.get(i.responseId) as AnswerState;
      const expected = expectedResponse(i, source);
      return {
        item_id: i.responseId,
        raw_response: a.skipped ? null : a.value,
        response_latency_ms: a.latencyMs === null ? null : Math.max(0, Math.round(a.latencyMs)),
        ...(expected !== null ? { expected_response: expected } : {}),
      };
    });
  return {
    pid: ctx.pid.trim(),
    study_id: ctx.studyId,
    wave: ctx.wave,
    occasion_id: ctx.occasionId,
    instrument_id: plan.instrumentId,
    instrument_version: plan.version,
    language: ctx.language,
    block: plan.block,
    administration_mode: ctx.mode,
    administrator_id: ctx.administratorId.trim(),
    device_id: ctx.deviceId,
    audio_version: ctx.audioVersion,
    site_mode: 'supervised' as const,
    rater_role: ctx.raterRole,
    rated_pid: ctx.raterRole === 'partner' ? ctx.ratedPid : null,
    planned_missing_items: [...plan.plannedMissing],
    responses,
  };
}

/** Stable per-browser device id for administration records (not an identity field). */
export function deviceIdFrom(storage: Pick<Storage, 'getItem' | 'setItem'> | null): string {
  const key = 'shriii.research.device-id';
  try {
    const existing = storage?.getItem(key);
    if (existing) return existing;
    const id = `web-tablet-${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36)}`;
    storage?.setItem(key, id);
    return id;
  } catch {
    return 'web-tablet';
  }
}
