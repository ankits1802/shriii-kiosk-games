/**
 * ProceduralCharacter on the articulated rig: backwards-compatible Character API, gestures and holds,
 * locomotion with ground-locked feet, views, held items, lip-sync from playback amplitude, the Stall
 * anger ladder, and the per-frame CPU budget (<= 2 ms for 12 characters).
 */
import '../../../onboarding/__tests__/canvasStub.ts';
import { Container, Ticker } from 'pixi.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Character, VoicePlayback, VoicePlaybackResult } from '../../../core/contracts.ts';
import { Lighting } from '../../lighting.ts';
import { motionSettings } from '../../motion.ts';
import { qualityProfile } from '../../quality.ts';
import { TextureCache } from '../../textures.ts';
import { ProceduralCharacter, type RigCharacterSpec } from '../ProceduralCharacter.ts';
import { GESTURE_NAMES } from '../rig/gestures.ts';

function deps(): ConstructorParameters<typeof ProceduralCharacter>[1] {
  const ticker = new Ticker();
  ticker.autoStart = false;
  ticker.stop();
  return {
    ticker,
    lighting: new Lighting(),
    quality: qualityProfile({ tier: 'medium', reducedMotion: false }),
    cache: new TextureCache(null),
  };
}

function make(spec: Partial<RigCharacterSpec> = {}): ProceduralCharacter {
  return new ProceduralCharacter({ id: 'c', role: 'customer', variant: 0, ...spec }, deps());
}

/** Advance until `p` settles or `seconds` elapse. */
async function run(c: ProceduralCharacter, p: Promise<void>, seconds: number): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  for (let t = 0; t < seconds && !done; t += 1 / 60) {
    c.advance(1 / 60);
    await Promise.resolve();
  }
  await Promise.resolve();
  return done;
}

function playback(amplitude?: () => number): { pb: VoicePlayback; end: () => void } {
  let resolveEnd: (r: VoicePlaybackResult) => void = () => undefined;
  const ended = new Promise<VoicePlaybackResult>((r) => {
    resolveEnd = r;
  });
  const pb: VoicePlayback & { amplitude?: () => number } = {
    lineId: 'x',
    started: Promise.resolve(0),
    ended,
    interrupt: () => undefined,
    ...(amplitude ? { amplitude } : {}),
  };
  return {
    pb,
    end: () =>
      resolveEnd({
        lineId: 'x',
        language: 'en-IN',
        status: 'completed',
        onsetMs: 0,
        endMs: 1,
        durationMs: 1,
        output: 'speaker',
        manifestVersion: 'dev',
        sha256: null,
        placeholder: true,
      } as unknown as VoicePlaybackResult),
  };
}

afterEach(() => {
  motionSettings.timeScale = 1;
});

describe('ProceduralCharacter (rig)', () => {
  it('implements the contract Character API with a wave-1 spec', async () => {
    const c: Character = make({ facing: 'left', scale: 0.8 });
    expect(c.view).toBeInstanceOf(Container);
    expect(c.view.scale.x).toBeCloseTo(-0.8, 6);
    c.setExpression('happy');
    c.lookAt({ x: 10, y: -100 });
    expect(await run(c as ProceduralCharacter, c.play('nod'), 3)).toBe(true);
    c.destroy();
    c.destroy();
  });

  it('plays every gesture to completion (holds resolve on reaching the pose)', async () => {
    for (const name of GESTURE_NAMES) {
      const c = make({ id: name });
      expect(await run(c, c.play(name), 6), name).toBe(true);
      if (name === 'fold_arms' || name === 'carry_on_head' || name === 'steer_cart')
        expect(c.activeGesture, name).toBe(name);
      c.destroy();
    }
  }, 30000);

  it('holds stay until released, then blend back to the stance', async () => {
    const c = make();
    await run(c, c.play('fold_arms'), 3);
    for (let i = 0; i < 300; i++) c.advance(1 / 60);
    expect(c.activeGesture).toBe('fold_arms');
    expect(await run(c, c.stopGesture(), 3)).toBe(true);
    expect(c.activeGesture).toBeNull();
  });

  it('fires gesture events (hand-over gives, receive takes)', async () => {
    const c = make();
    const events: string[] = [];
    await run(c, c.play('hand_over', { onEvent: (e) => events.push(e) }), 4);
    await run(c, c.play('receive', { onEvent: (e) => events.push(e) }), 4);
    expect(events).toEqual(['give', 'take']);
  });

  it('walks in from behind, turning to profile and back to its resting view', async () => {
    const c = make({ view: 'front' });
    const p = c.play('walk_in');
    c.advance(0.3);
    expect(c.activeGait).toBe('walk');
    expect(await run(c, p, 8)).toBe(true);
    for (let i = 0; i < 30; i++) c.advance(1 / 60);
    expect(c.currentView).toBe('front');
    expect(c.view.alpha).toBe(1);
    expect(await run(c, c.play('walk_out'), 8)).toBe(true);
    expect(c.view.alpha).toBe(0);
  });

  it('walkTo moves the view to the destination and faces it', async () => {
    const c = make({ scale: 0.5 });
    c.view.x = 100;
    expect(await run(c, c.walkTo(-50, { gait: 'run' }), 6)).toBe(true);
    expect(c.view.x).toBeCloseTo(-50, 0);
    expect(c.facing).toBe('left');
  });

  it('keeps the feet on the ground: hips drop at contact and rise when passing', () => {
    const c = make({ view: 'side' });
    c.showGaitFrame('walk', 0);
    const contactY = (c.view.children[1] as Container).y;
    c.showGaitFrame('walk', 0.25);
    const passingY = (c.view.children[1] as Container).y;
    expect(contactY).toBeGreaterThan(passingY + 1);
  });

  it('turns between front, three-quarter and side views', () => {
    const c = make();
    c.setView('three_quarter');
    for (let i = 0; i < 30; i++) c.advance(1 / 60);
    expect(c.currentView).toBe('three_quarter');
    c.setView('side', true);
    expect(c.currentView).toBe('side');
  });

  it('carries items in hand or on the head and releases them', () => {
    const c = make();
    const basket = new Container();
    c.hold(basket, 'head');
    expect(c.heldItem('head')).toBe(basket);
    const coins = new Container();
    c.hold(coins, 'r');
    for (let i = 0; i < 10; i++) c.advance(1 / 60);
    expect(c.release('r')).toBe(coins);
    expect(coins.parent).toBeNull();
    expect(c.heldItem('r')).toBeNull();
  });

  it('lip-syncs to the playback amplitude and rests when it ends', async () => {
    const c = make();
    let amp = 1;
    const { pb, end } = playback(() => amp);
    const speaking = c.speak(pb);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    for (let i = 0; i < 20; i++) c.advance(1 / 60);
    expect(c.currentViseme).not.toBe('rest');
    amp = 0;
    for (let i = 0; i < 40; i++) c.advance(1 / 60);
    expect(c.currentViseme).toBe('rest');
    end();
    await speaking;
  });

  it('shows the Stall anger ladder with non-colour cues', () => {
    const c = make();
    c.setAngerLevel(3);
    for (let i = 0; i < 60; i++) c.advance(1 / 60);
    expect(c.currentExpression).toBe('angry');
    expect(c.currentSymbol).toBe('steam');
    c.setAngerLevel(0);
    for (let i = 0; i < 90; i++) c.advance(1 / 60);
    expect(c.currentExpression).toBe('calm');
    c.react('surprised', 0.3);
    c.advance(0.1);
    expect(c.currentExpression).toBe('surprised');
    for (let i = 0; i < 60; i++) c.advance(1 / 60);
    expect(c.currentExpression).toBe('calm');
  });

  it('completes instantly when motion is disabled (tests, skipped transitions)', async () => {
    motionSettings.timeScale = 0;
    const c = make();
    let done = false;
    void c.play('wave').then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(true);
    let walked = false;
    void c.play('walk_in').then(() => {
      walked = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(walked).toBe(true);
  });

  it('accepts cloth variants and views in the spec (backwards-compatible extension)', () => {
    const a = make({ cloth: 2, view: 'side' });
    const b = make({ cloth: 0 });
    expect(a.appearance.upperColor).not.toBe(b.appearance.upperColor);
    expect(a.currentView).toBe('side');
  });

  it('updates 12 characters within the 2 ms per-frame CPU budget', () => {
    const cs = Array.from({ length: 12 }, (_, i) =>
      make({
        id: `p${i}`,
        variant: i,
        view: (['front', 'three_quarter', 'side'] as const)[i % 3] ?? 'front',
      }),
    );
    cs.forEach((c, i) => {
      if (i % 3 === 0) c.setLocomotion('walk');
      else if (i % 3 === 1) void c.play('clap');
    });
    void cs[0]?.speakFor(60000);
    for (let f = 0; f < 120; f++) for (const c of cs) c.advance(1 / 60); // warm-up (JIT)
    // Best of several batches: robust against other processes competing for the CPU.
    const batches: number[] = [];
    for (let b = 0; b < 6; b++) {
      const frames = 60;
      const t0 = performance.now();
      for (let f = 0; f < frames; f++) for (const c of cs) c.advance(1 / 60);
      batches.push((performance.now() - t0) / frames);
    }
    const perFrame = Math.min(...batches);
    // jsdom has no renderer: this is the rig's CPU work (pose, IK, cloth, face redraws).
    console.info(`rig CPU per frame, 12 characters: ${perFrame.toFixed(3)} ms (best of 6 batches)`);
    expect(perFrame).toBeLessThan(2);
    for (const c of cs) c.destroy();
  }, 30000);
});
