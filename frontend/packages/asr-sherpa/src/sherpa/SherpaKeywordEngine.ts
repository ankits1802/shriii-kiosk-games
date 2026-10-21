/**
 * sherpa-onnx streaming keyword spotter (zipformer transducer KWS) as a {@link KeywordEngine}.
 *
 * Confidence tiers: sherpa's KWS reports a hit without a score, so the engine runs one spotter per
 * grammar tier (same model, same keyword list, increasing `keywordsThreshold`). A detection's tier is
 * the strictest spotter that fired; the grammar maps tiers to calibrated confidences measured in the
 * bake-off. Spotters are built once in `prepare()` (model load takes seconds) and shared by sessions.
 *
 * Vocabulary: every spotter holds all grammar keywords; a session ignores hits outside its prompt's
 * vocabulary (sherpa's node binding has no per-stream keyword lists).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toSherpaKeywords } from '../grammar.ts';
import {
  ASR_SAMPLE_RATE,
  type AsrGrammar,
  type KeywordDetection,
  type KeywordEngine,
  type KeywordSession,
} from '../types.ts';
import {
  loadSherpa,
  type SherpaKeywordSpotter,
  type SherpaLoader,
  type SherpaModule,
  type SherpaOnlineStream,
} from './binding.ts';

export interface SherpaKwsModelFiles {
  readonly encoder: string;
  readonly decoder: string;
  readonly joiner: string;
  readonly tokens: string;
}

export interface SherpaKeywordEngineOptions {
  readonly model: SherpaKwsModelFiles;
  readonly numThreads?: number;
  readonly provider?: 'cpu';
  readonly maxActivePaths?: number;
  readonly numTrailingBlanks?: number;
  readonly keywordsScore?: number;
  /** Silence appended when a window closes so the decoder emits trailing tokens. */
  readonly flushSilenceMs?: number;
  readonly loader?: SherpaLoader;
}

/**
 * Resolve the model files of a sherpa KWS release directory (prefers int8 encoder/joiner, as in the
 * upstream examples; the decoder is fp32 because the int8 decoder is not shipped for every model).
 */
export function resolveKwsModelDir(dir: string): SherpaKwsModelFiles {
  const pick = (stem: string, preferInt8: boolean): string => {
    const names = readdirSync(dir).filter((n) => n.startsWith(`${stem}-`) && n.endsWith('.onnx'));
    const int8 = names.find((n) => n.endsWith('.int8.onnx'));
    const fp32 = names.find((n) => !n.endsWith('.int8.onnx'));
    const chosen = (preferInt8 ? (int8 ?? fp32) : (fp32 ?? int8)) ?? null;
    if (!chosen) throw new Error(`no ${stem}-*.onnx in ${dir}`);
    return join(dir, chosen);
  };
  const tokens = join(dir, 'tokens.txt');
  if (!existsSync(tokens)) throw new Error(`no tokens.txt in ${dir}`);
  return {
    encoder: pick('encoder', true),
    decoder: pick('decoder', false),
    joiner: pick('joiner', true),
    tokens,
  };
}

interface TierSpotter {
  readonly tier: number;
  readonly spotter: SherpaKeywordSpotter;
}

export class SherpaKeywordEngine implements KeywordEngine {
  readonly name = 'sherpa-onnx-kws';
  private readonly options: SherpaKeywordEngineOptions;
  private spotters: TierSpotter[] = [];
  private keywordCodes = new Set<string>();
  private sherpa: SherpaModule | null = null;

  constructor(options: SherpaKeywordEngineOptions) {
    this.options = options;
  }

  get ready(): boolean {
    return this.spotters.length > 0;
  }

  /** Version of the native addon (for `asr_engine_version` provenance). */
  get version(): string | null {
    return this.sherpa?.version ?? null;
  }

  async prepare(grammar: AsrGrammar): Promise<void> {
    const sherpa = await (this.options.loader ?? loadSherpa)();
    this.sherpa = sherpa;
    const keywords = toSherpaKeywords(grammar);
    const m = this.options.model;
    const spotters: TierSpotter[] = grammar.tiers.map((tier, index) => {
      const config = {
        featConfig: { sampleRate: ASR_SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: m.encoder, decoder: m.decoder, joiner: m.joiner },
          tokens: m.tokens,
          numThreads: this.options.numThreads ?? 1,
          provider: this.options.provider ?? 'cpu',
          debug: 0,
        },
        maxActivePaths: this.options.maxActivePaths ?? 4,
        numTrailingBlanks: this.options.numTrailingBlanks ?? 1,
        keywordsScore: this.options.keywordsScore ?? 1.0,
        keywordsThreshold: tier.keywords_threshold,
        keywordsBuf: keywords,
        keywordsBufSize: new TextEncoder().encode(keywords).length,
      };
      return { tier: index, spotter: new sherpa.KeywordSpotter(config) };
    });
    this.spotters = spotters;
    this.keywordCodes = new Set(Object.keys(grammar.keywords));
  }

  createSession(vocabulary: readonly string[]): KeywordSession {
    if (!this.ready) throw new Error('SherpaKeywordEngine.prepare() has not completed');
    const allowed = new Set(vocabulary.filter((c) => this.keywordCodes.has(c)));
    let streams: {
      readonly tier: number;
      readonly spotter: SherpaKeywordSpotter;
      stream: SherpaOnlineStream;
    }[] = this.spotters.map(({ tier, spotter }) => ({
      tier,
      spotter,
      stream: spotter.createStream(),
    }));
    let samplesSeen = 0;
    let disposed = false;
    const flushMs = this.options.flushSilenceMs ?? 400;

    const drain = (): KeywordDetection[] => {
      const out: KeywordDetection[] = [];
      for (const s of streams) {
        while (s.spotter.isReady(s.stream)) {
          s.spotter.decode(s.stream);
          const r = s.spotter.getResult(s.stream);
          if (r.keyword) {
            if (allowed.has(r.keyword)) {
              out.push({
                code: r.keyword,
                tier: s.tier,
                timeSec: r.timestamps.at(-1) ?? samplesSeen / ASR_SAMPLE_RATE,
              });
            }
            s.spotter.reset(s.stream);
          }
        }
      }
      return out;
    };

    return {
      accept: (samples) => {
        if (disposed || samples.length === 0) return;
        samplesSeen += samples.length;
        // acceptWaveform copies the samples into the native feature extractor.
        for (const s of streams) s.stream.acceptWaveform({ samples, sampleRate: ASR_SAMPLE_RATE });
      },
      poll: () => (disposed ? [] : drain()),
      finish: () => {
        if (disposed) return [];
        const tail = new Float32Array(Math.round((ASR_SAMPLE_RATE * flushMs) / 1000));
        for (const s of streams) {
          s.stream.acceptWaveform({ samples: tail, sampleRate: ASR_SAMPLE_RATE });
          s.stream.inputFinished();
        }
        return drain();
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const s of streams) s.spotter.reset(s.stream);
        streams = []; // native streams are released by their finalizers
      },
    };
  }

  dispose(): void {
    this.spotters = [];
    this.keywordCodes.clear();
  }
}
