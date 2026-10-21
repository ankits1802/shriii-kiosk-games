import { checkSessionSequence, validateEvent } from '@shriii/contracts';
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
import { isAbortError } from '../../core/contracts.ts';
import { physicalMetrics } from '../../input/metrics.ts';
import { ajvEventValidator } from '../../logging/event-logger.ts';
import { ScreenAbortedError } from '../../onboarding/ScreenKit.ts';
import { CALIBRATION_RULES, parseCalibrationRules } from '../calibration.ts';
import { SessionClock } from '../clock.ts';
import { loadGameContent } from '../content.ts';
import {
  HarnessParamError,
  moduleHarnessQuery,
  parseModuleHarnessParams,
  runModuleHarness,
  seedFromParam,
} from '../dev-harness.ts';
import { genericModuleFallback } from '../fallbacks/generic-module.ts';
import { SilentAudioService, SilentVoiceService } from '../fallbacks/silent-audio.ts';
import type { PlayServices } from '../module-host.ts';
import {
  GameModuleRegistry,
  ModuleRegistrationError,
  placeholderModules,
  plannedModulesFor,
  resolveModule,
} from '../registry.ts';
import { WrapUpController } from '../wrap-up.ts';

const content = loadGameContent();

function stub(id: GameModule['id']): GameModule {
  return {
    id,
    kind: 'micro',
    constructs: [],
    indicators: [],
    init: async () => undefined,
    run: async (): Promise<ModuleResult> => ({
      moduleId: id,
      endedReason: 'completed',
      durationMs: 0,
      trialsCompleted: 1,
      scorableTrials: 1,
      contextShiftIndex: null,
    }),
    destroy: () => undefined,
  };
}

describe('GameModuleRegistry (ENG-05)', () => {
  it('registers factories by id, rejects unknown ids and duplicates', () => {
    const r = new GameModuleRegistry();
    const changes: number[] = [];
    r.onChange((ids) => changes.push(ids.length));
    const undo = r.register('stall', () => stub('stall'));
    expect(r.has('stall')).toBe(true);
    expect(r.ids()).toEqual(['stall']);
    expect(() => r.register('stall', () => stub('stall'))).toThrow(ModuleRegistrationError);
    expect(() => r.register('nope' as 'stall', () => stub('stall'))).toThrow(/unknown module/);
    r.register('stall', () => stub('stall'), { replace: true });
    undo(); // stale undo does not remove the replacement
    expect(r.has('stall')).toBe(true);
    const undoAll = r.registerAll({ dont_tap: () => stub('dont_tap'), tower: () => stub('tower') });
    expect(Object.keys(r.toRecord()).sort()).toEqual(['dont_tap', 'stall', 'tower']);
    undoAll();
    expect(r.ids()).toEqual(['stall']);
    r.clear();
    expect(r.ids()).toEqual([]);
    expect(changes.at(-1)).toBe(0);
  });

  it('resolves registered modules, else the fallback; a broken factory falls back', () => {
    const r = new GameModuleRegistry({ balloon: () => stub('balloon') });
    const fb = (id: GameModule['id']) => stub(id);
    expect(resolveModule(r, 'balloon', fb)?.source).toBe('registered');
    expect(resolveModule(r, 'tower', fb)?.source).toBe('fallback');
    expect(resolveModule(r, 'tower')).toBeNull();
    // Plain-record registries work too.
    expect(resolveModule({ tower: () => stub('tower') }, 'tower', fb)?.source).toBe('registered');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    r.register('card_sort', () => stub('balloon'));
    r.register('share_pot', () => {
      throw new Error('broken');
    });
    expect(resolveModule(r, 'card_sort', fb)).toMatchObject({ source: 'fallback' });
    expect(resolveModule(r, 'share_pot', fb)?.module.id).toBe('share_pot');
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('plans Pathway A as stall -> weighing_post -> road_home and B as 5 core + slot', () => {
    expect(plannedModulesFor(content.plan, 'A', null)).toEqual([
      'stall',
      'weighing_post',
      'road_home',
    ]);
    const b = plannedModulesFor(content.plan, 'B', 'private_dice');
    expect(b).toEqual([...content.plan.pathways.B.core_order, 'private_dice']);
    expect(b).toHaveLength(6);
    expect(() => plannedModulesFor(content.plan, 'B', 'dont_tap' as 'private_dice')).toThrow(
      RangeError,
    );
    const r = new GameModuleRegistry({ stall: () => stub('stall') });
    expect(placeholderModules(r, plannedModulesFor(content.plan, 'A', null))).toEqual([
      'weighing_post',
      'road_home',
    ]);
  });
});

describe('WrapUpController', () => {
  it('requests once, notifies listeners (late ones immediately) and aborts its signal', () => {
    let t = 10;
    const c = new WrapUpController(() => t);
    const heard: string[] = [];
    c.signal.onRequest((r) => heard.push(`a:${r}`));
    const off = c.signal.onRequest((r) => heard.push(`b:${r}`));
    off();
    expect(c.signal.requested).toBe(false);
    t = 42;
    expect(c.request('soft_cap')).toBe(true);
    expect(c.request('session_time')).toBe(false);
    c.signal.onRequest((r) => heard.push(`late:${r}`));
    expect(heard).toEqual(['a:soft_cap', 'late:soft_cap']);
    expect(c.signal).toMatchObject({ requested: true, reason: 'soft_cap', requestedAtMs: 42 });
    expect(c.signal.signal.aborted).toBe(true);
  });
});

describe('isAbortError', () => {
  it('recognises typed, DOM, reason-object and legacy aborts but not real failures', () => {
    expect(isAbortError(new ScreenAbortedError())).toBe(true);
    expect(isAbortError(new DOMException('stop', 'AbortError'))).toBe(true);
    expect(isAbortError({ kind: 'walkaway' })).toBe(true);
    expect(isAbortError({ kind: 'time_cap' })).toBe(true);
    expect(isAbortError(new Error('aborted'))).toBe(true);
    expect(isAbortError('aborted')).toBe(true);
    expect(isAbortError({ isAbort: true })).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(new TypeError('x is undefined'))).toBe(false);
    expect(isAbortError({ kind: 'other' })).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(
      isAbortError(new Error('aborted prompts are not responses; log trial_end with outcome')),
    ).toBe(false);
  });
});

describe('calibration rules (content/games/shared/calibration.json)', () => {
  it('loads and validates the canonical content file', () => {
    expect(CALIBRATION_RULES.default_policy).toBe('fixed_L2_with_L1_fallback');
    expect(CALIBRATION_RULES.classifier.rules.length).toBeGreaterThan(0);
  });

  it('fails closed on malformed rules', () => {
    const good = JSON.parse(JSON.stringify(CALIBRATION_RULES)) as Record<string, unknown>;
    expect(() => parseCalibrationRules(good)).not.toThrow();
    expect(() => parseCalibrationRules({ ...good, fixed_level: 'L9' })).toThrow(/fixed_level/);
    expect(() => parseCalibrationRules({ ...good, default_policy: 'magic' })).toThrow(/policy/);
    expect(() =>
      parseCalibrationRules({
        ...good,
        classifier: {
          rules: [{ level: 'L1', when: { warmup_rt_ms_lt: 'fast' } }],
          otherwise: 'L2',
        },
      }),
    ).toThrow(/finite number/);
    expect(() =>
      parseCalibrationRules({
        ...good,
        classifier: { rules: [{ level: 'L1', when: { bogus: 1 } }], otherwise: 'L2' },
      }),
    ).toThrow(/unknown condition/);
    expect(() => parseCalibrationRules(null)).toThrow(TypeError);
  });
});

describe('module dev harness (ENG-05 AC: any module runs headlessly)', () => {
  it('parses ?module=<id>&level=L2&lang=en-IN&seed=123', () => {
    expect(parseModuleHarnessParams('?foo=1')).toBeNull();
    const p = parseModuleHarnessParams('?module=dont-tap&level=l3&lang=hi-IN&seed=123', content);
    expect(p).toEqual({
      moduleId: 'dont_tap',
      level: 'L3',
      language: 'hi-IN',
      seedHex: '000000000000007b',
      formId: null,
      pathway: 'B',
      bot: false,
      mode: 'pilot',
    });
    const a = parseModuleHarnessParams('module=road_home&bot=1&form=form_2', content);
    expect(a).toMatchObject({ pathway: 'A', bot: true, formId: 'form_2', level: 'L2' });
    expect(a?.language).toBe('en-IN');
    expect(() => parseModuleHarnessParams('?module=snake')).toThrow(HarnessParamError);
    expect(() => parseModuleHarnessParams('?module=tower&level=L5')).toThrow(/level/);
    expect(() => parseModuleHarnessParams('?module=tower&lang=fr-FR')).toThrow(/lang/);
    expect(() => parseModuleHarnessParams('?module=tower&seed=xyz')).toThrow(/seed/);
    expect(() => parseModuleHarnessParams('?module=tower&pathway=C')).toThrow(/pathway/);
  });

  it('maps seeds deterministically and round-trips the query', () => {
    expect(seedFromParam('0')).toBe('0000000000000000');
    expect(seedFromParam('0xff')).toBe('00000000000000ff');
    expect(seedFromParam('00c0ffee00c0ffee')).toBe('00c0ffee00c0ffee');
    expect(seedFromParam('18446744073709551615')).toBe('ffffffffffffffff');
    expect(() => seedFromParam('18446744073709551616')).toThrow(/64 bits/);
    const q = moduleHarnessQuery({
      moduleId: 'balloon',
      level: 'L1',
      language: 'ta-IN',
      seed: 7,
      bot: true,
    });
    expect(parseModuleHarnessParams(q, content)).toMatchObject({
      moduleId: 'balloon',
      level: 'L1',
      language: 'ta-IN',
      seedHex: '0000000000000007',
      bot: true,
    });
  });

  describe('runModuleHarness', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function services(clock: SessionClock): PlayServices {
      const layout: Layout = {
        width: 1920,
        height: 1080,
        safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
        orientation: 'landscape',
        metrics: physicalMetrics(),
        onChange: () => () => undefined,
      };
      return {
        app: {} as Application,
        layout,
        audio: new SilentAudioService(clock),
        voice: new SilentVoiceService(clock),
        input: { setLogger: () => undefined } as unknown as InputService,
        art: {} as ArtKit,
        createStage: () => ({}) as Container,
        releaseStage: () => undefined,
      };
    }

    function clock(): SessionClock {
      return new SessionClock({
        anchorPerfMs: Date.now(),
        platform: {
          perfNow: () => Date.now(),
          wallNow: () => Date.now(),
          requestFrame: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
        },
      });
    }

    it('runs a registered module standalone with a synthetic, valid event stream', async () => {
      const seen: ModuleContext[] = [];
      const registry = new GameModuleRegistry({
        tower: () => ({
          ...stub('tower'),
          init: async (ctx: ModuleContext) => {
            seen.push(ctx);
          },
        }),
      });
      const c = clock();
      const params = parseModuleHarnessParams(
        '?module=tower&level=L1&lang=mr-IN&seed=123',
        content,
      );
      if (!params) throw new Error('params');
      const run = runModuleHarness(params, {
        content,
        registry,
        services: services(c),
        clock: c,
        validate: ajvEventValidator(validateEventEnvelope),
      });
      const r = await run.result;
      expect(r).toMatchObject({ moduleId: 'tower', endedReason: 'completed' });
      expect(run.source()).toBe('registered');
      expect(seen[0]).toMatchObject({ level: 'L1', language: 'mr-IN' });
      expect(seen[0]?.rng.seedHex).toBe('000000000000007b');
      expect(seen[0]?.rng.streamName).toBe('session.tower');
      expect(seen[0]?.dev.headless).toBe(false);
      const ev = await run.events();
      expect(ev.map((e) => e.event_type)).toEqual([
        'session_start',
        'module_start',
        'module_end',
        'session_end',
      ]);
      expect(ev.every((e) => e.context.synthetic)).toBe(true);
      expect(checkSessionSequence(ev)).toEqual([]);
      for (const e of ev) expect(validateEvent(e).ok, e.event_type).toBe(true);
    });

    it('falls back to the placeholder module for unregistered ids (bot mode)', async () => {
      const c = clock();
      const params = parseModuleHarnessParams('?module=steady_hands&seed=9&bot=1', content);
      if (!params) throw new Error('params');
      const run = runModuleHarness(params, {
        content,
        registry: new GameModuleRegistry(),
        fallback: genericModuleFallback(content),
        services: services(c),
        clock: c,
      });
      await vi.advanceTimersByTimeAsync(130_000);
      const r = await run.result;
      expect(r.endedReason).toBe('completed');
      expect(run.source()).toBe('fallback');
      const ev = await run.events();
      expect(ev.filter((e) => e.event_type === 'response').length).toBeGreaterThan(0);
      expect(checkSessionSequence(ev)).toEqual([]);
    }, 30_000);

    it('abort() ends the module with explicit_exit', async () => {
      const c = clock();
      const params = parseModuleHarnessParams('?module=balloon&bot=1', content);
      if (!params) throw new Error('params');
      const run = runModuleHarness(params, {
        content,
        registry: {},
        fallback: genericModuleFallback(content),
        services: services(c),
        clock: c,
        abortGraceMs: 100,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      run.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await run.result).endedReason).toBe('explicit_exit');
      expect((await run.events()).at(-1)?.payload).toMatchObject({ reason: 'abandoned' });
    });
  });
});
