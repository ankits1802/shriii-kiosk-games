/**
 * Test helpers: run The Stall headlessly through the real module host and dev harness (fake timers,
 * the engine's DomInputService fed by the scripted bot, strict contract validation).
 */
import type { EventEnvelope } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import type { Application, Container } from 'pixi.js';
import { vi } from 'vitest';
import type { ArtKit, Layout, ModuleResult } from '../../../core/contracts.ts';
import { SessionClock } from '../../../engine/clock.ts';
import { loadGameContent } from '../../../engine/content.ts';
import { parseModuleHarnessParams, runModuleHarness } from '../../../engine/dev-harness.ts';
import { SilentAudioService, SilentVoiceService } from '../../../engine/fallbacks/silent-audio.ts';
import { GameModuleRegistry } from '../../../engine/registry.ts';
import { DomInputService } from '../../../input/input-service.ts';
import { physicalMetrics } from '../../../input/metrics.ts';
import { ajvEventValidator } from '../../../logging/event-logger.ts';
import { StallEpisode, type StallEpisodeOptions } from '../StallEpisode.ts';
import { trialParamsOf } from '../schedule.ts';

export const content = loadGameContent();

/** A certified test timing profile (so RT indicators are not excluded as uncertified). */
export const TEST_PROFILE = {
  version: 'test-certified',
  certified: true,
  displayOffsetMs: 0,
  audioOutputOffsetMs: 0,
  touchOffsetMs: 0,
  refreshHz: 60,
} as const;

export function fakeClock(certified = true): SessionClock {
  return new SessionClock({
    anchorPerfMs: Date.now(),
    ...(certified ? { profile: TEST_PROFILE } : {}),
    platform: {
      perfNow: () => Date.now(),
      wallNow: () => Date.now(),
      requestFrame: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    },
  });
}

export function testLayout(width = 1920, height = 1080, pxPerMm = 4): Layout {
  const metrics = physicalMetrics(pxPerMm);
  return {
    width,
    height,
    safeArea: { x: 0, y: height / 3, width, height: (height * 2) / 3 },
    orientation: width >= height ? 'landscape' : 'portrait',
    metrics,
    onChange: () => () => undefined,
  };
}

export interface HeadlessRun {
  readonly result: ModuleResult;
  readonly events: EventEnvelope[];
  readonly episode: StallEpisode;
  readonly trialParams: Record<string, Readonly<Record<string, unknown>>>;
  readonly sessionId: string;
}

/**
 * Run the stall once headlessly with the scripted bot. Must be called under `vi.useFakeTimers()`.
 * `voiceLineMs` simulates recorded line lengths.
 */
export async function runHeadless(
  query: string,
  options: {
    readonly voiceLineMs?: number;
    readonly layout?: Layout;
    readonly episode?: StallEpisodeOptions;
    readonly abortAtMs?: number;
    readonly certified?: boolean;
  } = {},
): Promise<HeadlessRun> {
  const clock = fakeClock(options.certified ?? true);
  const layout = options.layout ?? testLayout();
  const input = new DomInputService({
    clock,
    metrics: layout.metrics,
    element: null,
    stageSize: () => ({ width: layout.width, height: layout.height }),
    safeArea: () => layout.safeArea,
    strictTargets: true,
  });
  let episode: StallEpisode | null = null;
  const registry = new GameModuleRegistry({
    stall: () => {
      episode = new StallEpisode(
        content.get('stall').constructs,
        content.get('stall').indicators as never,
        options.episode ?? {},
      );
      return episode;
    },
  });
  const params = parseModuleHarnessParams(query, content);
  if (!params) throw new Error('no harness params');
  const voice = new SilentVoiceService(clock, { lineMs: options.voiceLineMs ?? 1800 });
  input.setVoice(voice);
  const run = runModuleHarness(params, {
    content,
    registry,
    clock,
    validate: ajvEventValidator(validateEventEnvelope),
    services: {
      app: {} as Application,
      layout,
      audio: new SilentAudioService(clock),
      voice,
      input,
      art: {} as ArtKit,
      createStage: () => ({}) as Container,
      releaseStage: () => undefined,
    },
  });
  input.setLogger(run.logger);
  if (options.abortAtMs !== undefined) {
    const at = options.abortAtMs;
    setTimeout(() => run.abort(), at);
  }
  let settled = false;
  void run.result.then(() => {
    settled = true;
  });
  for (let i = 0; i < 400 && !settled; i++) await vi.advanceTimersByTimeAsync(1000);
  const result = await run.result;
  const events = await run.events();
  const ep = episode as StallEpisode | null;
  if (!ep) throw new Error('episode not created');
  const plan = ep.currentPlan;
  return {
    result,
    events,
    episode: ep,
    trialParams: plan ? trialParamsOf(plan) : {},
    sessionId: run.sessionId,
  };
}
