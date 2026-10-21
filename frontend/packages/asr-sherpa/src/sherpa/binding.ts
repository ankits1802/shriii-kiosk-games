/**
 * Structural types for the parts of `sherpa-onnx-node` (native N-API addon, prebuilt for win-x64,
 * linux-x64/arm64 and macOS) that the adapter uses, and a lazy loader so the package works (with mock
 * engines) on machines where the addon is not installed. Only keyword spotting and VAD are used; the
 * adapter never touches the addon's TTS classes (VOX-01: no TTS in production).
 */

export interface SherpaWaveform {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

export interface SherpaOnlineStream {
  acceptWaveform(wave: SherpaWaveform): void;
  inputFinished(): void;
}

export interface SherpaKeywordResult {
  readonly keyword: string;
  readonly start_time: number;
  readonly timestamps: readonly number[];
  readonly tokens: readonly string[];
}

export interface SherpaKeywordSpotterConfig {
  readonly featConfig: { readonly sampleRate: number; readonly featureDim: number };
  readonly modelConfig: {
    readonly transducer: {
      readonly encoder: string;
      readonly decoder: string;
      readonly joiner: string;
    };
    readonly tokens: string;
    readonly numThreads: number;
    readonly provider: string;
    readonly debug: number;
  };
  readonly maxActivePaths?: number;
  readonly numTrailingBlanks?: number;
  readonly keywordsScore?: number;
  readonly keywordsThreshold?: number;
  readonly keywordsBuf: string;
  readonly keywordsBufSize: number;
}

export interface SherpaKeywordSpotter {
  createStream(): SherpaOnlineStream;
  isReady(stream: SherpaOnlineStream): boolean;
  decode(stream: SherpaOnlineStream): void;
  reset(stream: SherpaOnlineStream): void;
  getResult(stream: SherpaOnlineStream): SherpaKeywordResult;
}

export interface SherpaVadConfig {
  readonly sileroVad: {
    readonly model: string;
    readonly threshold: number;
    readonly minSilenceDuration: number;
    readonly minSpeechDuration: number;
    readonly windowSize: number;
    readonly maxSpeechDuration?: number;
  };
  readonly sampleRate: number;
  readonly numThreads: number;
  readonly provider: string;
  readonly debug: number;
}

export interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  pop(): void;
  reset(): void;
}

export interface SherpaModule {
  readonly version: string;
  readonly KeywordSpotter: new (config: SherpaKeywordSpotterConfig) => SherpaKeywordSpotter;
  readonly Vad: new (config: SherpaVadConfig, bufferSizeInSeconds: number) => SherpaVad;
}

export type SherpaLoader = () => Promise<SherpaModule>;

/** Load the native addon (throws a descriptive error when it is not installed for this platform). */
export const loadSherpa: SherpaLoader = async () => {
  try {
    const mod = (await import('sherpa-onnx-node')) as unknown as {
      default?: SherpaModule;
    } & SherpaModule;
    return (mod.default ?? mod) as SherpaModule;
  } catch (error) {
    throw new Error(
      `sherpa-onnx-node is not available on this platform (${process.platform}-${process.arch}); ` +
        'the kiosk stays touch only. Install the optional dependency to enable voice.',
      { cause: error },
    );
  }
};
