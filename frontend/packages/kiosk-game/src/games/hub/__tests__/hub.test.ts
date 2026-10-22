import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleResult } from '../../../core/contracts.ts';
import type { ModuleRunRequest } from '../../../engine/module-host.ts';
import { plannedModulesFor } from '../../../engine/registry.ts';
import { createSessionRng } from '../../../engine/rng.ts';
import { bridgeBudgetMs, CarouselHubRunner, carouselOrder } from '../CarouselHubRunner.ts';
import { set2ModuleFactories } from '../modules.ts';
import { content, runHeadless } from './headless.ts';

describe('carousel order and bridge budget (MG-10)', () => {
  it('follows the fixed core order plus the session slot, identical to the session plan', () => {
    for (const slot of content.plan.pathways.B.slot_candidates) {
      const order = carouselOrder(content.plan, slot);
      expect(order).toEqual(plannedModulesFor(content.plan, 'B', slot as never));
      expect(order).toHaveLength(6);
      expect(order.slice(0, 5)).toEqual(['dont_tap', 'card_sort', 'balloon', 'tower', 'share_pot']);
    }
  });

  it('keeps every bridge <= 5 s and all bridges within the 30 s segment budget', () => {
    const per = bridgeBudgetMs(content.plan, 6);
    expect(per).toBeLessThanOrEqual(5000);
    expect(per * 6).toBeLessThanOrEqual(content.plan.segments_max_s.bridges * 1000);
  });

  it('registers factories for the four set-2 modules', () => {
    const f = set2ModuleFactories();
    expect(Object.keys(f).sort()).toEqual([
      'four_stalls',
      'private_dice',
      'share_pot',
      'steady_hands',
    ]);
    for (const [id, make] of Object.entries(f)) {
      const m = make?.();
      expect(m?.id).toBe(id);
      expect(m?.kind).toBe('micro');
      // Declared constructs and indicators match the content config (ENG-08).
      const cfg = content.get(id as never);
      expect([...(m?.constructs ?? [])].sort()).toEqual([...cfg.constructs].sort());
      expect([...(m?.indicators ?? [])].sort()).toEqual([...cfg.indicators].sort());
      m?.destroy();
    }
  });
});

describe('CarouselHubRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function request(
    moduleId: ModuleRunRequest['moduleId'],
    pathway: 'A' | 'B',
    signal = new AbortController().signal,
  ): ModuleRunRequest {
    return {
      moduleId,
      level: 'L2',
      language: 'en-IN',
      logger: undefined as never,
      rng: createSessionRng('0000000000000001'),
      clock: { now: () => 0, delay: () => Promise.resolve() } as never,
      session: {
        sessionId: 's1',
        pathway,
        mode: 'pilot',
        siteMode: 'supervised',
        formId: 'form_1',
        slotForm: 'four_stalls',
        headset: false,
        slowPace: false,
      },
      signal,
    };
  }

  it('passes every module to the inner runner, bridging only Pathway B carousel modules', async () => {
    const ran: string[] = [];
    const bridges: string[] = [];
    const inner = {
      run: async (r: ModuleRunRequest): Promise<ModuleResult> => {
        ran.push(r.moduleId);
        return {
          moduleId: r.moduleId,
          endedReason: 'completed',
          durationMs: 0,
          trialsCompleted: 0,
          scorableTrials: 0,
          contextShiftIndex: null,
        };
      },
    };
    const hub = new CarouselHubRunner({
      inner,
      services: {
        app: {},
        layout: undefined as never,
        art: undefined as never,
        audio: undefined as never,
        voice: undefined as never,
        createStage: () => undefined as never,
        releaseStage: () => undefined,
      },
      plan: content.plan,
      onBridge: (b) => bridges.push(`${b.to}:${b.phase}`),
    });
    await hub.run(request('share_pot', 'B'));
    await hub.run(request('four_stalls', 'B'));
    await hub.run(request('stall', 'A'));
    await hub.run(request('warmup', 'B'));
    expect(ran).toEqual(['share_pot', 'four_stalls', 'stall', 'warmup']);
    expect(bridges).toEqual([
      'share_pot:start',
      'share_pot:end',
      'four_stalls:start',
      'four_stalls:end',
    ]);
  });

  it('runs a real Share-the-Pot -> slot session behind the hub headlessly', async () => {
    const run = await runHeadless({
      modules: ['share_pot', 'private_dice'],
      seed: '0000000000000901',
      hub: true,
    });
    expect(run.results.map((r) => r.endedReason)).toEqual(['completed', 'completed']);
    const starts = run.events
      .filter((e) => e.event_type === 'module_start')
      .map((e) => (e.payload as { module_id: string }).module_id);
    expect(starts).toEqual(['share_pot', 'private_dice']);
  });

  it('plays all four set-2 modules end to end on a portrait (1080 x 1920) kiosk', async () => {
    const run = await runHeadless({
      modules: ['share_pot', 'steady_hands', 'four_stalls', 'private_dice'],
      seed: '0000000000000907',
      width: 1080,
      height: 1920,
    });
    for (const r of run.results) expect(r.endedReason).not.toBe('error');
    expect(run.invalidEvents).toBe(0);
  });
});
