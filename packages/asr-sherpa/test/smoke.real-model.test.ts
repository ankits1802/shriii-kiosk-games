/**
 * Real-model smoke test: sherpa-onnx native addon + the 3.3M-parameter English KWS model + Silero VAD,
 * driven end to end through KeywordSpeechInput. Skipped unless the addon loads and the models were
 * fetched (`pnpm --filter @shriii/asr-sherpa fetch-models`, or ASR_SHERPA_MODEL_DIR).
 *
 * The English model is a stand-in to prove the plumbing; pilot-language models come from the bake-off.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ArrayFrameSource,
  type AsrGrammar,
  KeywordSpeechInput,
  parseGrammar,
} from '../src/index.ts';
import {
  loadSherpa,
  resolveKwsModelDir,
  SherpaKeywordEngine,
  SileroVad,
} from '../src/sherpa/index.ts';
import { concat as concatFloat, Gate, isZero, noise } from './helpers.ts';

const MODELS =
  process.env.ASR_SHERPA_MODEL_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'models');
const KWS_DIR = join(MODELS, 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01');
const VAD_MODEL = join(MODELS, 'silero_vad.onnx');

async function addonAvailable(): Promise<boolean> {
  try {
    await loadSherpa();
    return true;
  } catch {
    return false;
  }
}

const enabled = existsSync(join(KWS_DIR, 'tokens.txt')) && (await addonAvailable());

function grammar(): AsrGrammar {
  return parseGrammar({
    schema_version: '1.0',
    language: 'en-IN',
    grammar_version: '0.0.1',
    engine: 'sherpa-onnx-kws',
    model_id: 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
    // tokens from the model's test_keywords.txt (BPE pieces)
    keywords: {
      light_up: { phrases: [{ tokens: '▁ L IGHT ▁UP', text: 'light up' }] },
      lovely_child: { phrases: [{ tokens: '▁LOVE LY ▁CHI L D', text: 'lovely child' }] },
      forever: { phrases: [{ tokens: '▁FOR E VER', text: 'forever' }] },
    },
    tiers: [
      { keywords_threshold: 0.2, confidence: 0.75 },
      { keywords_threshold: 0.35, confidence: 0.92 },
    ],
    prompts: {
      'smoke.prompt': { vocabulary: ['light_up', 'lovely_child', 'forever'], voice_enabled: true },
    },
    policy: {
      min_propose_confidence: 0.6,
      min_commit_confidence: 0.9,
      noise_max_dbfs: -30,
      max_listen_ms: 20_000,
      vad_preroll_ms: 400,
      settle_ms: 300,
    },
  });
}

async function readWave(path: string): Promise<Float32Array> {
  const sherpa = (await loadSherpa()) as unknown as {
    readWave(p: string): { samples: Float32Array; sampleRate: number };
  };
  const w = sherpa.readWave(path);
  expect(w.sampleRate).toBe(16000);
  return w.samples;
}

describe.skipIf(!enabled)('sherpa-onnx real model smoke test', () => {
  let engine: SherpaKeywordEngine;

  it('prepares the engine from the model directory', async () => {
    engine = new SherpaKeywordEngine({ model: resolveKwsModelDir(KWS_DIR) });
    const t0 = performance.now();
    await engine.prepare(grammar());
    console.info(
      `sherpa ${engine.version}: prepare ${Math.round(performance.now() - t0)} ms (2 tiers)`,
    );
    expect(engine.ready).toBe(true);
  });

  for (const vadKind of ['energy', 'silero'] as const) {
    it(`spots "light up" in test_wavs/0.wav through the adapter (${vadKind} VAD)`, async () => {
      if (vadKind === 'silero' && !existsSync(VAD_MODEL)) return;
      const speech = await readWave(join(KWS_DIR, 'test_wavs', '0.wav'));
      const audio = concatFloat(noise(0.6, -70, 3), speech, noise(1.0, -70, 4));
      const frames: Float32Array[] = [];
      const source = new ArrayFrameSource(audio, { onEmit: (f) => frames.push(f) });
      const vad = vadKind === 'silero' ? await SileroVad.create({ model: VAD_MODEL }) : undefined;
      const input = new KeywordSpeechInput({
        engine,
        source,
        grammar: grammar(),
        gate: new Gate(),
        ...(vad ? { vad } : {}),
      });
      const ctrl = new AbortController();
      const t0 = performance.now();
      const result = await input.listen(
        'smoke.prompt',
        ['light_up', 'lovely_child', 'forever'],
        ctrl.signal,
      );
      console.info(
        `${vadKind}: ${JSON.stringify(result)} in ${Math.round(performance.now() - t0)} ms`,
      );
      expect(result.label).toBe('light_up');
      expect(result.confidence).toBeGreaterThanOrEqual(0.75);
      expect(source.isOpen).toBe(false);
      expect(frames.every(isZero)).toBe(true);
      expect(input.retainedSampleCount()).toBe(0);
    });
  }

  it('does not fire on keyword-free noise', async () => {
    const source = new ArrayFrameSource(noise(3, -45, 11));
    const input = new KeywordSpeechInput({ engine, source, grammar: grammar(), gate: new Gate() });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2500);
    const result = await input.listen('smoke.prompt', ['light_up', 'forever'], ctrl.signal);
    expect(result).toEqual({ label: null, confidence: null });
  });

  it('restricts hits to the prompt vocabulary', async () => {
    const speech = await readWave(join(KWS_DIR, 'test_wavs', '1.wav')); // contains "forever" and "lovely child"
    const source = new ArrayFrameSource(concatFloat(noise(0.5, -70, 5), speech, noise(1, -70, 6)));
    const input = new KeywordSpeechInput({ engine, source, grammar: grammar(), gate: new Gate() });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const result = await input.listen('smoke.prompt', ['light_up'], ctrl.signal);
    expect(result.label).toBeNull();
  });
});
