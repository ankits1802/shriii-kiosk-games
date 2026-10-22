/**
 * Shared types of the Pathway B micro-game kit (set 1: Don't-Tap, Card Sort, Balloon, Tower,
 * Wait-or-Now). The kit lives under `games/dont-tap/kit/` because Don't-Tap is the first module of
 * the fixed carousel order; it has no Don't-Tap specifics and the integrator may move it to a neutral
 * `games/_kit/` without code changes (every import is relative to this directory).
 *
 * Ground rules the kit enforces for every module built on it:
 * - Events follow the scoring conventions (`stats/scoring/.../conventions.py`): scorer trial types,
 *   closed response codes, `GameTrialSpec.params` keys recorded per trial.
 * - Stimulus onset is logged from the frame on which the stimulus is committed (`presentStimulus`).
 * - Response windows come from the level table (never hard-coded); practice precedes scored trials.
 * - No numbers, scores or "wrong" sounds are ever shown or played to the player.
 */
import type { EventCondition, Phase } from '@shriii/contracts';
import type {
  EventLogger,
  InputService,
  MicroGameId,
  ModuleContext,
} from '../../../core/contracts.ts';

/** The input service as implemented by the engine (`DomInputService`): optional extras duck-typed. */
export interface KitInput extends InputService {
  /** Route `input.raw_tap` / `input.hold` logging (module host and kit only). */
  setLogger?(logger: EventLogger | null): void;
  /** Mark the inter-stimulus interval (taps are classified `during_isi`). */
  markIsi?(): void;
  /** Clear the trial phase (taps outside any wait are on/off target). */
  markIdle?(): void;
  /** Inject a pointer sample (headless bots); same path as a DOM pointer event. */
  inject?(sample: {
    readonly kind: 'down' | 'up' | 'cancel';
    readonly pointerId: number;
    readonly clientX: number;
    readonly clientY: number;
    readonly timeStamp: number;
    readonly pointerType: 'touch' | 'pen' | 'mouse';
    readonly width?: number;
    readonly height?: number;
  }): void;
}

/** One trial as the kit runs and logs it. Built by each module from its config (never hard-coded). */
export interface KitTrial {
  readonly trialId: string;
  /** Block id from the module config (bare; the scorer accepts `<module>.<block>` or bare). */
  readonly blockId: string;
  /** Counts every trial of the module from 0, practice included (scoring convention). */
  readonly trialIndex: number;
  /** Scorer trial type (`conventions.MODULE_TRIAL_TYPES`). */
  readonly trialType: string;
  readonly stimulusId: string | null;
  readonly phase: Phase;
  readonly conditionId: string | null;
  readonly shiftActive: boolean;
  readonly timer: boolean;
  readonly noise: boolean;
  readonly scorable: boolean;
  readonly anchor: boolean;
  readonly probeGroupId: string | null;
  readonly formId: string;
  readonly responseWindowMs: number | null;
  readonly expectedResponse: string | null;
  readonly privateReport?: boolean;
  /** `GameTrialSpec.params` (scoring keys plus art/QA extras). Recorded for export. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Level-independent stimulus variant (hex-logged as `condition.variant_seed`). */
  readonly variant?: number;
}

/** Block as the module plays it (config block plus the length chosen for this session). */
export interface PlannedBlock {
  readonly blockId: string;
  readonly phase: Phase;
  readonly conditionId: string;
  readonly scorable: boolean;
  /** Planned trials (config `trials`, or a seeded length inside the switch window). */
  readonly trials: number;
  /** Protected minimum (config `min_trials`): wrap-up never trims below it. */
  readonly minTrials: number;
  readonly timer: boolean;
  readonly noise: boolean;
  readonly shiftActive: boolean;
}

/** Module phases published for screenshots, bots and the dev overlay. */
export type GamePhase =
  | 'loading'
  | 'intro'
  | 'practice'
  | 'main'
  | 'pressure'
  | 'shift'
  | 'probe'
  | 'outro'
  | 'ended';

/** Narrowed module context used by kit helpers. */
export type KitContext = ModuleContext;

export type { EventCondition, MicroGameId };

/**
 * Register a target that starts disabled. The engine input layer treats `spec.enabled === false` as
 * permanently disabled in hit-testing (handle.setEnabled cannot re-enable it), so targets are
 * registered enabled and switched off immediately; enabling later works through the handle.
 * Spacing between a module's own targets is checked by the module geometry tests.
 */
export function registerDisabledTarget(
  input: InputService,
  spec: Omit<Parameters<InputService['registerTarget']>[0], 'enabled'>,
): ReturnType<InputService['registerTarget']> {
  const handle = input.registerTarget(spec);
  handle.setEnabled(false);
  return handle;
}
