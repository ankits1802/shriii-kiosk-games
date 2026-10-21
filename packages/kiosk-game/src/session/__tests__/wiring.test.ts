/**
 * Engine wiring: registry-driven play (Pathway A / B), crash and abort error policy, global crash
 * handlers, play-ceiling wrap-up and module end, narration pausing the walkaway timer, and the
 * onboarding config derived from the warm-up game config.
 */
import type { EventEnvelope } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import type { Application, Container } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ArtKit,
  abortReasonOf,
  type GameModule,
  type InputService,
  type Layout,
  type ModuleContext,
  type ModuleResult,
} from '../../core/contracts.ts';
import { MemoryKeyValueStore } from '../../engine/assignment.ts';
import { SessionClock } from '../../engine/clock.ts';
import { loadGameContent } from '../../engine/content.ts';
import { genericModuleFallback } from '../../engine/fallbacks/generic-module.ts';
import { SilentAudioService, SilentVoiceService } from '../../engine/fallbacks/silent-audio.ts';
import { ModuleHost, type ModuleRunner, type ModuleRunRequest } from '../../engine/module-host.ts';
import { GameModuleRegistry, type ModuleSource } from '../../engine/registry.ts';
import { physicalMetrics } from '../../input/metrics.ts';
import { ajvEventValidator } from '../../logging/event-logger.ts';
import { MemoryOutbox } from '../../logging/outbox/memory-outbox.ts';
import { practiceConfigFromWarmup } from '../../onboarding/practiceConfig.ts';
import { ScreenAbortedError } from '../../onboarding/ScreenKit.ts';
import { installGlobalCrashHandlers } from '../crash-handlers.ts';
import { developmentDeviceConfig } from '../device.ts';
import { onboardingConfigFor } from '../onboarding-config.ts';
import { SessionController, type SessionControllerOptions } from '../session-controller.ts';
import { sessionTimersFromPlan } from '../session-machine.ts';

const content = loadGameContent();
const BANDS = {
  age: '25_34',
  literacy: 'with_difficulty',
  edu: 'secondary',
  gender: 'woman',
  device_use: 'daily',
  played_before: 'no',
} as const;

function fakeClock(): SessionClock {
  return new SessionClock({
    anchorPerfMs: Date.now(),
    platform: {
      perfNow: () => Date.now(),
      wallNow: () => Date.now(),
      requestFrame: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    },
  });
}

function makeController(extra: Partial<SessionControllerOptions> = {}) {
  const outbox = new MemoryOutbox({ kioskId: 'kiosk-test' });
  const store = new MemoryKeyValueStore();
  const errors: unknown[] = [];
  const controller = new SessionController({
    content,
    outbox,
    store,
    device: developmentDeviceConfig(store, { mode: 'pilot', synthetic: true }),
    clockFactory: fakeClock,
    validate: ajvEventValidator(validateEventEnvelope),
    onError: (e) => errors.push(e),
    ...extra,
  });
  return { controller, outbox, errors };
}

function onboard(controller: SessionController): void {
  controller.send({ type: 'TOUCH_START' });
  controller.send({ type: 'LANGUAGE_SELECTED', language: 'hi-IN' });
  controller.send({ type: 'CONSENT_GRANTED', tapConfirmed: true, archiveOptIn: false });
  controller.send({ type: 'BANDS_ANSWERED', bands: BANDS });
}

const L2 = { level: 'L2', policy: 'fixed_L2_with_L1_fallback', reason: 'default' } as const;

function done(req: ModuleRunRequest, endedReason: ModuleResult['endedReason']): ModuleResult {
  return {
    moduleId: req.moduleId,
    endedReason,
    durationMs: 1,
    trialsCompleted: 1,
    scorableTrials: 1,
    contextShiftIndex: null,
  };
}

/** Runner that completes every module at once and records what it was asked to run. */
function recordingRunner(): ModuleRunner & { readonly ran: ModuleRunRequest[] } {
  const ran: ModuleRunRequest[] = [];
  return {
    ran,
    run: async (req) => {
      ran.push(req);
      return done(req, 'completed');
    },
  };
}

async function sessionEvents(outbox: MemoryOutbox, id: string): Promise<EventEnvelope[]> {
  return (await outbox.sessionEvents(id)) as EventEnvelope[];
}

describe('session play runs the planned pathway through the module registry', () => {
  it('Pathway A: stall -> weighing_post -> road_home', async () => {
    const runner = recordingRunner();
    const { controller } = makeController({ runner, arm: 'A_narrative' });
    onboard(controller);
    controller.send({ type: 'WARMUP_DONE', calibration: L2 });
    await vi.waitFor(() => expect(controller.snapshot.state).toBe('report'));
    expect(runner.ran.map((r) => r.moduleId)).toEqual([
      'warmup',
      'stall',
      'weighing_post',
      'road_home',
    ]);
    expect(runner.ran.slice(1).every((r) => r.session.pathway === 'A')).toBe(true);
    controller.dispose();
  });

  it('Pathway B: the 5 core modules in fixed order + 1 seeded slot', async () => {
    const runner = recordingRunner();
    const { controller } = makeController({ runner });
    onboard(controller);
    controller.send({ type: 'WARMUP_DONE', calibration: L2 });
    await vi.waitFor(() => expect(controller.snapshot.state).toBe('report'));
    const played = runner.ran.slice(1).map((r) => r.moduleId);
    expect(played.slice(0, 5)).toEqual(content.plan.pathways.B.core_order);
    expect(played).toHaveLength(6);
    expect(content.plan.pathways.B.slot_candidates).toContain(played[5]);
    expect(played[5]).toBe(controller.snapshot.slotForm);
    controller.dispose();
  });

  it('registered episodes run as themselves; the placeholder only fills unregistered ids', async () => {
    vi.useFakeTimers();
    try {
      const registry = new GameModuleRegistry();
      const inits: ModuleContext[] = [];
      for (const id of ['warmup', 'stall', 'weighing_post', 'road_home'] as const) {
        registry.register(
          id,
          (): GameModule => ({
            id,
            kind: id === 'warmup' ? 'warmup' : 'episode',
            constructs: [],
            indicators: [],
            init: async (ctx) => {
              inits.push(ctx);
            },
            run: async () => ({
              moduleId: id,
              endedReason: 'completed',
              durationMs: 0,
              trialsCompleted: 1,
              scorableTrials: 1,
              contextShiftIndex: null,
            }),
            destroy: () => undefined,
          }),
        );
      }
      const clock = fakeClock();
      const layout: Layout = {
        width: 1920,
        height: 1080,
        safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
        orientation: 'landscape',
        metrics: physicalMetrics(),
        onChange: () => () => undefined,
      };
      const sources: string[] = [];
      const host = new ModuleHost({
        content,
        registry,
        dev: { overlay: false, voicePlaceholder: false, headless: true },
        fallback: genericModuleFallback(content),
        onResolved: (id, s: ModuleSource) => sources.push(`${id}:${s}`),
        services: {
          app: {} as Application,
          layout,
          audio: new SilentAudioService(clock),
          voice: new SilentVoiceService(clock),
          input: { setLogger: () => undefined } as unknown as InputService,
          art: {} as ArtKit,
          createStage: () => ({}) as Container,
          releaseStage: () => undefined,
        },
      });
      const { controller } = makeController({ runner: host, arm: 'A_narrative' });
      onboard(controller);
      for (let i = 0; i < 50 && controller.snapshot.state !== 'report'; i += 1)
        await vi.advanceTimersByTimeAsync(100);
      expect(controller.snapshot.state).toBe('report');
      expect(sources).toEqual([
        'warmup:registered',
        'stall:registered',
        'weighing_post:registered',
        'road_home:registered',
      ]);
      expect(inits.every((c) => c.wrapUp !== undefined)).toBe(true);
      expect(inits.find((c) => c.config.module_id === 'stall')?.logger.scope.task?.episode_id).toBe(
        'stall',
      );
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('error policy: aborts are normal, everything else is a crash', () => {
  it('reportError ignores ScreenAbortedError, AbortError, reason objects and legacy aborts', () => {
    const { controller, errors } = makeController();
    onboard(controller);
    for (const e of [
      new ScreenAbortedError(),
      new DOMException('x', 'AbortError'),
      { kind: 'walkaway' },
      new Error('aborted'),
    ]) {
      expect(controller.reportError(e)).toBe('abort');
    }
    expect(controller.snapshot.state).toBe('practiceWarmup');
    expect(errors).toEqual([]);
    controller.dispose();
  });

  it('a real error during a session ends it with CRASH (crash_recovery, events kept)', async () => {
    const { controller, outbox, errors } = makeController();
    onboard(controller);
    const id = controller.snapshot.sessionId;
    const boom = new Error('render failed');
    expect(controller.reportError(boom)).toBe('crash');
    expect(errors).toEqual([boom]);
    await vi.waitFor(() => expect(controller.snapshot.state).toBe('attract'));
    await controller.whenIdle();
    const ev = await sessionEvents(outbox, id);
    expect(ev.find((e) => e.event_type === 'session.abandoned')?.payload).toMatchObject({
      reason: 'crash_recovery',
    });
    expect(ev.find((e) => e.event_type === 'session_end')?.payload).toMatchObject({
      reason: 'crash_recovery',
    });
    expect(ev.some((e) => e.event_type === 'consent.granted')).toBe(true);
    // Outside a session errors are only reported.
    expect(controller.reportError(new Error('late'))).toBe('ignored');
    controller.dispose();
  });

  it('runScreen resolves null on abort without crashing, and crashes on failures', async () => {
    const { controller } = makeController();
    onboard(controller);
    expect(await controller.runScreen(async () => 7)).toBe(7);
    expect(
      await controller.runScreen(async () => {
        throw new ScreenAbortedError();
      }),
    ).toBeNull();
    expect(controller.snapshot.state).toBe('practiceWarmup');
    expect(
      await controller.runScreen(async () => {
        throw new TypeError('x is undefined');
      }),
    ).toBeNull();
    expect(['wipe', 'attract']).toContain(controller.snapshot.state);
    controller.dispose();
  });
});

describe('global crash handlers', () => {
  it('window error / unhandledrejection -> CRASH; abort rejections are marked handled', () => {
    const target = new EventTarget();
    const reported: unknown[] = [];
    const uninstall = installGlobalCrashHandlers(target, (err) => {
      reported.push(err);
      return err instanceof ScreenAbortedError ? 'abort' : 'crash';
    });
    const boom = new Error('boom');
    const err = new Event('error', { cancelable: true }) as Event & { error?: unknown };
    Object.defineProperty(err, 'error', { value: boom });
    target.dispatchEvent(err);
    const rej = (reason: unknown) => {
      const e = new Event('unhandledrejection', { cancelable: true });
      Object.defineProperty(e, 'reason', { value: reason });
      target.dispatchEvent(e);
      return e;
    };
    const aborted = rej(new ScreenAbortedError());
    const failed = rej(new TypeError('bad'));
    expect(reported[0]).toBe(boom);
    expect(reported).toHaveLength(3);
    expect(aborted.defaultPrevented).toBe(true);
    expect(failed.defaultPrevented).toBe(false);
    expect(err.defaultPrevented).toBe(false);
    // A message-only error event is still reported; an empty one is not.
    const msgOnly = new Event('error') as Event & { message?: string };
    Object.defineProperty(msgOnly, 'message', { value: 'Script error.' });
    target.dispatchEvent(msgOnly);
    target.dispatchEvent(new Event('error'));
    expect(reported).toHaveLength(4);
    uninstall();
    uninstall();
    rej(new Error('after'));
    expect(reported).toHaveLength(4);
  });

  it('wired to a controller, an unhandled rejection ends the session', async () => {
    const { controller } = makeController();
    onboard(controller);
    const target = new EventTarget();
    const off = installGlobalCrashHandlers(target, (e) => controller.reportError(e));
    const e = new Event('unhandledrejection', { cancelable: true });
    Object.defineProperty(e, 'reason', { value: new RangeError('oops') });
    target.dispatchEvent(e);
    expect(['wipe', 'attract']).toContain(controller.snapshot.state);
    off();
    controller.dispose();
  });
});

describe('play ceiling: graceful wrap-up, then the module is ended', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('requests a wrap-up outro_ms before the play ceiling and ends the module on leaving play', async () => {
    const ceilings = { ...sessionTimersFromPlan(content.plan).ceilingsMs, play: 20_000 };
    const seen: { id: string; wrapAt: number | null; abort: string | null }[] = [];
    const runner: ModuleRunner = {
      run: (req) =>
        new Promise<ModuleResult>((resolve) => {
          const rec = {
            id: req.moduleId,
            wrapAt: null as number | null,
            abort: null as string | null,
          };
          seen.push(rec);
          if (req.moduleId === 'warmup') {
            resolve(done(req, 'completed'));
            return;
          }
          // Ignores the wrap-up (worst case) and ends only when aborted.
          req.wrapUp?.addEventListener('abort', () => {
            rec.wrapAt = req.clock.now();
          });
          req.signal.addEventListener('abort', () => {
            rec.abort = abortReasonOf(req.signal)?.kind ?? null;
            resolve(done(req, 'time_cap'));
          });
        }),
    };
    const { controller } = makeController({
      runner,
      timers: { ceilingsMs: ceilings },
      playWrapUpLeadMs: 3_000,
    });
    onboard(controller);
    // The warm-up completes at once, so play starts right after onboarding (t ~ 0).
    await vi.advanceTimersByTimeAsync(16_900);
    expect(controller.snapshot.state).toBe('play');
    expect(seen[1]?.wrapAt).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(seen[1]?.wrapAt).not.toBeNull();
    expect(seen[1]?.wrapAt ?? 0).toBeGreaterThanOrEqual(16_900);
    expect(seen[1]?.wrapAt ?? 0).toBeLessThanOrEqual(17_100);
    expect(controller.requestWrapUp()).toBe(false); // already requested
    await vi.advanceTimersByTimeAsync(3_100);
    expect(controller.snapshot.state).toBe('report');
    expect(seen[1]?.abort).toBe('time_cap');
    expect(seen).toHaveLength(2); // nothing else starts under the report
    controller.dispose();
  });

  it('requestWrapUp() reaches the running module', async () => {
    let wrapped = false;
    const runner: ModuleRunner = {
      run: (req) =>
        new Promise<ModuleResult>((resolve) => {
          if (req.moduleId === 'warmup') return resolve(done(req, 'completed'));
          req.wrapUp?.addEventListener('abort', () => {
            wrapped = true;
            resolve(done(req, 'completed'));
          });
          req.signal.addEventListener('abort', () => resolve(done(req, 'walkaway')));
        }),
    };
    const { controller } = makeController({ runner });
    expect(controller.requestWrapUp()).toBe(false);
    onboard(controller);
    await vi.advanceTimersByTimeAsync(10);
    expect(controller.requestWrapUp()).toBe(true);
    expect(wrapped).toBe(true);
    controller.dispose();
  });
});

describe('narration pauses the walkaway timer (KSK-04)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('no walkaway prompt while the voice is speaking; counting restarts after it ends', async () => {
    const voiceClock = fakeClock();
    const voice = new SilentVoiceService(voiceClock, { lineMs: 30_000 });
    const { controller, outbox } = makeController({ voice });
    onboard(controller);
    const id = controller.snapshot.sessionId;
    await vi.advanceTimersByTimeAsync(2_000);
    const pb = voice.play('warmup.tap');
    expect(voice.speaking).toBe(true);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(controller.snapshot.walkawayStage).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000); // narration ends at 30 s
    expect((await pb.ended).status).toBe('completed');
    expect(voice.speaking).toBe(false);
    await vi.advanceTimersByTimeAsync(7_900);
    expect(controller.snapshot.walkawayStage).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.snapshot.walkawayStage).toBe('reprompt');
    await controller.logger?.flush();
    const prompted = (await sessionEvents(outbox, id)).filter(
      (e) => e.event_type === 'walkaway.prompted',
    );
    expect(prompted).toHaveLength(1);
    controller.dispose();
  });
});

describe('onboarding config (ONB-05)', () => {
  it('derives practice from the warm-up game config, never hand-copied values', () => {
    const store = new MemoryKeyValueStore();
    const device = developmentDeviceConfig(store);
    const cfg = onboardingConfigFor(device, content, { overrides: { pacing: 0 } });
    expect(cfg.practice).toEqual(practiceConfigFromWarmup(content.get('warmup'), 'L2'));
    const warm = content.get('warmup');
    expect(cfg.practice.tapWindowMs).toBe(warm.levels.L2.timing.tap_window_ms);
    expect(cfg.practice.holdRequiredMs).toBe(warm.levels.L2.timing.hold_required_ms);
    expect(cfg).toMatchObject({
      languages: device.languages,
      consentScriptId: device.consent.scriptId,
      packVersion: device.languagePack.version,
      pacing: 0,
    });
    expect(onboardingConfigFor(device, content, { level: 'L1' }).practice.tapWindowMs).toBe(
      warm.levels.L1.timing.tap_window_ms,
    );
  });
});
