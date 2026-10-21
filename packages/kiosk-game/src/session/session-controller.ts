/**
 * Session orchestration (KSK-02, KSK-04, ONB-02/04/06/07, ENG-10, MG-10, EPI-04/05).
 *
 * Owns one session at a time: creates the session id, seed, clock, RNG and logger at the first touch;
 * drives the statechart; logs every onboarding/session event; runs the warm-up and the pathway's
 * modules through a {@link ModuleRunner}; derives the calibration from the warm-up events; produces
 * the report model (thank-you unless a valid release pack says otherwise); and wipes at the end.
 *
 * Fail-closed rules:
 * - Before core consent every event is held locally (never uploaded). Declining consent, an under-18
 *   band or abandoning before consent purges the whole session: nothing is uploaded, nothing kept
 *   except the anonymous declined counter.
 * - In-session withdrawal (EXIT with erase) purges local rows and queues a tombstone.
 * - Abandon or crash after consent keeps the consented events (no resume).
 * - Uploads are paused for the whole session (no upload activity during play).
 */
import type {
  A11YProfile,
  BandsAnsweredPayload,
  BatteryArm,
  CalibrationLevel,
  CalibrationPolicy,
  EventEnvelope,
  EventSessionContext,
  EventVersions,
  LanguageTag,
  Pathway,
  PracticeSummaryPayload,
  SessionContext,
  SessionState,
  SlotForm,
  SurveyEnjoyPayload,
  SurveyPlayAgainPayload,
} from '@shriii/contracts';
import { type Actor, createActor } from 'xstate';
import type {
  Clock,
  ModuleId,
  ModuleResult,
  ModuleSessionInfo,
  ReportModel,
  SessionMachineEvent,
  SessionSnapshot,
} from '../core/contracts.ts';
import {
  assignForm,
  isSlotForm,
  type KeyValueStore,
  MemoryKeyValueStore,
  PermutedBlockAssigner,
  PILOT_ARMS,
} from '../engine/assignment.ts';
import {
  CalibrationLock,
  decideCalibration,
  warmupMetricsFromEvents,
} from '../engine/calibration.ts';
import { SessionClock } from '../engine/clock.ts';
import type { GameContent } from '../engine/content.ts';
import { isModuleId } from '../engine/content.ts';
import type { ModuleRunner } from '../engine/module-host.ts';
import { createSessionRng, type Pcg32Rng } from '../engine/rng.ts';
import {
  createSessionLogger,
  type EventValidator,
  type SessionEventLogger,
} from '../logging/event-logger.ts';
import type { KioskOutbox } from '../logging/outbox/types.ts';
import type { BatchUploader } from '../logging/uploader.ts';
import { randomSeedHex, uuidv7 } from '../logging/uuid.ts';
import type { KioskDeviceConfig } from './device.ts';
import {
  type SessionEndReason,
  type SessionMachineSnapshot,
  type SessionTimers,
  sessionMachine,
  sessionTimersFromPlan,
  stateNameOf,
} from './session-machine.ts';
import {
  type WalkawayConfig,
  WalkawayMonitor,
  type WalkawayStage,
  walkawayConfigFromPlan,
} from './walkaway.ts';

/** Optional extra detail the onboarding/survey UI can attach to statechart events. */
export interface SessionEventExtras {
  /** LANGUAGE_SELECTED: taps used to choose. */
  readonly taps?: number;
  /** CONSENT_GRANTED / CONSENT_DECLINED: replays per consent segment. */
  readonly replayCounts?: readonly number[];
  /** BANDS_ANSWERED: per-question answer latency and number of changes (ONB-04 AC). */
  readonly latencies?: BandsAnsweredPayload['answer_latency_ms'];
  readonly changeCount?: number;
  /** SURVEY_DONE: micro-survey answers (ONB-07); default `skipped`. */
  readonly enjoy?: SurveyEnjoyPayload['face'];
  readonly playAgain?: SurveyPlayAgainPayload['answer'];
  /** WARMUP_DONE: practice summary and warm-up metrics (logged with the calibration result). */
  readonly practiceSummary?: PracticeSummaryPayload;
  readonly warmupRtMs?: number | null;
  readonly warmupAccuracy?: number | null;
}

/** An event sent to the controller: a statechart event plus optional extras. */
export type SessionControllerEvent = SessionMachineEvent & SessionEventExtras;

/** Snapshot published to the UI. */
export interface KioskSessionView extends SessionSnapshot {
  readonly walkawayStage: WalkawayStage | null;
  readonly currentModule: ModuleId | null;
  /** Language faces in this session's seeded random order (ONB-01). */
  readonly languageFaceOrder: readonly LanguageTag[];
  readonly report: ReportModel | null;
  readonly seedHex: string | null;
}

export interface SessionControllerOptions {
  readonly content: GameContent;
  readonly outbox: KioskOutbox;
  readonly device: KioskDeviceConfig;
  /** Kiosk-level persistent store (slot/arm permuted blocks). */
  readonly store?: KeyValueStore;
  readonly uploader?: BatchUploader | null;
  /** Runs the warm-up and pathway modules; null = the UI/tests drive WARMUP_DONE/MODULE_DONE. */
  readonly runner?: ModuleRunner | null;
  readonly clockFactory?: () => Clock;
  readonly seedFactory?: () => string;
  readonly calibrationPolicy?: CalibrationPolicy;
  readonly forcedLevel?: CalibrationLevel | null;
  /** Fixed arm, or `randomised` (EPI-05 permuted blocks, offline fallback). Default `B_fixed`. */
  readonly arm?: BatteryArm | 'randomised';
  readonly validate?: EventValidator;
  readonly reportProvider?: (snapshot: SessionSnapshot) => ReportModel;
  readonly offerContactOptIn?: boolean;
  readonly timers?: Partial<SessionTimers>;
  readonly walkaway?: Partial<WalkawayConfig>;
  readonly refreshHz?: number;
  /** Input layer hooks: activity resets walkaway, timed windows suspend it, raw taps get the logger. */
  readonly input?: {
    onActivity(listener: (tMs: number) => void): () => void;
    onWindowChange(listener: (open: boolean) => void): () => void;
    setLogger(logger: SessionEventLogger | null): void;
    setClock?(clock: Clock): void;
  } | null;
  readonly onError?: (error: unknown) => void;
}

interface ActiveSession {
  readonly sessionId: string;
  readonly seedHex: string;
  readonly clock: Clock;
  readonly rng: Pcg32Rng;
  readonly logger: SessionEventLogger;
  readonly formId: string;
  readonly arm: BatteryArm;
  readonly armSource: 'offline_fallback' | 'forced' | 'not_applicable';
  readonly pathway: Pathway;
  readonly slot: SlotForm | null;
  readonly plannedModules: ModuleId[];
  readonly faceOrder: LanguageTag[];
  readonly slotPeek: ReturnType<PermutedBlockAssigner<SlotForm>['peek']> | null;
  readonly armPeek: ReturnType<PermutedBlockAssigner<BatteryArm>['peek']> | null;
  readonly calibration: CalibrationLock;
  readonly warmupEvents: EventEnvelope[];
  /** Trials paused by a walkaway prompt (`<module>#<trial>`); their later events are interrupted. */
  readonly interruptedTrials: Set<string>;
  /** The trial between its `trial_start` and `trial_end`, if any. */
  openTrial: string | null;
  readonly abort: AbortController;
  /** Live envelope context (language changes after selection). */
  readonly contextRef: { current: EventSessionContext };
  readonly consent: { granted: boolean };
  context: SessionContext;
  language: LanguageTag | null;
  lastState: SessionState;
  currentModule: ModuleId | null;
  lastTrialId: string | null;
  lastModuleId: string | null;
  report: ReportModel | null;
  playIndex: number;
  finalizing: boolean;
  a11ySlowPace: boolean;
}

const DEFAULT_REPORT = (s: SessionSnapshot): ReportModel => ({
  mode: 'thank_you',
  reason: 'battery_gate_closed',
  language: s.language ?? 'en-IN',
  disclaimerKey: 'report.disclaimer',
  deliveryModes: ['spoken', 'screen'],
});

export class SessionController {
  private readonly opts: SessionControllerOptions;
  private readonly actor: Actor<typeof sessionMachine>;
  private readonly walkaway: WalkawayMonitor;
  private readonly slotAssigner: PermutedBlockAssigner<SlotForm>;
  private readonly armAssigner: PermutedBlockAssigner<BatteryArm>;
  private readonly listeners = new Set<(view: KioskSessionView) => void>();
  private readonly unsubscribers: (() => void)[] = [];
  private session: ActiveSession | null = null;
  private pendingTrigger: string | null = null;
  private prevState: SessionState = 'attract';
  private view: KioskSessionView;
  private disposed = false;
  /** Resolves when the last wipe finished (tests). */
  private wipeDone: Promise<void> = Promise.resolve();

  constructor(options: SessionControllerOptions) {
    this.opts = options;
    const plan = options.content.plan;
    const store = options.store ?? new MemoryKeyValueStore();
    const slots = plan.pathways.B.slot_candidates.filter(isSlotForm);
    this.slotAssigner = new PermutedBlockAssigner<SlotForm>({
      store,
      kioskSeedHex: options.device.kioskSeedHex,
      name: 'slot',
      values: slots,
      blockSize: plan.pathways.B.slot_randomisation.block_size,
    });
    this.armAssigner = new PermutedBlockAssigner<BatteryArm>({
      store,
      kioskSeedHex: options.device.kioskSeedHex,
      name: 'arm',
      values: PILOT_ARMS,
      blockSize: 2,
    });
    const timers = sessionTimersFromPlan(plan, options.timers);
    this.actor = createActor(sessionMachine, {
      input: { timers, offerContactOptIn: options.offerContactOptIn ?? false },
    });
    const walkCfg = { ...walkawayConfigFromPlan(plan), ...options.walkaway };
    this.walkaway = new WalkawayMonitor(
      walkCfg,
      {
        onPrompt: (stage, idle) => {
          // A pause marks the running trial interrupted (KSK-04): excluded from latency indicators.
          const open = this.session?.openTrial;
          if (open) this.session?.interruptedTrials.add(open);
          this.session?.logger.log('walkaway.prompted', {
            stage,
            elapsed_idle_ms: Math.round(idle),
          });
          this.publish();
        },
        onResume: (stage, idle) => {
          this.session?.logger.log('walkaway.resumed', {
            stage,
            elapsed_idle_ms: Math.round(idle),
          });
          this.publish();
        },
        onIdle: (duration) => {
          this.session?.logger.log('idle', {
            duration_ms: Math.round(duration),
            state: this.prevState,
            after_response_window: true,
          });
        },
        onAbandon: () => {
          this.send({ type: 'IDLE_TIMEOUT' });
        },
      },
      () => this.session?.clock.now() ?? 0,
    );
    if (options.input) {
      this.unsubscribers.push(options.input.onActivity(() => this.walkaway.activity()));
      this.unsubscribers.push(
        options.input.onWindowChange((open) =>
          open ? this.walkaway.windowOpen() : this.walkaway.windowClose(),
        ),
      );
    }
    this.view = this.buildView(this.actor.getSnapshot());
    this.actor.subscribe((snap) => this.onSnapshot(snap));
    this.actor.start();
  }

  /* ---------------------------------------------------------------- public API */

  /** Current UI snapshot. */
  get snapshot(): KioskSessionView {
    return this.view;
  }

  /** Subscribe to snapshot changes (called immediately with the current snapshot). */
  subscribe(listener: (view: KioskSessionView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  }

  /** The running session's logger (onboarding/report screens log through it), or null in attract. */
  get logger(): SessionEventLogger | null {
    return this.session?.logger ?? null;
  }

  /** The running session's clock, or null in attract. */
  get clock(): Clock | null {
    return this.session?.clock ?? null;
  }

  /** Resolves when the most recent wipe has finished its storage work. */
  whenIdle(): Promise<void> {
    return this.wipeDone;
  }

  /**
   * Send a statechart event. Returns false when the current state does not accept it (e.g. a
   * consent tap after the session was abandoned).
   */
  send(event: SessionControllerEvent): boolean {
    if (this.disposed) return false;
    const snap = this.actor.getSnapshot();
    if (!snap.can(event)) return false;
    try {
      this.before(event, snap);
    } catch (err) {
      this.opts.onError?.(err);
    }
    this.pendingTrigger = event.type.toLowerCase();
    this.actor.send(event);
    this.pendingTrigger = null;
    return true;
  }

  /** Accessibility profile from onboarding (slow pace maps to L1, flagged). */
  setA11yProfile(profile: A11YProfile): void {
    const s = this.session;
    if (!s) return;
    s.a11ySlowPace = profile.slow_pace;
    s.context = { ...s.context, a11y: profile, headset: profile.headset };
    s.logger.log('a11y.profile', { profile });
  }

  /** Abort the running module (dev skip); the module ends with `explicit_exit`. */
  skipCurrentModule(): void {
    this.moduleAbort?.abort({ kind: 'explicit_exit' });
  }

  /* ---------------------------------------------------------------- devtools */

  /** Dev: force the calibration level for the rest of the session. */
  devSetCalibration(level: CalibrationLevel): void {
    const s = this.session;
    if (!s) return;
    const d = s.calibration.force(level);
    s.context = { ...s.context, calibration_level: d.level, calibration_policy: d.policy };
    s.logger.log('calibration_result', {
      policy: d.policy,
      level: d.level,
      reason: d.reason,
      warmup_rt_ms: null,
      warmup_accuracy: null,
    });
    this.publish();
  }

  /** Dev: switch language (before consent freely, after consent logged as a switch). */
  devSetLanguage(language: LanguageTag): void {
    if (!this.send({ type: 'LANGUAGE_SELECTED', language })) {
      const s = this.session;
      if (!s || s.language === language) return;
      s.logger.log('language_switched', {
        from_language: s.language ?? language,
        to_language: language,
        after_consent: s.consent.granted,
      });
      s.language = language;
      s.context = { ...s.context, language };
      this.publish();
    }
  }

  /** Dev: jump the walkaway machine to a stage (or straight to abandon). */
  devSimulateWalkaway(stage: WalkawayStage | 'abandon'): void {
    this.walkaway.simulate(stage);
  }

  /**
   * Dev: fast-forward onboarding (synthetic answers) and start play at `moduleId` (default: the
   * first planned module). Works from attract or from any onboarding state.
   */
  devQuickStart(
    options: {
      readonly moduleId?: ModuleId;
      readonly language?: LanguageTag;
      readonly level?: CalibrationLevel;
    } = {},
  ): void {
    const lang = options.language ?? this.opts.device.languages[0];
    this.send({ type: 'TOUCH_START' });
    this.send({ type: 'LANGUAGE_SELECTED', language: lang });
    this.send({ type: 'CONSENT_GRANTED', tapConfirmed: true, archiveOptIn: false });
    this.send({
      type: 'BANDS_ANSWERED',
      bands: {
        age: 'prefer_not_to_say',
        literacy: 'prefer_not_to_say',
        edu: 'prefer_not_to_say',
        gender: 'prefer_not_to_say',
        device_use: 'prefer_not_to_say',
        played_before: 'prefer_not_to_say',
      },
    });
    const s = this.session;
    if (!s) return;
    if (options.moduleId) {
      const idx = s.plannedModules.indexOf(options.moduleId);
      if (idx >= 0) s.playIndex = idx;
      else {
        s.plannedModules.splice(0, 0, options.moduleId);
        s.playIndex = 0;
      }
    }
    this.skipCurrentModule();
    const decision = s.calibration.force(options.level ?? 'L2');
    this.send({ type: 'WARMUP_DONE', calibration: decision });
  }

  /** Dev: jump to a module during play (aborts the current one). */
  devJumpToModule(moduleId: ModuleId): void {
    const s = this.session;
    if (!s || stateNameOf(this.actor.getSnapshot()) !== 'play') {
      this.devQuickStart({ moduleId });
      return;
    }
    const idx = s.plannedModules.indexOf(moduleId);
    if (idx >= 0) s.playIndex = idx;
    else s.plannedModules.splice(s.playIndex, 0, moduleId);
    this.jumpPending = true;
    this.skipCurrentModule();
  }

  dispose(): void {
    this.disposed = true;
    for (const u of this.unsubscribers) u();
    this.session?.abort.abort({ kind: 'crash' });
    this.walkaway.dispose();
    this.actor.stop();
    this.listeners.clear();
  }

  /* ---------------------------------------------------------------- internals */

  private moduleAbort: AbortController | null = null;
  private jumpPending = false;

  private beginSession(): ActiveSession {
    const o = this.opts;
    const plan = o.content.plan;
    const seedHex = (o.seedFactory ?? randomSeedHex)();
    const clock = (o.clockFactory ?? (() => new SessionClock()))();
    const rng = createSessionRng(seedHex);
    const sessionId = uuidv7();
    const formId = assignForm(rng);
    // Arm (EPI-05) and slot (MG-10) are peeked now and committed on consent.
    let arm: BatteryArm;
    let armSource: ActiveSession['armSource'];
    let armPeek: ActiveSession['armPeek'] = null;
    if (o.arm === 'randomised') {
      armPeek = this.armAssigner.peek();
      arm = armPeek.value;
      armSource = 'offline_fallback';
    } else {
      arm = o.arm ?? 'B_fixed';
      armSource = 'forced';
    }
    const pathway: Pathway = arm.startsWith('A') ? 'A' : 'B';
    const slotPeek = pathway === 'B' ? this.slotAssigner.peek() : null;
    const slot = slotPeek?.value ?? null;
    const plannedRaw =
      pathway === 'B'
        ? [...plan.pathways.B.core_order, ...(slot ? [slot] : [])]
        : [...plan.pathways.A.order];
    const plannedModules = plannedRaw.filter(isModuleId);
    const faceOrder = rng.stream('language_faces').shuffle(o.device.languages);
    const calibration = new CalibrationLock();
    const contextRef: { current: EventSessionContext } = {
      current: this.eventContext(arm, slot, null),
    };
    const consentRef = { granted: false };
    const versions: EventVersions = {
      ...o.device.versions,
      bundle_hash: o.content.bundleHash,
      timing_profile_version: clock.profile.version,
    };
    const warmupEvents: EventEnvelope[] = [];
    const interruptedTrials = new Set<string>();
    const trialKey = (moduleId: string | null, trialId: string): string =>
      `${moduleId ?? ''}#${trialId}`;
    const logger = createSessionLogger({
      sessionId,
      outbox: o.outbox,
      clock,
      context: () => contextRef.current,
      versions,
      consentGranted: () => consentRef.granted,
      ...(o.validate ? { validate: o.validate } : {}),
      isInterrupted: (task) =>
        task.trial_id !== null && interruptedTrials.has(trialKey(task.module_id, task.trial_id)),
      onEvent: (e) => {
        if (e.task?.module_id === plan.pathways[pathway].warmup) warmupEvents.push(e);
        if (e.task?.trial_id) {
          this.trackTrial(e.task.module_id, e.task.trial_id);
          const current = this.session;
          if (current && current.sessionId === sessionId) {
            const key = trialKey(e.task.module_id, e.task.trial_id);
            if (e.event_type === 'trial_start') current.openTrial = key;
            else if (e.event_type === 'trial_end' && current.openTrial === key)
              current.openTrial = null;
          }
        }
      },
      onWriteError: (err) => o.onError?.(err),
    });
    const session: ActiveSession = {
      sessionId,
      seedHex,
      clock,
      rng,
      logger,
      formId,
      arm,
      armSource,
      pathway,
      slot,
      plannedModules,
      faceOrder,
      slotPeek,
      armPeek,
      calibration,
      warmupEvents,
      interruptedTrials,
      openTrial: null,
      abort: new AbortController(),
      contextRef,
      consent: consentRef,
      context: this.initialContext(sessionId, arm, slot),
      language: null,
      lastState: 'attract',
      currentModule: null,
      lastTrialId: null,
      lastModuleId: null,
      report: null,
      playIndex: 0,
      finalizing: false,
      a11ySlowPace: false,
    };
    this.session = session;
    this.opts.uploader?.pause();
    logger.log('session_start', {
      seed: seedHex,
      rng_algorithm: 'pcg32',
      refresh_hz: o.refreshHz ?? clock.profile.refreshHz,
      arm_source: armSource,
      stratum: null,
      slot_form: slot,
    });
    logger.log('session.context', { context: session.context });
    o.input?.setClock?.(clock);
    o.input?.setLogger(logger);
    this.walkaway.start(o.device.mode);
    return session;
  }

  private eventContext(
    arm: BatteryArm | null,
    slot: SlotForm | null,
    language: LanguageTag | null,
  ): EventSessionContext {
    const d = this.opts.device;
    return {
      participant_pid: null,
      kiosk_id: d.kioskId,
      site_id: d.siteId,
      site_mode: d.siteMode,
      mode: d.mode,
      battery_arm: arm,
      slot_form: slot,
      language,
      player_slot: 1,
      synthetic: d.synthetic,
    };
  }

  private initialContext(
    sessionId: string,
    arm: BatteryArm,
    slot: SlotForm | null,
  ): SessionContext {
    const d = this.opts.device;
    return {
      schema_version: '1.0',
      session_id: sessionId,
      language: null,
      age_band: null,
      literacy_band: null,
      edu_band: null,
      gender: null,
      device_familiarity: null,
      played_before: null,
      asr_enabled: false,
      noise: { noise_floor_dbfs: null, samples: 0 },
      headset: false,
      a11y: {
        slow_pace: false,
        volume_boost: false,
        headset: false,
        pictogram_storyboard: false,
        hold_threshold_ms: null,
      },
      practice: { practice_struggle: false, skills_passed: [] },
      battery_arm: arm,
      slot_form: slot,
      calibration_level: null,
      calibration_policy: this.opts.calibrationPolicy ?? 'fixed_L2_with_L1_fallback',
      linkage_flag: false,
      linked_prior_session_token: null,
      device: { ...d.device },
      site_mode: d.siteMode,
      mode: d.mode,
      variant_pack_id: d.versions.variant_pack_id,
      completion: 'in_progress',
      walkaway_point: null,
    };
  }

  private setLanguage(s: ActiveSession, language: LanguageTag): void {
    s.language = language;
    s.context = { ...s.context, language };
    s.contextRef.current = { ...s.contextRef.current, language };
  }

  private trackTrial(moduleId: string | null, trialId: string): void {
    const s = this.session;
    if (!s) return;
    s.lastTrialId = trialId;
    s.lastModuleId = moduleId;
  }

  /** Side effects that must be logged before the transition (ordering matters for seq). */
  private before(event: SessionControllerEvent, snap: SessionMachineSnapshot): void {
    if (event.type === 'TOUCH_START' && stateNameOf(snap) === 'attract') {
      this.beginSession();
      return;
    }
    const s = this.session;
    if (!s) return;
    switch (event.type) {
      case 'LANGUAGE_SELECTED': {
        if (s.language === null) {
          this.setLanguage(s, event.language);
          s.logger.log('language_selected', {
            language: event.language,
            face_order: s.faceOrder as [LanguageTag, ...LanguageTag[]],
            pack_version: this.opts.device.languagePack.version,
            manifest_hash: this.opts.device.languagePack.manifestHash,
            taps: event.taps ?? 1,
          });
        } else if (s.language !== event.language) {
          const from = s.language;
          this.setLanguage(s, event.language);
          s.logger.log('language_switched', {
            from_language: from,
            to_language: event.language,
            after_consent: s.consent.granted,
          });
        }
        break;
      }
      case 'CONSENT_GRANTED': {
        s.consent.granted = true;
        const c = this.opts.device.consent;
        const replays =
          event.replayCounts && event.replayCounts.length > 0 ? [...event.replayCounts] : [0];
        s.logger.log('consent.granted', {
          consent_kind: 'core',
          tap_confirmed: true,
          consent_script_id: c.scriptId,
          consent_version_hash: c.versionHash,
          replay_counts: replays as [number, ...number[]],
          policy_version: c.policyVersion,
        });
        s.logger.log('optin.archive', { granted: event.archiveOptIn });
        // The session now counts for the permuted blocks.
        if (s.slotPeek) this.slotAssigner.commit(s.slotPeek);
        if (s.armPeek) this.armAssigner.commit(s.armPeek);
        break;
      }
      case 'BANDS_ANSWERED': {
        const b = event.bands;
        s.logger.log('bands.answered', {
          ...b,
          answer_latency_ms: event.latencies ?? {
            age: null,
            literacy: null,
            edu: null,
            gender: null,
            device_use: null,
            played_before: null,
          },
          change_count: event.changeCount ?? 0,
        });
        s.context = {
          ...s.context,
          age_band: b.age,
          literacy_band: b.literacy,
          edu_band: b.edu,
          gender: b.gender,
          device_familiarity: b.device_use,
          played_before: b.played_before,
        };
        s.logger.log('session.context', { context: s.context });
        break;
      }
      case 'WARMUP_DONE': {
        if (event.practiceSummary) {
          s.logger.log('practice.summary', event.practiceSummary);
          s.context = {
            ...s.context,
            practice: {
              practice_struggle: event.practiceSummary.practice_struggle,
              skills_passed: event.practiceSummary.skills
                .filter((k) => k.completed)
                .map((k) => k.skill),
            },
          };
        }
        // Exactly one level per session (ENG-10): a forced/dev lock wins over the event's decision.
        const d = s.calibration.current ?? s.calibration.lock(event.calibration);
        s.logger.log('calibration_result', {
          policy: d.policy,
          level: d.level,
          reason: d.reason,
          warmup_rt_ms: event.warmupRtMs ?? null,
          warmup_accuracy: event.warmupAccuracy ?? null,
        });
        s.context = { ...s.context, calibration_level: d.level, calibration_policy: d.policy };
        s.logger.log('session.context', { context: s.context });
        break;
      }
      case 'SURVEY_DONE': {
        s.logger.log('survey.enjoy', { face: event.enjoy ?? 'skipped' });
        s.logger.log('survey.play_again', { answer: event.playAgain ?? 'skipped' });
        break;
      }
      case 'OPTIN_DONE': {
        s.logger.log('optin.contact', { granted: event.contactOptIn });
        break;
      }
      case 'IDLE_TIMEOUT':
      case 'CRASH':
      case 'EXIT': {
        const kind =
          event.type === 'IDLE_TIMEOUT'
            ? 'walkaway'
            : event.type === 'CRASH'
              ? 'crash'
              : event.erase
                ? 'withdrawn'
                : 'explicit_exit';
        s.abort.abort({ kind });
        if (event.type === 'EXIT' && event.erase && s.consent.granted) {
          s.logger.log('erasure_requested', { scope: 'session', channel: 'kiosk_hand_icon' });
        }
        break;
      }
      default:
        break;
    }
  }

  private onSnapshot(snap: SessionMachineSnapshot): void {
    const name = stateNameOf(snap);
    const prev = this.prevState;
    if (name !== prev) {
      this.prevState = name;
      const s = this.session;
      if (s && name !== 'attract') {
        s.lastState = prev === 'wipe' ? s.lastState : prev;
        if (name !== 'wipe' || s.consent.granted) {
          s.logger.log('session.state_changed', {
            from_state: prev,
            to_state: name,
            trigger: this.pendingTrigger ?? 'timer',
          });
        }
      }
      this.enterState(name, snap);
    }
    this.publish(snap);
  }

  private enterState(name: SessionState, snap: SessionMachineSnapshot): void {
    const s = this.session;
    switch (name) {
      case 'practiceWarmup':
        if (s && this.opts.runner) void this.runWarmup(s);
        break;
      case 'play':
        if (s && this.opts.runner) void this.runPlay(s);
        break;
      case 'report':
        if (s) this.prepareReport(s);
        break;
      case 'wipe':
        if (s && !s.finalizing) {
          s.finalizing = true;
          this.wipeDone = this.finalize(s, snap).catch((err: unknown) => this.opts.onError?.(err));
        }
        break;
      case 'attract':
        this.walkaway.stop();
        break;
      default:
        break;
    }
  }

  private moduleSessionInfo(s: ActiveSession): ModuleSessionInfo {
    return {
      sessionId: s.sessionId,
      pathway: s.pathway,
      mode: this.opts.device.mode,
      siteMode: this.opts.device.siteMode,
      formId: s.formId,
      slotForm: s.slot,
      headset: s.context.headset,
      slowPace: s.a11ySlowPace,
    };
  }

  private async runModule(
    s: ActiveSession,
    moduleId: ModuleId,
    level: CalibrationLevel,
  ): Promise<ModuleResult | null> {
    const runner = this.opts.runner;
    if (!runner) return null;
    const ac = new AbortController();
    const onSession = (): void => ac.abort(s.abort.signal.reason);
    if (s.abort.signal.aborted) ac.abort(s.abort.signal.reason);
    else s.abort.signal.addEventListener('abort', onSession, { once: true });
    this.moduleAbort = ac;
    s.currentModule = moduleId;
    this.publish();
    try {
      return await runner.run({
        moduleId,
        level,
        language: s.language ?? this.opts.device.languages[0],
        logger: s.logger,
        rng: s.rng,
        clock: s.clock,
        session: this.moduleSessionInfo(s),
        signal: ac.signal,
      });
    } finally {
      s.abort.signal.removeEventListener('abort', onSession);
      if (this.moduleAbort === ac) this.moduleAbort = null;
      if (s.currentModule === moduleId) s.currentModule = null;
      this.publish();
    }
  }

  private async runWarmup(s: ActiveSession): Promise<void> {
    const warmupId = this.opts.content.plan.pathways[s.pathway].warmup;
    if (!isModuleId(warmupId)) return;
    const result = await this.runModule(s, warmupId, 'L2');
    if (this.session !== s || stateNameOf(this.actor.getSnapshot()) !== 'practiceWarmup') return;
    if (
      result &&
      result.endedReason !== 'completed' &&
      result.endedReason !== 'time_cap' &&
      result.endedReason !== 'explicit_exit'
    )
      return;
    const metrics = warmupMetricsFromEvents(s.warmupEvents, this.opts.content.get(warmupId));
    const decision = decideCalibration({
      policy: s.context.calibration_policy,
      practiceStruggle: metrics.summary.practice_struggle,
      slowPace: s.a11ySlowPace,
      warmupRtMs: metrics.warmupRtMs,
      warmupAccuracy: metrics.warmupAccuracy,
      forcedLevel: this.opts.forcedLevel ?? null,
    });
    this.send({
      type: 'WARMUP_DONE',
      calibration: decision,
      practiceSummary: metrics.summary,
      warmupRtMs: metrics.warmupRtMs,
      warmupAccuracy: metrics.warmupAccuracy,
    });
  }

  private async runPlay(s: ActiveSession): Promise<void> {
    while (
      this.session === s &&
      stateNameOf(this.actor.getSnapshot()) === 'play' &&
      s.playIndex < s.plannedModules.length
    ) {
      const moduleId = s.plannedModules[s.playIndex] as ModuleId;
      const level = s.calibration.current?.level ?? 'L2';
      this.jumpPending = false;
      const result = await this.runModule(s, moduleId, level);
      if (this.session !== s || s.abort.signal.aborted) return;
      if (this.jumpPending) continue; // devtools jumped: playIndex already points at the target
      if (result) this.send({ type: 'MODULE_DONE', result });
      s.playIndex += 1;
    }
    if (this.session === s && stateNameOf(this.actor.getSnapshot()) === 'play')
      this.send({ type: 'PLAY_DONE' });
  }

  private prepareReport(s: ActiveSession): void {
    const provider = this.opts.reportProvider ?? DEFAULT_REPORT;
    let model: ReportModel;
    try {
      model = provider(this.view);
    } catch (err) {
      this.opts.onError?.(err);
      model = DEFAULT_REPORT(this.view);
    }
    s.report = model;
    if (model.mode === 'player_report' && model.traits.length > 0) {
      s.logger.log('report.delivered', {
        report_mode: 'player_report',
        release_pack_version: model.releasePackVersion,
        delivery_modes: (model.deliveryModes.length > 0 ? model.deliveryModes : ['screen']) as [
          'spoken' | 'printed' | 'qr' | 'screen',
          ...('spoken' | 'printed' | 'qr' | 'screen')[],
        ],
        traits_shown_count: model.traits.length,
      });
    } else {
      s.logger.log('report.withheld', {
        report_mode: model.mode === 'player_report' ? 'thank_you' : model.mode,
        release_pack_version: model.mode === 'player_report' ? model.releasePackVersion : null,
        reason:
          model.mode === 'thank_you'
            ? model.reason
            : model.mode === 'demo'
              ? 'demo_mode'
              : 'no_trait_released',
      });
    }
  }

  private async finalize(s: ActiveSession, snap: SessionMachineSnapshot): Promise<void> {
    const ctx = snap.context;
    const o = this.opts;
    const endReason: SessionEndReason = ctx.endReason ?? 'abandoned';
    s.abort.abort({ kind: endReason === 'withdrawn' ? 'withdrawn' : 'walkaway' });
    this.walkaway.stop();
    try {
      if (!s.consent.granted || endReason === 'under_age') {
        // Fail closed: nothing before consent is ever uploaded or kept, and an under-18 band keeps
        // nothing at all (ONB-04). Uploads are paused for the whole session, so nothing has left
        // the kiosk yet and no tombstone is needed.
        await s.logger.flush();
        await o.outbox.purgeSession(s.sessionId);
        if (endReason === 'consent_declined') await o.outbox.recordDecline();
      } else if (ctx.erase) {
        await s.logger.flush();
        const coversUpto = s.logger.nextSeq - 1;
        await o.outbox.purgeSession(s.sessionId, (seq) =>
          s.logger.buildDetached(
            'session_tombstone',
            { reason: 'withdrawal', covers_seq_upto: coversUpto },
            seq,
          ),
        );
      } else {
        const elapsed = Math.round(s.clock.now());
        const abandoned = endReason !== 'completed' && endReason !== 'time_cap';
        if (abandoned && ctx.abandonReason) {
          s.logger.log('session.abandoned', {
            last_state: s.lastState,
            module_id: s.lastModuleId,
            trial_id: s.lastTrialId,
            elapsed_ms: elapsed,
            reason: ctx.abandonReason,
          });
        }
        s.context = {
          ...s.context,
          completion: endReason === 'completed' ? 'complete' : abandoned ? 'abandoned' : 'partial',
          walkaway_point: abandoned
            ? { state: s.lastState, module_id: s.lastModuleId, trial_id: s.lastTrialId }
            : null,
        };
        s.logger.log('session.context', { context: s.context });
        s.logger.log('session_end', { reason: endReason, duration_ms: elapsed });
        await s.logger.flush();
        await o.outbox.closeSession(s.sessionId);
      }
    } finally {
      if (this.session === s) {
        this.session = null;
        o.input?.setLogger(null);
      }
      o.uploader?.resume();
      if (stateNameOf(this.actor.getSnapshot()) === 'wipe') this.actor.send({ type: 'WIPE_DONE' });
      this.publish();
    }
  }

  private buildView(snap: SessionMachineSnapshot): KioskSessionView {
    const s = this.session;
    const ctx = snap.context;
    return {
      sessionId: s?.sessionId ?? '',
      state: stateNameOf(snap),
      mode: this.opts.device.mode,
      siteMode: this.opts.device.siteMode,
      pathway: s?.pathway ?? null,
      arm: s?.arm ?? null,
      slotForm: s?.slot ?? null,
      formId: s?.formId ?? '',
      language: s?.language ?? ctx.language,
      consentGranted: ctx.consentGranted,
      archiveOptIn: ctx.archiveOptIn,
      calibration: s?.calibration.current ?? ctx.calibration,
      plannedModules: s ? [...s.plannedModules] : [],
      completedModules: ctx.completedModules,
      startedAtMs: 0,
      context: s?.context ?? null,
      walkawayStage: this.walkaway.stage,
      currentModule: s?.currentModule ?? null,
      languageFaceOrder: s?.faceOrder ?? [...this.opts.device.languages],
      report: s?.report ?? null,
      seedHex: s?.seedHex ?? null,
    };
  }

  private publish(snap: SessionMachineSnapshot = this.actor.getSnapshot()): void {
    this.view = this.buildView(snap);
    for (const l of this.listeners) l(this.view);
  }
}
