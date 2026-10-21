/**
 * Silero VAD through sherpa-onnx as a {@link VoiceActivityDetector}. Frames of any length are
 * re-blocked into the model's window; speech segments the detector queues are popped and discarded
 * immediately (the adapter only needs the live speech/non-speech decision, never the audio).
 */
import { ASR_SAMPLE_RATE, type VadDecision, type VoiceActivityDetector } from '../types.ts';
import { rmsDbfs } from '../vad.ts';
import { loadSherpa, type SherpaLoader, type SherpaVad } from './binding.ts';

export interface SileroVadOptions {
  readonly model: string;
  readonly threshold?: number;
  readonly minSilenceDuration?: number;
  readonly minSpeechDuration?: number;
  readonly windowSize?: number;
  readonly loader?: SherpaLoader;
}

export class SileroVad implements VoiceActivityDetector {
  private readonly vad: SherpaVad;
  private readonly window: Float32Array;
  private filled = 0;
  private speech = false;

  private constructor(vad: SherpaVad, windowSize: number) {
    this.vad = vad;
    this.window = new Float32Array(windowSize);
  }

  static async create(options: SileroVadOptions): Promise<SileroVad> {
    const sherpa = await (options.loader ?? loadSherpa)();
    const windowSize = options.windowSize ?? 512;
    const vad = new sherpa.Vad(
      {
        sileroVad: {
          model: options.model,
          threshold: options.threshold ?? 0.5,
          minSilenceDuration: options.minSilenceDuration ?? 0.3,
          minSpeechDuration: options.minSpeechDuration ?? 0.1,
          windowSize,
        },
        sampleRate: ASR_SAMPLE_RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      // queue capacity in seconds; segments are popped immediately
      5,
    );
    return new SileroVad(vad, windowSize);
  }

  accept(frame: Float32Array): VadDecision {
    let offset = 0;
    while (offset < frame.length) {
      const n = Math.min(frame.length - offset, this.window.length - this.filled);
      this.window.set(frame.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === this.window.length) {
        this.vad.acceptWaveform(this.window);
        this.window.fill(0);
        this.filled = 0;
        this.speech = this.vad.isDetected();
        while (!this.vad.isEmpty()) this.vad.pop();
      }
    }
    return { speech: this.speech, levelDbfs: rmsDbfs(frame) };
  }

  reset(): void {
    this.window.fill(0);
    this.filled = 0;
    this.speech = false;
    this.vad.reset();
  }
}
