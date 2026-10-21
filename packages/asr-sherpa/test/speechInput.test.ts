import type { SpeechInput } from '@shriii/kiosk-game/core/contracts';
import { describe, expect, it } from 'vitest';
import {
  ArrayFrameSource,
  type AsrGrammar,
  KeywordSpeechInput,
  type MicStateEvent,
  type ProposalEvent,
} from '../src/index.ts';
import {
  concat,
  Gate,
  grammar,
  isZero,
  noise,
  RATE,
  ScriptedEngine,
  type ScriptedHit,
  tone,
} from './helpers.ts';

const QUIET = -65;

/** 0.5 s room tone, 0.6 s "utterance", 1.5 s room tone. */
function utterance(): Float32Array {
  return concat(noise(0.5, QUIET, 1), tone(0.6, -18), noise(1.5, QUIET, 2));
}

interface Rig {
  input: KeywordSpeechInput;
  engine: ScriptedEngine;
  source: ArrayFrameSource;
  gate: Gate;
  frames: Float32Array[];
  mic: MicStateEvent[];
  proposals: ProposalEvent[];
}

async function rig(
  hits: ScriptedHit[],
  audio: Float32Array = utterance(),
  g: AsrGrammar = grammar(),
  prepare = true,
): Promise<Rig> {
  const engine = new ScriptedEngine(hits);
  if (prepare) await engine.prepare(g);
  const frames: Float32Array[] = [];
  const source = new ArrayFrameSource(audio, { onEmit: (f) => frames.push(f) });
  const gate = new Gate();
  const input = new KeywordSpeechInput({ engine, source, grammar: g, gate });
  const mic: MicStateEvent[] = [];
  const proposals: ProposalEvent[] = [];
  input.onMicState((e) => mic.push(e));
  input.onProposal((e) => proposals.push(e));
  return { input, engine, source, gate, frames, mic, proposals };
}

function window(ms: number): { signal: AbortSignal; close: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return {
    signal: ctrl.signal,
    close: () => {
      clearTimeout(t);
      ctrl.abort();
    },
  };
}

describe('KeywordSpeechInput availability', () => {
  it('implements the kiosk SpeechInput contract', async () => {
    const { input } = await rig([]);
    const contract: SpeechInput = input;
    expect(typeof contract.listen).toBe('function');
  });

  it('requires policy, consent, a voice-enabled prompt and a prepared engine', async () => {
    const r = await rig([]);
    expect(r.input.isAvailable('stall.offer')).toBe(true);
    expect(r.input.isAvailable('tower.retry')).toBe(false); // failed VOX-06
    expect(r.input.isAvailable('unknown.prompt')).toBe(false);
    expect(r.input.isAvailable('consent.core')).toBe(false); // touch only by rule
    r.gate.enabled = false;
    expect(r.input.isAvailable('stall.offer')).toBe(false);
    r.gate.enabled = true;
    r.gate.consent = false;
    expect(r.input.isAvailable('stall.offer')).toBe(false);
    const unprepared = await rig([], utterance(), grammar(), false);
    expect(unprepared.input.isAvailable('stall.offer')).toBe(false);
  });

  it('never opens the mic for an unavailable prompt or a closed window', async () => {
    const r = await rig([{ afterSamples: 1, code: 'yes', tier: 1 }]);
    expect(
      await r.input.listen('tower.retry', ['yes', 'no'], new AbortController().signal),
    ).toEqual({
      label: null,
      confidence: null,
    });
    const aborted = new AbortController();
    aborted.abort();
    expect(await r.input.listen('stall.offer', ['yes', 'no'], aborted.signal)).toEqual({
      label: null,
      confidence: null,
    });
    expect(r.source.openCount).toBe(0);
    expect(r.mic).toEqual([]);
  });
});

describe('KeywordSpeechInput listening', () => {
  it('commits a high-tier detection and closes the mic before resolving', async () => {
    const r = await rig([{ afterSamples: 4000, code: 'yes', tier: 1 }]);
    const w = window(3000);
    const result = await r.input.listen('stall.offer', ['yes', 'no'], w.signal);
    w.close();
    expect(result).toEqual({ label: 'yes', confidence: 0.95 });
    expect(r.source.openCount).toBe(1);
    expect(r.source.isOpen).toBe(false);
    expect(r.input.isMicOpen).toBe(false);
    expect(r.mic).toEqual([
      { state: 'open', promptId: 'stall.offer' },
      { state: 'closed', promptId: 'stall.offer', reason: 'detected' },
    ]);
    expect(r.proposals).toEqual([{ promptId: 'stall.offer', code: 'yes', confidence: 0.95 }]);
  });

  it('returns a low-tier proposal after the settle time', async () => {
    const r = await rig([{ afterSamples: 4000, code: 'no', tier: 0 }]);
    const w = window(3000);
    const result = await r.input.listen('stall.offer', ['yes', 'no'], w.signal);
    w.close();
    expect(result).toEqual({ label: 'no', confidence: 0.7 });
    expect(r.proposals.map((p) => p.code)).toEqual(['no']);
  });

  it('upgrades to the stricter tier when it fires within the settle window', async () => {
    const r = await rig([
      { afterSamples: 3000, code: 'yes', tier: 0 },
      { afterSamples: 4500, code: 'yes', tier: 1 },
    ]);
    const w = window(3000);
    expect(await r.input.listen('stall.offer', ['yes', 'no'], w.signal)).toEqual({
      label: 'yes',
      confidence: 0.95,
    });
    w.close();
  });

  it('drops results below the propose threshold', async () => {
    const g = grammar({
      tiers: [
        { keywords_threshold: 0.1, confidence: 0.4 },
        { keywords_threshold: 0.3, confidence: 0.95 },
      ],
    });
    const r = await rig([{ afterSamples: 4000, code: 'yes', tier: 0 }], utterance(), g);
    const w = window(1500);
    expect(await r.input.listen('stall.offer', ['yes', 'no'], w.signal)).toEqual({
      label: null,
      confidence: null,
    });
    expect(r.proposals).toEqual([]);
  });

  it('only proposes codes in both the caller vocabulary and the prompt grammar', async () => {
    const r = await rig([
      { afterSamples: 3000, code: 'share', tier: 1 }, // not in stall.offer
      { afterSamples: 3500, code: 'no', tier: 1 }, // caller only offers "yes"
    ]);
    const w = window(1500);
    expect(await r.input.listen('stall.offer', ['yes', 'share'], w.signal)).toEqual({
      label: null,
      confidence: null,
    });
    expect(r.engine.sessions[0]?.vocabulary).toEqual(['yes']);
    const none = await rig([]);
    expect(await none.input.listen('stall.offer', ['wait'], new AbortController().signal)).toEqual({
      label: null,
      confidence: null,
    });
    expect(none.source.openCount).toBe(0);
  });

  it('treats two codes at the same tier as ambiguous, and prefers a stricter tier', async () => {
    const amb = await rig([
      { afterSamples: 3000, code: 'yes', tier: 0 },
      { afterSamples: 3200, code: 'no', tier: 0 },
    ]);
    const w = window(1500);
    expect(await amb.input.listen('stall.offer', ['yes', 'no'], w.signal)).toEqual({
      label: null,
      confidence: null,
    });
    const mixed = await rig([
      { afterSamples: 3000, code: 'yes', tier: 0 },
      { afterSamples: 3200, code: 'no', tier: 1 },
    ]);
    const w2 = window(1500);
    expect(await mixed.input.listen('stall.offer', ['yes', 'no'], w2.signal)).toEqual({
      label: 'no',
      confidence: 0.95,
    });
    w2.close();
  });

  it('closes the mic when the prompt window closes without a detection', async () => {
    const r = await rig([]);
    const w = window(400);
    const result = await r.input.listen('stall.offer', ['yes', 'no'], w.signal);
    expect(result).toEqual({ label: null, confidence: null });
    expect(r.mic.at(-1)).toEqual({
      state: 'closed',
      promptId: 'stall.offer',
      reason: 'window_closed',
    });
    expect(r.source.isOpen).toBe(false);
  });

  it('enforces max_listen_ms even if the caller never closes the window', async () => {
    const g = grammar({
      policy: {
        min_propose_confidence: 0.6,
        min_commit_confidence: 0.9,
        noise_max_dbfs: -35,
        max_listen_ms: 600,
        vad_preroll_ms: 300,
        settle_ms: 100,
      },
    });
    const r = await rig([], utterance(), g);
    const t0 = Date.now();
    const result = await r.input.listen('stall.offer', ['yes', 'no'], new AbortController().signal);
    expect(result.label).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    expect(r.mic.at(-1)?.reason).toBe('timeout');
  });

  it('allows one window at a time', async () => {
    const r = await rig([]);
    const w = window(500);
    const first = r.input.listen('stall.offer', ['yes', 'no'], w.signal);
    expect(await r.input.listen('stall.share', ['share'], new AbortController().signal)).toEqual({
      label: null,
      confidence: null,
    });
    await first;
    expect(r.source.openCount).toBe(1);
  });

  it('stays touch only (mic closed) when the engine cannot start a session', async () => {
    const r = await rig([]);
    r.engine.createSession = () => {
      throw new Error('native failure');
    };
    expect(await r.input.listen('stall.offer', ['yes'], new AbortController().signal)).toEqual({
      label: null,
      confidence: null,
    });
    expect(r.source.openCount).toBe(0);
    expect(r.input.isMicOpen).toBe(false);
  });
});

describe('VAD gating and privacy', () => {
  it('feeds the engine nothing when there is no speech', async () => {
    const r = await rig([], noise(2, QUIET, 3));
    const w = window(800);
    await r.input.listen('stall.offer', ['yes', 'no'], w.signal);
    expect(r.engine.sessions[0]?.samples).toBe(0);
  });

  it('feeds speech plus a bounded pre-roll only', async () => {
    const r = await rig([]);
    const w = window(1800);
    await r.input.listen('stall.offer', ['yes', 'no'], w.signal);
    const fed = r.engine.sessions[0]?.samples ?? 0;
    const speech = 0.6 * RATE;
    const maxExtra = (0.3 /* pre-roll */ + 0.3 /* hangover */ + 0.1) * RATE;
    expect(fed).toBeGreaterThanOrEqual(speech * 0.9);
    expect(fed).toBeLessThanOrEqual(speech + maxExtra);
  });

  it('retains no audio: frames zeroed, ring wiped, engine session disposed', async () => {
    const r = await rig([{ afterSamples: 4000, code: 'yes', tier: 1 }]);
    const w = window(3000);
    await r.input.listen('stall.offer', ['yes', 'no'], w.signal);
    w.close();
    // give the source a chance to emit frames after close (they must be zeroed too)
    await new Promise((res) => setTimeout(res, 20));
    expect(r.frames.length).toBeGreaterThan(10);
    expect(r.frames.every(isZero)).toBe(true);
    expect(r.input.retainedSampleCount()).toBe(0);
    const s = r.engine.sessions[0];
    expect(s?.disposed).toBe(true);
    expect(s?.copies.every(isZero)).toBe(true);
  });

  it('switches the session to touch only when the first window is too noisy (VOX-05)', async () => {
    const r = await rig([{ afterSamples: 1, code: 'yes', tier: 1 }], noise(3, -25, 9));
    const w = window(2000);
    const result = await r.input.listen('stall.offer', ['yes', 'no'], w.signal);
    w.close();
    expect(result).toEqual({ label: null, confidence: null });
    expect(r.input.touchOnlyBecauseOfNoise).toBe(true);
    expect(r.input.noiseDbfs).toBeGreaterThan(-28);
    expect(r.input.noiseDbfs).toBeLessThan(-22);
    expect(r.mic.at(-1)?.reason).toBe('noise');
    expect(r.input.isAvailable('stall.offer')).toBe(false);
    expect(r.frames.every(isZero)).toBe(true);
  });

  it('measures the noise floor in the first window only and keeps voice on in a quiet room', async () => {
    const r = await rig([]);
    const w = window(1500);
    await r.input.listen('stall.offer', ['yes', 'no'], w.signal);
    const floor = r.input.noiseDbfs;
    expect(floor).not.toBeNull();
    expect(floor as number).toBeLessThan(-55);
    expect(r.input.isAvailable('stall.offer')).toBe(true);
  });
});
