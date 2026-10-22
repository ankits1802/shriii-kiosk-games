/**
 * Headless harness for the set-2 module tests: real module host, real input layer (pointer samples
 * injected by the scripted bot), silent audio/voice, strict Ajv event validation and a session clock
 * on vitest fake timers, so a full module runs in milliseconds of wall time.
 */
import type { EventEnvelope } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import type { Application, Container } from 'pixi.js';
import { vi } from 'vitest';
import type {
  ArtKit,
  Layout,
  ModuleId,
  ModuleResult,
  SiteMode,
  TimingProfile,
} from '../../../core/contracts.ts';
import { SessionClock } from '../../../engine/clock.ts';
import { type GameContent, loadGameContent } from '../../../engine/content.ts';
import { SilentAudioService, SilentVoiceService } from '../../../engine/fallbacks/silent-audio.ts';
import type { PlayServices } from '../../../engine/module-host.ts';
import { GameModuleRegistry } from '../../../engine/registry.ts';
import { DomInputService } from '../../../input/input-service.ts';
import { physicalMetrics } from '../../../input/metrics.ts';
import { ajvEventValidator } from '../../../logging/event-logger.ts';
import type { MicroGameHooks, PhaseInfo } from '../kit/runtime.ts';
import { type Set2Module, set2ModuleFactories } from '../modules.ts';
import { runSet2Session } from '../session-run.ts';

export const content: GameContent = loadGameContent();

/** Certified synthetic profile so timing-sensitive checks see `timing_flag: ok`. */
export const BENCH: TimingProfile = {
  version: 'test-bench',
  certified: true,
  displayOffsetMs: 0,
  audioOutputOffsetMs: 0,
  touchOffsetMs: 0,
  refreshHz: 60,
};

export function testLayout(width = 1920, height = 1080): Layout {
  const metrics = physicalMetrics();
  const margin = 8 * metrics.pxPerMm;
  return {
    width,
    height,
    safeArea: { x: margin, y: margin, width: width - 2 * margin, height: height - 2 * margin },
    orientation: width >= height ? 'landscape' : 'portrait',
    metrics,
    onChange: () => () => undefined,
  };
}

export interface HeadlessRun {
  readonly results: ModuleResult[];
  readonly events: EventEnvelope[];
  readonly params: Record<string, Record<string, unknown>>;
  readonly phases: PhaseInfo[];
  readonly sessionId: string;
  readonly invalidEvents: number;
}

export interface HeadlessOptions {
  readonly modules: readonly ModuleId[];
  readonly seed?: string;
  readonly level?: 'L1' | 'L2' | 'L3';
  readonly siteMode?: SiteMode;
  readonly headset?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly hub?: boolean;
  readonly maxMs?: number;
  /** Abort the session after this much session time. */
  readonly abortAtMs?: number;
  /** Extra hooks / factories (e.g. a counting entropy source for private dice). */
  readonly hooks?: MicroGameHooks;
  readonly content?: GameContent;
  readonly registry?: GameModuleRegistry;
}

/** Run modules headlessly with the scripted bot. Call inside a test with fake timers enabled. */
export async function runHeadless(options: HeadlessOptions): Promise<HeadlessRun> {
  const clock = new SessionClock({
    anchorPerfMs: Date.now(),
    profile: BENCH,
    platform: {
      perfNow: () => Date.now(),
      wallNow: () => Date.now(),
      requestFrame: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    },
  });
  const layout = testLayout(options.width, options.height);
  const audio = new SilentAudioService(clock);
  const voice = new SilentVoiceService(clock, { lineMs: 1500 });
  const input = new DomInputService({
    clock,
    metrics: layout.metrics,
    element: null,
    stageSize: () => ({ width: layout.width, height: layout.height }),
    safeArea: () => layout.safeArea,
    strictTargets: true,
    voice,
  });
  const phases: PhaseInfo[] = [];
  const created: Set2Module[] = [];
  const registry =
    options.registry ??
    new GameModuleRegistry(
      set2ModuleFactories(
        {
          onPhase: (p) => {
            phases.push(p);
            options.hooks?.onPhase?.(p);
          },
        },
        (m) => created.push(m),
      ),
    );
  const services: PlayServices = {
    app: {} as Application,
    layout,
    audio,
    voice,
    input,
    art: {} as ArtKit,
    createStage: () => ({ addChild: () => undefined }) as unknown as Container,
    releaseStage: () => undefined,
  };
  let invalid = 0;
  const strict = ajvEventValidator(validateEventEnvelope);
  const run = runSet2Session({
    content: options.content ?? content,
    registry,
    services,
    modules: options.modules,
    seedHex: options.seed ?? '00000000000000aa',
    level: options.level ?? 'L2',
    siteMode: options.siteMode ?? 'supervised',
    headset: options.headset ?? false,
    clock,
    hub: options.hub ?? false,
    validate: (e) => {
      const r = strict(e);
      if (!r.ok) {
        invalid += 1;
        // Surface the first failures in test output.
        if (invalid <= 3) console.error('invalid event', r, JSON.stringify(e).slice(0, 400));
      }
      return r;
    },
    dev: { headless: true },
  });
  let done = false;
  const results = run.results.then((r) => {
    done = true;
    return r;
  });
  const maxMs = options.maxMs ?? 200_000 * options.modules.length;
  let elapsed = 0;
  while (!done && elapsed < maxMs) {
    await vi.advanceTimersByTimeAsync(250);
    elapsed += 250;
    if (options.abortAtMs !== undefined && clock.now() >= options.abortAtMs) run.abort();
  }
  if (!done) throw new Error(`modules did not finish within ${maxMs} ms of session time`);
  const res = await results;
  await vi.advanceTimersByTimeAsync(100);
  return {
    results: res,
    events: await run.events(),
    params: Object.assign({}, ...created.map((m) => m.trialParams())),
    phases,
    sessionId: run.sessionId,
    invalidEvents: invalid,
  };
}

/** Events of one trial, by trial id. */
export function trialsOf(
  events: readonly EventEnvelope[],
  moduleId: string,
): Map<string, EventEnvelope[]> {
  const out = new Map<string, EventEnvelope[]>();
  for (const e of events) {
    const tid = e.task?.trial_id;
    if (!tid || e.task?.module_id !== moduleId) continue;
    const list = out.get(tid) ?? [];
    list.push(e);
    out.set(tid, list);
  }
  return out;
}

/** The `trial_start` payloads of a module in order. */
export function trialStarts(events: readonly EventEnvelope[], moduleId: string): EventEnvelope[] {
  return events.filter((e) => e.event_type === 'trial_start' && e.task?.module_id === moduleId);
}
