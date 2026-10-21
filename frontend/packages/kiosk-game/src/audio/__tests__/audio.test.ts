/**
 * Audio engine: graph construction (buses -> master -> limiter -> destination, reverb send), SFX
 * synthesis for every id, music scheduling and cross-fades, ambience beds, ducking under voice, volume
 * clamping, mute safety without Web Audio, and the "pressure" layer never depending on performance.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SfxId } from '../../core/contracts.ts';
import { AudioEngine, BUS_LEVELS } from '../AudioEngine.ts';
import { CUES } from '../music/cues.ts';
import { SFX } from '../sfx/library.ts';
import { degreeHz, RAGAS, SA_HZ } from '../theory.ts';
import { type MockAudioContext, type MockNode, mockFactory } from './mockAudio.ts';

function reaches(from: MockNode, to: MockNode, seen = new Set<MockNode>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.outputs.some((o) => reaches(o, to, seen));
}

async function unlockedEngine(): Promise<{ engine: AudioEngine; ctx: MockAudioContext }> {
  const { ctx, factory } = mockFactory();
  const engine = new AudioEngine({ contextFactory: factory, masterVolume: 0.8 });
  await engine.unlock();
  return { engine, ctx };
}

describe('AudioEngine graph', () => {
  it('routes every bus through master and a limiter to the destination', async () => {
    const { engine, ctx } = await unlockedEngine();
    expect(engine.unlocked).toBe(true);
    const [limiter] = ctx.ofKind('compressor');
    expect(limiter).toBeDefined();
    if (!limiter) return;
    expect(limiter.outputs).toContain(ctx.destination);
    const gains = ctx.ofKind('gain');
    const master = gains.find((g) => g.outputs.includes(limiter));
    expect(master).toBeDefined();
    // music/ambience/sfx/voice buses all reach the limiter.
    const busLevels: number[] = Object.values(BUS_LEVELS);
    const buses = gains.filter((g) =>
      busLevels.includes((g as unknown as { gain: { value: number } }).gain.value),
    );
    expect(buses.length).toBeGreaterThanOrEqual(4);
    for (const b of buses) expect(reaches(b, limiter)).toBe(true);
    expect(ctx.ofKind('convolver')).toHaveLength(1);
    expect(engine.voiceHost().voiceInput).not.toBeNull();
  });

  it('synthesises every SFX id without throwing and reports onset and completion', async () => {
    const { engine, ctx } = await unlockedEngine();
    ctx.currentTime = 1;
    for (const id of Object.keys(SFX) as SfxId[]) {
      const before = ctx.nodes.length;
      const h = engine.playSfx(id, { volume: 0.7, pan: -0.3 });
      expect(ctx.nodes.length).toBeGreaterThan(before);
      expect(h.onsetMs).toBeGreaterThan(1000);
      h.stop(10);
      await expect(h.ended).resolves.toBe('interrupted');
    }
  });

  it('the gentle "oops" (incorrect) is soft and short, never a buzzer', async () => {
    const { engine, ctx } = await unlockedEngine();
    const before = ctx.nodes.length;
    engine.playSfx('incorrect');
    const created = ctx.nodes.slice(before);
    const oscs = created.filter((n) => n.kind === 'oscillator') as unknown as { type: string }[];
    expect(oscs.every((o) => o.type === 'sine' || o.type === 'triangle')).toBe(true);
  });

  it('music cues schedule tanpura plucks (periodic wave) and cross-fade between cues', async () => {
    vi.useFakeTimers();
    try {
      const { engine, ctx } = await unlockedEngine();
      engine.playMusic('attract', { fadeMs: 500 });
      expect(engine.currentMusic).toBe('attract');
      const waves = ctx
        .ofKind('oscillator')
        .filter((o) => (o as unknown as { wave: unknown }).wave !== null);
      expect(waves.length).toBeGreaterThan(0);
      ctx.currentTime = 2;
      vi.advanceTimersByTime(100);
      engine.playMusic('road_home', { fadeMs: 500 });
      expect(engine.currentMusic).toBe('road_home');
      engine.stopMusic(200);
      expect(engine.currentMusic).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the pressure cue is a fixed condition layer (no performance input exists)', () => {
    expect(CUES.pressure.tension).toBeGreaterThan(0);
    expect(CUES.pressure.melody).toBe(0);
    // setTension takes only a condition level; there is no API to feed scores into the music.
    expect(AudioEngine.prototype.setTension.length).toBe(1);
  });

  it('ambience beds start looping noise and switch with a cross-fade', async () => {
    vi.useFakeTimers();
    try {
      const { engine, ctx } = await unlockedEngine();
      engine.setAmbience('market_busy', { fadeMs: 300 });
      expect(engine.currentAmbience).toBe('market_busy');
      const loops = ctx.ofKind('buffer').filter((s) => (s as unknown as { loop: boolean }).loop);
      expect(loops.length).toBeGreaterThanOrEqual(4);
      engine.setAmbience('road_evening', { fadeMs: 300 });
      expect(engine.currentAmbience).toBe('road_evening');
      engine.setAmbience(null);
      expect(engine.currentAmbience).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ducking and volume', () => {
  it('ducks music and ambience under voice, takes the deepest request, and releases independently', async () => {
    const { engine } = await unlockedEngine();
    const r1 = engine.duck(0.4);
    const r2 = engine.duck(0.7);
    expect(engine.duckAmount).toBeCloseTo(0.7);
    r2();
    expect(engine.duckAmount).toBeCloseTo(0.4);
    r2(); // idempotent
    r1();
    expect(engine.duckAmount).toBe(0);
  });

  it('clamps master volume to the policy maximum', async () => {
    const { factory } = mockFactory();
    const engine = new AudioEngine({ contextFactory: factory, maxVolume: 0.9 });
    await engine.unlock();
    engine.setMasterVolume(2);
    expect(engine.masterVolume).toBe(0.9);
    engine.setMasterVolume(-1);
    expect(engine.masterVolume).toBe(0);
  });
});

describe('mute safety', () => {
  it('works as a silent no-op without Web Audio', async () => {
    const engine = new AudioEngine({ contextFactory: () => null });
    await engine.unlock();
    expect(engine.unlocked).toBe(false);
    const h = engine.playSfx('tap');
    await expect(h.ended).resolves.toBe('completed');
    engine.playMusic('hub');
    engine.setAmbience('market_day');
    const release = engine.duck(0.5);
    release();
    engine.stopAll();
    expect(engine.voiceHost().context).toBeNull();
  });

  it('plays nothing before the first gesture unlocks the context', () => {
    const { ctx, factory } = mockFactory();
    const engine = new AudioEngine({ contextFactory: factory });
    expect(engine.context).not.toBeNull(); // builds the bus graph only
    const graphNodes = ctx.nodes.length;
    const h = engine.playSfx('chime');
    expect(ctx.nodes.length).toBe(graphNodes);
    expect(engine.unlocked).toBe(false);
    return expect(h.ended).resolves.toBe('completed');
  });
});

describe('music theory', () => {
  it('is in one fixed key and every raga is pentatonic', () => {
    expect(SA_HZ).toBeCloseTo(146.83);
    for (const r of Object.values(RAGAS)) expect(r).toHaveLength(5);
    expect(degreeHz('bhupali', 0, 0)).toBeCloseTo(SA_HZ);
    expect(degreeHz('bhupali', 5, 0)).toBeCloseTo(SA_HZ * 2);
    expect(degreeHz('durga', 3, 0)).toBeCloseTo(SA_HZ * 1.5);
  });
});
