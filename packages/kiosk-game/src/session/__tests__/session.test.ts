import { checkSessionSequence, type EventEnvelope, validateEvent } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import fc from 'fast-check';
import type { Application, Container } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActor } from 'xstate';
import type { ArtKit, InputService, Layout, SessionMachineEvent } from '../../core/contracts.ts';
import { MemoryKeyValueStore } from '../../engine/assignment.ts';
import { SessionClock } from '../../engine/clock.ts';
import { loadGameContent } from '../../engine/content.ts';
import { genericModuleFallback } from '../../engine/fallbacks/generic-module.ts';
import { SilentAudioService, SilentVoiceService } from '../../engine/fallbacks/silent-audio.ts';
import { ModuleHost } from '../../engine/module-host.ts';
import { physicalMetrics } from '../../input/metrics.ts';
import { ajvEventValidator } from '../../logging/event-logger.ts';
import { MemoryOutbox } from '../../logging/outbox/memory-outbox.ts';
import { BatchUploader } from '../../logging/uploader.ts';
import { developmentDeviceConfig } from '../device.ts';
import { SessionController, type SessionControllerOptions } from '../session-controller.ts';
import { sessionMachine, sessionTimersFromPlan, stateNameOf } from '../session-machine.ts';

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

async function allEvents(outbox: MemoryOutbox): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  for (;;) {
    const batch = await outbox.nextBatch();
    if (!batch) break;
    for (const c of batch.session_chunks) if (c.encryption === 'none_dev') out.push(...c.events);
    await outbox.applyResult({
      schema_version: '1.0',
      batch_id: batch.batch_id,
      server_received_at: '2026-10-21T00:00:00.000Z',
      clock_offset_estimate_ms: null,
      duplicate_batch: false,
      results: out
        .filter((e) => batch.session_chunks.some((c) => c.session_id === e.session_id))
        .map((e) => ({
          event_id: e.event_id,
          session_id: e.session_id,
          seq: e.seq,
          status: 'accepted' as const,
          reason_code: null,
        })),
      summary: { accepted: 0, duplicate: 0, parked: 0, rejected_terminal: 0, retryable: 0 },
    });
  }
  return out;
}

function onboard(controller: SessionController): void {
  expect(controller.send({ type: 'TOUCH_START' })).toBe(true);
  expect(controller.send({ type: 'LANGUAGE_SELECTED', language: 'hi-IN', taps: 1 })).toBe(true);
  expect(
    controller.send({ type: 'CONSENT_GRANTED', tapConfirmed: true, archiveOptIn: false }),
  ).toBe(true);
  expect(controller.send({ type: 'BANDS_ANSWERED', bands: BANDS })).toBe(true);
}

describe('session statechart (KSK-02)', () => {
  it('play is never reachable without CONSENT_GRANTED{tapConfirmed:true} (10k random sequences)', () => {
    const timers = sessionTimersFromPlan(content.plan);
    const calibration = {
      level: 'L2',
      policy: 'fixed_L2_with_L1_fallback',
      reason: 'default',
    } as const;
    const result = {
      moduleId: 'dont_tap',
      endedReason: 'completed',
      durationMs: 1,
      trialsCompleted: 1,
      scorableTrials: 1,
      contextShiftIndex: null,
    } as const;
    const eventArb = fc.constantFrom<
      SessionMachineEvent | { type: 'CONSENT_GRANTED'; tapConfirmed: false; archiveOptIn: boolean }
    >(
      { type: 'TOUCH_START' },
      { type: 'LANGUAGE_SELECTED', language: 'hi-IN' },
      { type: 'CONSENT_GRANTED', tapConfirmed: false, archiveOptIn: false },
      { type: 'CONSENT_DECLINED' },
      { type: 'BANDS_ANSWERED', bands: BANDS },
      { type: 'UNDER_AGE' },
      { type: 'WARMUP_DONE', calibration },
      { type: 'MODULE_DONE', result },
      { type: 'PLAY_DONE' },
      { type: 'REPORT_DONE' },
      { type: 'SURVEY_DONE' },
      { type: 'IDLE_TIMEOUT' },
      { type: 'EXIT', erase: false },
      { type: 'CRASH' },
    );
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), (events) => {
        const actor = createActor(sessionMachine, {
          input: { timers, offerContactOptIn: true },
        }).start();
        for (const e of events) {
          actor.send(e as SessionMachineEvent);
          const name = stateNameOf(actor.getSnapshot());
          if (name === 'bands' || name === 'practiceWarmup' || name === 'play') {
            expect(actor.getSnapshot().context.consentGranted).toBe(true);
          }
        }
        actor.stop();
      }),
      { numRuns: 10_000 },
    );
  });

  it('a granted tap leads through every state to wipe and back to attract', () => {
    const timers = sessionTimersFromPlan(content.plan);
    const actor = createActor(sessionMachine, {
      input: { timers, offerContactOptIn: true },
    }).start();
    const seen: string[] = [];
    actor.subscribe((s) => seen.push(stateNameOf(s)));
    for (const e of [
      { type: 'TOUCH_START' },
      { type: 'LANGUAGE_SELECTED', language: 'ta-IN' },
      { type: 'CONSENT_GRANTED', tapConfirmed: true, archiveOptIn: true },
      { type: 'BANDS_ANSWERED', bands: BANDS },
      {
        type: 'WARMUP_DONE',
        calibration: {
          level: 'L1',
          policy: 'fixed_L2_with_L1_fallback',
          reason: 'practice_struggle',
        },
      },
      { type: 'PLAY_DONE' },
      { type: 'REPORT_DONE' },
      { type: 'SURVEY_DONE' },
      { type: 'OPTIN_DONE', contactOptIn: false },
      { type: 'FAREWELL_DONE' },
      { type: 'WIPE_DONE' },
    ] as const)
      actor.send(e);
    expect([...new Set(seen)]).toEqual([
      'languageSelect',
      'consent',
      'bands',
      'practiceWarmup',
      'play',
      'report',
      'survey',
      'contactOptIn',
      'farewell',
      'wipe',
      'attract',
    ]);
    expect(stateNameOf(actor.getSnapshot())).toBe('attract');
    expect(actor.getSnapshot().context.consentGranted).toBe(false); // reset for the next player
  });
});

describe('SessionController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completes a session and keeps a gapless, valid event log', async () => {
    const { controller, outbox, errors } = makeController();
    onboard(controller);
    expect(controller.snapshot.state).toBe('practiceWarmup');
    expect(controller.snapshot.plannedModules).toHaveLength(6);
    controller.send({
      type: 'WARMUP_DONE',
      calibration: { level: 'L2', policy: 'fixed_L2_with_L1_fallback', reason: 'default' },
    });
    controller.send({ type: 'PLAY_DONE' });
    expect(controller.snapshot.report?.mode).toBe('thank_you');
    controller.send({ type: 'REPORT_DONE' });
    controller.send({ type: 'SURVEY_DONE', enjoy: 'happy', playAgain: 'yes' });
    expect(controller.snapshot.state).toBe('farewell');
    await vi.advanceTimersByTimeAsync(10_000);
    await controller.whenIdle();
    expect(controller.snapshot.state).toBe('attract');
    const events = await allEvents(outbox);
    expect(errors).toEqual([]);
    expect(checkSessionSequence(events)).toEqual([]);
    for (const e of events) expect(validateEvent(e).ok, e.event_type).toBe(true);
    const types = events.map((e) => e.event_type);
    expect(types[0]).toBe('session_start');
    expect(types.at(-1)).toBe('session_end');
    for (const t of [
      'language_selected',
      'consent.granted',
      'optin.archive',
      'bands.answered',
      'calibration_result',
      'report.withheld',
      'survey.enjoy',
      'survey.play_again',
    ] as const) {
      expect(types).toContain(t);
    }
    expect(types.indexOf('consent.granted')).toBeLessThan(types.indexOf('bands.answered'));
    const transitions = events
      .filter((e) => e.event_type === 'session.state_changed')
      .map((e) => (e.payload as { to_state: string }).to_state);
    expect(transitions).toEqual([
      'languageSelect',
      'consent',
      'bands',
      'practiceWarmup',
      'play',
      'report',
      'survey',
      'farewell',
      'wipe',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ reason: 'completed' });
    expect(events.every((e) => !e.timing.scorable)).toBe(true);
    expect(events[0]?.payload).toMatchObject({
      rng_algorithm: 'pcg32',
      slot_form: controller.snapshot.slotForm ?? expect.any(String),
    });
    controller.dispose();
  });

  it('consent declined: nothing is stored or uploaded, only the anonymous counter', async () => {
    const { controller, outbox } = makeController();
    controller.send({ type: 'TOUCH_START' });
    controller.send({ type: 'LANGUAGE_SELECTED', language: 'mr-IN' });
    controller.send({ type: 'CONSENT_DECLINED' });
    await controller.whenIdle();
    expect(controller.snapshot.state).toBe('attract');
    expect(await outbox.nextBatch()).toBeNull();
    const stats = await outbox.stats();
    expect(stats).toMatchObject({ pendingEvents: 0, sessions: 0, declinedCount: 1 });
    // Play is not reachable afterwards without a new consent.
    expect(
      controller.send({
        type: 'WARMUP_DONE',
        calibration: { level: 'L2', policy: 'forced', reason: 'forced' },
      }),
    ).toBe(false);
    controller.dispose();
  });

  it('under-18: nothing is kept', async () => {
    const { controller, outbox } = makeController();
    controller.send({ type: 'TOUCH_START' });
    controller.send({ type: 'LANGUAGE_SELECTED', language: 'hi-IN' });
    controller.send({ type: 'CONSENT_GRANTED', tapConfirmed: true, archiveOptIn: false });
    controller.send({ type: 'UNDER_AGE' });
    await controller.whenIdle();
    expect(await outbox.nextBatch()).toBeNull();
    expect(await outbox.stats()).toMatchObject({ pendingEvents: 0, sessions: 0, declinedCount: 0 });
    controller.dispose();
  });

  it('walkaway before consent purges the session; after consent it keeps the events', async () => {
    const pre = makeController();
    pre.controller.send({ type: 'TOUCH_START' });
    await vi.advanceTimersByTimeAsync(56_000);
    await pre.controller.whenIdle();
    expect(pre.controller.snapshot.state).toBe('attract');
    expect((await pre.outbox.stats()).sessions).toBe(0);
    pre.controller.dispose();

    const post = makeController();
    onboard(post.controller);
    await vi.advanceTimersByTimeAsync(8000);
    expect(post.controller.snapshot.walkawayStage).toBe('reprompt');
    await vi.advanceTimersByTimeAsync(48_000);
    await post.controller.whenIdle();
    expect(post.controller.snapshot.state).toBe('attract');
    const events = await allEvents(post.outbox);
    expect(checkSessionSequence(events)).toEqual([]);
    const abandoned = events.find((e) => e.event_type === 'session.abandoned');
    expect(abandoned?.payload).toMatchObject({ reason: 'timeout', last_state: 'practiceWarmup' });
    expect(
      events
        .filter((e) => e.event_type === 'walkaway.prompted')
        .map((e) => (e.payload as { stage: string }).stage),
    ).toEqual(['reprompt', 'still_there', 'countdown']);
    expect(events.at(-1)?.payload).toMatchObject({ reason: 'abandoned' });
    post.controller.dispose();
  });

  it('in-session withdrawal leaves only a tombstone', async () => {
    const { controller, outbox } = makeController();
    onboard(controller);
    controller.send({ type: 'EXIT', erase: true });
    await controller.whenIdle();
    const events = await allEvents(outbox);
    expect(events.map((e) => e.event_type)).toEqual(['session_tombstone']);
    expect(validateEvent(events[0]).ok).toBe(true);
    controller.dispose();
  });

  it('runs warm-up and the whole Pathway B carousel headlessly, with uploads paused during play', async () => {
    const calls: number[] = [];
    const outbox = new MemoryOutbox({ kioskId: 'kiosk-test' });
    const uploader = new BatchUploader({
      outbox,
      apiBase: 'http://api.test',
      fetch: (async () => {
        calls.push(Date.now());
        return new Response('{}', { status: 500 });
      }) as typeof fetch,
    });
    const stageStub = {} as Container;
    const layout = {
      width: 1920,
      height: 1080,
      safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
      orientation: 'landscape',
      metrics: physicalMetrics(),
      onChange: () => () => undefined,
    } satisfies Layout;
    const clockForServices = fakeClock();
    const host = new ModuleHost({
      content,
      registry: {},
      dev: { overlay: false, voicePlaceholder: false, headless: true },
      fallback: genericModuleFallback(content),
      services: {
        app: {} as Application,
        layout,
        audio: new SilentAudioService(clockForServices),
        voice: new SilentVoiceService(clockForServices),
        input: { setLogger: () => undefined } as unknown as InputService,
        art: {} as ArtKit,
        createStage: () => stageStub,
        releaseStage: () => undefined,
      },
    });
    const store = new MemoryKeyValueStore();
    const controller = new SessionController({
      content,
      outbox,
      store,
      uploader,
      runner: host,
      // Think-aloud mode: walkaway is disabled (the headless bot never touches the screen).
      device: developmentDeviceConfig(store, { synthetic: true, mode: 'think_aloud' }),
      clockFactory: fakeClock,
      validate: ajvEventValidator(validateEventEnvelope),
    });
    onboard(controller);
    const sessionStart = Date.now();
    for (let i = 0; i < 2000 && controller.snapshot.state !== 'report'; i += 1)
      await vi.advanceTimersByTimeAsync(1000);
    expect(controller.snapshot.state).toBe('report');
    const playEnd = Date.now();
    expect(calls.filter((t) => t >= sessionStart && t <= playEnd)).toEqual([]);
    expect(controller.snapshot.completedModules.map((m) => m.moduleId)).toEqual(
      controller.snapshot.plannedModules,
    );
    expect(controller.snapshot.completedModules.every((m) => m.endedReason === 'completed')).toBe(
      true,
    );
    expect(controller.snapshot.calibration?.level).toBe('L2');
    controller.send({ type: 'REPORT_DONE' });
    controller.send({ type: 'SURVEY_DONE' });
    await vi.advanceTimersByTimeAsync(10_000);
    await controller.whenIdle();
    const events: EventEnvelope[] = [];
    for (const e of (await outbox.sessionEvents(
      controller.snapshot.sessionId || '',
    )) as EventEnvelope[])
      events.push(e);
    controller.dispose();
    // Read the session back from the outbox (single session in this outbox).
    const batch = await outbox.nextBatch();
    const all =
      batch?.session_chunks.flatMap((c) => (c.encryption === 'none_dev' ? c.events : [])) ?? [];
    expect(all.length).toBeGreaterThan(0);
    // (The first batch is capped by size; verify the prefix.)
    expect(checkSessionSequence(all)).toEqual([]);
    for (const e of all) expect(validateEvent(e).ok, `${e.event_type} ${e.seq}`).toBe(true);
    expect(all.filter((e) => e.event_type === 'module_start').length).toBeGreaterThan(0);
    expect(all.some((e) => e.event_type === 'practice.summary')).toBe(true);
  }, 120_000);
});

describe('walkaway pause marks the running trial interrupted (KSK-04)', () => {
  it('events of a trial paused by a walkaway prompt carry timing.interrupted=true', async () => {
    const { controller, outbox, errors } = makeController();
    onboard(controller);
    const s = controller.logger;
    expect(s).not.toBeNull();
    if (!s) return;
    const trial = (id: string) =>
      s.child({
        task: {
          episode_id: null,
          module_id: 'dont_tap',
          block_id: 'main',
          trial_id: id,
          trial_index: 0,
          form_id: 'form_1',
          anchor_trial: false,
        },
        condition: {
          phase: 'main',
          condition_id: 'go',
          shift_active: false,
          timer: false,
          noise: false,
          calibration_level: 'L2',
          variant_seed: null,
        },
        scorable: true,
      });
    const start = {
      trial_type: 'go',
      stimulus_id: null,
      response_window_ms: 1000,
      private_report: false,
      expected_response: null,
    } as const;
    const end = {
      outcome: 'omission',
      correctness: false,
      response_count: 0,
      duration_ms: 10,
    } as const;
    const a = trial('dont_tap.main.0');
    a.log('trial_start', start);
    controller.devSimulateWalkaway('reprompt');
    a.log('trial_end', end);
    const b = trial('dont_tap.main.1');
    b.log('trial_start', start);
    b.log('trial_end', end);
    await s.flush();
    const events = (await outbox.sessionEvents(controller.snapshot.sessionId)) as EventEnvelope[];
    const flag = (id: string, type: string) =>
      events.find((e) => e.task?.trial_id === id && e.event_type === type)?.timing.interrupted;
    expect(flag('dont_tap.main.0', 'trial_start')).toBe(false);
    expect(flag('dont_tap.main.0', 'trial_end')).toBe(true);
    expect(flag('dont_tap.main.1', 'trial_start')).toBe(false);
    expect(flag('dont_tap.main.1', 'trial_end')).toBe(false);
    expect(events.some((e) => e.event_type === 'walkaway.prompted')).toBe(true);
    expect(errors).toEqual([]);
    controller.dispose();
  });
});
