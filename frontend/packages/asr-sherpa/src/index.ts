/**
 * @shriii/asr-sherpa — closed-vocabulary, opt-in-per-prompt speech input (VOX-04).
 *
 * Core (platform-neutral): the {@link KeywordSpeechInput} adapter implementing the kiosk's
 * `SpeechInput` contract, grammar validation, energy VAD, pre-roll ring buffer and proposal helpers.
 * Engines and sources live in sub-entries: `@shriii/asr-sherpa/sherpa` (Node / Electron main, native
 * sherpa-onnx addon) and `@shriii/asr-sherpa/web` (browser microphone).
 */
export {
  GrammarError,
  isTouchOnlyPrompt,
  parseGrammar,
  TOUCH_ONLY_PROMPT_PREFIXES,
  toSherpaKeywords,
} from './grammar.ts';
export {
  KeywordSpeechInput,
  type KeywordSpeechInputOptions,
  type SpeechResult,
} from './KeywordSpeechInput.ts';
export {
  assertVoiceSubset,
  type ClassifyOptions,
  classifyProposal,
  type ProposalAction,
} from './proposal.ts';
export {
  type MessageTransport,
  portTransport,
  RemoteKeywordEngine,
  serveKeywordEngine,
} from './remote.ts';
export { SampleRing } from './ringBuffer.ts';
export { ArrayFrameSource, type ArrayFrameSourceOptions } from './sources.ts';
export {
  ASR_SAMPLE_RATE,
  type AsrGate,
  type AsrGrammar,
  type AsrRuntimePolicy,
  type AudioFrameSource,
  type CaptureHandle,
  type ConfidenceTier,
  type GrammarPhrase,
  type KeywordDetection,
  type KeywordEngine,
  type KeywordSession,
  type MicStateEvent,
  type PromptPolicy,
  type ProposalEvent,
  type VadDecision,
  type VoiceActivityDetector,
} from './types.ts';
export { EnergyVad, type EnergyVadOptions, rmsDbfs } from './vad.ts';
