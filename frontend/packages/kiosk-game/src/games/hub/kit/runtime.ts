/**
 * Micro-game runtime shared by the Pathway B set-2 modules (Share-the-Pot, Steady Hands, Four Stalls,
 * Private Dice) and the carousel hub.
 *
 * It wraps a {@link ModuleContext} with the small amount of policy every module needs:
 *
 * - abort-safe waiting (`sleep`, `check`): an aborted module context (walkaway, exit, hard cap)
 *   surfaces as a {@link ModuleAbortedError}, which `isAbortError()` recognises as an expected abort;
 * - level-table timing reads that fail closed when a key is missing (ENG-10: no hard-coded timers);
 * - the soft-cap wrap-up request (ENG-05);
 * - voice lines with optional lip-sync and procedural SFX (failures never reach gameplay);
 * - `visual` (a real Pixi renderer is attached) and `bot` (headless scripted bot, `dev.headless`)
 *   switches, so the same module code runs on the kiosk, in the dev harness and in vitest;
 * - phase notifications for screenshot and bot tooling (never logged, never shown).
 */
import type { GameConfig } from '@shriii/contracts';
import {
  abortReasonOf,
  type Character,
  type EventLogger,
  type LineId,
  type ModuleContext,
  type ModuleEndedReason,
  type ModuleId,
  type SfxId,
  type SfxOptions,
} from '../../../core/contracts.ts';
import { type RawTapClassifier, routeInputLogging, withRawTapClassifier } from './logging.ts';

/** Thrown by runtime waits once the module context aborted. An expected abort, never a crash. */
export class ModuleAbortedError extends Error {
  readonly isAbort = true as const;
  constructor() {
    super('module aborted');
    this.name = 'ModuleAbortedError';
  }
}

/** Thrown when the module config lacks a value the module needs (fail closed, ENG-04). */
export class MicroGameConfigError extends Error {
  constructor(moduleId: string, message: string) {
    super(`[${moduleId}] ${message}`);
    this.name = 'MicroGameConfigError';
  }
}

/** Where a module is in its flow (dev tooling only). */
export interface PhaseInfo {
  readonly moduleId: string;
  readonly phase: string;
  /** Trial index the phase belongs to, or null. */
  readonly trialIndex: number | null;
  /** Session-clock time of the notification. */
  readonly tMs: number;
}

/** Optional hooks a factory can pass to a module (dev harness, screenshot and bot tooling). */
export interface MicroGameHooks {
  /** Called on every phase change (intro, practice, trial, reveal, outro, ...). */
  readonly onPhase?: (info: PhaseInfo) => void;
}

/** True when `app` carries a live Pixi renderer (false for headless contexts and test stubs). */
export function hasRenderer(app: unknown): boolean {
  if (app === null || typeof app !== 'object') return false;
  const r = (app as { renderer?: unknown }).renderer;
  return r !== null && typeof r === 'object';
}

export class GameRuntime<TConfig extends GameConfig = GameConfig> {
  readonly ctx: ModuleContext<TConfig>;
  readonly moduleId: ModuleId;
  /** A real renderer is attached: build and animate the scene. */
  readonly visual: boolean;
  /** Headless scripted bot drives the input (ENG-05 AC). */
  readonly bot: boolean;
  private readonly hooks: MicroGameHooks;
  private readonly disposers: (() => void)[] = [];
  private currentPhase = 'init';
  private readonly startedMs: number;
  private classifier: RawTapClassifier | null = null;
  private inputBase: EventLogger | null = null;
  private routed = false;

  constructor(ctx: ModuleContext<TConfig>, moduleId: ModuleId, hooks: MicroGameHooks = {}) {
    this.ctx = ctx;
    this.moduleId = moduleId;
    this.visual = hasRenderer(ctx.app);
    this.bot = ctx.dev.headless;
    this.hooks = hooks;
    this.startedMs = ctx.clock.now();
  }

  /** Session time since the module was initialised (the host starts its caps just before init). */
  elapsedMs(): number {
    return this.now() - this.startedMs;
  }

  /**
   * ENG-05 graceful wrap-up, anticipated: true when an optional trial (one above its block minimum)
   * should be skipped because the soft cap has been requested, or because `requiredMs` (the time the
   * remaining required trials, probe segment and outro still need) plus `nextMs` (this trial) would
   * overrun the module's soft cap. Block minimums are never skipped by callers.
   */
  shouldSkipOptional(requiredMs: number, nextMs: number): boolean {
    if (this.wrapUpRequested()) return true;
    return this.elapsedMs() + requiredMs + nextMs > this.ctx.config.budget.soft_cap_ms;
  }

  /** `budget_trial_ms` of a block (or the level's median seconds per trial) in ms. */
  trialBudgetMs(blockId: string): number {
    const b = this.ctx.config.blocks.find((x) => x.block_id === blockId);
    if (b?.budget_trial_ms) return b.budget_trial_ms;
    return this.ctx.levelConfig.seconds_per_trial.median * 1000;
  }

  get signal(): AbortSignal {
    return this.ctx.signal;
  }

  get aborted(): boolean {
    return this.ctx.signal.aborted;
  }

  get phaseName(): string {
    return this.currentPhase;
  }

  /** Session-clock now. */
  now(): number {
    return this.ctx.clock.now();
  }

  /** Throw {@link ModuleAbortedError} when the module context has been aborted. */
  check(): void {
    if (this.ctx.signal.aborted) throw new ModuleAbortedError();
  }

  /** Wait `ms` of session time; throws {@link ModuleAbortedError} on abort. */
  async sleep(ms: number): Promise<void> {
    this.check();
    if (ms <= 0) return;
    try {
      await this.ctx.clock.delay(ms, this.ctx.signal);
    } catch {
      throw new ModuleAbortedError();
    }
  }

  /** Wait until the given session time (no-op when already past). */
  async sleepUntil(tMs: number): Promise<void> {
    await this.sleep(tMs - this.now());
  }

  /** True once a soft-cap / session-time wrap-up has been requested (ENG-05). */
  wrapUpRequested(): boolean {
    return this.ctx.wrapUp?.requested ?? false;
  }

  /** A level-table timing value (ms) that must exist. */
  timing(key: string): number {
    const v = this.ctx.levelConfig.timing[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new MicroGameConfigError(
        this.moduleId,
        `levels.${this.ctx.level}.timing.${key} is missing (ENG-10: timings come from the level table)`,
      );
    }
    return v;
  }

  /** A required numeric constraint. */
  constraintNumber(key: string): number {
    const v = (this.ctx.config.constraints as Record<string, unknown>)[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new MicroGameConfigError(this.moduleId, `constraints.${key} must be a number`);
    }
    return v;
  }

  /** A required list of numbers from the constraints. */
  constraintNumbers(key: string): number[] {
    const v = (this.ctx.config.constraints as Record<string, unknown>)[key];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new MicroGameConfigError(this.moduleId, `constraints.${key} must be a list of numbers`);
    }
    return v as number[];
  }

  /** A required list of strings from the constraints. */
  constraintStrings(key: string): string[] {
    const v = (this.ctx.config.constraints as Record<string, unknown>)[key];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new MicroGameConfigError(this.moduleId, `constraints.${key} must be a list of strings`);
    }
    return v as string[];
  }

  /** An optional boolean constraint. */
  constraintBoolean(key: string): boolean | null {
    const v = (this.ctx.config.constraints as Record<string, unknown>)[key];
    return typeof v === 'boolean' ? v : null;
  }

  /** Planned and minimum trial counts of a block from the config. */
  block(blockId: string): { readonly trials: number; readonly minTrials: number } {
    const b = this.ctx.config.blocks.find((x) => x.block_id === blockId);
    if (!b) throw new MicroGameConfigError(this.moduleId, `block '${blockId}' is not configured`);
    return { trials: b.trials, minTrials: b.min_trials };
  }

  /** Notify dev tooling of a phase change. */
  phase(name: string, trialIndex: number | null = null): void {
    this.currentPhase = name;
    try {
      this.hooks.onPhase?.({ moduleId: this.moduleId, phase: name, trialIndex, tMs: this.now() });
    } catch {
      // dev hooks never break gameplay
    }
  }

  /** Play a procedural sound effect (never throws). */
  sfx(id: SfxId, options?: SfxOptions): void {
    try {
      this.ctx.audio.playSfx(id, options);
    } catch {
      // audio is decorative; a failure never reaches gameplay
    }
  }

  /**
   * Play a pre-recorded voice line (skipped when the language pack lacks it) and lip-sync `speaker`.
   * Resolves when the line ends; throws {@link ModuleAbortedError} if the module aborted meanwhile.
   */
  async say(lineId: LineId, speaker?: Character | null): Promise<void> {
    this.check();
    if (!this.ctx.voice.has(lineId)) return;
    const pb = this.ctx.voice.play(lineId, { signal: this.ctx.signal });
    if (speaker) void speaker.speak(pb).catch(() => undefined);
    await pb.ended;
    this.check();
  }

  /** Start a voice line without waiting (lip-sync included). */
  sayAsync(lineId: LineId, speaker?: Character | null): void {
    if (this.aborted || !this.ctx.voice.has(lineId)) return;
    const pb = this.ctx.voice.play(lineId, { signal: this.ctx.signal });
    if (speaker) void speaker.speak(pb).catch(() => undefined);
  }

  /**
   * Route the input layer's raw-tap / hold logging to `base` (the open trial's logger, so every tap
   * carries its trial position and condition) or, with null, back to the module logger. The module's
   * raw-tap classifier, if any, wraps whichever logger is active.
   */
  routeInput(base: EventLogger | null): void {
    this.inputBase = base;
    const b = base ?? this.ctx.logger;
    const logger = this.classifier ? withRawTapClassifier(b, this.classifier) : b;
    if (routeInputLogging(this.ctx.input, logger) && !this.routed) {
      this.routed = true;
      this.onDispose(() => routeInputLogging(this.ctx.input, this.ctx.logger));
    }
  }

  /** Install a module-aware raw-tap classifier (see `logging.ts`). */
  setRawTapClassifier(classify: RawTapClassifier | null): void {
    this.classifier = classify;
    this.routeInput(this.inputBase);
  }

  /** `module_end.ended_reason` implied by the context's abort state. */
  endedReason(): ModuleEndedReason {
    const r = abortReasonOf(this.ctx.signal);
    if (!r) return 'completed';
    return r.kind === 'crash' ? 'error' : r.kind;
  }

  /** Register a teardown callback (run by {@link dispose}, most recent first). */
  onDispose(fn: () => void): void {
    this.disposers.push(fn);
  }

  dispose(): void {
    for (const fn of this.disposers.splice(0).reverse()) {
      try {
        fn();
      } catch {
        // teardown is best effort
      }
    }
  }
}

/** Round a session time / duration to microsecond precision for logging. */
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
