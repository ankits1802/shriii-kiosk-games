/**
 * Contract between the Weighing Post episode logic (timing, logging, input) and its presentation.
 *
 * Measurement integrity rules this contract encodes:
 * - The logic owns the timeline. Scene methods START visuals and return immediately; the logic waits
 *   fixed, language-independent durations ({@link CHOREO}) on the session clock, never on animations.
 * - `reveal*` methods make the stimulus visible synchronously; the logic calls them inside
 *   `presentStimulus()` so `stimulus_onset` is logged on the frame the stimulus is committed.
 * - Animations never cover a visible stimulus or an enabled choice.
 * - The private luck-die face is passed straight to {@link WeighingScene.luckShowFace} and must not be
 *   stored anywhere (no fields, labels or logs); {@link WeighingScene.luckClear} wipes the drawing.
 */
import type { Rect } from '../../../core/contracts.ts';
import type { WeighDecision, WeighItem, WeighRule } from '../../../paradigms/weighing-post.ts';
import type {
  AllocationCode,
  DilemmaKind,
  DilemmaTrial,
  GambleTrial,
  ProbeTrial,
  WeighTrial,
} from '../schedule.ts';

/** Characters that voice lines. */
export type SpeakerRole = 'guide' | 'inspector' | 'customer' | 'assistant';

/** Which family of choice tokens is on the counter. */
export type ChoiceKind =
  | 'weigh'
  | 'bribe'
  | 'overpayment'
  | 'assistant_mistake'
  | 'fraud_found'
  | 'gamble'
  | 'luck'
  | 'probe';

/** A touch slot laid out by the scene (stage pixels). */
export interface ChoiceSlot {
  readonly code: string;
  readonly rect: Rect;
}

/** Fixed rects of the persistent controls. */
export interface ControlRects {
  readonly confirm: Rect;
  readonly inspect: Rect;
  readonly replay: Rect;
}

/** Visual-only state of a choice token row. */
export interface ChoiceState {
  readonly enabled: boolean;
  readonly selected: string | null;
  readonly confirmVisible: boolean;
}

export interface WeighingScene {
  /** True when the scene renders (false for the headless scene used by bots and tests). */
  readonly renders: boolean;
  /** Build the set (called once from `init`). */
  mount(): Promise<void>;
  /** Episode progress 0..1 drives the late-afternoon light towards sunset (time of day). */
  setProgress(fraction: number): void;
  /** Rects of the persistent controls (confirm, inspect/re-weigh, replay). */
  controls(): ControlRects;
  /** Where the confirm seal goes when `token` is selected. */
  confirmFor(token: Rect): Rect;
  /** Lay out choice tokens for a kind (no visual change). */
  layoutChoices(kind: ChoiceKind, codes: readonly string[]): readonly ChoiceSlot[];
  /** Show the tokens (enabled or not). Called inside `presentStimulus` when they are the go signal. */
  showChoices(
    kind: ChoiceKind,
    codes: readonly string[],
    options: { readonly enabled: boolean },
  ): void;
  setChoiceState(state: ChoiceState): void;
  /** Stamp/press feedback for the committed choice, then the tokens leave. */
  commitChoice(code: string | null): void;
  hideChoices(): void;
  /** Show/hide the inspect (re-weigh) control. */
  setInspectVisible(visible: boolean, enabled: boolean): void;

  intro(): void;
  outro(): void;
  /** Guide demonstrates the decision rule on the placard (practice / new rule). */
  practiceHint(expected: WeighDecision): void;
  clearHints(): void;

  weighPrepare(trial: WeighTrial): void;
  /** Goods land on the pan; the needle settles in `settleMs` unless the reading is ambiguous. */
  weighReveal(trial: WeighTrial, settleMs: number): void;
  /** Lift and re-weigh; `steady` settles an ambiguous reading. */
  reweigh(item: WeighItem, settleMs: number, steady: boolean): void;
  weighOutcome(trial: WeighTrial, decision: WeighDecision | null): void;

  dilemmaPrepare(trial: DilemmaTrial): void;
  dilemmaReveal(trial: DilemmaTrial): void;
  dilemmaOutcome(trial: DilemmaTrial, code: string | null): void;

  gamblePrepare(trial: GambleTrial): void;
  gambleReveal(trial: GambleTrial): void;
  gambleOutcome(trial: GambleTrial, code: 'gamble' | 'inspect' | null, caught: boolean): void;

  /** Cloth screen rises around the dice cup (first luck token). */
  luckBegin(): void;
  /** Cup shakes and the die tumbles behind the screen. */
  luckRoll(): void;
  /** Draw the private face on the die. MUST NOT retain `face` (dice mode a). */
  luckShowFace(face: number): void;
  /** Pictured luck tokens for the REPORTED value drop into the bowl. */
  luckOutcome(reported: number | null): void;
  /** Wipe the die drawing (called right after the report). */
  luckClear(): void;
  luckEnd(): void;

  /** Inspector announces the new market rule; the rule placard turns to the new rule. */
  newRuleAnnounce(rule: WeighRule): void;
  newRuleDone(): void;

  probeBegin(): void;
  probePrepare(trial: ProbeTrial): void;
  probeReveal(trial: ProbeTrial): void;
  probeOutcome(trial: ProbeTrial, code: string | null): void;
  probeEnd(): void;

  /** Speaking animation for the character voicing the current line (`null` stops it). */
  speaker(role: SpeakerRole | null): void;
  destroy(): void;
}

/**
 * Presentation timeline (ms on the session clock). These are presentation constants, identical in
 * every language and at every level; load parameters (response windows, needle settle time) always come
 * from the level table in the module config.
 */
export const CHOREO = {
  /** Intro visuals before the guide's line may end the intro (bounded by `budget.intro_ms`). */
  introMinMs: 5200,
  /** Customer steps up, the declared brass weights go on the right pan, the goods arc to the pan. */
  weighPrepareMs: 760,
  /** Lift-and-drop before a re-weigh settles. */
  reweighLiftMs: 320,
  /** Stamp, customer reaction and hand-back after a weighing decision. */
  weighExitMs: 560,
  /** The dilemma scene plays out before its key stimulus (coins, error, discovery) is shown. */
  dilemmaPrepareMs: 1250,
  dilemmaExitMs: 760,
  gamblePrepareMs: 1000,
  gambleOutcomeMs: 1000,
  /** Cloth screen rises before the first luck token. */
  luckBeginMs: 850,
  /** Cup shake and tumble before the private face is shown. */
  luckRollMs: 700,
  luckOutcomeMs: 420,
  luckEndMs: 520,
  /** Visual part of the announcement (the inspector's line extends it). */
  newRuleMinMs: 2600,
  newRuleSettleMs: 500,
  probeBeginMs: 650,
  probePrepareMs: 300,
  probeOutcomeMs: 260,
  probeEndMs: 400,
  /** Practice: the guide points at the placard row and then at the matching stamp. */
  practiceHintMs: 1400,
} as const;

export type { AllocationCode, DilemmaKind };
