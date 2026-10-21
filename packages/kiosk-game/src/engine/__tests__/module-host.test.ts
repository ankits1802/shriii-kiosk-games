import { checkSessionSequence, type EventEnvelope, validateEvent } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import type { Application, Container } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ArtKit,
  GameModule,
  InputService,
  Layout,
  ModuleContext,
  ModuleResult,
} from '../../core/contracts.ts';
import { abortReasonOf } from '../../core/contracts.ts';
import { physicalMetrics } from '../../input/metrics.ts';
import { TEST_CONTEXT, TEST_VERSIONS } from '../../logging/__tests__/helpers.ts';
import { ajvEventValidator, createSessionLogger } from '../../logging/event-logger.ts';
import { MemoryOutbox } from '../../logging/outbox/memory-outbox.ts';
import { SessionClock } from '../clock.ts';
import { loadGameContent } from '../content.ts';
import { genericModuleFallback } from '../fallbacks/generic-module.ts';
import { SilentAudioService, SilentVoiceService } from '../fallbacks/silent-audio.ts';
import { ModuleHost, type ModuleRunRequest } from '../module-host.ts';
import { createSessionRng } from '../rng.ts';

const content = loadGameContent();

function harness(registry: Record<string, () => GameModule> = {}) {
  const clock = new SessionClock({
    anchorPerfMs: Date.now(),
    platform: {
      perfNow: () => Date.now(),
      wallNow: () => Date.now(),
      requestFrame: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    },
  });
  const outbox = new MemoryOutbox({ kioskId: 'kiosk-test' });
  const logger = createSessionLogger({
    sessionId: '01a15df9-9480-78bd-98a1-a021f6e0e2f9',
    outbox,
    clock,
    context: () => TEST_CONTEXT,
    versions: TEST_VERSIONS,
    consentGranted: () => true,
    validate: ajvEventValidator(validateEventEnvelope),
  });
  logger.log('session_start', {
    seed: '0123456789abcdef',
    rng_algorithm: 'pcg32',
    refresh_hz: 60,
    arm_source: 'forced',
    stratum: null,
    slot_form: null,
  });
  const released: Container[] = [];
  const loggers: unknown[] = [];
  const layout: Layout = {
    width: 1920,
    height: 1080,
    safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
    orientation: 'landscape',
    metrics: physicalMetrics(),
    onChange: () => () => undefined,
  };
  const host = new ModuleHost({
    content,
    registry,
    dev: { overlay: false, voicePlaceholder: false, headless: true },
    fallback: genericModuleFallback(content),
    abortGraceMs: 500,
    services: {
      app: {} as Application,
      layout,
      audio: new SilentAudioService(clock),
      voice: new SilentVoiceService(clock),
      input: { setLogger: (l: unknown) => loggers.push(l) } as unknown as InputService,
      art: {} as ArtKit,
      createStage: () => ({ id: Math.random() }) as unknown as Container,
      releaseStage: (s) => released.push(s),
    },
  });
  const request = (
    moduleId: ModuleRunRequest['moduleId'],
    signal = new AbortController().signal,
  ): ModuleRunRequest => ({
    moduleId,
    level: 'L2',
    language: 'hi-IN',
    logger,
    rng: createSessionRng('00000000000000ff'),
    clock,
    session: {
      sessionId: logger.sessionId,
      pathway: 'B',
      mode: 'pilot',
      siteMode: 'supervised',
      formId: 'form_1',
      slotForm: null,
      headset: false,
      slowPace: false,
    },
    signal,
  });
  const events = async (): Promise<EventEnvelope[]> => {
    await logger.flush();
    return (await outbox.sessionEvents(logger.sessionId)) as EventEnvelope[];
  };
  return { host, request, events, released, loggers, logger };
}

class StubModule implements GameModule {
  readonly id = 'balloon' as const;
  readonly kind = 'micro' as const;
  readonly constructs = [];
  readonly indicators = [];
  ctx: ModuleContext | null = null;
  destroyed = 0;
  constructor(private readonly behaviour: 'complete' | 'hang' | 'throw' | 'self_log') {}
  async init(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }
  run(): Promise<ModuleResult> {
    const ctx = this.ctx as ModuleContext;
    const done = (): ModuleResult => ({
      moduleId: 'balloon',
      endedReason: 'completed',
      durationMs: 0,
      trialsCompleted: 3,
      scorableTrials: 3,
      contextShiftIndex: null,
    });
    switch (this.behaviour) {
      case 'complete':
        return Promise.resolve(done());
      case 'self_log':
        ctx.logger.log('module_start', {
          module_id: 'balloon',
          kind: 'micro',
          paradigms: ['bart'],
          duration_budget_ms: 1,
          soft_cap_ms: 1,
          hard_cap_ms: 1,
          config_hash: '0'.repeat(64),
        });
        ctx.logger.log('module_end', {
          module_id: 'balloon',
          ended_reason: 'completed',
          duration_ms: 1,
          trials_completed: 3,
        });
        return Promise.resolve(done());
      case 'throw':
        return Promise.reject(new Error('boom'));
      case 'hang':
        return new Promise(() => undefined); // ignores its abort signal
    }
  }
  destroy(): void {
    this.destroyed += 1;
  }
}

describe('ModuleHost (ENG-05)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('logs module_start/module_end once each, even when the module logs them too', async () => {
    const stub = new StubModule('self_log');
    const { host, request, events, released, loggers, logger } = harness({ balloon: () => stub });
    const r = await host.run(request('balloon'));
    expect(r).toMatchObject({ moduleId: 'balloon', endedReason: 'completed', trialsCompleted: 3 });
    const ev = await events();
    expect(ev.filter((e) => e.event_type === 'module_start')).toHaveLength(1);
    expect(ev.filter((e) => e.event_type === 'module_end')).toHaveLength(1);
    const start = ev.find((e) => e.event_type === 'module_start');
    expect(start?.payload).toMatchObject({
      module_id: 'balloon',
      config_hash: content.configHash('balloon'),
      hard_cap_ms: 100000,
    });
    expect(start?.task?.module_id).toBe('balloon');
    expect(stub.destroyed).toBe(1);
    expect(released).toHaveLength(1);
    expect(loggers.at(-1)).toBe(logger);
    expect(stub.ctx?.levelConfig).toBe(content.get('balloon').levels.L2);
    expect(stub.ctx?.rng.streamName).toBe('session.balloon');
  });

  it('ends a hanging module at the hard cap with time_cap', async () => {
    const stub = new StubModule('hang');
    const { host, request, events } = harness({ balloon: () => stub });
    const p = host.run(request('balloon'));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(stub.ctx && abortReasonOf(stub.ctx.signal)).toEqual({ kind: 'time_cap' });
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    expect(r.endedReason).toBe('time_cap');
    expect((await events()).at(-1)?.payload).toMatchObject({ ended_reason: 'time_cap' });
    expect(stub.destroyed).toBe(1);
  });

  it('propagates a session abort (walkaway) and survives module errors', async () => {
    const hang = new StubModule('hang');
    const { host, request } = harness({
      balloon: () => hang,
      tower: () => new StubModule('throw') as unknown as GameModule,
    });
    const ac = new AbortController();
    const p = host.run(request('balloon', ac.signal));
    await vi.advanceTimersByTimeAsync(10);
    ac.abort({ kind: 'walkaway' });
    await vi.advanceTimersByTimeAsync(500);
    expect((await p).endedReason).toBe('walkaway');
    const e = await host.run(request('tower'));
    expect(e.endedReason).toBe('error');
  });

  it('runs any configured module headlessly through the generic fallback with valid events', async () => {
    const { host, request, events } = harness();
    for (const id of ['dont_tap', 'warmup', 'steady_hands'] as const) {
      const p = host.run(request(id));
      await vi.advanceTimersByTimeAsync(130_000);
      const r = await p;
      expect(r.endedReason).toBe('completed');
      const cfg = content.get(id);
      expect(r.durationMs).toBeLessThanOrEqual(cfg.budget.hard_cap_ms);
      expect(r.trialsCompleted).toBeGreaterThanOrEqual(
        cfg.blocks.reduce((a, b) => a + b.min_trials, 0),
      );
    }
    const ev = await events();
    expect(checkSessionSequence(ev)).toEqual([]);
    for (const e of ev) expect(validateEvent(e).ok, `${e.event_type}#${e.seq}`).toBe(true);
    const shift = ev.find(
      (e) => e.event_type === 'context_shift' && e.task?.module_id === 'dont_tap',
    );
    expect(shift?.payload).toMatchObject({ kind: 'pressure_on', shift_index: 40 });
    const practice = ev.filter(
      (e) => e.condition?.phase === 'practice' || e.condition?.phase === 'warmup',
    );
    expect(practice.length).toBeGreaterThan(0);
    expect(practice.every((e) => !e.timing.scorable)).toBe(true);
    expect(ev.some((e) => e.timing.scorable && e.event_type === 'response')).toBe(true);
  }, 60_000);

  it('skips modules without config or implementation', async () => {
    const { host, request } = harness();
    const noFallback = new ModuleHost({
      ...(host as unknown as { opts: ConstructorParameters<typeof ModuleHost>[0] }).opts,
      fallback: () => null,
    });
    expect((await noFallback.run(request('balloon'))).endedReason).toBe('skipped');
  });
});
