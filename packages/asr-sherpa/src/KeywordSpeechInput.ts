/**
 * Closed-vocabulary {@link SpeechInput} (VOX-04) on a keyword-spotting engine.
 *
 * Rules enforced here:
 * - Availability requires policy `asr_enabled`, core consent, a grammar prompt that passed VOX-06
 *   (`voice_enabled`), a prepared engine and a session that is not in touch-only mode because of noise
 *   (VOX-05). Consent, opt-ins, bands and private reports are touch only by rule.
 * - The microphone is opened inside `listen()` only and closed before `listen()` resolves (on detection,
 *   window close via the AbortSignal, the hard `max_listen_ms` cap, noise or error).
 * - The VAD runs only on frames of that open window; only speech (plus a short pre-roll) reaches the
 *   engine. The first window's non-speech frames give the session noise floor (`env.noise_dbfs`).
 * - Proposals are restricted to the intersection of the caller's vocabulary and the prompt's grammar
 *   vocabulary, so every voice result maps to an on-screen icon (always mirrored by an icon). Below the
 *   propose threshold nothing is returned; ambiguous hits (two codes at the same tier) return nothing.
 * - No audio retained: every incoming frame is zero-filled after use, the pre-roll ring is wiped when
 *   the window closes and the engine session is disposed. No top-k alternatives are produced.
 */
import type { SpeechInput } from '@shriii/kiosk-game/core/contracts';
import { isTouchOnlyPrompt } from './grammar.ts';
import { SampleRing } from './ringBuffer.ts';
import {
  ASR_SAMPLE_RATE,
  type AsrGate,
  type AsrGrammar,
  type AudioFrameSource,
  type CaptureHandle,
  type KeywordDetection,
  type KeywordEngine,
  type KeywordSession,
  type MicStateEvent,
  type ProposalEvent,
  type VoiceActivityDetector,
} from './types.ts';
import { EnergyVad } from './vad.ts';

export interface SpeechResult {
  readonly label: string | null;
  readonly confidence: number | null;
}

export interface KeywordSpeechInputOptions {
  readonly engine: KeywordEngine;
  readonly source: AudioFrameSource;
  readonly grammar: AsrGrammar;
  readonly gate: AsrGate;
  /** Defaults to {@link EnergyVad}. */
  readonly vad?: VoiceActivityDetector;
  /** Non-speech audio needed in the first window before the noise floor is decided. */
  readonly noiseMeasureMs?: number;
  /**
   * Upper bound on the engine's end-of-window flush. A remote or wedged engine can never keep the
   * adapter busy (which would block every later prompt): past this, the window is decided on the
   * detections already seen.
   */
  readonly finishTimeoutMs?: number;
  /** Timer functions (injectable for tests). */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

type Listener<T> = (event: T) => void;
type EndReason = NonNullable<MicStateEvent['reason']>;

const NONE: SpeechResult = Object.freeze({ label: null, confidence: null });

export class KeywordSpeechInput implements SpeechInput {
  private readonly engine: KeywordEngine;
  private readonly source: AudioFrameSource;
  private readonly grammar: AsrGrammar;
  private readonly gate: AsrGate;
  private readonly vad: VoiceActivityDetector;
  private readonly ring: SampleRing;
  private readonly noiseMeasureMs: number;
  private readonly finishTimeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly micListeners = new Set<Listener<MicStateEvent>>();
  private readonly proposalListeners = new Set<Listener<ProposalEvent>>();
  private activePrompt: string | null = null;
  private touchOnly = false;
  private noiseDecided = false;
  private noiseLevels: number[] = [];
  private noiseMs = 0;
  private measuredNoiseDbfs: number | null = null;
  private micOpen = false;

  constructor(options: KeywordSpeechInputOptions) {
    this.engine = options.engine;
    this.source = options.source;
    this.grammar = options.grammar;
    this.gate = options.gate;
    this.vad = options.vad ?? new EnergyVad();
    this.noiseMeasureMs = options.noiseMeasureMs ?? 300;
    this.finishTimeoutMs = options.finishTimeoutMs ?? 2000;
    this.ring = new SampleRing(
      Math.round((ASR_SAMPLE_RATE * this.grammar.policy.vad_preroll_ms) / 1000),
    );
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Session noise floor from the first window (dBFS), null until measured. Logged as `env.noise_dbfs`. */
  get noiseDbfs(): number | null {
    return this.measuredNoiseDbfs;
  }

  /** True once the session switched to touch only because of noise (VOX-05). */
  get touchOnlyBecauseOfNoise(): boolean {
    return this.touchOnly;
  }

  get isMicOpen(): boolean {
    return this.micOpen;
  }

  onMicState(listener: Listener<MicStateEvent>): () => void {
    this.micListeners.add(listener);
    return () => this.micListeners.delete(listener);
  }

  /** Live proposals while the window is open (the UI highlights the matching icon). */
  onProposal(listener: Listener<ProposalEvent>): () => void {
    this.proposalListeners.add(listener);
    return () => this.proposalListeners.delete(listener);
  }

  isAvailable(promptId: string): boolean {
    if (isTouchOnlyPrompt(promptId)) return false;
    if (this.touchOnly || !this.engine.ready) return false;
    if (!this.gate.asrEnabled() || !this.gate.coreConsentGranted()) return false;
    const prompt = this.grammar.prompts[promptId];
    return prompt?.voice_enabled === true && prompt.vocabulary.length > 0;
  }

  /** Samples still held by the adapter (always 0 outside an open window). */
  retainedSampleCount(): number {
    return this.ring.nonZeroSamples();
  }

  listen(
    promptId: string,
    vocabulary: readonly string[],
    signal: AbortSignal,
  ): Promise<SpeechResult> {
    if (signal.aborted || !this.isAvailable(promptId) || this.activePrompt !== null) {
      return Promise.resolve(NONE);
    }
    const prompt = this.grammar.prompts[promptId];
    const allowed = new Set(
      vocabulary.filter((c) => prompt?.vocabulary.includes(c) && c in this.grammar.keywords),
    );
    if (allowed.size === 0) return Promise.resolve(NONE);

    const policy = this.grammar.policy;
    const tiers = this.grammar.tiers;
    let session: KeywordSession;
    try {
      session = this.engine.createSession([...allowed]);
    } catch {
      return Promise.resolve(NONE); // engine failure: touch carries on, the mic is never opened
    }
    this.activePrompt = promptId;
    this.vad.reset();
    this.ring.wipe();

    return new Promise<SpeechResult>((resolve) => {
      const best = new Map<string, number>(); // code -> highest tier
      let finished = false;
      let inSpeech = false;
      // Settles with the capture handle once the source has opened (null if opening failed).
      let opening: Promise<CaptureHandle | null> = Promise.resolve(null);
      let settleTimer: unknown = null;
      let proposed: string | null = null;

      const record = (dets: readonly KeywordDetection[]): void => {
        for (const d of dets) {
          if (!allowed.has(d.code) || d.tier < 0 || d.tier >= tiers.length) continue;
          best.set(d.code, Math.max(best.get(d.code) ?? -1, d.tier));
        }
      };

      const decide = (): SpeechResult => {
        if (best.size === 0) return NONE;
        const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
        const [topCode, topTier] = ranked[0] as [string, number];
        if (ranked.length > 1 && (ranked[1] as [string, number])[1] === topTier) return NONE; // ambiguous
        const confidence = (tiers[topTier] as { confidence: number }).confidence;
        if (confidence < policy.min_propose_confidence) return NONE;
        return { label: topCode, confidence };
      };

      const finish = (reason: EndReason): void => {
        if (finished) return;
        finished = true;
        this.clearTimer(capTimer);
        if (settleTimer !== null) this.clearTimer(settleTimer);
        signal.removeEventListener('abort', onAbort);
        // Wait for a still-pending open to settle so the real capture is closed before the mic is
        // reported closed and before the result is returned (deferred one microtask so a finish
        // triggered synchronously inside source.open() still sees the opening promise).
        void Promise.resolve()
          .then(() => opening)
          .then((h) => (h ? h.close() : undefined))
          .catch(() => undefined)
          .then(async () => {
            this.setMic(false, promptId, reason);
            if (reason !== 'noise' && reason !== 'error') {
              try {
                record(await this.boundedFinish(session));
              } catch {
                /* engine flush failure: decide on what we have */
              }
            }
            session.dispose();
            this.ring.wipe();
            this.vad.reset();
            this.activePrompt = null;
            resolve(reason === 'noise' || reason === 'error' ? NONE : decide());
          });
      };

      const onAbort = (): void => finish('window_closed');
      const capTimer = this.setTimer(() => finish('timeout'), policy.max_listen_ms);
      signal.addEventListener('abort', onAbort, { once: true });

      const onFrame = (frame: Float32Array): void => {
        try {
          if (finished) return;
          const decision = this.vad.accept(frame);
          if (!decision.speech) this.trackNoise(decision.levelDbfs, frame.length);
          if (this.touchOnly) {
            finish('noise');
            return;
          }
          if (decision.speech) {
            if (!inSpeech) {
              for (const view of this.ring.views()) session.accept(view);
              this.ring.wipe();
              inSpeech = true;
            }
            session.accept(frame);
          } else {
            inSpeech = false;
            this.ring.push(frame);
          }
          record(session.poll());
          const current = decide();
          if (current.label !== null && current.confidence !== null) {
            if (current.label !== proposed) {
              proposed = current.label;
              this.emitProposal({ promptId, code: current.label, confidence: current.confidence });
            }
            if (current.confidence >= policy.min_commit_confidence || policy.settle_ms === 0) {
              finish('detected');
            } else if (settleTimer === null) {
              settleTimer = this.setTimer(() => finish('detected'), policy.settle_ms);
            }
          }
        } finally {
          frame.fill(0);
        }
      };

      this.setMic(true, promptId);
      opening = this.source
        .open(onFrame, () => finish('error'))
        .then(
          (h) => h,
          () => {
            finish('error');
            return null;
          },
        );
    });
  }

  private boundedFinish(session: KeywordSession): Promise<readonly KeywordDetection[]> {
    let timer: unknown = null;
    const timeout = new Promise<readonly KeywordDetection[]>((resolve) => {
      timer = this.setTimer(() => resolve([]), this.finishTimeoutMs);
    });
    return Promise.race([Promise.resolve(session.finish()), timeout]).finally(() => {
      if (timer !== null) this.clearTimer(timer);
    });
  }

  private trackNoise(levelDbfs: number, samples: number): void {
    if (this.noiseDecided) return;
    this.noiseLevels.push(levelDbfs);
    this.noiseMs += (1000 * samples) / ASR_SAMPLE_RATE;
    if (this.noiseMs < this.noiseMeasureMs) return;
    const sorted = [...this.noiseLevels].sort((a, b) => a - b);
    this.measuredNoiseDbfs = sorted[Math.floor(sorted.length / 2)] ?? null;
    this.noiseDecided = true;
    this.noiseLevels = [];
    if (
      this.measuredNoiseDbfs !== null &&
      this.measuredNoiseDbfs > this.grammar.policy.noise_max_dbfs
    ) {
      this.touchOnly = true;
    }
  }

  private setMic(open: boolean, promptId: string, reason?: EndReason): void {
    this.micOpen = open;
    const event: MicStateEvent = reason
      ? { state: open ? 'open' : 'closed', promptId, reason }
      : { state: open ? 'open' : 'closed', promptId };
    for (const l of this.micListeners) l(event);
  }

  private emitProposal(event: ProposalEvent): void {
    for (const l of this.proposalListeners) l(event);
  }
}
