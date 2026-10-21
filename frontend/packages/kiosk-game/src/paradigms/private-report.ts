/**
 * Private report (MG-06 Private Dice; EPI-02 Weighing Post luck tokens), `integrity_dice_mode = a`.
 *
 * Mode (a): the true outcome is NEVER stored, logged, returned or kept reachable. Only the reported
 * value is logged (`report` event). Outputs feed group-level estimators only (over-report rate,
 * distribution skew); no individual is ever classified (non-negotiable 6, SCR-08).
 *
 * Design choices that keep the privacy claim true:
 *
 * 1. The true outcome is drawn from a NON-seeded entropy source (`crypto.getRandomValues` by
 *    default). Drawing it from the session SeededRng would make it reproducible from the logged
 *    session seed (`pnpm replay <seed>`), i.e. stored in effect. This is the one deliberate exception
 *    to ENG-03 in the paradigm core.
 * 2. {@link PrivateReportTrial.reveal} hands the outcome to a render callback synchronously and keeps
 *    no reference to it: the value lives only in the callback's argument. The trial object's state
 *    is `ready | revealed | reported` and nothing else.
 * 3. Rejection sampling gives an exactly uniform face (no modulo bias), so the group estimator's
 *    fair-die expectation (`private_report.faces`, `high_values` in YAML) holds.
 * 4. Reports are touch only (never voiced; the engine marks `private_report: true` trials with an
 *    empty `voice_vocabulary`), and the report UI should not pre-select the revealed face.
 */
import type { ReportPayload } from '@shriii/contracts';
import { type IndicatorBinding, ParadigmConfigError, ParadigmStateError } from './common.ts';

const PARADIGM = 'private_report';

/** Source of unpredictable 32-bit words (NOT the session RNG; see the module doc). */
export interface EntropySource {
  fill(out: Uint32Array): void;
}

/** Default entropy: Web Crypto (`globalThis.crypto.getRandomValues`), available in browsers, Electron and Node. */
export const cryptoEntropy: EntropySource = {
  fill(out: Uint32Array): void {
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } })
      .crypto;
    if (!c?.getRandomValues) {
      throw new ParadigmStateError(
        PARADIGM,
        'Web Crypto is unavailable; private reports cannot run',
      );
    }
    c.getRandomValues(out);
  },
};

const TWO_POW_32 = 0x1_0000_0000;

function assertFaces(faces: number): void {
  if (!Number.isInteger(faces) || faces < 2 || faces > 1000) {
    throw new ParadigmConfigError(PARADIGM, `faces must be an integer in 2..1000, got ${faces}`);
  }
}

/** Exactly uniform integer in `1..faces` by rejection sampling over 32-bit words. */
export function uniformFace(entropy: EntropySource, faces: number): number {
  assertFaces(faces);
  const limit = TWO_POW_32 - (TWO_POW_32 % faces);
  const word = new Uint32Array(1);
  for (let i = 0; i < 64; i += 1) {
    entropy.fill(word);
    const w = word[0] as number;
    if (w < limit) {
      word[0] = 0;
      return (w % faces) + 1;
    }
  }
  throw new ParadigmStateError(PARADIGM, 'entropy source keeps returning out-of-range words');
}

export type ReportContext = ReportPayload['report_context'];

export interface PrivateReportOptions {
  readonly context: ReportContext;
  readonly reportIndex: number;
  /** From YAML (`private_report.faces`). */
  readonly faces: number;
  readonly entropy?: EntropySource;
}

/** Live state of one private report. Holds no outcome. */
export class PrivateReportTrial {
  readonly context: ReportContext;
  readonly reportIndex: number;
  readonly faces: number;
  private readonly entropy: EntropySource;
  private phase: 'ready' | 'revealed' | 'reported' = 'ready';

  constructor(options: PrivateReportOptions) {
    if (!Number.isInteger(options.reportIndex) || options.reportIndex < 0) {
      throw new ParadigmConfigError(PARADIGM, 'reportIndex must be a non-negative integer');
    }
    assertFaces(options.faces);
    this.context = options.context;
    this.reportIndex = options.reportIndex;
    this.faces = options.faces;
    this.entropy = options.entropy ?? cryptoEntropy;
  }

  get state(): 'ready' | 'revealed' | 'reported' {
    return this.phase;
  }

  /**
   * Draw the private outcome and pass it to `show` (e.g. the cupped-hand dice face). The value is
   * not stored anywhere in this object and is not returned. Callable once.
   */
  reveal(show: (face: number) => void): void {
    if (this.phase !== 'ready')
      throw new ParadigmStateError(PARADIGM, `reveal called in state ${this.phase}`);
    this.phase = 'revealed';
    show(uniformFace(this.entropy, this.faces));
  }

  /**
   * Record the player's report and return the `report` payload: reported value only, never the true
   * outcome. Allowed without a reveal only for timeouts handled by the caller (they log no report).
   */
  report(
    reportedValue: number,
    options: { readonly headset: boolean; readonly onlookerReported: boolean },
  ): ReportPayload {
    if (this.phase !== 'revealed')
      throw new ParadigmStateError(PARADIGM, `report called in state ${this.phase}`);
    if (!Number.isInteger(reportedValue) || reportedValue < 1 || reportedValue > this.faces) {
      throw new ParadigmStateError(PARADIGM, `reported value must be 1..${this.faces}`);
    }
    this.phase = 'reported';
    return {
      report_context: this.context,
      report_index: this.reportIndex,
      reported_value: reportedValue,
      headset: options.headset,
      onlooker_reported: options.onlookerReported,
    };
  }
}

/** Closed response codes for a picture report (`face_1..face_n`). */
export function reportVocabulary(faces: number): [string, ...string[]] {
  const out: string[] = [];
  for (let i = 1; i <= faces; i += 1) out.push(`face_${i}`);
  return out as [string, ...string[]];
}

/** Parse a committed `face_k` code into the reported value (null for anything else). */
export function parseFaceCode(code: string | null, faces: number): number | null {
  if (code === null) return null;
  const m = /^face_(\d+)$/.exec(code);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 1 && v <= faces ? v : null;
}

/**
 * Keys that must never appear in anything a private-report trial logs or stores. Used by tests and
 * by the module's pre-log guard.
 */
export const FORBIDDEN_TRUE_OUTCOME_KEYS: readonly string[] = [
  'true_outcome',
  'true_value',
  'true_roll',
  'roll',
  'actual_roll',
  'outcome_value',
  'revealed_value',
  'face',
];

/** Throws if a payload (deeply) contains a forbidden true-outcome key. */
export function assertNoTrueOutcome(payload: unknown): void {
  const visit = (v: unknown, path: string): void => {
    if (v === null || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_TRUE_OUTCOME_KEYS.includes(k)) {
        throw new ParadigmStateError(PARADIGM, `true outcome key "${k}" at ${path}${k}`);
      }
      visit(child, `${path}${k}.`);
    }
  };
  visit(payload, '');
}

/** Group-level only: these indicators have `group_only: true` and are never scored per person. */
export const PRIVATE_REPORT_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'private_dice',
    indicators: ['integrity.dice_overreport_rate', 'integrity.report_distribution_skew'],
  },
  { moduleId: 'weighing_post', indicators: ['integrity.luck_token_overreport_rate'] },
];
