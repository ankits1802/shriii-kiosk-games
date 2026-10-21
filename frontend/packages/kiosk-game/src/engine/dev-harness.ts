/**
 * Module dev harness (ENG-05 AC "any module runs headlessly with a scripted bot", PLT-01): launch one
 * module standalone, outside a session, for screenshots, bots and module development:
 *
 *   frontend/apps/kiosk  ?module=dont_tap&level=L2&lang=en-IN&seed=123[&form=form_1][&bot=1][&pathway=B]
 *
 * This file is the DOM-free part: URL parsing, the deterministic seed mapping, and
 * {@link runModuleHarness}, which runs the module through the real {@link ModuleHost} (same context,
 * logger gate, caps and wrap-up as in a session) against an in-memory outbox. The browser launcher
 * that builds the Pixi stage lives in `session/module-harness.ts`.
 *
 * Harness sessions are always `synthetic: true`, never uploaded, and the module id must be one the
 * content bundle configures. The registered factory is used when present; otherwise the generic
 * placeholder module runs (same rule as the session's play state).
 */
import type {
  CalibrationLevel,
  EventEnvelope,
  EventSessionContext,
  EventVersions,
  LanguageTag,
  Pathway,
  SessionMode,
  SlotForm,
} from '@shriii/contracts';
import type {
  Clock,
  DevFlags,
  GameModule,
  ModuleFactoryLookup,
  ModuleId,
  ModuleRegistry,
  ModuleResult,
} from '../core/contracts.ts';
import {
  createSessionLogger,
  type EventValidator,
  type SessionEventLogger,
} from '../logging/event-logger.ts';
import { MemoryOutbox } from '../logging/outbox/memory-outbox.ts';
import { uuidv7 } from '../logging/uuid.ts';
import { isSlotForm } from './assignment.ts';
import { SessionClock } from './clock.ts';
import { type GameContent, isModuleId } from './content.ts';
import { ModuleHost, type PlayServices } from './module-host.ts';
import type { ModuleSource } from './registry.ts';
import { createSessionRng } from './rng.ts';

/** Languages the harness accepts (the development language set). */
export const HARNESS_LANGUAGES: readonly LanguageTag[] = ['hi-IN', 'mr-IN', 'ta-IN', 'en-IN'];
const LEVELS: readonly CalibrationLevel[] = ['L1', 'L2', 'L3'];

/** Parsed harness URL parameters. */
export interface ModuleHarnessParams {
  readonly moduleId: ModuleId;
  readonly level: CalibrationLevel;
  readonly language: LanguageTag;
  /** 16 lowercase hex chars (from `seed`, decimal or hex). */
  readonly seedHex: string;
  /** `form` parameter, or null for the module's first configured form. */
  readonly formId: string | null;
  /** `pathway` parameter, or inferred: episodes -> A, everything else -> B. */
  readonly pathway: Pathway;
  /** `bot=1`: headless scripted run (DevFlags.headless). */
  readonly bot: boolean;
  readonly mode: SessionMode;
}

/** A harness URL that names a module but is otherwise invalid. The message names the parameter. */
export class HarnessParamError extends Error {
  readonly param: string;
  constructor(param: string, message: string) {
    super(`module harness: ${param}: ${message}`);
    this.name = 'HarnessParamError';
    this.param = param;
  }
}

const UINT64_MAX = (1n << 64n) - 1n;

/**
 * Map a `seed` parameter to a 16-hex session seed. Decimal (`123`) and `0x`-prefixed or 16-char hex
 * are accepted; the mapping is the plain 64-bit value, so `seed=123` is always `000000000000007b`.
 * @throws HarnessParamError when the value is not a 64-bit unsigned integer.
 */
export function seedFromParam(value: string): string {
  const v = value.trim().toLowerCase();
  let n: bigint;
  if (/^[0-9a-f]{16}$/.test(v)) n = BigInt(`0x${v}`);
  else if (/^0x[0-9a-f]{1,16}$/.test(v)) n = BigInt(v);
  else if (/^[0-9]{1,20}$/.test(v)) n = BigInt(v);
  else throw new HarnessParamError('seed', `'${value}' is not a decimal or hex 64-bit seed`);
  if (n > UINT64_MAX) throw new HarnessParamError('seed', `'${value}' exceeds 64 bits`);
  return n.toString(16).padStart(16, '0');
}

/**
 * Parse harness parameters. Returns null when there is no `module` parameter (normal kiosk start).
 * @throws HarnessParamError for an unknown module/level/language/pathway or a bad seed.
 */
export function parseModuleHarnessParams(
  search: string | URLSearchParams,
  content?: GameContent,
): ModuleHarnessParams | null {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const raw = q.get('module');
  if (raw === null) return null;
  const moduleId = raw.trim().replaceAll('-', '_');
  if (!isModuleId(moduleId)) throw new HarnessParamError('module', `unknown module '${raw}'`);
  if (content && !content.has(moduleId)) {
    throw new HarnessParamError('module', `'${moduleId}' has no config in the content bundle`);
  }
  const level = (q.get('level') ?? 'L2').toUpperCase();
  if (!LEVELS.includes(level as CalibrationLevel)) {
    throw new HarnessParamError('level', `'${level}' is not L1, L2 or L3`);
  }
  const lang = q.get('lang') ?? q.get('language') ?? 'en-IN';
  if (!HARNESS_LANGUAGES.includes(lang)) {
    throw new HarnessParamError('lang', `'${lang}' is not one of ${HARNESS_LANGUAGES.join(', ')}`);
  }
  const seedParam = q.get('seed');
  const seedHex = seedFromParam(seedParam ?? '1');
  const kind = content?.has(moduleId) ? content.get(moduleId).kind : null;
  const inferred: Pathway =
    kind === 'episode' ||
    moduleId === 'stall' ||
    moduleId === 'weighing_post' ||
    moduleId === 'road_home'
      ? 'A'
      : 'B';
  const pathwayParam = q.get('pathway');
  if (pathwayParam !== null && pathwayParam !== 'A' && pathwayParam !== 'B') {
    throw new HarnessParamError('pathway', `'${pathwayParam}' is not A or B`);
  }
  const bot = q.get('bot');
  const form = q.get('form');
  return {
    moduleId,
    level: level as CalibrationLevel,
    language: lang,
    seedHex,
    formId: form !== null && form.trim() !== '' ? form.trim() : null,
    pathway: (pathwayParam as Pathway | null) ?? inferred,
    bot: bot === '1' || bot === 'true',
    mode: 'pilot',
  };
}

/** Build the query string for a harness launch (inverse of {@link parseModuleHarnessParams}). */
export function moduleHarnessQuery(
  params: Pick<ModuleHarnessParams, 'moduleId' | 'level' | 'language'> & {
    readonly seed?: string | number;
    readonly formId?: string | null;
    readonly bot?: boolean;
    readonly pathway?: Pathway;
  },
): string {
  const q = new URLSearchParams();
  q.set('module', params.moduleId);
  q.set('level', params.level);
  q.set('lang', params.language);
  if (params.seed !== undefined) q.set('seed', String(params.seed));
  if (params.formId) q.set('form', params.formId);
  if (params.pathway) q.set('pathway', params.pathway);
  if (params.bot) q.set('bot', '1');
  return `?${q.toString()}`;
}

/** Version tuple for harness sessions (synthetic; never uploaded). */
const HARNESS_VERSIONS: Omit<EventVersions, 'bundle_hash' | 'timing_profile_version'> = {
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

/** Dependencies of {@link runModuleHarness}. */
export interface ModuleHarnessDeps {
  readonly content: GameContent;
  readonly registry: ModuleRegistry | ModuleFactoryLookup;
  readonly services: PlayServices;
  readonly dev?: Partial<DevFlags>;
  /** Placeholder for unregistered ids (normally `genericModuleFallback(content)`). */
  readonly fallback?: (id: ModuleId) => GameModule | null;
  readonly clock?: Clock;
  readonly outbox?: MemoryOutbox;
  /** Strict event validation (dev builds). */
  readonly validate?: EventValidator;
  readonly abortGraceMs?: number;
}

/** A running harness module. */
export interface ModuleHarnessRun {
  readonly params: ModuleHarnessParams;
  readonly sessionId: string;
  readonly logger: SessionEventLogger;
  readonly clock: Clock;
  /** Resolves when the module ended (never rejects). */
  readonly result: Promise<ModuleResult>;
  /** Whether the registered module or the placeholder ran (known once resolved). */
  readonly source: () => ModuleSource | null;
  /** Every event logged so far, in seq order (flushes first). */
  events(): Promise<EventEnvelope[]>;
  /** Stop the module (ends with `explicit_exit`). */
  abort(): void;
}

/** Run one module standalone through the real module host. */
export function runModuleHarness(
  params: ModuleHarnessParams,
  deps: ModuleHarnessDeps,
): ModuleHarnessRun {
  const { content } = deps;
  if (!content.has(params.moduleId)) {
    throw new HarnessParamError('module', `'${params.moduleId}' has no config in the bundle`);
  }
  const clock = deps.clock ?? new SessionClock();
  const outbox = deps.outbox ?? new MemoryOutbox({ kioskId: 'kiosk-dev-harness' });
  const sessionId = uuidv7();
  const config = content.get(params.moduleId);
  const formId =
    params.formId !== null && config.forms.includes(params.formId)
      ? params.formId
      : (config.forms[0] ?? 'form_1');
  const slot: SlotForm | null =
    params.pathway === 'B' && isSlotForm(params.moduleId) ? params.moduleId : null;
  const context: EventSessionContext = {
    participant_pid: null,
    kiosk_id: 'kiosk-dev-harness',
    site_id: 'site-dev',
    site_mode: 'supervised',
    mode: params.mode,
    battery_arm: params.pathway === 'A' ? 'A_narrative' : 'B_fixed',
    slot_form: slot,
    language: params.language,
    player_slot: 1,
    synthetic: true,
  };
  const logger = createSessionLogger({
    sessionId,
    outbox,
    clock,
    context: () => context,
    versions: {
      ...HARNESS_VERSIONS,
      bundle_hash: content.bundleHash,
      timing_profile_version: clock.profile.version,
    },
    consentGranted: () => true,
    ...(deps.validate ? { validate: deps.validate } : {}),
  });
  logger.log('session_start', {
    seed: params.seedHex,
    rng_algorithm: 'pcg32',
    refresh_hz: clock.profile.refreshHz,
    arm_source: 'forced',
    stratum: null,
    slot_form: slot,
  });
  let source: ModuleSource | null = null;
  const host = new ModuleHost({
    content,
    registry: deps.registry,
    services: deps.services,
    dev: {
      overlay: deps.dev?.overlay ?? false,
      voicePlaceholder: deps.dev?.voicePlaceholder ?? false,
      headless: deps.dev?.headless ?? params.bot,
    },
    ...(deps.fallback ? { fallback: deps.fallback } : {}),
    ...(deps.abortGraceMs !== undefined ? { abortGraceMs: deps.abortGraceMs } : {}),
    onResolved: (_id, s) => {
      source = s;
    },
  });
  const ac = new AbortController();
  const result = host
    .run({
      moduleId: params.moduleId,
      level: params.level,
      language: params.language,
      logger,
      rng: createSessionRng(params.seedHex),
      clock,
      session: {
        sessionId,
        pathway: params.pathway,
        mode: params.mode,
        siteMode: 'supervised',
        formId,
        slotForm: slot,
        headset: false,
        slowPace: false,
      },
      signal: ac.signal,
    })
    .then((r) => {
      logger.log('session_end', {
        reason: r.endedReason === 'completed' ? 'completed' : 'abandoned',
        duration_ms: Math.round(clock.now()),
      });
      return r;
    });
  return {
    params,
    sessionId,
    logger,
    clock,
    result,
    source: () => source,
    async events() {
      await logger.flush();
      return (await outbox.sessionEvents(sessionId)) as EventEnvelope[];
    },
    abort() {
      ac.abort({ kind: 'explicit_exit' });
    },
  };
}
