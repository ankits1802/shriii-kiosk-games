/**
 * Engine-agnostic building blocks of the closed-vocabulary speech adapter (VOX-04).
 *
 * Privacy contract (PRV-03, VOX-04): audio exists only as RAM frames while a consented prompt window
 * is open. Every frame handed to the adapter is zero-filled after it has been consumed, the pre-roll
 * ring buffer is wiped when the window closes, and engines copy samples into their own feature
 * pipeline and drop it on `dispose()`. Nothing is written to storage, logs or telemetry.
 */

/** Sample rate of every frame exchanged with engines and VADs (Hz). */
export const ASR_SAMPLE_RATE = 16_000;

/** An open capture. `close()` must stop the microphone track (the mic indicator goes off). */
export interface CaptureHandle {
  close(): Promise<void>;
}

/**
 * Microphone (or test) source delivering mono float32 frames at {@link ASR_SAMPLE_RATE}.
 * The source must hand out a fresh buffer per frame: the consumer zero-fills it after use.
 */
export interface AudioFrameSource {
  open(
    onFrame: (frame: Float32Array) => void,
    onError: (error: unknown) => void,
  ): Promise<CaptureHandle>;
}

/** One keyword hit. `tier` indexes {@link AsrGrammar.tiers} (higher = stricter threshold). */
export interface KeywordDetection {
  readonly code: string;
  readonly tier: number;
  /** Seconds since the start of the session's audio (engine clock). */
  readonly timeSec: number;
}

/** A decoding session for one prompt window. */
export interface KeywordSession {
  /** Feed samples; the engine copies them (the caller wipes its buffer afterwards). */
  accept(samples: Float32Array): void;
  /** Detections decoded since the last poll. */
  poll(): KeywordDetection[];
  /**
   * Flush pending audio at window end and return the remaining detections (asynchronous for engines
   * that run in another process or worker).
   */
  finish(): KeywordDetection[] | Promise<KeywordDetection[]>;
  /** Drop every buffer and stream state held for this window. */
  dispose(): void;
}

/** A keyword-spotting engine (sherpa-onnx KWS in production; scripted mocks in tests). */
export interface KeywordEngine {
  readonly name: string;
  /** Load models and compile the grammar's keyword list (slow; call at boot, never inside a window). */
  prepare(grammar: AsrGrammar): Promise<void>;
  readonly ready: boolean;
  /** Start a session restricted to `vocabulary` (codes from the grammar). */
  createSession(vocabulary: readonly string[]): KeywordSession;
  dispose(): void;
}

/** Per-frame voice-activity decision. */
export interface VadDecision {
  readonly speech: boolean;
  /** RMS level of the frame in dBFS (used for the session noise floor, VOX-05). */
  readonly levelDbfs: number;
}

/** Voice-activity detector; runs only on frames from an open prompt window. */
export interface VoiceActivityDetector {
  accept(frame: Float32Array): VadDecision;
  reset(): void;
}

/** One phrase that maps to a closed response code. Tokens are model units (e.g. BPE pieces). */
export interface GrammarPhrase {
  /** Space-separated model tokens, e.g. `▁YES` or `▁HA AN`. Produced offline by tools/asr-bakeoff. */
  readonly tokens: string;
  /** Optional per-phrase boosting score (sherpa `:score`). */
  readonly boost?: number;
  /** Human-readable form for review sheets (never shown on the kiosk). */
  readonly text?: string;
}

/** Confidence tier: a KWS threshold and the empirical precision measured for it in the bake-off. */
export interface ConfidenceTier {
  readonly keywords_threshold: number;
  /** Calibrated confidence (held-out precision of detections at this tier), 0..1. */
  readonly confidence: number;
}

/** Per-prompt voice policy written by the bake-off (VOX-06). */
export interface PromptPolicy {
  /** Codes that may be spoken for this prompt (must be a subset of its touch options). */
  readonly vocabulary: readonly string[];
  /** True only when the prompt passed the VOX-06 accuracy and fairness policy. */
  readonly voice_enabled: boolean;
}

/** Runtime thresholds (written into the language pack's ASR config from the bake-off YAML policy). */
export interface AsrRuntimePolicy {
  /** Below this calibrated confidence nothing is proposed. */
  readonly min_propose_confidence: number;
  /** At or above this calibrated confidence a voice answer may commit without a confirming tap. */
  readonly min_commit_confidence: number;
  /** Session switches to touch only when the first window's noise floor exceeds this (VOX-05). */
  readonly noise_max_dbfs: number;
  /** Hard cap on how long the mic may stay open in one window, even if the caller never aborts. */
  readonly max_listen_ms: number;
  /** Audio kept before VAD onset so word starts are not lost. */
  readonly vad_preroll_ms: number;
  /** After the first detection, keep decoding this long to collect other tiers or competing codes. */
  readonly settle_ms: number;
}

/** Language-pack ASR configuration consumed by the adapter (`asr-grammars/<lang>/asr-config.json`). */
export interface AsrGrammar {
  readonly schema_version: '1.0';
  readonly language: string;
  readonly grammar_version: string;
  readonly engine: string;
  readonly model_id: string;
  readonly keywords: Readonly<Record<string, { readonly phrases: readonly GrammarPhrase[] }>>;
  readonly tiers: readonly ConfidenceTier[];
  readonly prompts: Readonly<Record<string, PromptPolicy>>;
  readonly policy: AsrRuntimePolicy;
}

/** Live checks outside the grammar (policy file, consent state). */
export interface AsrGate {
  /** Site/session policy `asr_enabled`. */
  asrEnabled(): boolean;
  /** Core consent granted for this session. */
  coreConsentGranted(): boolean;
}

/** Mic lifecycle notifications (for `prompt_window_open/close` integration checks and the mic ring UI). */
export interface MicStateEvent {
  readonly state: 'open' | 'closed';
  readonly promptId: string;
  readonly reason?: 'detected' | 'window_closed' | 'timeout' | 'noise' | 'error';
}

/** A proposal made while the window is still open, so the UI can highlight the matching icon. */
export interface ProposalEvent {
  readonly promptId: string;
  readonly code: string;
  readonly confidence: number;
}
