/**
 * Run the Road Home episode headlessly through the real {@link ModuleHost} (same context, logger
 * gate, caps and wrap-up as a session) with the scripted bot, in virtual time, and return the
 * strictly validated event stream plus the plan's trial params (the scorer's join table).
 */
import type { EventEnvelope, EventSessionContext } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import type { Application, Container } from 'pixi.js';
import type {
  ArtKit,
  CalibrationLevel,
  InputService,
  Layout,
  ModuleResult,
} from '../../../core/contracts.ts';
import { loadGameContent } from '../../../engine/content.ts';
import { SilentAudioService, SilentVoiceService } from '../../../engine/fallbacks/silent-audio.ts';
import { ModuleHost } from '../../../engine/module-host.ts';
import { createSessionRng } from '../../../engine/rng.ts';
import { physicalMetrics } from '../../../input/metrics.ts';
import { TEST_VERSIONS } from '../../../logging/__tests__/helpers.ts';
import { ajvEventValidator, createSessionLogger } from '../../../logging/event-logger.ts';
import { MemoryOutbox } from '../../../logging/outbox/memory-outbox.ts';
import type { RoadBotPolicy } from '../bot.ts';
import type { BeatDurations } from '../null-presenter.ts';
import type { RoadHomePlan } from '../plan.ts';
import { RoadHomeEpisode } from '../RoadHomeEpisode.ts';
import { VirtualTime } from './virtual-time.ts';

export const A_CONTEXT: EventSessionContext = {
  participant_pid: null,
  kiosk_id: 'kiosk-test',
  site_id: 'site-test',
  site_mode: 'supervised',
  mode: 'pilot',
  battery_arm: 'A_narrative',
  slot_form: null,
  language: 'en-IN',
  player_slot: 1,
  synthetic: true,
};

/** Nominal durations of the Pixi view's beats (keep in sync with `view/beats.ts`). */
export interface HeadlessRun {
  readonly result: ModuleResult;
  readonly events: EventEnvelope[];
  readonly plan: RoadHomePlan;
  readonly sessionId: string;
  readonly virtualMs: number;
}

export async function runHeadless(
  options: {
    readonly seedHex?: string;
    readonly level?: CalibrationLevel;
    readonly formId?: string;
    readonly bot?: RoadBotPolicy;
    readonly beats?: BeatDurations;
    readonly abortAtMs?: number;
    /** Use a certified timing profile (default true; scoring treats uncertified sessions as excluded). */
    readonly certified?: boolean;
  } = {},
): Promise<HeadlessRun> {
  const content = loadGameContent();
  const vt = new VirtualTime(options.certified ?? true);
  const clock = vt.clock;
  const outbox = new MemoryOutbox({ kioskId: 'kiosk-test' });
  const sessionId = '01a15df9-9480-78bd-98a1-a021f6e0e2f9';
  const seedHex = options.seedHex ?? '000000000000007b';
  const logger = createSessionLogger({
    sessionId,
    outbox,
    clock,
    context: () => A_CONTEXT,
    versions: { ...TEST_VERSIONS, timing_profile_version: clock.profile.version },
    consentGranted: () => true,
    validate: ajvEventValidator(validateEventEnvelope),
  });
  logger.log('session_start', {
    seed: seedHex,
    rng_algorithm: 'pcg32',
    refresh_hz: 60,
    arm_source: 'forced',
    stratum: null,
    slot_form: null,
  });
  const layout: Layout = {
    width: 1920,
    height: 1080,
    safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
    orientation: 'landscape',
    metrics: physicalMetrics(),
    onChange: () => () => undefined,
  };
  let episode: RoadHomeEpisode | null = null;
  const host = new ModuleHost({
    content,
    registry: {
      road_home: () => {
        episode = new RoadHomeEpisode({
          view: 'headless',
          ...(options.bot ? { bot: options.bot } : {}),
          ...(options.beats ? { headlessBeats: options.beats } : {}),
        });
        return episode;
      },
    },
    dev: { overlay: false, voicePlaceholder: false, headless: true },
    abortGraceMs: 500,
    services: {
      app: {} as Application,
      layout,
      audio: new SilentAudioService(clock),
      voice: new SilentVoiceService(clock, { lineMs: 600 }),
      input: { setLogger: () => undefined } as unknown as InputService,
      art: {} as ArtKit,
      createStage: () => ({}) as Container,
      releaseStage: () => undefined,
    },
  });
  const ac = new AbortController();
  if (options.abortAtMs !== undefined) {
    void clock.delay(options.abortAtMs).then(() => ac.abort({ kind: 'walkaway' }));
  }
  const result = await vt.run(
    host.run({
      moduleId: 'road_home',
      level: options.level ?? 'L2',
      language: 'en-IN',
      logger,
      rng: createSessionRng(seedHex),
      clock,
      session: {
        sessionId,
        pathway: 'A',
        mode: 'pilot',
        siteMode: 'supervised',
        formId: options.formId ?? 'form_1',
        slotForm: null,
        headset: false,
        slowPace: false,
      },
      signal: ac.signal,
    }),
  );
  logger.log('session_end', {
    reason: result.endedReason === 'completed' ? 'completed' : 'abandoned',
    duration_ms: Math.round(clock.now()),
  });
  await vt.run(logger.flush());
  const events = (await outbox.sessionEvents(sessionId)) as EventEnvelope[];
  const ep = episode as RoadHomeEpisode | null;
  const plan = ep?.currentPlan;
  if (!plan) throw new Error('episode did not build a plan');
  return { result, events, plan, sessionId, virtualMs: vt.now };
}
