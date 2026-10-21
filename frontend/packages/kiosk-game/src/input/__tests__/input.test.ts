import type { EventEnvelope } from '@shriii/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toResponsePayload } from '../../core/contracts.ts';
import { SessionClock } from '../../engine/clock.ts';
import { SilentVoiceService } from '../../engine/fallbacks/silent-audio.ts';
import { testLogger } from '../../logging/__tests__/helpers.ts';
import { MemoryOutbox } from '../../logging/outbox/memory-outbox.ts';
import {
  DomInputService,
  type PointerSample,
  sayOrTouchTargetId,
  TargetSizeError,
} from '../input-service.ts';
import { physicalMetrics } from '../metrics.ts';
import { ScriptedSpeechInput } from '../speech.ts';

const metrics = physicalMetrics(4); // 4 px/mm: 80 px min target, 32 px spacing

function setup(opts: { speech?: ScriptedSpeechInput; voiceMs?: number } = {}) {
  const clock = new SessionClock({
    anchorPerfMs: 0,
    platform: { perfNow: () => Date.now(), wallNow: () => Date.now() },
  });
  const outbox = new MemoryOutbox({ kioskId: 'kiosk-test' });
  const logger = testLogger(outbox);
  const voice = new SilentVoiceService(clock, { lineMs: opts.voiceMs ?? 0 });
  const input = new DomInputService({
    clock,
    metrics,
    strictTargets: true,
    stageSize: () => ({ width: 1000, height: 1000 }),
    logger,
    voice,
    speech: opts.speech ?? null,
  });
  const tap = (x: number, y: number, extra: Partial<PointerSample> = {}): void => {
    const t = Date.now();
    input.inject({
      kind: 'down',
      pointerId: extra.pointerId ?? 1,
      clientX: x,
      clientY: y,
      timeStamp: t,
      pointerType: 'touch',
      ...extra,
    });
    if (extra.kind === undefined)
      input.inject({
        kind: 'up',
        pointerId: extra.pointerId ?? 1,
        clientX: x,
        clientY: y,
        timeStamp: t + 1,
        pointerType: 'touch',
      });
  };
  const events = async (): Promise<EventEnvelope[]> => {
    await logger.flush();
    return (await outbox.sessionEvents(logger.sessionId)) as EventEnvelope[];
  };
  return { clock, input, tap, events };
}

describe('DomInputService (ENG-06, KSK-05)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => vi.useRealTimers());

  it('enforces 20 mm targets and 8 mm spacing in dev', () => {
    const { input } = setup();
    expect(() =>
      input.registerTarget({
        id: 'small',
        bounds: { x: 0, y: 0, width: 60, height: 100 },
        audioKey: 'a',
        kind: 'tap',
      }),
    ).toThrow(TargetSizeError);
    input.registerTarget({
      id: 'a',
      bounds: { x: 0, y: 0, width: 80, height: 80 },
      audioKey: 'a',
      kind: 'tap',
    });
    expect(() =>
      input.registerTarget({
        id: 'b',
        bounds: { x: 100, y: 0, width: 80, height: 80 },
        audioKey: 'b',
        kind: 'tap',
      }),
    ).toThrow(/8 mm/);
    expect(() =>
      input.registerTarget({
        id: 'c',
        bounds: { x: 120, y: 0, width: 80, height: 80 },
        audioKey: 'c',
        kind: 'tap',
      }),
    ).not.toThrow();
    // A full-screen layer containing other targets is allowed.
    expect(() =>
      input.registerTarget({
        id: 'bg',
        bounds: { x: 0, y: 0, width: 1000, height: 1000 },
        audioKey: 'bg',
        kind: 'tap',
      }),
    ).not.toThrow();
  });

  it('measures latency from the anchor, records premature and extra taps, never debounced', async () => {
    const { clock, input, tap, events } = setup();
    input.registerTarget({
      id: 'go',
      bounds: { x: 400, y: 600, width: 200, height: 200 },
      audioKey: 'go',
      kind: 'tap',
    });
    const anchor = clock.now() + 100;
    const wait = input.waitForTap(['go'], { anchorMs: anchor, windowMs: 1000 });
    tap(500, 700); // before the anchor: premature, does not resolve
    vi.advanceTimersByTime(350);
    tap(10, 10); // off target
    tap(500, 700);
    const r = await wait;
    expect(r.kind).toBe('tap');
    if (r.kind === 'tap') {
      expect(r.latencyMs).toBe(250);
      expect(r.tap.xyNorm).toEqual([0.5, 0.7]);
    }
    tap(500, 700); // extra
    const raw = (await events())
      .filter((e) => e.event_type === 'input.raw_tap')
      .map((e) => e.payload as { classification: string; anchor_offset_ms: number | null });
    expect(raw.map((p) => p.classification)).toEqual([
      'premature',
      'off_target',
      'on_target',
      'extra',
    ]);
    expect(raw[0]?.anchor_offset_ms).toBe(-100);
    expect(raw[3]?.anchor_offset_ms).toBe(250);
  });

  it('times out at anchor + window and supports abort', async () => {
    const { clock, input } = setup();
    input.registerTarget({
      id: 'go',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      audioKey: 'go',
      kind: 'tap',
    });
    const t = input.waitForTap(['go'], { anchorMs: clock.now(), windowMs: 540 });
    vi.advanceTimersByTime(540);
    expect(await t).toEqual({ kind: 'timeout' });
    const ac = new AbortController();
    const a = input.waitForTap(['go'], {
      anchorMs: clock.now(),
      windowMs: null,
      signal: ac.signal,
    });
    ac.abort({ kind: 'walkaway' });
    expect(await a).toEqual({ kind: 'aborted' });
  });

  it('filters palm contacts and flags multi-touch interference', async () => {
    const { input, tap, events } = setup();
    input.registerTarget({
      id: 'go',
      bounds: { x: 0, y: 0, width: 500, height: 500 },
      audioKey: 'go',
      kind: 'tap',
    });
    tap(100, 100, { width: 200, height: 200 }); // 50 mm contact
    input.inject({
      kind: 'down',
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      timeStamp: Date.now(),
      pointerType: 'touch',
    });
    input.inject({
      kind: 'down',
      pointerId: 2,
      clientX: 200,
      clientY: 200,
      timeStamp: Date.now(),
      pointerType: 'touch',
    });
    const cls = (await events())
      .filter((e) => e.event_type === 'input.raw_tap')
      .map((e) => (e.payload as { classification: string }).classification);
    expect(cls).toEqual(['filtered_palm', 'on_target', 'multi_touch_interference']);
  });

  it('detects holds and logs input.hold', async () => {
    const { input, events } = setup();
    input.registerTarget({
      id: 'h',
      bounds: { x: 0, y: 0, width: 200, height: 200 },
      audioKey: 'h',
      kind: 'hold',
    });
    const p = input.waitForHold('h', { requiredMs: 1200, windowMs: 3000 });
    vi.advanceTimersByTime(500);
    input.inject({
      kind: 'down',
      pointerId: 3,
      clientX: 50,
      clientY: 50,
      timeStamp: Date.now(),
      pointerType: 'touch',
    });
    vi.advanceTimersByTime(4000); // window only bounds the start of the hold
    input.inject({
      kind: 'up',
      pointerId: 3,
      clientX: 50,
      clientY: 50,
      timeStamp: Date.now(),
      pointerType: 'touch',
    });
    const r = await p;
    expect(r).toMatchObject({ kind: 'hold', holdMs: 4000, completed: true });
    const hold = (await events()).find((e) => e.event_type === 'input.hold');
    expect(hold?.payload).toMatchObject({ hold_ms: 4000, required_hold_ms: 1200, completed: true });
  });

  it('SayOrTouch: icon touch with revisions and confirm', async () => {
    const { input, tap, events } = setup();
    const id = (c: string) => sayOrTouchTargetId('tone', c);
    input.registerTarget({
      id: id('warm'),
      bounds: { x: 0, y: 600, width: 200, height: 200 },
      audioKey: 'w',
      kind: 'tap',
    });
    input.registerTarget({
      id: id('firm'),
      bounds: { x: 400, y: 600, width: 200, height: 200 },
      audioKey: 'f',
      kind: 'tap',
    });
    input.registerTarget({
      id: id('confirm'),
      bounds: { x: 800, y: 600, width: 200, height: 200 },
      audioKey: 'c',
      kind: 'tap',
    });
    const p = input.sayOrTouch({
      promptId: 'tone',
      options: [
        { code: 'warm', iconId: 'smile', audioKey: 'w' },
        { code: 'firm', iconId: 'firm', audioKey: 'f' },
      ],
      windowMs: 5000,
      latencyAnchor: 'visual_onset',
      allowRevisions: true,
      requireConfirm: true,
      privateReport: false,
    });
    vi.advanceTimersByTime(300);
    tap(100, 700);
    vi.advanceTimersByTime(300);
    tap(500, 700);
    vi.advanceTimersByTime(400);
    tap(900, 700);
    const r = await p;
    expect(r).toMatchObject({
      kind: 'response',
      value: 'firm',
      inputMode: 'touch',
      latencyMs: 1000,
      bargeIn: false,
      tapCount: 3,
    });
    expect(r.revisions.map((x) => x.value)).toEqual(['warm', 'firm']);
    const payload = toResponsePayload(r, {
      stimulusId: null,
      correctness: null,
      latencyAnchor: 'visual_onset',
    });
    expect(payload.input_mode).toBe('touch');
    const types = (await events()).map((e) => e.event_type);
    expect(types.filter((t) => t.startsWith('prompt_window'))).toEqual([
      'prompt_window_open',
      'prompt_window_close',
    ]);
  });

  it('SayOrTouch: barge-in during a spoken prompt yields negative latency', async () => {
    const { input, tap } = setup({ voiceMs: 2000 });
    input.registerTarget({
      id: sayOrTouchTargetId('q', 'yes'),
      bounds: { x: 0, y: 0, width: 200, height: 200 },
      audioKey: 'y',
      kind: 'tap',
    });
    const p = input.sayOrTouch({
      promptId: 'q',
      options: [{ code: 'yes', iconId: 'tick', audioKey: 'y' }],
      promptLine: 'q.prompt',
      windowMs: 4000,
      latencyAnchor: 'audio_end',
      allowRevisions: false,
      requireConfirm: false,
      privateReport: false,
    });
    vi.advanceTimersByTime(500);
    tap(50, 50);
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(r).toMatchObject({ kind: 'response', value: 'yes', latencyMs: -1500, bargeIn: true });
  });

  it('SayOrTouch: optional voice proposes a code; private reports never use voice', async () => {
    const speech = new ScriptedSpeechInput();
    speech.answer('d', 'now', 0.93, 200);
    speech.answer('p', 'face_3', 0.9, 100);
    const { input } = setup({ speech });
    const voiced = input.sayOrTouch({
      promptId: 'd',
      options: [
        { code: 'now', iconId: 'sun', audioKey: 'n' },
        { code: 'wait', iconId: 'moon', audioKey: 'w' },
      ],
      voiceCodes: ['now', 'wait'],
      windowMs: 3000,
      latencyAnchor: 'visual_onset',
      allowRevisions: false,
      requireConfirm: false,
      privateReport: false,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(await voiced).toMatchObject({
      kind: 'response',
      value: 'now',
      inputMode: 'voice',
      asrLabel: 'now',
      asrConfidence: 0.93,
    });
    const priv = input.sayOrTouch({
      promptId: 'p',
      options: [{ code: 'face_3', iconId: 'die3', audioKey: 'x' }],
      voiceCodes: ['face_3'],
      windowMs: 1000,
      latencyAnchor: 'visual_onset',
      allowRevisions: false,
      requireConfirm: false,
      privateReport: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await priv).toMatchObject({ kind: 'timeout', inputMode: 'timeout', latencyMs: null });
  });

  it('notifies timed windows (walkaway suspension) and activity', async () => {
    const { clock, input, tap } = setup();
    const windows: boolean[] = [];
    let activity = 0;
    input.onWindowChange((o) => windows.push(o));
    input.onActivity(() => (activity += 1));
    input.registerTarget({
      id: 'go',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      audioKey: 'go',
      kind: 'tap',
    });
    const w = input.waitForTap(['go'], { anchorMs: clock.now(), windowMs: 1000 });
    tap(50, 50);
    await w;
    expect(windows).toEqual([true, false]);
    expect(activity).toBe(1);
    expect(input.lastInteractionMs).toBe(clock.now());
  });
});
