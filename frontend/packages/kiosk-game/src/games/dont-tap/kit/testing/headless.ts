/**
 * Headless module runs on virtual time through the REAL engine path: `runModuleHarness` (module host,
 * gated logger, soft/hard caps, wrap-up), the strict Ajv event validator, the engine input layer
 * (`DomInputService`, bot pointer injection) and the memory outbox. Used by the module tests, the
 * multi-session NDJSON export for the Python scoring check, and duration checks.
 */
import type { CalibrationLevel, EventEnvelope } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import { type Application, Container } from 'pixi.js';
import { staticLayout } from '../../../../art/layout.ts';
import type { GameModule, ModuleId, ModuleResult } from '../../../../core/contracts.ts';
import { loadGameContent } from '../../../../engine/content.ts';
import { runModuleHarness } from '../../../../engine/dev-harness.ts';
import { BasicArtKit } from '../../../../engine/fallbacks/basic-art.ts';
import { SilentAudioService } from '../../../../engine/fallbacks/silent-audio.ts';
import { DomInputService } from '../../../../input/input-service.ts';
import { CSS_PX_PER_MM } from '../../../../input/metrics.ts';
import { ajvEventValidator } from '../../../../logging/event-logger.ts';
import { CatalogueTimedVoice } from './catalogue-voice.ts';
import { VirtualTime } from './virtual-time.ts';

/** A module instance that can report its session trial params (kit modules do). */
export interface ParamsReporter {
  trialParams(): Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface HeadlessRunOptions {
  readonly moduleId: ModuleId;
  readonly factory: () => GameModule & ParamsReporter;
  readonly level?: CalibrationLevel;
  /** Decimal or hex seed (harness convention). */
  readonly seed?: string | number;
  readonly formId?: string;
  readonly width?: number;
  readonly height?: number;
  /** Abort the module after this much simulated time (walkaway tests). */
  readonly abortAfterMs?: number;
}

export interface HeadlessRunResult {
  readonly result: ModuleResult;
  readonly events: EventEnvelope[];
  readonly sessionId: string;
  readonly trialParams: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Simulated duration of the module (module_start to module_end). */
  readonly durationMs: number;
  /** Count of events the strict validator rejected (logged as `invalid` placeholders). */
  readonly invalidEvents: number;
  readonly voiceLines: readonly string[];
}

/** Run one module headlessly with the scripted bot. */
export async function runHeadless(options: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const vt = new VirtualTime();
  const clock = vt.clock();
  const content = loadGameContent();
  const layout = staticLayout(options.width ?? 1920, options.height ?? 1080, CSS_PX_PER_MM);
  const overlay = new Container();
  const voice = new CatalogueTimedVoice(clock);
  const input = new DomInputService({
    clock,
    metrics: layout.metrics,
    element: null,
    stageSize: () => ({ width: layout.width, height: layout.height }),
    safeArea: () => layout.safeArea,
    strictTargets: true,
    voice,
  });
  let instance: (GameModule & ParamsReporter) | null = null;
  const seed = options.seed ?? 123;
  const run = runModuleHarness(
    {
      moduleId: options.moduleId,
      level: options.level ?? 'L2',
      language: 'en-IN',
      seedHex: BigInt(seed).toString(16).padStart(16, '0'),
      formId: options.formId ?? null,
      pathway: 'B',
      bot: true,
      mode: 'pilot',
    },
    {
      content,
      clock,
      registry: {
        [options.moduleId]: () => {
          instance = options.factory();
          return instance;
        },
      },
      validate: ajvEventValidator(validateEventEnvelope),
      services: {
        app: {} as Application,
        layout,
        audio: new SilentAudioService(clock),
        voice,
        input,
        art: new BasicArtKit(layout, overlay),
        createStage: () => new Container(),
        releaseStage: (c) => c.destroy({ children: true }),
      },
    },
  );
  input.setLogger(run.logger);
  if (options.abortAfterMs !== undefined) {
    void clock.delay(options.abortAfterMs).then(() => run.abort());
  }
  const result = await vt.runUntil(run.result);
  const events = await vt.runUntil(run.events());
  input.dispose();
  const start = events.find((e) => e.event_type === 'module_start');
  const end = events.find((e) => e.event_type === 'module_end');
  const reporter = instance as (GameModule & ParamsReporter) | null;
  return {
    result,
    events,
    sessionId: run.sessionId,
    trialParams: reporter ? reporter.trialParams() : {},
    durationMs: start && end ? end.timing.t_mono_ms - start.timing.t_mono_ms : 0,
    invalidEvents: events.filter((e) => e.event_type === 'invalid').length,
    voiceLines: voice.played,
  };
}

/** NDJSON of events (one envelope per line). */
export function toNdjson(events: readonly EventEnvelope[]): string {
  return `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
}
