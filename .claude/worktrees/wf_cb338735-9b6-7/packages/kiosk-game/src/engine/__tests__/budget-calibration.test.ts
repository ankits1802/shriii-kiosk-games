import type { EventEnvelope } from '@shriii/contracts';
import { describe, expect, it } from 'vitest';
import { assignForm, MemoryKeyValueStore, PermutedBlockAssigner } from '../assignment.ts';
import {
  checkSessionBudget,
  estimateModuleDurationMs,
  simulateSessionTimeline,
} from '../budget.ts';
import {
  CALIBRATION_RULES,
  CalibrationLock,
  decideCalibration,
  warmupMetricsFromEvents,
} from '../calibration.ts';
import { buildGameContent, ContentBundleError, loadGameContent } from '../content.ts';
import { createSessionRng } from '../rng.ts';

const content = loadGameContent();
const plan = content.plan;

describe('content bundle', () => {
  it('loads and validates every config with a stable bundle hash', () => {
    expect(content.configs.size).toBe(14);
    expect(content.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(loadGameContent().bundleHash).toBe(content.bundleHash);
  });

  it('refuses an invalid bundle and reports the path', () => {
    const broken = structuredClone(content.get('balloon')) as unknown as Record<string, unknown>;
    broken.requires_numeracy = true;
    expect(() => buildGameContent(plan, [['pathway-b/balloon.json', broken]])).toThrow(
      ContentBundleError,
    );
    try {
      buildGameContent(plan, [['pathway-b/balloon.json', broken]]);
    } catch (e) {
      expect((e as ContentBundleError).issues.join()).toContain(
        'pathway-b/balloon.json/requires_numeracy',
      );
    }
  });
});

describe('ONB-08 session budget', () => {
  it('passes every static plan §4.4 check', () => {
    expect(checkSessionBudget(content)).toEqual([]);
  });

  it('flags a module that breaks its budget', () => {
    const slow = structuredClone(content.get('dont_tap'));
    slow.budget.hard_cap_ms = 70_000;
    slow.budget.soft_cap_ms = 69_000;
    const raw = [...content.configs.values()].map(
      (c) => [c.module_id, c.module_id === 'dont_tap' ? slow : c] as const,
    );
    const v = checkSessionBudget(buildGameContent(plan, raw));
    expect(v.some((x) => x.path.startsWith('dont_tap'))).toBe(true);
  });

  it('every B module lasts 60-120 s at every level (median and trimmed slow bot)', () => {
    for (const id of [...plan.pathways.B.core_order, ...plan.pathways.B.slot_candidates]) {
      const c = content.get(id as 'dont_tap');
      for (const level of ['L1', 'L2', 'L3'] as const) {
        for (const ms of [
          estimateModuleDurationMs(c, level, 'median'),
          estimateModuleDurationMs(c, level, 'slow', true),
        ]) {
          expect(ms).toBeGreaterThanOrEqual(plan.b_module_duration_s.min * 1000);
          expect(ms).toBeLessThanOrEqual(plan.b_module_duration_s.max * 1000);
        }
      }
    }
  });

  it('1,000 slow-bot sessions at L1 stay within the 900 s cap on both pathways', () => {
    const slots = plan.pathways.B.slot_candidates;
    for (let i = 0; i < 1000; i += 1) {
      const rng = createSessionRng(i.toString(16).padStart(16, '0'));
      const pathway = i % 5 === 4 ? 'A' : 'B';
      const t = simulateSessionTimeline(content, {
        pathway,
        slot: pathway === 'B' ? (slots[i % slots.length] ?? null) : null,
        level: 'L1',
        bot: 'slow',
        rng,
        jitter: 0.15,
      });
      expect(t.totalS).toBeLessThanOrEqual(plan.session_cap_s);
      // Minimums are protected even when the soft cap trims optional trials.
      for (const m of t.modules) {
        const cfg = content.get(m.id as 'dont_tap');
        expect(m.hitHardCap).toBe(false);
        for (const b of cfg.blocks)
          expect(m.trialsPerBlock[b.block_id]).toBeGreaterThanOrEqual(b.min_trials);
      }
    }
  });

  it('median bot: onboarding <= 90 s, warm-up <= 60 s, scored play 540-630 s', () => {
    for (const [pathway, slot] of [
      ['B', 'wait_or_now'],
      ['B', 'private_dice'],
      ['A', null],
    ] as const) {
      const t = simulateSessionTimeline(content, {
        pathway,
        slot,
        level: 'L2',
        bot: 'median',
        rng: createSessionRng('00000000000000aa'),
        jitter: 0,
      });
      expect(t.onboardingS).toBeLessThanOrEqual(plan.segments_max_s.onboarding);
      expect(t.warmupS).toBeLessThanOrEqual(plan.segments_max_s.practice_warmup);
      expect(t.scoredPlayS).toBeGreaterThanOrEqual(plan.scored_play_median_s.min);
      expect(t.scoredPlayS).toBeLessThanOrEqual(plan.scored_play_median_s.max);
    }
  });
});

describe('calibration (ENG-10)', () => {
  const base = {
    practiceStruggle: false,
    slowPace: false,
    warmupRtMs: 400,
    warmupAccuracy: 0.98,
  } as const;

  it('pilot policy: L2 unless practice struggle or a11y slow pace', () => {
    expect(decideCalibration({ ...base, policy: 'fixed_L2_with_L1_fallback' })).toEqual({
      level: 'L2',
      policy: 'fixed_L2_with_L1_fallback',
      reason: 'default',
    });
    // Fast and accurate players still get L2 under the pilot policy.
    expect(
      decideCalibration({ ...base, policy: 'fixed_L2_with_L1_fallback', warmupRtMs: 200 }).level,
    ).toBe('L2');
    expect(
      decideCalibration({ ...base, policy: 'fixed_L2_with_L1_fallback', practiceStruggle: true }),
    ).toMatchObject({
      level: 'L1',
      reason: 'practice_struggle',
    });
    expect(
      decideCalibration({ ...base, policy: 'fixed_L2_with_L1_fallback', slowPace: true }),
    ).toMatchObject({
      level: 'L1',
      reason: 'a11y_choice',
    });
  });

  it('classifier policy follows the rules file', () => {
    const fast = CALIBRATION_RULES.classifier.rules.find((r) => r.level === 'L3');
    expect(fast).toBeDefined();
    expect(
      decideCalibration({ ...base, policy: 'classifier', warmupRtMs: 300, warmupAccuracy: 1 })
        .level,
    ).toBe('L3');
    expect(decideCalibration({ ...base, policy: 'classifier', warmupRtMs: 1200 }).level).toBe('L1');
    expect(
      decideCalibration({ ...base, policy: 'classifier', warmupRtMs: 600, warmupAccuracy: 0.9 })
        .level,
    ).toBe('L2');
  });

  it('forced and retest-locked policies', () => {
    expect(decideCalibration({ ...base, policy: 'forced', forcedLevel: 'L3' })).toMatchObject({
      level: 'L3',
      reason: 'forced',
    });
    expect(
      decideCalibration({ ...base, policy: 'retest_locked', retestLevel: 'L1', slowPace: true }),
    ).toMatchObject({
      level: 'L1',
      reason: 'retest_lock',
    });
    expect(() => decideCalibration({ ...base, policy: 'forced' })).toThrow();
  });

  it('locks exactly one level per session', () => {
    const lock = new CalibrationLock();
    lock.lock({ level: 'L2', policy: 'fixed_L2_with_L1_fallback', reason: 'default' });
    expect(() =>
      lock.lock({ level: 'L1', policy: 'fixed_L2_with_L1_fallback', reason: 'practice_struggle' }),
    ).toThrow();
    expect(lock.current?.level).toBe('L2');
  });

  it('derives practice struggle from warm-up events', () => {
    const warm = content.get('warmup');
    const ev = (
      block: string,
      type: 'response' | 'input.hold',
      ok: boolean,
      latency = 500,
    ): EventEnvelope =>
      ({
        event_type: type,
        task: { module_id: 'warmup', block_id: block },
        payload:
          type === 'response'
            ? { correctness: ok, latency_ms: latency }
            : { completed: ok, hold_ms: ok ? 1300 : 300, required_hold_ms: 1200, target_id: 'x' },
      }) as unknown as EventEnvelope;
    const good = [
      ev('tap', 'response', true),
      ev('tap', 'response', true),
      ev('hold', 'input.hold', true),
      ev('hold', 'input.hold', true),
      ev('choice', 'response', true),
      ev('choice', 'response', true),
    ];
    const m = warmupMetricsFromEvents(good, warm);
    expect(m.summary.practice_struggle).toBe(false);
    expect(m.summary.skills.every((s) => s.completed)).toBe(true);
    expect(m.warmupRtMs).toBe(500);
    const struggling = [
      ...good.slice(0, 2),
      ...Array.from({ length: 4 }, () => ev('hold', 'input.hold', false)),
      ...good.slice(4),
    ];
    const s = warmupMetricsFromEvents(struggling, warm);
    expect(s.summary.practice_struggle).toBe(true);
    expect(s.summary.hold_accuracy).toBe(0);
  });
});

describe('assignment', () => {
  it('balances slot forms exactly within each block of 4 committed sessions', () => {
    const store = new MemoryKeyValueStore();
    const slots = ['wait_or_now', 'steady_hands', 'four_stalls', 'private_dice'] as const;
    const a = new PermutedBlockAssigner({
      store,
      kioskSeedHex: '0f0f0f0f0f0f0f0f',
      name: 'slot',
      values: slots,
      blockSize: 4,
    });
    const seen: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const p = a.peek();
      // An uncommitted (declined) session does not consume the slot.
      if (i % 3 === 0) expect(a.peek()).toEqual(p);
      a.commit(p);
      seen.push(p.value);
    }
    for (let b = 0; b < 10; b += 1) expect(new Set(seen.slice(b * 4, b * 4 + 4)).size).toBe(4);
    // Reproducible from the kiosk seed.
    const again = new PermutedBlockAssigner({
      store: new MemoryKeyValueStore(),
      kioskSeedHex: '0f0f0f0f0f0f0f0f',
      name: 'slot',
      values: slots,
      blockSize: 4,
    });
    expect(again.block(3)).toEqual(a.block(3));
  });

  it('draws the parallel form from the session seed', () => {
    const forms = new Set<string>();
    for (let i = 0; i < 64; i += 1)
      forms.add(assignForm(createSessionRng(i.toString(16).padStart(16, '0'))));
    expect(forms).toEqual(new Set(['form_1', 'form_2']));
    expect(assignForm(createSessionRng('0000000000000001'))).toBe(
      assignForm(createSessionRng('0000000000000001')),
    );
  });
});
