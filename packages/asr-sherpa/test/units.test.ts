import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertVoiceSubset,
  classifyProposal,
  EnergyVad,
  GrammarError,
  parseGrammar,
  rmsDbfs,
  SampleRing,
  toSherpaKeywords,
} from '../src/index.ts';
import { concat, grammar, grammarJson, noise, RATE, tone } from './helpers.ts';

describe('grammar', () => {
  it('parses and freezes a valid config', () => {
    const g = grammar();
    expect(g.language).toBe('hi-IN');
    expect(Object.isFrozen(g)).toBe(true);
    expect(g.prompts['stall.offer']?.vocabulary).toEqual(['yes', 'no']);
  });

  it.each([
    [
      'touch-only prompt enabled',
      { prompts: { 'consent.core': { vocabulary: ['yes'], voice_enabled: true } } },
      /touch only/,
    ],
    [
      'optin enabled',
      { prompts: { 'optin.archive': { vocabulary: ['yes'], voice_enabled: true } } },
      /touch only/,
    ],
    [
      'unknown vocab code',
      { prompts: { p: { vocabulary: ['maybe'], voice_enabled: true } } },
      /no keyword phrases/,
    ],
    [
      'duplicate tokens',
      {
        keywords: { yes: { phrases: [{ tokens: '▁A' }] }, no: { phrases: [{ tokens: '▁A' }] } },
        prompts: {},
      },
      /maps to both/,
    ],
    [
      'tiers not ascending',
      {
        tiers: [
          { keywords_threshold: 0.3, confidence: 0.9 },
          { keywords_threshold: 0.2, confidence: 0.95 },
        ],
      },
      /ascending/,
    ],
    ['bad language', { language: 'hindi' }, /BCP-47/],
    [
      'bad token syntax',
      { keywords: { yes: { phrases: [{ tokens: '▁A @x' }] } }, prompts: {} },
      /tokens/,
    ],
    [
      'commit below propose',
      {
        policy: {
          min_propose_confidence: 0.9,
          min_commit_confidence: 0.5,
          noise_max_dbfs: -35,
          max_listen_ms: 4000,
          vad_preroll_ms: 300,
          settle_ms: 100,
        },
      },
      /min_commit_confidence/,
    ],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => parseGrammar(grammarJson(overrides))).toThrow(GrammarError);
    expect(() => parseGrammar(grammarJson(overrides))).toThrow(message);
  });

  it('renders a sherpa keywords buffer', () => {
    const g = parseGrammar(
      grammarJson({
        keywords: {
          yes: { phrases: [{ tokens: '▁HAA N', boost: 1.5 }] },
          no: { phrases: [{ tokens: '▁NA' }] },
        },
        prompts: {},
      }),
    );
    expect(toSherpaKeywords(g)).toBe('▁HAA N @yes :1.5\n▁NA @no');
    expect(toSherpaKeywords(g, ['no'])).toBe('▁NA @no');
  });
});

describe('proposal semantics', () => {
  const policy = { min_propose_confidence: 0.6, min_commit_confidence: 0.9 };
  const touchCodes = ['yes', 'no'];
  it('commits only high confidence on-screen codes', () => {
    expect(classifyProposal({ label: 'yes', confidence: 0.95 }, policy, { touchCodes })).toEqual({
      kind: 'commit',
      code: 'yes',
      confidence: 0.95,
    });
    expect(classifyProposal({ label: 'yes', confidence: 0.7 }, policy, { touchCodes }).kind).toBe(
      'propose',
    );
    expect(classifyProposal({ label: 'yes', confidence: 0.5 }, policy, { touchCodes }).kind).toBe(
      'none',
    );
    expect(
      classifyProposal({ label: 'share', confidence: 0.99 }, policy, { touchCodes }).kind,
    ).toBe('none');
    expect(classifyProposal({ label: null, confidence: null }, policy, { touchCodes }).kind).toBe(
      'none',
    );
  });
  it('never commits by voice when a confirm tick is required or the prompt is touch only', () => {
    expect(
      classifyProposal({ label: 'yes', confidence: 0.99 }, policy, {
        touchCodes,
        requireConfirm: true,
      }).kind,
    ).toBe('propose');
    expect(
      classifyProposal({ label: 'yes', confidence: 0.99 }, policy, { touchCodes, touchOnly: true })
        .kind,
    ).toBe('none');
  });
  it('asserts voiceOptions are a subset of touchOptions', () => {
    expect(() => assertVoiceSubset('p', ['yes'], ['yes', 'no'])).not.toThrow();
    expect(() => assertVoiceSubset('p', ['yes', 'maybe'], ['yes', 'no'])).toThrow(/maybe/);
  });
});

describe('SampleRing', () => {
  it('keeps the newest samples in order across wrap-around and wipes to zero', () => {
    const r = new SampleRing(5);
    r.push(Float32Array.from([1, 2, 3]));
    r.push(Float32Array.from([4, 5, 6, 7]));
    expect(r.size).toBe(5);
    expect(r.views().flatMap((v) => [...v])).toEqual([3, 4, 5, 6, 7]);
    r.push(Float32Array.from([8, 9, 10, 11, 12, 13]));
    expect(r.views().flatMap((v) => [...v])).toEqual([9, 10, 11, 12, 13]);
    r.wipe();
    expect(r.size).toBe(0);
    expect(r.views()).toEqual([]);
    expect(r.nonZeroSamples()).toBe(0);
  });
  it('handles zero capacity', () => {
    const r = new SampleRing(0);
    r.push(Float32Array.from([1]));
    expect(r.size).toBe(0);
  });
});

describe('EnergyVad', () => {
  const frames = (x: Float32Array, n = 512) => {
    const out: Float32Array[] = [];
    for (let i = 0; i < x.length; i += n) out.push(x.slice(i, i + n));
    return out;
  };

  it('opens on speech after onset, closes after hangover', () => {
    const vad = new EnergyVad();
    const x = concat(noise(0.5, -65), tone(0.5, -20), noise(1.0, -65));
    const decisions = frames(x).map((f) => vad.accept(f).speech);
    const frameS = 512 / RATE;
    const first = decisions.indexOf(true) * frameS;
    const last = decisions.lastIndexOf(true) * frameS;
    expect(first).toBeGreaterThan(0.45);
    expect(first).toBeLessThan(0.65);
    expect(last).toBeGreaterThan(1.0);
    expect(last).toBeLessThan(1.0 + 0.3 + 2 * frameS);
  });

  it('adapts to a persistent noise source instead of calling it speech', () => {
    const vad = new EnergyVad();
    const decisions = frames(noise(4, -30)).map((f) => vad.accept(f).speech);
    expect(decisions.slice(-20).every((d) => !d)).toBe(true);
    expect(decisions.filter(Boolean).length).toBe(0);
  });

  it('measures frame level', () => {
    expect(rmsDbfs(tone(0.1, -20))).toBeCloseTo(-20, 0);
    expect(rmsDbfs(new Float32Array(10))).toBe(-120);
  });
});

describe('contract with tools/asr-bakeoff', () => {
  it('parses the asr-config the bake-off emits', () => {
    const path = fileURLToPath(
      new URL('../../../tools/asr-bakeoff/fixtures/asr-config.sample.json', import.meta.url),
    );
    const g = parseGrammar(JSON.parse(readFileSync(path, 'utf8')));
    expect(g.language).toBe('hi-IN');
    expect(g.prompts['generic.yes_no']?.voice_enabled).toBe(true);
    expect(g.tiers.map((t) => t.confidence)).toEqual([0.9, 0.98]);
    expect(toSherpaKeywords(g)).toContain('▁HAA N @yes');
  });
});
