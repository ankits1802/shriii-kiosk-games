import {
  ASR_SAMPLE_RATE,
  type AsrGate,
  type AsrGrammar,
  type KeywordDetection,
  type KeywordEngine,
  type KeywordSession,
  parseGrammar,
} from '../src/index.ts';

export const RATE = ASR_SAMPLE_RATE;

export function grammarJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1.0',
    language: 'hi-IN',
    grammar_version: '0.1.0',
    engine: 'sherpa-onnx-kws',
    model_id: 'test-model',
    keywords: {
      yes: { phrases: [{ tokens: '▁HAA N', text: 'haan' }, { tokens: '▁JI ▁HAA N' }] },
      no: { phrases: [{ tokens: '▁NA HII N' }] },
      wait: { phrases: [{ tokens: '▁RU KO' }] },
      share: { phrases: [{ tokens: '▁BAA NT O' }] },
    },
    tiers: [
      { keywords_threshold: 0.15, confidence: 0.7 },
      { keywords_threshold: 0.35, confidence: 0.95 },
    ],
    prompts: {
      'stall.offer': { vocabulary: ['yes', 'no'], voice_enabled: true },
      'stall.share': { vocabulary: ['share', 'wait'], voice_enabled: true },
      'tower.retry': { vocabulary: ['yes', 'no'], voice_enabled: false },
      'consent.core': { vocabulary: ['yes', 'no'], voice_enabled: false },
    },
    policy: {
      min_propose_confidence: 0.6,
      min_commit_confidence: 0.9,
      noise_max_dbfs: -35,
      max_listen_ms: 4000,
      vad_preroll_ms: 300,
      settle_ms: 100,
    },
    ...overrides,
  };
}

export function grammar(overrides: Record<string, unknown> = {}): AsrGrammar {
  return parseGrammar(grammarJson(overrides));
}

/** Tone burst standing in for an utterance (energy VAD sees speech). */
export function tone(seconds: number, dbfs = -20, hz = 300): Float32Array {
  const n = Math.round(seconds * RATE);
  const a = 10 ** (dbfs / 20) * Math.SQRT2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

export function noise(seconds: number, dbfs: number, seed = 7): Float32Array {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  const a = 10 ** (dbfs / 20) * Math.sqrt(3);
  for (let i = 0; i < n; i++) out[i] = a * (2 * rand() - 1);
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function add(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

export interface ScriptedHit {
  /** Fire once this many speech samples have been fed to the session. */
  readonly afterSamples: number;
  readonly code: string;
  readonly tier: number;
}

/**
 * Mock engine: emits scripted detections once enough speech samples were accepted. It copies what it
 * receives (like the native engine) and wipes the copy on dispose, recording everything for asserts.
 */
export class ScriptedEngine implements KeywordEngine {
  readonly name = 'scripted';
  ready = false;
  prepared: AsrGrammar | null = null;
  sessions: { vocabulary: string[]; samples: number; disposed: boolean; copies: Float32Array[] }[] =
    [];
  hits: ScriptedHit[];

  constructor(hits: ScriptedHit[] = []) {
    this.hits = hits;
  }

  async prepare(g: AsrGrammar): Promise<void> {
    this.prepared = g;
    this.ready = true;
  }

  createSession(vocabulary: readonly string[]): KeywordSession {
    const rec = {
      vocabulary: [...vocabulary],
      samples: 0,
      disposed: false,
      copies: [] as Float32Array[],
    };
    this.sessions.push(rec);
    const pending = [...this.hits];
    const fire = (): KeywordDetection[] => {
      const out: KeywordDetection[] = [];
      for (let i = pending.length - 1; i >= 0; i--) {
        const h = pending[i] as ScriptedHit;
        if (rec.samples >= h.afterSamples) {
          out.push({ code: h.code, tier: h.tier, timeSec: rec.samples / RATE });
          pending.splice(i, 1);
        }
      }
      return out;
    };
    return {
      accept: (samples) => {
        if (rec.disposed) throw new Error('accept after dispose');
        rec.copies.push(Float32Array.from(samples));
        rec.samples += samples.length;
      },
      poll: fire,
      finish: fire,
      dispose: () => {
        rec.disposed = true;
        for (const c of rec.copies) c.fill(0);
      },
    };
  }

  dispose(): void {
    this.ready = false;
  }
}

export class Gate implements AsrGate {
  enabled = true;
  consent = true;
  asrEnabled(): boolean {
    return this.enabled;
  }
  coreConsentGranted(): boolean {
    return this.consent;
  }
}

export function isZero(a: Float32Array): boolean {
  for (const v of a) if (v !== 0) return false;
  return true;
}
