/**
 * Onboarding contracts (plan ONB-01..07, KSK-03). Screens code against the engine interfaces only
 * (input, voice, audio, logger, clock, rng) and against {@link OnboardingArt}, the subset of the art kit
 * they use (implemented by `MelaArtKit`; tests supply a light fake).
 */
import type { Application, Container } from 'pixi.js';
import type { HintKind } from '../art/ui/buttons.ts';
import type {
  AudioService,
  Backdrop,
  ButtonSpec,
  Character,
  CharacterSpec,
  Clock,
  EventLogger,
  InputService,
  LanguageTag,
  Layout,
  ParticleEmitter,
  ParticleSpec,
  Point,
  SceneId,
  SeededRng,
  TimeOfDay,
  TransitionKind,
  UiButton,
  VoiceService,
} from '../core/contracts.ts';

/** A button or tile with its physical size (px) and optional selection state. */
export interface SizedButton extends UiButton {
  readonly sizePx: number;
  setSelected?(selected: boolean): void;
  press?(): void;
}

/** Character with the optional rich gestures of the procedural rig. */
export interface RichCharacter extends Character {
  pointAt?(point: Point): Promise<void>;
  clearLook?(): void;
  entrance?(): Promise<void>;
  exit?(): Promise<void>;
}

/** Backdrop with optional cinematic extras. */
export interface RichBackdrop extends Backdrop {
  panTo?(offset: number, durationMs?: number): Promise<void>;
  setTimeValue?(value: number, durationMs?: number): Promise<void>;
}

/** Hand-pointer hint. */
export interface HandHintLike {
  readonly view: Container;
  show(kind: HintKind, target: Point, holdMs?: number): void;
  stop(): void;
  destroy(): void;
}

/** What onboarding needs from the art kit. */
export interface OnboardingArt {
  readonly unit: number;
  createBackdrop(sceneId: SceneId, timeOfDay: TimeOfDay): RichBackdrop;
  createCharacter(spec: CharacterSpec): RichCharacter;
  createButton(spec: ButtonSpec): SizedButton;
  createIconButton(
    spec: Omit<ButtonSpec, 'variant'> & { readonly variant?: ButtonSpec['variant'] },
  ): SizedButton;
  createPictureTile(id: string, pictogram: Container, sizeMm: number, accent?: number): SizedButton;
  createHandHint(sizeMm?: number): HandHintLike;
  createParticles(spec: ParticleSpec): ParticleEmitter;
  transition(
    kind: TransitionKind,
    options?: { readonly durationMs?: number; readonly midpoint?: () => void | Promise<void> },
  ): Promise<void>;
  lightSweep?(durationMs?: number): Promise<void>;
  glow?(x: number, y: number, radius: number): Promise<void>;
  raiseOverlay?(): void;
}

/** Engine services available to onboarding screens. */
export interface OnboardingServices {
  readonly app: Application;
  /** Root container owned by onboarding (screens add and remove their layers here). */
  readonly stage: Container;
  readonly layout: Layout;
  readonly art: OnboardingArt;
  readonly audio: AudioService;
  readonly voice: VoiceService;
  readonly input: InputService;
  /** Session logger; onboarding uses a child scoped to `task: null, scorable: false`. */
  readonly logger: EventLogger;
  readonly clock: Clock;
  readonly rng: SeededRng;
  readonly signal?: AbortSignal;
}

/** Content/policy facts onboarding needs (from the signed packs). */
export interface OnboardingConfig {
  /** Enabled languages, in configured order (faces are shown in a seeded random order). */
  readonly languages: readonly LanguageTag[];
  readonly packVersion: string;
  readonly manifestHash: string;
  readonly consentScriptId: string;
  readonly consentVersionHash: string;
  readonly policyVersion: string;
  /** Attract greeting cadence (KSK-03: at most one per 20 s). */
  readonly greetingIntervalMs: number;
  /** Quiet hours [startHour, endHour) in local wall time: no spoken greetings. */
  readonly quietHours: readonly [number, number] | null;
  /** Survey answer timeout (ONB-07, 10 s). */
  readonly surveyTimeoutMs: number;
  /** Contact opt-in timeout (ONB-03: timeout counts as "no"). */
  readonly optInTimeoutMs: number;
  /** Warm-up level timing (practice reads tap window and hold threshold from the warm-up config). */
  readonly practice: {
    readonly tapWindowMs: number;
    readonly holdRequiredMs: number;
    readonly passesRequired: number;
    readonly maxAttempts: number;
  };
  /** Speed factor for UI pacing (tests use 0 to skip non-essential waits). */
  readonly pacing: number;
}

/** UI defaults (UX constants, not scientific thresholds). */
export const DEFAULT_ONBOARDING_CONFIG: Omit<
  OnboardingConfig,
  | 'languages'
  | 'packVersion'
  | 'manifestHash'
  | 'consentScriptId'
  | 'consentVersionHash'
  | 'policyVersion'
  | 'practice'
> = {
  greetingIntervalMs: 20_000,
  quietHours: null,
  surveyTimeoutMs: 10_000,
  optInTimeoutMs: 20_000,
  pacing: 1,
};

/** Result of a screen that may be redirected to language selection via the globe icon. */
export type WithGlobe<T> = T | { readonly type: 'GLOBE' };
