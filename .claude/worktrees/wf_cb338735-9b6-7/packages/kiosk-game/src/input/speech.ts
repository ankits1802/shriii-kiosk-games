/**
 * Optional closed-vocabulary voice adapters (VOX-04). Touch always works without any of these.
 * The production adapter (sherpa-onnx keyword spotting) is a later feature; until then the kiosk
 * uses {@link NullSpeechInput}. A scripted adapter supports tests and headless bots.
 */
import type { SpeechInput } from '../core/contracts.ts';

/** No ASR: every prompt is touch only. */
export class NullSpeechInput implements SpeechInput {
  isAvailable(): boolean {
    return false;
  }
  listen(
    _promptId: string,
    _vocabulary: readonly string[],
    signal: AbortSignal,
  ): Promise<{ readonly label: string | null; readonly confidence: number | null }> {
    return new Promise((resolve) => {
      if (signal.aborted) resolve({ label: null, confidence: null });
      else
        signal.addEventListener('abort', () => resolve({ label: null, confidence: null }), {
          once: true,
        });
    });
  }
}

/** Scripted ASR for tests/bots: answers prompts from a queue after a delay. */
export class ScriptedSpeechInput implements SpeechInput {
  private readonly answers = new Map<
    string,
    { label: string | null; confidence: number; afterMs: number }
  >();

  /** Queue the answer for a prompt id. */
  answer(promptId: string, label: string | null, confidence = 0.9, afterMs = 0): void {
    this.answers.set(promptId, { label, confidence, afterMs });
  }

  isAvailable(promptId: string): boolean {
    return this.answers.has(promptId);
  }

  listen(
    promptId: string,
    vocabulary: readonly string[],
    signal: AbortSignal,
  ): Promise<{ readonly label: string | null; readonly confidence: number | null }> {
    const a = this.answers.get(promptId);
    return new Promise((resolve) => {
      if (!a || signal.aborted) {
        resolve({ label: null, confidence: null });
        return;
      }
      const t = setTimeout(() => {
        const label = a.label !== null && vocabulary.includes(a.label) ? a.label : null;
        resolve({ label, confidence: label === null ? null : a.confidence });
      }, a.afterMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve({ label: null, confidence: null });
        },
        { once: true },
      );
    });
  }
}
