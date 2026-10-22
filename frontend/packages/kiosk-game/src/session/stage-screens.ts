/**
 * Stage screens: runs the Pixi onboarding, report and survey screens (ONB-01..07, KSK-03, REP-01)
 * for the session states that have one, instead of the icon-only React fallbacks.
 *
 * The bridge subscribes to the {@link SessionController}; when the statechart enters `attract`,
 * `languageSelect`, `consent`, `bands`, `report`, `survey` or `contactOptIn` it runs the matching
 * screen on its own stage layer and sends the screen's statechart event (with the extras the
 * controller logs) back to the controller. Leaving the state (walkaway, exit, wipe) aborts the
 * screen; the layer is cleared between states.
 *
 * Logging: the controller is the single writer of the onboarding events (language, consent, bands,
 * survey, opt-in), so the screens get a logger that drops those types and keeps only what the
 * controller cannot know (instruction replays). The language faces are shown in exactly the order
 * the controller logs (`view.languageFaceOrder`).
 */
import type { LanguageTag, SessionState } from '@shriii/contracts';
import { type Application, Container } from 'pixi.js';
import { AttractLoop } from '../attract/AttractLoop.ts';
import type {
  ArtKit,
  AudioService,
  Clock,
  EventLogger,
  InputService,
  Layout,
  LoggedEvent,
  LogScope,
  SeededRng,
  VoiceService,
} from '../core/contracts.ts';
import type { GameContent } from '../engine/content.ts';
import { createSessionRng } from '../engine/rng.ts';
import { ScreenAbortedError, ScreenKit } from '../onboarding/ScreenKit.ts';
import { runBands } from '../onboarding/screens/bands.ts';
import { runConsent } from '../onboarding/screens/consent.ts';
import { runLanguageSelect } from '../onboarding/screens/languageSelect.ts';
import { runContactOptIn, runSurvey } from '../onboarding/screens/survey.ts';
import type { OnboardingArt, OnboardingConfig, OnboardingServices } from '../onboarding/types.ts';
import { runReport } from '../report/ReportScreen.ts';
import type { KioskDeviceConfig } from './device.ts';
import { onboardingConfigFor } from './onboarding-config.ts';
import type {
  KioskSessionView,
  SessionController,
  SessionControllerEvent,
} from './session-controller.ts';

/** Session states the stage screens own (the React fallbacks render nothing for these). */
export const STAGE_SCREEN_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'attract',
  'languageSelect',
  'consent',
  'bands',
  'report',
  'survey',
  'contactOptIn',
]);

/** Event types the controller logs itself (dropped from the screens' logger). */
const CONTROLLER_LOGGED: ReadonlySet<string> = new Set([
  'language_selected',
  'language_switched',
  'consent.granted',
  'consent.declined',
  'optin.archive',
  'bands.answered',
  'practice.summary',
  'survey.enjoy',
  'survey.play_again',
  'optin.contact',
]);

/** True when the art kit has everything the onboarding screens draw with (the Mela art kit). */
export function isOnboardingArt(art: ArtKit): art is ArtKit & OnboardingArt {
  const a = art as unknown as Partial<OnboardingArt>;
  return (
    typeof a.createPictureTile === 'function' &&
    typeof a.createHandHint === 'function' &&
    typeof a.createIconButton === 'function' &&
    typeof a.unit === 'number'
  );
}

const DROPPED: LoggedEvent = { eventId: '', seq: -1, tMonoMs: 0, valid: true };

/** A logger that forwards everything except the controller-owned onboarding events. */
function screenLogger(inner: EventLogger): EventLogger {
  return {
    get sessionId() {
      return inner.sessionId;
    },
    get scope(): LogScope {
      return inner.scope;
    },
    log(type, payload, options) {
      if (CONTROLLER_LOGGED.has(type as string)) return DROPPED;
      return inner.log(type, payload, options);
    },
    child(scope) {
      return screenLogger(inner.child(scope));
    },
    flush: () => inner.flush(),
  };
}

/** Logger for attract (no session exists yet): logs nothing. */
const ATTRACT_LOGGER: EventLogger = {
  sessionId: '',
  scope: { task: null, condition: null, scorable: false } as unknown as LogScope,
  log: () => DROPPED,
  child: () => ATTRACT_LOGGER,
  flush: () => Promise.resolve(),
};

/** RNG whose `shuffle` keeps the given order (faces are pre-ordered by the controller). */
function orderKeepingRng(base: SeededRng): SeededRng {
  const rng = Object.create(base) as SeededRng & { shuffle: SeededRng['shuffle'] };
  Object.defineProperty(rng, 'shuffle', { value: <T>(items: readonly T[]): T[] => [...items] });
  return rng;
}

export interface StageScreensOptions {
  readonly controller: SessionController;
  readonly content: GameContent;
  readonly device: KioskDeviceConfig;
  readonly app: Application;
  readonly layer: Container;
  readonly layout: Layout;
  readonly art: ArtKit & OnboardingArt;
  readonly audio: AudioService;
  readonly voice: VoiceService;
  readonly input: InputService;
  /** Runtime clock (attract runs before a session clock exists). */
  readonly runtimeClock: Clock;
  /** Unlock audio on the first touch (browser autoplay policy). */
  readonly unlockAudio?: () => void;
  /** UX overrides for the onboarding config (pacing, timeouts). */
  readonly overrides?: Partial<Omit<OnboardingConfig, 'practice'>>;
}

/** Runs the stage screens for the controller's states until disposed. */
export class StageScreens {
  private readonly opts: StageScreensOptions;
  private readonly unsubscribe: () => void;
  private running: { key: string; abort: AbortController; done: Promise<void> } | null = null;
  private kit: { sessionId: string; kit: ScreenKit; stage: Container } | null = null;
  private disposed = false;
  private attractLoop: { loop: AttractLoop; stage: Container } | null = null;

  constructor(options: StageScreensOptions) {
    this.opts = options;
    this.unsubscribe = options.controller.subscribe((view) => this.onView(view));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.running?.abort.abort();
    this.running = null;
    this.dropAttract();
    this.dropKit();
  }

  private dropAttract(): void {
    const a = this.attractLoop;
    this.attractLoop = null;
    if (!a) return;
    try {
      a.loop.destroy();
    } catch {
      // already gone
    }
    this.opts.layer.removeChild(a.stage);
    a.stage.destroy({ children: true });
  }

  private onView(view: KioskSessionView): void {
    if (this.disposed) return;
    const state = view.state as SessionState;
    const key = `${view.sessionId}|${state}`;
    if (this.running?.key === key) return;
    this.running?.abort.abort();
    this.running = null;
    if (!STAGE_SCREEN_STATES.has(state)) {
      // Play, warm-up, farewell and wipe own the stage: clear onboarding art.
      this.dropKit();
      return;
    }
    const abort = new AbortController();
    const entry = { key, abort, done: Promise.resolve() };
    this.running = entry;
    entry.done = this.runState(state, view, abort.signal)
      .catch((err: unknown) => {
        if (abort.signal.aborted || err instanceof ScreenAbortedError) return;
        this.opts.controller.reportError(err);
      })
      .finally(() => {
        if (this.running === entry) this.running = null;
      });
  }

  private config(view: KioskSessionView): OnboardingConfig {
    const base = onboardingConfigFor(this.opts.device, this.opts.content, {
      ...(view.pathway ? { pathway: view.pathway } : {}),
      ...(this.opts.overrides ? { overrides: this.opts.overrides } : {}),
    });
    const faces = view.languageFaceOrder.length > 0 ? view.languageFaceOrder : base.languages;
    return { ...base, languages: faces };
  }

  private services(
    stage: Container,
    logger: EventLogger,
    rng: SeededRng,
    signal: AbortSignal,
  ): OnboardingServices {
    const o = this.opts;
    const clock = o.controller.clock;
    if (!clock) throw new Error('stage screens: no session clock');
    return {
      app: o.app,
      stage,
      layout: o.layout,
      art: o.art,
      audio: o.audio,
      voice: o.voice,
      input: o.input,
      logger,
      clock,
      rng,
      signal,
    };
  }

  /** One ScreenKit per session (the fair and the guide carry across onboarding steps). */
  private sessionKit(view: KioskSessionView, signal: AbortSignal): ScreenKit {
    const logger = this.opts.controller.logger;
    if (!logger) throw new Error('stage screens: no session logger');
    if (this.kit && this.kit.sessionId === view.sessionId) {
      // Re-point the abort signal at the current state's screen.
      (this.kit.kit.services as { signal?: AbortSignal }).signal = signal;
      return this.kit.kit;
    }
    this.dropKit();
    const stage = new Container();
    stage.label = 'stage-screens';
    this.opts.layer.addChild(stage);
    const rng = orderKeepingRng(createSessionRng(view.seedHex ?? '0000000000000000').stream('ui'));
    const services = { ...this.services(stage, screenLogger(logger), rng, signal) };
    const kit = new ScreenKit(services, this.config(view));
    this.kit = { sessionId: view.sessionId, kit, stage };
    return kit;
  }

  private dropKit(): void {
    const k = this.kit;
    this.kit = null;
    if (!k) return;
    try {
      k.kit.destroy();
    } catch {
      // already gone
    }
    this.opts.layer.removeChild(k.stage);
    k.stage.destroy({ children: true });
  }

  private send(event: SessionControllerEvent, signal: AbortSignal): void {
    if (signal.aborted || this.disposed) return;
    this.opts.controller.send(event);
  }

  private async runState(
    state: SessionState,
    view: KioskSessionView,
    signal: AbortSignal,
  ): Promise<void> {
    switch (state) {
      case 'attract':
        return this.attract(view, signal);
      case 'languageSelect': {
        const kit = this.sessionKit(view, signal);
        const r = await runLanguageSelect(kit, view.language);
        this.send({ ...r.event, taps: r.taps }, signal);
        return;
      }
      case 'consent': {
        const kit = this.sessionKit(view, signal);
        for (;;) {
          const r = await runConsent(kit);
          if ('type' in r) {
            await this.switchLanguage(kit, signal);
            continue;
          }
          this.send({ ...r.event, replayCounts: r.replayCounts }, signal);
          return;
        }
      }
      case 'bands': {
        const kit = this.sessionKit(view, signal);
        for (;;) {
          const r = await runBands(kit);
          if ('type' in r) {
            await this.switchLanguage(kit, signal);
            continue;
          }
          if (r.event.type === 'BANDS_ANSWERED' && 'payload' in r) {
            this.send(
              {
                ...r.event,
                latencies: r.payload.answer_latency_ms,
                changeCount: r.payload.change_count,
              },
              signal,
            );
          } else {
            this.send(r.event, signal);
          }
          return;
        }
      }
      case 'report': {
        const kit = this.sessionKit(view, signal);
        if (view.report) {
          const r = await runReport(kit, view.report);
          this.send(r.event, signal);
        } else {
          this.send({ type: 'REPORT_DONE' }, signal);
        }
        return;
      }
      case 'survey': {
        const kit = this.sessionKit(view, signal);
        const r = await runSurvey(kit);
        this.send({ ...r.event, enjoy: r.enjoy, playAgain: r.playAgain }, signal);
        return;
      }
      case 'contactOptIn': {
        const kit = this.sessionKit(view, signal);
        const r = await runContactOptIn(kit);
        this.send(r.event, signal);
        return;
      }
      default:
        return;
    }
  }

  /** Globe tapped: choose again and tell the controller (it logs `language_switched`). */
  private async switchLanguage(kit: ScreenKit, signal: AbortSignal): Promise<void> {
    const current: LanguageTag | null = this.opts.controller.snapshot.language;
    const r = await runLanguageSelect(kit, current);
    this.send({ ...r.event, taps: r.taps }, signal);
    await this.opts.voice.setLanguage(r.event.language);
  }

  private async attract(view: KioskSessionView, signal: AbortSignal): Promise<void> {
    this.dropKit();
    const stage = new Container();
    stage.label = 'attract';
    this.opts.layer.addChild(stage);
    const o = this.opts;
    const clockless = o.controller.clock;
    const services: OnboardingServices = {
      app: o.app,
      stage,
      layout: o.layout,
      art: o.art,
      audio: o.audio,
      voice: o.voice,
      input: o.input,
      logger: ATTRACT_LOGGER,
      clock: clockless ?? o.runtimeClock,
      rng: createSessionRng(view.seedHex ?? 'a77ac7a77ac70000').stream('attract'),
      signal,
    };
    const config = onboardingConfigFor(o.device, o.content, {
      ...(o.overrides ? { overrides: o.overrides } : {}),
    });
    const loop = new AttractLoop(services, config);
    this.attractLoop = { loop, stage };
    try {
      const r = await loop.run();
      o.unlockAudio?.();
      this.send(r.event, signal);
    } finally {
      if (this.attractLoop?.loop === loop) this.dropAttract();
    }
  }
}
