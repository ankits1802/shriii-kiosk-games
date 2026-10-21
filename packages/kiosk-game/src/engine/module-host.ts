/**
 * ModuleHost (ENG-05): runs one {@link GameModule} against a fresh {@link ModuleContext}.
 *
 * - Logs `module_start` before `init()` and `module_end` after the module settles. If a module also
 *   logs them itself, the duplicates are dropped (the host's records are canonical).
 * - Gates the module's logger: once the module has ended, nothing it (or the input layer routed to
 *   it) logs is written, so no event of a module can follow its `module_end`.
 * - Requests a graceful wrap-up through `ctx.wrapUp` at `budget.soft_cap_ms` (or when the session
 *   asks via `request.wrapUp`); the module finishes its current trial and outro and completes.
 * - Enforces the hard cap: at `budget.hard_cap_ms` the context signal aborts with
 *   `{kind:'time_cap'}`; a module that does not settle within the grace period is ended by the host.
 * - Propagates session aborts (walkaway, exit, withdrawal, crash) through the same signal.
 * - Never throws: init/run errors end the module with `ended_reason: 'error'`.
 * - Routes the input layer's raw-tap logging to the module-scoped logger while the module runs.
 * - Resolves modules through the {@link GameModuleRegistry} (or a plain record); the generic
 *   placeholder module is used only when no factory is registered for the id.
 */
import type {
  CalibrationLevel,
  EventTaskPosition,
  EventType,
  GameConfig,
  LanguageTag,
  PayloadOf,
} from '@shriii/contracts';
import type { Application, Container } from 'pixi.js';
import {
  type ArtKit,
  type AudioService,
  abortReasonOf,
  type Clock,
  type DevFlags,
  type EventLogger,
  type GameModule,
  type InputService,
  isAbortError,
  type Layout,
  type LoggedEvent,
  type LogOptions,
  type LogScope,
  type ModuleAbortReason,
  type ModuleContext,
  type ModuleEndedReason,
  type ModuleFactoryLookup,
  type ModuleId,
  type ModuleRegistry,
  type ModuleResult,
  type ModuleSessionInfo,
  type SeededRng,
  type VoiceService,
} from '../core/contracts.ts';
import { GatedLogger, LoggerGate, warnOnLateEvents } from '../logging/gated-logger.ts';
import type { GameContent } from './content.ts';
import { type ModuleSource, resolveModule } from './registry.ts';
import { WrapUpController } from './wrap-up.ts';

/** Services shared by every module (owned by the engine). */
export interface PlayServices {
  readonly app: Application;
  readonly layout: Layout;
  readonly audio: AudioService;
  readonly voice: VoiceService;
  readonly input: InputService & { setLogger?: (logger: EventLogger | null) => void };
  readonly art: ArtKit;
  /** Create the module's root container (added to the stage). */
  createStage(moduleId: ModuleId): Container;
  /** Remove and destroy a module's root container. */
  releaseStage(stage: Container): void;
}

/** What the session controller asks the host to run. */
export interface ModuleRunRequest {
  readonly moduleId: ModuleId;
  readonly level: CalibrationLevel;
  readonly language: LanguageTag;
  /** Session root logger. */
  readonly logger: EventLogger;
  /** Session root RNG (`session`); the host derives `session.<module_id>`. */
  readonly rng: SeededRng;
  readonly clock: Clock;
  readonly session: ModuleSessionInfo;
  /** Session abort (walkaway, exit, withdrawal, crash). */
  readonly signal: AbortSignal;
  /** Session-level wrap-up request (play time running out); aborting it requests a wrap-up. */
  readonly wrapUp?: AbortSignal;
}

/** Anything that can run modules for the session controller. */
export interface ModuleRunner {
  run(request: ModuleRunRequest): Promise<ModuleResult>;
}

export interface ModuleHostOptions {
  readonly content: GameContent;
  /** Plain record or a live {@link GameModuleRegistry} (looked up at each run). */
  readonly registry: ModuleRegistry | ModuleFactoryLookup;
  readonly services: PlayServices;
  readonly dev: DevFlags;
  /** Used when the registry has no factory for a module (e.g. the generic fallback module). */
  readonly fallback?: (moduleId: ModuleId) => GameModule | null;
  /** How long a module may take to settle after an abort before the host ends it (default 2 s). */
  readonly abortGraceMs?: number;
  /** Notified when a module instance is resolved (dev overlay, harness, tests). */
  readonly onResolved?: (moduleId: ModuleId, source: ModuleSource) => void;
  /** Notified for events a module logs after its end (dropped). Default: dev warning. */
  readonly onLateEvent?: (type: EventType, moduleId: string) => void;
}

const ABORT_TO_ENDED: Readonly<Record<ModuleAbortReason['kind'], ModuleEndedReason>> = {
  walkaway: 'walkaway',
  explicit_exit: 'explicit_exit',
  withdrawn: 'withdrawn',
  time_cap: 'time_cap',
  crash: 'error',
};

/** Module logger wrapper that suppresses module-authored `module_start` / `module_end`. */
class HostedLogger implements EventLogger {
  readonly sessionId: string;
  readonly scope: LogScope;
  private readonly inner: EventLogger;
  private readonly hostReceipt: () => LoggedEvent;

  constructor(inner: EventLogger, hostReceipt: () => LoggedEvent) {
    this.inner = inner;
    this.sessionId = inner.sessionId;
    this.scope = inner.scope;
    this.hostReceipt = hostReceipt;
  }

  log<T extends EventType>(type: T, payload: PayloadOf<T>, options?: LogOptions): LoggedEvent {
    if (type === 'module_start' || type === 'module_end') return this.hostReceipt();
    return this.inner.log(type, payload, options);
  }

  child(scope: Partial<LogScope>): EventLogger {
    return new HostedLogger(this.inner.child(scope), this.hostReceipt);
  }

  flush(): Promise<void> {
    return this.inner.flush();
  }
}

function baseTask(config: GameConfig, formId: string): EventTaskPosition {
  return {
    episode_id: config.kind === 'episode' ? config.module_id : null,
    module_id: config.module_id,
    block_id: null,
    trial_id: null,
    trial_index: null,
    form_id: config.forms.includes(formId) ? formId : config.forms[0],
    anchor_trial: false,
  };
}

export class ModuleHost implements ModuleRunner {
  private readonly opts: ModuleHostOptions;

  constructor(options: ModuleHostOptions) {
    this.opts = options;
  }

  async run(req: ModuleRunRequest): Promise<ModuleResult> {
    const { content, registry, services, dev } = this.opts;
    const id = req.moduleId;
    const skipped = (): ModuleResult => ({
      moduleId: id,
      endedReason: 'skipped',
      durationMs: 0,
      trialsCompleted: 0,
      scorableTrials: 0,
      contextShiftIndex: null,
    });
    if (!content.has(id)) return skipped();
    const config = content.get(id);
    const resolved = resolveModule(registry, id, this.opts.fallback);
    if (!resolved) return skipped();
    const module = resolved.module;
    this.opts.onResolved?.(id, resolved.source);

    const clock = req.clock;
    const startMs = clock.now();
    const levelConfig = config.levels[req.level];
    const scoped = req.logger.child({
      task: baseTask(config, req.session.formId),
      condition: null,
      scorable: config.scorable,
    });
    const startReceipt = scoped.log('module_start', {
      module_id: config.module_id,
      kind: config.kind === 'episode' ? 'episode' : 'micro',
      paradigms: config.paradigms,
      duration_budget_ms: levelConfig.estimated_duration_ms.median,
      soft_cap_ms: config.budget.soft_cap_ms,
      hard_cap_ms: config.budget.hard_cap_ms,
      config_hash: content.configHash(id),
    });
    // Gate: once the module has ended nothing it still holds may write events (ENG-05/ENG-07).
    const gate = new LoggerGate(
      id,
      this.opts.onLateEvent ?? (import.meta.env?.DEV ? warnOnLateEvents() : undefined),
    );
    const logger: EventLogger = new GatedLogger(
      new HostedLogger(scoped, () => startReceipt),
      gate,
      () => clock.now(),
    );

    // Abort plumbing: session abort or hard cap.
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort(req.signal.reason);
    if (req.signal.aborted) controller.abort(req.signal.reason);
    else req.signal.addEventListener('abort', onParentAbort, { once: true });
    const capTimer = new AbortController();
    clock.delay(config.budget.hard_cap_ms, capTimer.signal).then(
      () => controller.abort({ kind: 'time_cap' } satisfies ModuleAbortReason),
      () => undefined,
    );
    // Soft cap: graceful wrap-up request (the module decides how to finish).
    const wrapUp = new WrapUpController(() => clock.now());
    clock.delay(config.budget.soft_cap_ms, capTimer.signal).then(
      () => wrapUp.request('soft_cap'),
      () => undefined,
    );
    const onSessionWrapUp = (): void => {
      wrapUp.request('session_time');
    };
    if (req.wrapUp?.aborted) wrapUp.request('session_time');
    else req.wrapUp?.addEventListener('abort', onSessionWrapUp, { once: true });

    const stage = services.createStage(id);
    const ctx: ModuleContext = {
      app: services.app,
      stage,
      layout: services.layout,
      rng: req.rng.stream(id),
      logger,
      audio: services.audio,
      voice: services.voice,
      input: services.input,
      art: services.art,
      clock,
      level: req.level,
      language: req.language,
      config,
      levelConfig,
      session: req.session,
      signal: controller.signal,
      dev,
      wrapUp: wrapUp.signal,
    };
    services.input.setLogger?.(logger);

    let result: ModuleResult;
    try {
      await module.init(ctx);
      result = await this.raceAbort(module.run(), controller.signal, clock, id, startMs);
    } catch (err) {
      const reason = abortReasonOf(controller.signal);
      // A module that rethrows its abort (legacy behaviour) ended normally; anything else failed.
      if (!(reason && isAbortError(err))) console.error(`[module-host] ${id} failed`, err);
      result = {
        moduleId: id,
        endedReason: reason ? ABORT_TO_ENDED[reason.kind] : 'error',
        durationMs: clock.now() - startMs,
        trialsCompleted: 0,
        scorableTrials: 0,
        contextShiftIndex: null,
      };
    } finally {
      capTimer.abort();
      req.signal.removeEventListener('abort', onParentAbort);
      req.wrapUp?.removeEventListener('abort', onSessionWrapUp);
      // Close before module_end: anything the module logs from here on is dropped.
      gate.close();
      try {
        module.destroy();
      } catch (err) {
        console.error(`[module-host] ${id} destroy failed`, err);
      }
      try {
        services.releaseStage(stage);
      } catch {
        // stage already gone
      }
      services.input.setLogger?.(req.logger);
    }

    const durationMs = Math.round((clock.now() - startMs) * 1000) / 1000;
    const final: ModuleResult = {
      ...result,
      moduleId: id,
      durationMs,
      ...(wrapUp.requested ? { wrappedUp: true } : {}),
    };
    scoped.log('module_end', {
      module_id: config.module_id,
      ended_reason: final.endedReason,
      duration_ms: durationMs,
      trials_completed: final.trialsCompleted,
    });
    return final;
  }

  /** Resolve with the module's result, or end it after the grace period once aborted. */
  private raceAbort(
    run: Promise<ModuleResult>,
    signal: AbortSignal,
    clock: Clock,
    id: ModuleId,
    startMs: number,
  ): Promise<ModuleResult> {
    const grace = this.opts.abortGraceMs ?? 2000;
    return new Promise<ModuleResult>((resolve, reject) => {
      let settled = false;
      const forced = (): void => {
        void clock.delay(grace).then(() => {
          if (settled) return;
          settled = true;
          const reason = abortReasonOf(signal);
          resolve({
            moduleId: id,
            endedReason: reason ? ABORT_TO_ENDED[reason.kind] : 'error',
            durationMs: clock.now() - startMs,
            trialsCompleted: 0,
            scorableTrials: 0,
            contextShiftIndex: null,
          });
        });
      };
      if (signal.aborted) forced();
      else signal.addEventListener('abort', forced, { once: true });
      run.then(
        (r) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', forced);
          // An aborted module reports the abort reason even if it returned "completed".
          const reason = abortReasonOf(signal);
          resolve(
            reason && r.endedReason === 'completed'
              ? { ...r, endedReason: ABORT_TO_ENDED[reason.kind] }
              : r,
          );
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', forced);
          reject(err);
        },
      );
    });
  }
}
