/**
 * Development voice service that stays silent but takes each line's catalogue duration
 * (`content/i18n/lines.yaml` `target_duration_ms`), so module timing in bots, tests and screenshots
 * matches what pre-recorded narration will take. Never used in production (no audio is produced).
 */
import type {
  Clock,
  LanguageTag,
  LineId,
  Unsubscribe,
  VoicePlayback,
  VoicePlaybackResult,
  VoicePlayOptions,
  VoiceService,
} from '../../../../core/contracts.ts';
import { LINES } from '../../../../voice/catalogue/lines.generated.ts';

export class CatalogueTimedVoice implements VoiceService {
  language: LanguageTag;
  readonly isDevPlaceholder = false;
  private readonly clock: Clock;
  private current: { interrupt(): void } | null = null;
  private last: LineId | null = null;
  private speakingNow = false;
  private readonly listeners = new Set<(s: boolean) => void>();
  /** Lines played so far, in order (tests). */
  readonly played: LineId[] = [];

  constructor(clock: Clock, language: LanguageTag = 'en-IN') {
    this.clock = clock;
    this.language = language;
  }

  get speaking(): boolean {
    return this.speakingNow;
  }

  onSpeakingChange(listener: (speaking: boolean) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  has(lineId: LineId): boolean {
    return lineId in LINES;
  }

  isVoiceForbidden(lineId: LineId): boolean {
    return LINES[lineId]?.voiceForbidden ?? false;
  }

  play(lineId: LineId, options: VoicePlayOptions = {}): VoicePlayback {
    return this.playSequence([lineId], options);
  }

  playSequence(lineIds: readonly LineId[], options: VoicePlayOptions = {}): VoicePlayback {
    if (options.interruptCurrent !== false) this.current?.interrupt();
    const duration = lineIds.reduce((a, id) => a + (LINES[id]?.targetDurationMs ?? 0), 0);
    const lineId = lineIds[0] ?? '';
    this.last = lineId;
    this.played.push(...lineIds);
    const onsetMs = this.clock.now();
    const ac = new AbortController();
    this.setSpeaking(true);
    let resolveEnded: (r: VoicePlaybackResult) => void = () => undefined;
    const ended = new Promise<VoicePlaybackResult>((r) => {
      resolveEnded = r;
    });
    let done = false;
    const finish = (status: 'completed' | 'interrupted'): void => {
      if (done) return;
      done = true;
      ac.abort();
      this.setSpeaking(false);
      const endMs = this.clock.now();
      resolveEnded({
        lineId,
        language: this.language,
        status,
        onsetMs,
        endMs,
        durationMs: endMs - onsetMs,
        output: 'speaker',
        manifestVersion: 'dev-catalogue-timed',
        sha256: null,
        placeholder: true,
      });
    };
    this.clock.delay(duration, ac.signal).then(
      () => finish('completed'),
      () => undefined,
    );
    options.signal?.addEventListener('abort', () => finish('interrupted'), { once: true });
    const handle = { interrupt: () => finish('interrupted') };
    this.current = handle;
    return { lineId, started: Promise.resolve(onsetMs), ended, interrupt: handle.interrupt };
  }

  replayLast(options?: VoicePlayOptions): VoicePlayback | null {
    return this.last ? this.play(this.last, { ...options, replay: true }) : null;
  }

  stop(): void {
    this.current?.interrupt();
  }

  async preload(): Promise<void> {
    // Nothing to decode.
  }

  async setLanguage(language: LanguageTag): Promise<void> {
    this.language = language;
  }

  private setSpeaking(s: boolean): void {
    if (s === this.speakingNow) return;
    this.speakingNow = s;
    for (const l of this.listeners) l(s);
  }
}
