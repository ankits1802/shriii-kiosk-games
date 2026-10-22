/**
 * Seams of the Road Home episode:
 *
 * - the **director** (`director.ts`) owns the trial loop, the paradigm state and every event;
 * - a **presenter** renders scenes (`view/RoadHomeView.ts`, or `NullPresenter` for headless runs);
 * - a **player** answers each prompt: the human player reads touches through the input service, the
 *   scripted bot (`bot.ts`) answers headlessly (ENG-05 AC "runs headlessly with a scripted bot").
 *
 * Measurement rules the seams enforce: the presenter prepares a stimulus off-screen (or veiled) and
 * `reveal()` makes it visible synchronously inside the frame the director timestamps
 * (`presentStimulus`); feedback animations never run while a response window is open, and nothing
 * the presenter does changes a window, a count or a stimulus.
 */
import type { RouteStepPayload } from '@shriii/contracts';
import type { PlayedRound } from '../../paradigms/public-goods.ts';
import type { Branch } from '../../paradigms/reversal.ts';
import type { RoadHomePlan, RoadHomeTrial } from './plan.ts';
import type { EpisodeWalk } from './walk.ts';

/** Where the latest touch landed (normalised to the safe area), for `touch_xy_norm`. */
export type TouchXy = readonly [number, number] | null;

export type MapAnswer =
  | { readonly kind: 'node'; readonly node: string; readonly tMs: number; readonly xy: TouchXy }
  | {
      readonly kind: 'rest';
      readonly tMs: number;
      readonly latencyMs: number;
      readonly xy: TouchXy;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' };

export type ChoiceAnswer<C extends string> =
  | {
      readonly kind: 'choice';
      readonly value: C;
      readonly tMs: number;
      readonly latencyMs: number;
      readonly xy: TouchXy;
      readonly tapCount: number;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' };

export interface FuelAnswer {
  readonly kind: 'confirm' | 'timeout' | 'aborted';
  /** Bundles in the trough when confirmed (or when the window closed). */
  readonly tokens: number;
  /** Every change of the trough before confirming, as `tokens_<n>` codes. */
  readonly revisions: readonly { readonly value: string; readonly tMs: number }[];
  readonly tMs: number | null;
  readonly latencyMs: number | null;
  readonly tapCount: number;
  readonly xy: TouchXy;
}

export interface HoldRecord {
  readonly startMs: number;
  readonly holdMs: number;
  readonly completed: boolean;
}

export interface EffortAnswer {
  readonly kind: 'held' | 'timeout' | 'aborted';
  readonly holds: readonly HoldRecord[];
  readonly completed: boolean;
}

/** A route-step prompt. */
export interface MapStepRequest {
  readonly trial: RoadHomeTrial;
  readonly walk: EpisodeWalk;
  /** Latency anchor of this step (map onset or the previous step). */
  readonly anchorMs: number;
  readonly windowMs: number;
  /** The rest (fallback) option is on offer. */
  readonly restOffered: boolean;
  /** Nodes whose roads the player has found blocked this trial. */
  readonly knownBlocked: ReadonlySet<string>;
  readonly signal: AbortSignal;
}

export interface ChoiceRequest {
  readonly trial: RoadHomeTrial;
  readonly anchorMs: number;
  readonly windowMs: number | null;
  readonly signal: AbortSignal;
}

export interface FuelRequest extends ChoiceRequest {
  readonly endowment: number;
}

export interface EffortRequest extends ChoiceRequest {
  readonly requiredMs: number;
}

/** Answers prompts (human through touch, or the scripted bot). */
export interface RoadHomePlayer {
  mapStep(req: MapStepRequest): Promise<MapAnswer>;
  fork(req: ChoiceRequest): Promise<ChoiceAnswer<Branch>>;
  optional(req: ChoiceRequest): Promise<ChoiceAnswer<'take'>>;
  fuel(req: FuelRequest): Promise<FuelAnswer>;
  effort(req: EffortRequest): Promise<EffortAnswer>;
  probe(req: ChoiceRequest): Promise<ChoiceAnswer<'safe' | 'risky'>>;
  /** Route raw input logging into a trial scope (null restores the module scope). */
  dispose(): void;
}

/** Feedback hooks a player may call while a prompt is open (visual only, never a stimulus change). */
export interface PlayerFeedback {
  /** A touch landed on `key` (ripple, squash). */
  touched(key: string): void;
  /** The trough now holds `tokens` bundles (fodder moves between the pile and the trough). */
  fuelChanged(tokens: number): void;
  /** Hold progress 0..1 on the uphill push (null = released). */
  effortProgress(progress: number | null): void;
}

/** A step the director accepted (already logged). */
export interface StepEvent {
  readonly payload: RouteStepPayload;
  readonly moved: boolean;
  readonly reserve: boolean;
  /** The step was taken by the fallback guide (auto route after resting). */
  readonly auto: boolean;
}

/** Renders the episode. Every promise resolves (never rejects) and honours `signal`. */
export interface RoadHomePresenter extends PlayerFeedback {
  /** Build scenes for the plan (preload). */
  init(plan: RoadHomePlan): Promise<void>;
  /** Cinematic opening (runs alongside the intro narration). */
  intro(signal: AbortSignal): Promise<void>;
  /** Stage the trial's scene with its stimulus still hidden (camera, time of day, props). */
  prepare(trial: RoadHomeTrial, signal: AbortSignal): Promise<void>;
  /** Make the stimulus visible and interactive NOW (synchronous; called inside the onset frame). */
  reveal(trial: RoadHomeTrial): void;
  /** Hide and disable the trial's response targets (window closed). */
  conceal(trial: RoadHomeTrial): void;
  /** Offer the reachable waypoints (and the rest option) before a route-step prompt. */
  offer(trial: RoadHomeTrial, nodes: readonly string[], rest: boolean): void;
  /** Practice: show the hand hint on `key` (`node:<id>`, `branch:left|right`). */
  hint(key: string | null): void;
  /** A route step was accepted; animate the cart (queued, returns when this move is shown). */
  step(trial: RoadHomeTrial, step: StepEvent): Promise<void>;
  /** The step window passed without a tap: gently pulse the reachable waypoints. */
  nudge(trial: RoadHomeTrial): void;
  /** The rest option was taken (or the cap was reached): the ferry / guide is called. */
  rest(trial: RoadHomeTrial, prompted: boolean): Promise<void>;
  /** The map is done: arrival flourish. */
  mapDone(trial: RoadHomeTrial): Promise<void>;
  forkOutcome(trial: RoadHomeTrial, choice: Branch | null, correct: boolean): Promise<void>;
  optionalOutcome(trial: RoadHomeTrial, taken: boolean): Promise<void>;
  fuelOutcome(trial: RoadHomeTrial, played: PlayedRound): Promise<void>;
  effortOutcome(trial: RoadHomeTrial, completed: boolean): Promise<void>;
  probeOutcome(trial: RoadHomeTrial, choice: 'safe' | 'risky' | null): Promise<void>;
  /** Shorten flourishes (soft-cap wrap-up). Never touches stimuli or windows. */
  setHurry(hurry: boolean): void;
  /** Arrival home under the stars and the warm handover to the report. */
  outro(signal: AbortSignal): Promise<void>;
  destroy(): void;
}
