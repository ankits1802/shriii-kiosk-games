/**
 * Shared kiosk-game interfaces. Every engine service, micro-game (Pathway B), episode (Pathway A),
 * onboarding screen and report view codes against the types in this file.
 *
 * Ground rules encoded here (see docs/BUILD_DECISIONS.md and docs/IMPLEMENTATION_PLAN.md):
 * - Touch is always sufficient; voice is optional, closed-vocabulary and mirrored by an icon (KSK-05, VOX-04).
 * - No visible scores or numerals in player scenes (ENG-11): the art kit has no text/number API.
 * - Every event goes through {@link EventLogger}; `seq` is gapless and `t_mono_ms` never decreases (ENG-07).
 * - All times are milliseconds on the session monotonic clock ({@link Clock}), never wall time.
 * - Load parameters come from the level table in the module config (ENG-10); no hard-coded timers.
 * - Randomness only through {@link SeededRng} named substreams (ENG-03).
 *
 * This file is types plus a few UI constants only; it has no runtime dependencies on Pixi or the DOM.
 */
import type {
  BandsAnsweredPayload,
  BatteryArm,
  CalibrationLevel,
  CalibrationPolicy,
  ConstructId,
  EventCondition,
  EventTaskPosition,
  EventType,
  GameConfig,
  GameTrialSpec,
  InputMode,
  LanguageTag,
  LatencyAnchor,
  LevelConfig,
  Pathway,
  PayloadOf,
  Phase,
  ReleasePack,
  ReportMode,
  SessionContext,
  SessionMode,
  SessionState,
  SiteMode,
  SlotForm,
  TimingFlag,
  UploadBatch,
  UploadBatchResult,
} from '@shriii/contracts';
import type { Application, Container } from 'pixi.js';

export type {
  BatteryArm,
  CalibrationLevel,
  CalibrationPolicy,
  ConstructId,
  GameConfig,
  GameTrialSpec,
  InputMode,
  LanguageTag,
  LatencyAnchor,
  LevelConfig,
  Pathway,
  Phase,
  ReportMode,
  SessionMode,
  SiteMode,
  SlotForm,
  TimingFlag,
};

/* ================================================================================================
 * Identifiers and small shared types
 * ============================================================================================== */

/** Pathway B micro-game ids (MG-01..MG-09). */
export type MicroGameId =
  | 'dont_tap'
  | 'card_sort'
  | 'balloon'
  | 'tower'
  | 'share_pot'
  | 'wait_or_now'
  | 'steady_hands'
  | 'four_stalls'
  | 'private_dice';

/** Pathway A episode ids (EPI-01..EPI-03) plus the Pathway D co-play substudy episode (EPI-06). */
export type EpisodeId = 'stall' | 'weighing_post' | 'road_home' | 'coplay';

/** Any playable module id. `warmup` is the merged practice/calibration module (ONB-05, ENG-10). */
export type ModuleId = MicroGameId | EpisodeId | 'warmup';

/** Indicator id from the scoring dictionary: `<construct_id>.<name>`. */
export type IndicatorId = `${ConstructId}.${string}`;

/** Voice-line id from `content/i18n/lines.yaml` (e.g. `dont_tap.intro`). Resolved per language via the audio manifest. */
export type LineId = string;

/** Procedural sound-effect ids (Web Audio synthesis; no third-party samples). */
export type SfxId =
  | 'tap'
  | 'tap_soft'
  | 'confirm'
  | 'cancel'
  | 'correct'
  | 'incorrect'
  | 'whoosh'
  | 'pop'
  | 'pump'
  | 'balloon_burst'
  | 'coin_drop'
  | 'jar_fill'
  | 'card_flip'
  | 'pot_place'
  | 'dice_shake'
  | 'scale_creak'
  | 'cart_roll'
  | 'bell'
  | 'chime'
  | 'timer_tick'
  | 'transition';

/** Procedural music cues (drone + percussion layers). */
export type MusicCueId =
  | 'attract'
  | 'onboarding'
  | 'hub'
  | 'stall'
  | 'weighing_post'
  | 'road_home'
  | 'pressure'
  | 'report'
  | 'farewell';

/** Procedural ambience beds. */
export type AmbienceId = 'market_day' | 'market_busy' | 'road_evening' | 'quiet';

/** Function returned by subscriptions; call to unsubscribe. Idempotent. */
export type Unsubscribe = () => void;

/** Axis-aligned rectangle in stage pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A point in stage pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Minimum touch target edge (KSK-05, plan section 1.5). UI constant, not a scientific threshold. */
export const TOUCH_TARGET_MIN_MM = 20;
/** Minimum spacing between touch targets (KSK-05). */
export const TOUCH_SPACING_MIN_MM = 8;
/** Maximum flashing frequency allowed in any animation (KSK-05). */
export const MAX_FLASH_HZ = 3;

/* ================================================================================================
 * Clock and timing (ENG-01, ENG-02)
 * ============================================================================================== */

/** Per-SKU constant offsets from the timing calibration rig (ENG-02). All in ms. */
export interface TimingProfile {
  /** `timing_profile_version` stamped on every event. */
  readonly version: string;
  /** False until the SKU is certified; events carry `timing_flag: uncertified_timing_profile`. */
  readonly certified: boolean;
  /** Added to rAF-commit time to get `presented_onset`. */
  readonly displayOffsetMs: number;
  /** Added to scheduled Web Audio time to get `audio_onset` / `prompt_audio_end`. */
  readonly audioOutputOffsetMs: number;
  /** Subtracted from `PointerEvent.timeStamp` to get the response time. */
  readonly touchOffsetMs: number;
  /** Nominal refresh rate (Hz) measured at session start. */
  readonly refreshHz: number;
}

/**
 * Session monotonic clock. Time zero is the session anchor (set at `session_start`); values are
 * `performance.now()`-based milliseconds and never decrease. Wall time is informational only.
 */
export interface Clock {
  /** `performance.now()` value at the session anchor. */
  readonly anchorPerfMs: number;
  /** The SKU timing profile in force. */
  readonly profile: TimingProfile;
  /** Milliseconds since the session anchor (monotonic, sub-ms precision). */
  now(): number;
  /** ISO-8601 wall time with offset; informational (clock-offset estimation only). */
  wallTime(): string;
  /** Convert a DOMHighResTimeStamp (rAF timestamp, `PointerEvent.timeStamp`) to session time. */
  fromPerformanceTime(perfMs: number): number;
  /** Convert a pointer timestamp to session time and subtract the per-SKU touch offset. */
  fromPointerTime(pointerTimeStamp: number): number;
  /** Convert an `AudioContext.currentTime` value (seconds) to session time plus the audio output offset. */
  fromAudioTime(audioContextSeconds: number): number;
  /** Resolve on the next animation frame with the presented-onset estimate (session ms, display offset applied). */
  nextFrame(): Promise<number>;
  /** Resolve after `ms` of session time; rejects with the signal's reason when aborted. */
  delay(ms: number, signal?: AbortSignal): Promise<void>;
}

/* ================================================================================================
 * Randomness (ENG-03)
 * ============================================================================================== */

/** Serializable PCG32 state for replay (`pnpm replay <seed> <bundleHash>`). */
export interface RngState {
  readonly algorithm: 'pcg32';
  /** 64-bit state as 16 hex characters. */
  readonly state: string;
  /** 64-bit stream increment as 16 hex characters. */
  readonly increment: string;
}

/**
 * Deterministic seeded RNG (PCG32). The same session seed + bundle reproduce every schedule.
 * Never use `Math.random()` in game logic.
 */
export interface SeededRng {
  /** Session seed (16 hex chars) this generator descends from. */
  readonly seedHex: string;
  /** Dotted name of this substream, e.g. `session.dont_tap.schedule`. */
  readonly streamName: string;
  /** Next uniformly distributed unsigned 32-bit integer. */
  nextUint32(): number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] (both inclusive). */
  int(min: number, max: number): number;
  /** True with probability `p` (default 0.5). */
  bool(p?: number): boolean;
  /** Uniformly chosen element; throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** Weighted choice; weights must be non-negative and not all zero. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** New array in a Fisher-Yates shuffled order (input untouched). */
  shuffle<T>(items: readonly T[]): T[];
  /** Independent named substream derived from this stream's seed and the name (stable across runs). */
  stream(name: string): SeededRng;
  /** Snapshot of the generator state. */
  state(): RngState;
}

/* ================================================================================================
 * Event logging (ENG-07, ING-01)
 * ============================================================================================== */

/** Default task/condition/scorability applied to events logged through a (child) logger. */
export interface LogScope {
  /** Task position; null for session-level events. */
  readonly task: EventTaskPosition | null;
  /** Experimental condition; null for session-level events. */
  readonly condition: EventCondition | null;
  /** False for practice, warm-up and onboarding. Practice/warm-up phases force false. */
  readonly scorable: boolean;
}

/** Per-call overrides. Event time (`t_mono_ms`) is always the logging time; measured times go in the payload. */
export interface LogOptions {
  readonly task?: EventTaskPosition | null;
  readonly condition?: EventCondition | null;
  readonly scorable?: boolean;
  /** True when a pause interrupted the trial (excluded from latency indicators). */
  readonly interrupted?: boolean;
  /** Timing quality; anything but `ok` excludes the trial from timing-sensitive indicators. */
  readonly timingFlag?: TimingFlag;
}

/** Receipt for a logged event. */
export interface LoggedEvent {
  readonly eventId: string;
  readonly seq: number;
  readonly tMonoMs: number;
  /** False if validation failed and an `invalid` placeholder was written with the same seq. */
  readonly valid: boolean;
}

/**
 * Typed logger. Fills the envelope (versions, context, timing, null server fields), validates with
 * the strict Ajv validator, allocates a gapless per-session `seq` in the same outbox transaction,
 * and never throws into gameplay (failures become `invalid` placeholders).
 */
export interface EventLogger {
  /** Current session id (UUIDv7). */
  readonly sessionId: string;
  /** Defaults applied by this logger. */
  readonly scope: LogScope;
  /** Log one event with a payload typed by its `event_type`. */
  log<T extends EventType>(type: T, payload: PayloadOf<T>, options?: LogOptions): LoggedEvent;
  /** Derived logger sharing the session sequence, with merged scope defaults. */
  child(scope: Partial<LogScope>): EventLogger;
  /** Resolve once every event logged so far is durably stored in the outbox. */
  flush(): Promise<void>;
}

/** Offline-first outbox (KSK-07). Browser build: IndexedDB (Dexie); Electron: SQLite adapter later. */
export interface Outbox {
  /** Append an event row and allocate its `seq` atomically; returns the allocated seq. */
  append(sessionId: string, build: (seq: number) => unknown): Promise<number>;
  /** Next seq that will be allocated for a session. */
  nextSeq(sessionId: string): Promise<number>;
  /** Build the next session-ordered upload batch (<= 500 events or <= 256 kB), or null when empty. */
  nextBatch(): Promise<UploadBatch | null>;
  /** Apply per-event server statuses; terminal statuses are purged after the grace period. */
  applyResult(result: UploadBatchResult): Promise<void>;
  /** Delete a session's local rows (in-session withdrawal) and queue a tombstone. */
  purgeSession(sessionId: string): Promise<void>;
  /** Count of events not yet acknowledged by the server. */
  pendingCount(): Promise<number>;
}

/* ================================================================================================
 * Audio and voice (VOX-01, VOX-02)
 * ============================================================================================== */

/** Where sound is routed. Voice-forbidden clips are refused on `speaker` (KSK-05). */
export type AudioOutput = 'speaker' | 'headset';

/** A playing sound. `onsetMs` is the scheduled onset on the session clock with the SKU audio offset applied. */
export interface AudioHandle {
  readonly onsetMs: number;
  /** Resolves when playback ends. */
  readonly ended: Promise<'completed' | 'interrupted'>;
  /** Stop with a short fade (default 30 ms). */
  stop(fadeMs?: number): void;
}

/** Options for a sound effect. */
export interface SfxOptions {
  /** 0..1 relative to the SFX bus. */
  readonly volume?: number;
  /** -1 (left) .. 1 (right). */
  readonly pan?: number;
  /** Session-clock time to start at; default now. */
  readonly atMs?: number;
}

/** Procedural music, SFX and ambience (Web Audio). Pre-recorded voice goes through {@link VoiceService}. */
export interface AudioService {
  /** Resume the AudioContext after the first user gesture (attract touch). */
  unlock(): Promise<void>;
  /** True once the AudioContext is running. */
  readonly unlocked: boolean;
  /** Current output route. */
  readonly output: AudioOutput;
  /** Play a procedural sound effect. */
  playSfx(id: SfxId, options?: SfxOptions): AudioHandle;
  /** Cross-fade to a music cue (loops until changed). */
  playMusic(cue: MusicCueId, options?: { readonly fadeMs?: number }): void;
  /** Fade out the current music. */
  stopMusic(fadeMs?: number): void;
  /** Set (or clear with null) the ambience bed. */
  setAmbience(id: AmbienceId | null, options?: { readonly fadeMs?: number }): void;
  /** Duck music and ambience by `amount` (0..1) until the returned release function is called. */
  duck(amount: number, rampMs?: number): () => void;
  /** Master volume 0..1 (a11y volume boost may exceed the default cap within policy). */
  setMasterVolume(volume: number): void;
  readonly masterVolume: number;
  /** Stop everything immediately (session wipe). */
  stopAll(): void;
}

/** Result of a finished voice clip; the voice service also logs `audio.played` with these fields. */
export interface VoicePlaybackResult {
  readonly lineId: LineId;
  readonly language: LanguageTag;
  readonly status: 'completed' | 'interrupted';
  /** Session-clock onset (audio offset applied). */
  readonly onsetMs: number;
  /** Session-clock end; logged as `prompt_audio_end` for prompts (latency anchor `audio_end`). */
  readonly endMs: number;
  readonly durationMs: number;
  readonly output: AudioOutput;
  /** Manifest version and clip hash (null for the dev placeholder). */
  readonly manifestVersion: string;
  readonly sha256: string | null;
  /** True when produced by the dev-only Web Speech placeholder (never in production builds). */
  readonly placeholder: boolean;
}

/** A voice clip in flight. */
export interface VoicePlayback {
  readonly lineId: LineId;
  /** Resolves with the corrected onset time once audio actually starts. */
  readonly started: Promise<number>;
  /** Resolves when the clip ends or is interrupted. Never rejects. */
  readonly ended: Promise<VoicePlaybackResult>;
  /** Interrupt with a 30 ms fade (barge-in, skip, walkaway). */
  interrupt(): void;
}

/** Options for {@link VoiceService.play}. */
export interface VoicePlayOptions {
  /** Abort (e.g. walkaway) interrupts playback. */
  readonly signal?: AbortSignal;
  /** Interrupt the clip currently playing (default true). */
  readonly interruptCurrent?: boolean;
  /** Duck music/ambience while speaking (default true). */
  readonly duck?: boolean;
  /** Mark as a player-requested replay (logs `instruction_replay`). */
  readonly replay?: boolean;
}

/**
 * Pre-recorded voice by line id x language through the signed audio manifest. There is NO runtime
 * TTS in production; `isDevPlaceholder` is true only when `VITE_DEV_VOICE_PLACEHOLDER` is set in a dev
 * build (the placeholder shows a "DEV VOICE" banner and is compiled out of production builds).
 */
export interface VoiceService {
  readonly language: LanguageTag;
  readonly isDevPlaceholder: boolean;
  /** True when the line exists for the current language (manifest or placeholder). */
  has(lineId: LineId): boolean;
  /** True when the line is on the never-voice list (`voice_forbidden`): refused on speakers. */
  isVoiceForbidden(lineId: LineId): boolean;
  /** Play one line. */
  play(lineId: LineId, options?: VoicePlayOptions): VoicePlayback;
  /** Play several lines gaplessly (e.g. report segments); one playback for the whole sequence. */
  playSequence(lineIds: readonly LineId[], options?: VoicePlayOptions): VoicePlayback;
  /** Replay the most recent instructional line, or null if none. */
  replayLast(options?: VoicePlayOptions): VoicePlayback | null;
  /** Stop all voice immediately. */
  stop(): void;
  /** Pre-decode clips for an upcoming module/episode. */
  preload(lineIds: readonly LineId[]): Promise<void>;
  /** Switch language (before consent freely; after consent the switch is logged). */
  setLanguage(language: LanguageTag): Promise<void>;
  /**
   * True while any narration clip is audibly playing (from the clip start until it ends or is
   * interrupted). Optional for backward compatibility; the engine treats a missing value as "not
   * speaking". The walkaway timer pauses while this is true (KSK-04: idle counts only after prompts).
   */
  readonly speaking?: boolean;
  /**
   * Subscribe to {@link VoiceService.speaking} transitions (called only on change, never with the
   * current value). Optional for backward compatibility.
   */
  onSpeakingChange?(listener: (speaking: boolean) => void): Unsubscribe;
}

/** Optional closed-vocabulary speech input (VOX-04). Touch always works without it. */
export interface SpeechInput {
  /** False unless policy, consent, ASR evaluation and noise all allow it for this prompt. */
  isAvailable(promptId: string): boolean;
  /**
   * Open the microphone only for this consented prompt window and propose a label from `vocabulary`.
   * Audio stays in a RAM ring buffer and is discarded after decoding.
   */
  listen(
    promptId: string,
    vocabulary: readonly string[],
    signal: AbortSignal,
  ): Promise<{ readonly label: string | null; readonly confidence: number | null }>;
}

/* ================================================================================================
 * Input (ENG-06, KSK-05)
 * ============================================================================================== */

/** Physical screen geometry used to enforce >= 20 mm targets at the configured DPI. */
export interface PhysicalMetrics {
  readonly pxPerMm: number;
  readonly minTargetPx: number;
  readonly minSpacingPx: number;
}

/** A tappable/holdable region. Every interactive element has an audio key (KSK-05 lint). */
export interface TargetSpec {
  readonly id: string;
  /** Stage-pixel bounds (must be >= {@link TOUCH_TARGET_MIN_MM} on both axes). */
  readonly bounds: Rect;
  /** Voice line describing the target (replayed on long-press help). */
  readonly audioKey: LineId;
  readonly kind: 'tap' | 'hold' | 'drag';
  readonly enabled?: boolean;
}

/** Handle for a registered target. */
export interface TargetHandle {
  readonly id: string;
  setBounds(bounds: Rect): void;
  setEnabled(enabled: boolean): void;
  remove(): void;
}

/** Every raw tap, never debounced (extra and premature taps included). Times are session ms. */
export interface RawTap {
  readonly targetId: string | null;
  /** Normalised to the safe area, origin top-left. */
  readonly xyNorm: readonly [number, number];
  /** Pointer time on the session clock, touch offset applied. */
  readonly tMs: number;
  readonly pointerType: 'touch' | 'pen' | 'mouse';
  readonly activePoints: number;
  /** Palm/ghost touches are filtered; multi-touch (>= 2) is interference except in co-play zones. */
  readonly filtered: 'none' | 'palm' | 'multi_touch_interference';
}

/** Result of waiting for a tap. */
export type TapResult =
  | { readonly kind: 'tap'; readonly tap: RawTap; readonly latencyMs: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' };

/** Result of waiting for a hold. */
export type HoldResult =
  | {
      readonly kind: 'hold';
      readonly targetId: string;
      readonly startMs: number;
      readonly holdMs: number;
      readonly completed: boolean;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' };

/** One option in a SayOrTouch prompt: an icon (always) plus an optional voice label. */
export interface SayOrTouchOption<C extends string = string> {
  /** Closed response code stored as `response_value`. */
  readonly code: C;
  readonly iconId: string;
  readonly audioKey: LineId;
}

/**
 * A closed-vocabulary prompt answered by touch, or (when enabled) by voice confirmed per policy.
 * `voiceCodes` must be a subset of the option codes (VOX-04 AC); private reports are touch only.
 */
export interface SayOrTouchPrompt<C extends string = string> {
  readonly promptId: string;
  /** 2-4 options (ChoiceGrid). */
  readonly options: readonly SayOrTouchOption<C>[];
  readonly voiceCodes?: readonly C[];
  /** Spoken prompt; when set, the latency anchor defaults to `audio_end`. */
  readonly promptLine?: LineId;
  /** Response window in ms from the anchor; null = untimed (self-paced). From the level table. */
  readonly windowMs: number | null;
  readonly latencyAnchor: LatencyAnchor;
  /** Allow changing the selection before confirming; every change is recorded in `revisions`. */
  readonly allowRevisions: boolean;
  /** Require a tick confirmation after selection. */
  readonly requireConfirm: boolean;
  /** Private report (never voiced, touch only, headset rules apply). */
  readonly privateReport: boolean;
  readonly signal?: AbortSignal;
}

/** Outcome of a SayOrTouch prompt; maps 1:1 onto the `response` event payload. */
export interface SayOrTouchResult<C extends string = string> {
  readonly kind: 'response' | 'timeout' | 'aborted';
  /** Committed code, null on timeout/abort. */
  readonly value: C | null;
  readonly inputMode: InputMode;
  /** Signed latency from the anchor; null only on timeout/abort. Negative with `bargeIn` = true. */
  readonly latencyMs: number | null;
  readonly bargeIn: boolean;
  /** Session time of the committing input, null on timeout. */
  readonly responseMs: number | null;
  readonly revisions: readonly { readonly value: C; readonly tMs: number }[];
  readonly tapCount: number;
  readonly touchXyNorm: readonly [number, number] | null;
  readonly asrLabel: C | null;
  readonly asrConfidence: number | null;
}

/** Unified input layer. Touch is primary; a voice adapter plugs in through {@link SpeechInput}. */
export interface InputService {
  readonly metrics: PhysicalMetrics;
  /** Register a target; in dev builds throws if it is smaller than 20 mm or closer than 8 mm to another. */
  registerTarget(spec: TargetSpec): TargetHandle;
  /** Subscribe to every raw tap (the input layer also logs `input.raw_tap`). */
  onRawTap(listener: (tap: RawTap) => void): Unsubscribe;
  /** Wait for a tap on one of `targetIds`; latency is measured from `anchorMs` (session time). */
  waitForTap(
    targetIds: readonly string[],
    options: {
      readonly anchorMs: number;
      readonly windowMs: number | null;
      readonly signal?: AbortSignal;
    },
  ): Promise<TapResult>;
  /** Wait for a hold on `targetId` of at least `requiredMs` (logs `input.hold`). */
  waitForHold(
    targetId: string,
    options: {
      readonly requiredMs: number;
      readonly windowMs: number | null;
      readonly signal?: AbortSignal;
    },
  ): Promise<HoldResult>;
  /** Run a SayOrTouch prompt (icon first; mic ring only when ASR is enabled for this prompt). */
  sayOrTouch<C extends string>(prompt: SayOrTouchPrompt<C>): Promise<SayOrTouchResult<C>>;
  /** Globally enable/disable input (e.g. during transitions). */
  setEnabled(enabled: boolean): void;
  /** Session time of the last touch (idle/walkaway detection). */
  readonly lastInteractionMs: number;
}

/* ================================================================================================
 * Layout, art kit and scenes (KSK-06, BUILD_DECISIONS art direction)
 * ============================================================================================== */

/** Screen layout in stage pixels. */
export interface Layout {
  readonly width: number;
  readonly height: number;
  /** Region safe for interactive content (targets live in the lower two-thirds, KSK-06). */
  readonly safeArea: Rect;
  readonly orientation: 'landscape' | 'portrait';
  readonly metrics: PhysicalMetrics;
  /** Notified after a resize with the new layout. */
  onChange(listener: (layout: Layout) => void): Unsubscribe;
}

/** Scenes of the golden-hour Indian village market fair. */
export type SceneId =
  | 'attract'
  | 'market_square'
  | 'hub'
  | 'stall_front'
  | 'weighing_post'
  | 'road_home'
  | 'tower_courtyard'
  | 'balloon_fair'
  | 'card_tent'
  | 'share_circle'
  | 'report';

export type TimeOfDay = 'morning' | 'midday' | 'golden_hour' | 'dusk';

/** An animated, parallax backdrop. */
export interface Backdrop {
  readonly view: Container;
  readonly sceneId: SceneId;
  setTimeOfDay(timeOfDay: TimeOfDay, options?: { readonly durationMs?: number }): Promise<void>;
  /** -1..1 horizontal parallax offset. */
  setParallax(offset: number): void;
  destroy(): void;
}

export type CharacterRole =
  | 'guide'
  | 'player'
  | 'customer'
  | 'assistant'
  | 'partner'
  | 'inspector'
  | 'vendor';

export type Expression =
  | 'neutral'
  | 'happy'
  | 'thinking'
  | 'surprised'
  | 'calm'
  | 'annoyed'
  | 'angry';

export type CharacterAnimation =
  | 'idle'
  | 'wave'
  | 'nod'
  | 'point'
  | 'walk_in'
  | 'walk_out'
  | 'celebrate'
  | 'shrug';

/** Character to create. Customer `toneLevel` (0 calm .. 4 hostile) is a stimulus property, never player sensing. */
export interface CharacterSpec {
  readonly id: string;
  readonly role: CharacterRole;
  /** Seeded appearance variant (attire, palette); same variant = same look. */
  readonly variant?: number;
  readonly toneLevel?: 0 | 1 | 2 | 3 | 4;
  readonly facing?: 'left' | 'right';
  readonly scale?: number;
}

/** A procedural character. */
export interface Character {
  readonly view: Container;
  readonly spec: CharacterSpec;
  setExpression(expression: Expression): void;
  /** Lip-sync to a voice playback until it ends. */
  speak(playback: VoicePlayback): Promise<void>;
  play(animation: CharacterAnimation): Promise<void>;
  lookAt(point: Point): void;
  destroy(): void;
}

/** Icon-only button (no text, no numerals). */
export interface ButtonSpec {
  readonly id: string;
  readonly iconId: string;
  readonly audioKey: LineId;
  readonly variant: 'primary' | 'secondary' | 'confirm' | 'cancel' | 'replay' | 'help' | 'exit';
  /** Edge length in mm (>= {@link TOUCH_TARGET_MIN_MM}). */
  readonly sizeMm?: number;
}

/** A created button; register it with the input service via its target id. */
export interface UiButton {
  readonly view: Container;
  readonly targetId: string;
  setEnabled(enabled: boolean): void;
  /** Attention pulse (<= 3 Hz). */
  pulse(): void;
  destroy(): void;
}

export type ParticleKind =
  | 'confetti'
  | 'sparkle'
  | 'dust'
  | 'petals'
  | 'smoke'
  | 'coins'
  | 'leaves';

export interface ParticleSpec {
  readonly kind: ParticleKind;
  readonly origin: Point;
  readonly count?: number;
  readonly durationMs?: number;
}

export interface ParticleEmitter {
  readonly view: Container;
  burst(count?: number): void;
  stop(): void;
  destroy(): void;
}

export type TransitionKind = 'fade' | 'iris' | 'wipe_left' | 'wipe_right' | 'curtain';

/** Colour-blind-safe palette tokens (colour is never the only cue). Hex RGB numbers. */
export interface Palette {
  readonly sky: number;
  readonly sun: number;
  readonly earth: number;
  readonly foliage: number;
  readonly accentA: number;
  readonly accentB: number;
  readonly accentC: number;
  readonly ink: number;
  readonly paper: number;
  readonly confirm: number;
  readonly cancel: number;
}

/**
 * Original procedural/vector art (no third-party images). Deliberately has no text or number API
 * (ENG-11): quantities are shown as needles, piles and pictured tokens.
 */
export interface ArtKit {
  readonly palette: Palette;
  createBackdrop(sceneId: SceneId, timeOfDay: TimeOfDay): Backdrop;
  createCharacter(spec: CharacterSpec): Character;
  createButton(spec: ButtonSpec): UiButton;
  /** Round icon button (replay, help, exit, globe, hand). */
  createIconButton(
    spec: Omit<ButtonSpec, 'variant'> & { readonly variant?: ButtonSpec['variant'] },
  ): UiButton;
  createIcon(iconId: string, sizeMm: number): Container;
  createParticles(spec: ParticleSpec): ParticleEmitter;
  /** Full-stage transition; resolves when the covering half completes if `midpoint` is given, else at the end. */
  transition(
    kind: TransitionKind,
    options?: { readonly durationMs?: number; readonly midpoint?: () => void | Promise<void> },
  ): Promise<void>;
}

/* ================================================================================================
 * Calibration, session state (KSK-02, ENG-10) and report model (REP-01..03)
 * ============================================================================================== */

/** Locked calibration decision for the session (exactly one level per session). */
export interface CalibrationDecision {
  readonly level: CalibrationLevel;
  readonly policy: CalibrationPolicy;
  readonly reason:
    | 'default'
    | 'practice_struggle'
    | 'a11y_choice'
    | 'classifier'
    | 'forced'
    | 'retest_lock';
}

/** Session statechart states (KSK-02). */
export type SessionStateName = SessionState;

/** Why a session ended without completing. */
export type AbandonReason =
  | 'timeout'
  | 'explicit_exit'
  | 'consent_declined'
  | 'crash_recovery'
  | 'under_age';

/** Events accepted by the session statechart. */
export type SessionMachineEvent =
  | { readonly type: 'TOUCH_START' }
  | { readonly type: 'LANGUAGE_SELECTED'; readonly language: LanguageTag }
  | {
      readonly type: 'CONSENT_GRANTED';
      readonly tapConfirmed: true;
      readonly archiveOptIn: boolean;
    }
  | { readonly type: 'CONSENT_DECLINED' }
  | {
      readonly type: 'BANDS_ANSWERED';
      readonly bands: Omit<BandsAnsweredPayload, 'answer_latency_ms' | 'change_count'>;
    }
  | { readonly type: 'UNDER_AGE' }
  | { readonly type: 'WARMUP_DONE'; readonly calibration: CalibrationDecision }
  | { readonly type: 'MODULE_DONE'; readonly result: ModuleResult }
  | { readonly type: 'PLAY_DONE' }
  | { readonly type: 'REPORT_DONE' }
  | { readonly type: 'SURVEY_DONE' }
  | { readonly type: 'OPTIN_DONE'; readonly contactOptIn: boolean }
  | { readonly type: 'IDLE_TIMEOUT' }
  | { readonly type: 'EXIT'; readonly erase: boolean }
  | { readonly type: 'CRASH' };

/** Read-only snapshot of the running session for UI and modules. Contains no identity data. */
export interface SessionSnapshot {
  readonly sessionId: string;
  readonly state: SessionStateName;
  readonly mode: SessionMode;
  readonly siteMode: SiteMode;
  readonly pathway: Pathway | null;
  readonly arm: BatteryArm | null;
  readonly slotForm: SlotForm | null;
  readonly formId: string;
  readonly language: LanguageTag | null;
  readonly consentGranted: boolean;
  readonly archiveOptIn: boolean;
  readonly calibration: CalibrationDecision | null;
  /** Module order for this session (fixed order + slot for B; three episodes for A). */
  readonly plannedModules: readonly ModuleId[];
  readonly completedModules: readonly ModuleResult[];
  readonly startedAtMs: number;
  readonly context: SessionContext | null;
}

/** Internal ordinal band code; both poles are strengths-framed and only phrase keys reach players. */
export type BandCode = 'pole_a' | 'centre' | 'pole_b';

/** One trait line in a participant report. Never contains a number. */
export interface ReportTrait {
  readonly trait: ConstructId;
  readonly band: BandCode;
  /** Allowlisted phrase key (digits are impossible by schema). */
  readonly phraseKey: string;
}

interface ReportModelBase {
  readonly language: LanguageTag;
  readonly disclaimerKey: string;
  readonly deliveryModes: readonly ('spoken' | 'printed' | 'qr' | 'screen')[];
}

/** Default: thank-you only (closed battery gate, invalid/expired pack, flagged session, or policy). */
export interface ThankYouReportModel extends ReportModelBase {
  readonly mode: 'thank_you';
  readonly reason:
    | 'battery_gate_closed'
    | 'release_pack_invalid'
    | 'release_pack_expired'
    | 'session_not_valid_for_report'
    | 'no_trait_released'
    | 'policy_thank_you_only';
}

/** Fictional example profile for think-aloud comprehension testing; never computed from play. */
export interface DemoProfile {
  readonly demoProfileId: string;
  readonly traits: readonly ReportTrait[];
}

/** Demo report: built only from a {@link DemoProfile}; it has no session-derived inputs by construction. */
export interface DemoReportModel extends ReportModelBase {
  readonly mode: 'demo';
  readonly demoProfileId: string;
  readonly traits: readonly ReportTrait[];
}

/** Player report: only via a valid, unexpired, signature-checked release pack (display rule, gates.yaml). */
export interface PlayerReportModel extends ReportModelBase {
  readonly mode: 'player_report';
  readonly releasePackVersion: string;
  /** 0-5 traits; empty means the UI falls back to thank-you. */
  readonly traits: readonly ReportTrait[];
  readonly normProvisional: boolean;
}

/** What the report screen renders. Discriminated on `mode`. */
export type ReportModel = ThankYouReportModel | DemoReportModel | PlayerReportModel;

/** Verifies and exposes the signed release pack (REP-03). Fails closed. */
export interface ReleasePackReader {
  /** The verified pack, or null when missing, expired, tampered or mismatched with the dictionary. */
  current(): ReleasePack | null;
}

/* ================================================================================================
 * Game module contract (ENG-05)
 * ============================================================================================== */

/** Why a module was stopped from outside (passed as the AbortSignal reason). */
export interface ModuleAbortReason {
  readonly kind: 'walkaway' | 'explicit_exit' | 'withdrawn' | 'time_cap' | 'crash';
}

/** Read a typed {@link ModuleAbortReason} from an aborted signal (null when not aborted). */
export function abortReasonOf(signal: AbortSignal): ModuleAbortReason | null {
  if (!signal.aborted) return null;
  const r: unknown = signal.reason;
  if (r !== null && typeof r === 'object' && 'kind' in r) {
    const kind = (r as { kind: unknown }).kind;
    if (
      kind === 'walkaway' ||
      kind === 'explicit_exit' ||
      kind === 'withdrawn' ||
      kind === 'time_cap' ||
      kind === 'crash'
    ) {
      return { kind };
    }
  }
  return { kind: 'crash' };
}

const ABORT_KINDS: ReadonlySet<string> = new Set<ModuleAbortReason['kind']>([
  'walkaway',
  'explicit_exit',
  'withdrawn',
  'time_cap',
  'crash',
]);

/**
 * True when `error` is an expected abort rather than a failure: a typed screen/module abort error
 * (anything with `isAbort === true`, e.g. the onboarding `ScreenAbortedError`), a DOM `AbortError`,
 * a {@link ModuleAbortReason} thrown by `signal.throwIfAborted()` / `Clock.delay`, or a legacy
 * `Error('aborted')`. Session code treats these as a normal abort (never as a crash).
 */
export function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return error === 'aborted';
  const e = error as { isAbort?: unknown; name?: unknown; message?: unknown; kind?: unknown };
  if (e.isAbort === true) return true;
  if (e.name === 'AbortError' || e.name === 'ScreenAbortedError') return true;
  if (typeof e.kind === 'string' && ABORT_KINDS.has(e.kind) && !(error instanceof Error)) {
    return true;
  }
  if (typeof e.message === 'string') {
    const m = e.message.trim().toLowerCase();
    return m === 'aborted' || m === 'screen aborted' || m === 'module aborted';
  }
  return false;
}

/** Why a module is asked to wrap up gracefully (ENG-05). */
export type WrapUpReason = 'soft_cap' | 'session_time';

/**
 * Soft-cap wrap-up signal (ENG-05). When requested, a module should finish its current trial, skip
 * remaining optional trials (block minimums stay protected) and play its outro, then resolve `run()`
 * with `endedReason: 'completed'`. Unlike {@link ModuleContext.signal} this never aborts anything; the
 * hard cap still ends the module with `time_cap`.
 */
export interface WrapUpSignal {
  /** True once a wrap-up was requested. */
  readonly requested: boolean;
  /** Why, or null before a request. */
  readonly reason: WrapUpReason | null;
  /** Session-clock time of the request, or null. */
  readonly requestedAtMs: number | null;
  /** Aborted (with the {@link WrapUpReason} as reason) when a wrap-up is requested; race waits on it. */
  readonly signal: AbortSignal;
  /** Called once when the wrap-up is requested (immediately if it already was). */
  onRequest(listener: (reason: WrapUpReason) => void): Unsubscribe;
}

/** How a module ended (matches `module_end.ended_reason`). */
export type ModuleEndedReason =
  | 'completed'
  | 'time_cap'
  | 'walkaway'
  | 'explicit_exit'
  | 'withdrawn'
  | 'error'
  | 'skipped';

/** Summary returned by {@link GameModule.run}. Contains counts only, never scores (ENG-11). */
export interface ModuleResult {
  readonly moduleId: ModuleId;
  readonly endedReason: ModuleEndedReason;
  readonly durationMs: number;
  readonly trialsCompleted: number;
  readonly scorableTrials: number;
  /** Trial index of the logged context shift, null when the module has none. */
  readonly contextShiftIndex: number | null;
  /** True when the module ended after a soft-cap wrap-up request (set by the module host). */
  readonly wrappedUp?: boolean;
}

/** Session facts a module may read (no identity data). */
export interface ModuleSessionInfo {
  readonly sessionId: string;
  readonly pathway: Pathway;
  readonly mode: SessionMode;
  readonly siteMode: SiteMode;
  readonly formId: string;
  readonly slotForm: SlotForm | null;
  /** Headset currently connected (private-report rules, KSK-12). */
  readonly headset: boolean;
  /** Accessibility slow-pace choice (maps to L1, flagged). */
  readonly slowPace: boolean;
}

/** Development-only switches (all false in production builds). */
export interface DevFlags {
  /** Debug overlay with seed, trial, condition and frame timing (PLT-01). */
  readonly overlay: boolean;
  /** Web Speech placeholder voice (VITE_DEV_VOICE_PLACEHOLDER). */
  readonly voicePlaceholder: boolean;
  /** Headless bot mode (ENG-05: any module runs headlessly with a scripted bot). */
  readonly headless: boolean;
}

/** Everything a module receives. Services are owned by the engine; modules must not destroy them. */
export interface ModuleContext<TConfig extends GameConfig = GameConfig> {
  /** Pixi application (shared). */
  readonly app: Application;
  /** Root container owned by this module; the engine removes it after `destroy()`. */
  readonly stage: Container;
  readonly layout: Layout;
  /** Module-specific substream (e.g. `session.dont_tap`); derive further substreams by name. */
  readonly rng: SeededRng;
  /** Logger pre-scoped with `task.module_id` (and `episode_id` for episodes). */
  readonly logger: EventLogger;
  readonly audio: AudioService;
  readonly voice: VoiceService;
  readonly input: InputService;
  readonly art: ArtKit;
  readonly clock: Clock;
  /** Locked calibration level; read load parameters from `levelConfig`, never hard-code them. */
  readonly level: CalibrationLevel;
  readonly language: LanguageTag;
  /** Validated module config from `content/games/**`. */
  readonly config: TConfig;
  /** `config.levels[level]`. */
  readonly levelConfig: LevelConfig;
  readonly session: ModuleSessionInfo;
  /** Aborted on walkaway/exit/withdrawal/hard cap; reason via {@link abortReasonOf}. */
  readonly signal: AbortSignal;
  readonly dev: DevFlags;
  /**
   * Soft-cap wrap-up request (ENG-05): requested at `config.budget.soft_cap_ms` or when the session's
   * play time runs out. Always provided by the module host; optional only so hand-built test
   * contexts stay valid.
   */
  readonly wrapUp?: WrapUpSignal;
}

/**
 * A playable unit (micro-game, episode or warm-up). Lifecycle: `init(ctx)` -> `run()` -> `destroy()`.
 * `run()` resolves (never rejects for expected aborts) with `endedReason` set accordingly, and must log
 * `module_start`/`module_end` plus all trial events through `ctx.logger`.
 */
export interface GameModule<TConfig extends GameConfig = GameConfig> {
  readonly id: ModuleId;
  readonly kind: 'micro' | 'episode' | 'warmup';
  /** Constructs this module provides evidence for (must match the dictionary/config). */
  readonly constructs: readonly ConstructId[];
  /** Indicator ids this module emits (ENG-08 declarations). */
  readonly indicators: readonly IndicatorId[];
  /** Prepare scene, preload audio, build the seeded schedule. */
  init(ctx: ModuleContext<TConfig>): Promise<void>;
  /** Play to completion, soft-cap wrap-up, hard cap or abort. */
  run(): Promise<ModuleResult>;
  /** Release Pixi objects, listeners and timers. Idempotent. */
  destroy(): void;
}

/** Creates fresh module instances (one per session). */
export type GameModuleFactory<TConfig extends GameConfig = GameConfig> = () => GameModule<TConfig>;

/** Registry of module factories keyed by id (plain record form). */
export type ModuleRegistry = Readonly<Partial<Record<ModuleId, GameModuleFactory>>>;

/** Live registry lookup (implemented by the engine's `GameModuleRegistry`). */
export interface ModuleFactoryLookup {
  /** The factory registered for `id`, or undefined. */
  get(id: ModuleId): GameModuleFactory | undefined;
}

/** Produces the deterministic trial schedule for a module (ENG-09). */
export interface TrialScheduler {
  /** Build the schedule for `config` at `level` from `rng`; satisfies every constraint and minimum or throws. */
  schedule(
    config: GameConfig,
    level: CalibrationLevel,
    rng: SeededRng,
    formId: string,
  ): readonly GameTrialSpec[];
}

/** The `response` event payload type. */
export type ResponsePayload = PayloadOf<'response'>;

/**
 * Map a {@link SayOrTouchResult} onto the `response` event payload. Timeouts become
 * `input_mode: timeout` with null value and latency (the only case where latency is null).
 * Aborted prompts must not be logged as responses (log `trial_end` with outcome `aborted`), so they throw.
 */
export function toResponsePayload<C extends string>(
  result: SayOrTouchResult<C>,
  options: {
    readonly stimulusId: string | null;
    readonly correctness: boolean | null;
    readonly latencyAnchor: LatencyAnchor;
    readonly holdMs?: number | null;
  },
): ResponsePayload {
  if (result.kind === 'aborted') {
    throw new Error('aborted prompts are not responses; log trial_end with outcome "aborted"');
  }
  const timeout = result.kind === 'timeout';
  const voiced = result.inputMode === 'voice' || result.inputMode === 'voice_then_touch_confirm';
  return {
    stimulus_id: options.stimulusId,
    response_value: timeout ? null : result.value,
    correctness: timeout ? null : options.correctness,
    input_mode: timeout ? 'timeout' : result.inputMode,
    latency_ms: timeout ? null : result.latencyMs,
    latency_anchor: options.latencyAnchor,
    barge_in: timeout ? false : result.bargeIn,
    hold_ms: options.holdMs ?? null,
    tap_count: result.tapCount,
    revisions: result.revisions.map((r) => ({ value: r.value, t_ms: r.tMs })),
    touch_xy_norm: result.touchXyNorm ? [result.touchXyNorm[0], result.touchXyNorm[1]] : null,
    asr_label: voiced ? result.asrLabel : null,
    asr_confidence: voiced ? result.asrConfidence : null,
  };
}
