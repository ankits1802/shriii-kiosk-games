/**
 * Synthetic multi-module session runner for the set-2 dev harness, bot playthroughs and tests: one
 * session (synthetic, never uploaded) that runs a list of modules back to back through the real
 * `ModuleHost` (optionally behind the {@link CarouselHubRunner}), with the same logger, outbox and
 * strict validation as `runModuleHarness`. It is the set-2 equivalent of the engine harness for more
 * than one module (e.g. Share-the-Pot followed by a slot module, with hub bridges in between).
 */
import type {
  CalibrationLevel,
  EventEnvelope,
  EventSessionContext,
  EventVersions,
  LanguageTag,
  SessionMode,
  SiteMode,
  SlotForm,
} from '@shriii/contracts';
import type {
  Clock,
  DevFlags,
  ModuleFactoryLookup,
  ModuleId,
  ModuleRegistry,
  ModuleResult,
} from '../../core/contracts.ts';
import { isSlotForm } from '../../engine/assignment.ts';
import { SessionClock } from '../../engine/clock.ts';
import type { GameContent } from '../../engine/content.ts';
import { ModuleHost, type ModuleRunner, type PlayServices } from '../../engine/module-host.ts';
import { createSessionRng } from '../../engine/rng.ts';
import {
  createSessionLogger,
  type EventValidator,
  type SessionEventLogger,
} from '../../logging/event-logger.ts';
import { MemoryOutbox } from '../../logging/outbox/memory-outbox.ts';
import { uuidv7 } from '../../logging/uuid.ts';
import { CarouselHubRunner } from './CarouselHubRunner.ts';

export interface Set2SessionOptions {
  readonly content: GameContent;
  readonly registry: ModuleRegistry | ModuleFactoryLookup;
  readonly services: PlayServices;
  readonly modules: readonly ModuleId[];
  readonly seedHex: string;
  readonly level?: CalibrationLevel;
  readonly language?: LanguageTag;
  readonly formId?: string;
  readonly slot?: SlotForm | null;
  readonly mode?: SessionMode;
  readonly siteMode?: SiteMode;
  readonly headset?: boolean;
  readonly dev?: Partial<DevFlags>;
  readonly clock?: Clock;
  readonly outbox?: MemoryOutbox;
  readonly validate?: EventValidator;
  /** Wrap the module host in the carousel hub (fair-map bridges). */
  readonly hub?: boolean;
  /** Decorate the runner (e.g. to observe bridges). */
  readonly onBridge?: ConstructorParameters<typeof CarouselHubRunner>[0]['onBridge'];
}

export interface Set2SessionRun {
  readonly sessionId: string;
  readonly logger: SessionEventLogger;
  readonly clock: Clock;
  readonly results: Promise<ModuleResult[]>;
  events(): Promise<EventEnvelope[]>;
  abort(): void;
}

const VERSIONS: Omit<EventVersions, 'bundle_hash' | 'timing_profile_version'> = {
  app_version: '0.1.0',
  audio_manifest_hash: null,
  variant_pack_id: null,
  scoring_dict_version: '0.1.0',
  indicator_set_version: '0.1.0',
  protocol_version: null,
  policy_version: '1.0.0',
  release_pack_version: null,
  device_profile_id: 'dev-harness',
  hardware_sku: 'dev-harness',
};

export function runSet2Session(options: Set2SessionOptions): Set2SessionRun {
  const clock = options.clock ?? new SessionClock();
  const outbox = options.outbox ?? new MemoryOutbox({ kioskId: 'kiosk-dev-set2' });
  const sessionId = uuidv7();
  const slot: SlotForm | null =
    options.slot !== undefined
      ? options.slot
      : ((options.modules.find((m) => isSlotForm(m)) as SlotForm | undefined) ?? null);
  const language = options.language ?? 'en-IN';
  const context: EventSessionContext = {
    participant_pid: null,
    kiosk_id: 'kiosk-dev-set2',
    site_id: 'site-dev',
    site_mode: options.siteMode ?? 'supervised',
    mode: options.mode ?? 'pilot',
    battery_arm: 'B_fixed',
    slot_form: slot,
    language,
    player_slot: 1,
    synthetic: true,
  };
  const logger = createSessionLogger({
    sessionId,
    outbox,
    clock,
    context: () => context,
    versions: {
      ...VERSIONS,
      bundle_hash: options.content.bundleHash,
      timing_profile_version: clock.profile.version,
    },
    consentGranted: () => true,
    ...(options.validate ? { validate: options.validate } : {}),
  });
  (options.services.input as { setLogger?: (l: SessionEventLogger) => void }).setLogger?.(logger);
  logger.log('session_start', {
    seed: options.seedHex,
    rng_algorithm: 'pcg32',
    refresh_hz: clock.profile.refreshHz,
    arm_source: 'forced',
    stratum: null,
    slot_form: slot,
  });
  const dev: DevFlags = {
    overlay: options.dev?.overlay ?? false,
    voicePlaceholder: options.dev?.voicePlaceholder ?? false,
    headless: options.dev?.headless ?? false,
  };
  const host = new ModuleHost({
    content: options.content,
    registry: options.registry,
    services: options.services,
    dev,
  });
  const runner: ModuleRunner = options.hub
    ? new CarouselHubRunner({
        inner: host,
        services: options.services,
        plan: options.content.plan,
        ...(options.onBridge ? { onBridge: options.onBridge } : {}),
      })
    : host;
  const ac = new AbortController();
  const rng = createSessionRng(options.seedHex);
  const results = (async () => {
    const out: ModuleResult[] = [];
    for (const moduleId of options.modules) {
      if (ac.signal.aborted) break;
      const config = options.content.get(moduleId);
      const formId =
        options.formId && config.forms.includes(options.formId)
          ? options.formId
          : (config.forms[0] ?? 'form_1');
      const r = await runner.run({
        moduleId,
        level: options.level ?? 'L2',
        language,
        logger,
        rng,
        clock,
        session: {
          sessionId,
          pathway: 'B',
          mode: context.mode,
          siteMode: context.site_mode,
          formId,
          slotForm: slot,
          headset: options.headset ?? false,
          slowPace: false,
        },
        signal: ac.signal,
      });
      out.push(r);
    }
    logger.log('session_end', {
      reason: out.every((r) => r.endedReason === 'completed') ? 'completed' : 'abandoned',
      duration_ms: Math.round(clock.now()),
    });
    return out;
  })();
  return {
    sessionId,
    logger,
    clock,
    results,
    async events() {
      await logger.flush();
      return (await outbox.sessionEvents(sessionId)) as EventEnvelope[];
    },
    abort() {
      ac.abort({ kind: 'explicit_exit' });
    },
  };
}
