/**
 * Silent stand-ins for the audio and voice services, used until the audio engine (src/audio) is
 * wired in and in headless runs. They honour the contracts (handles resolve, onsets are on the
 * session clock, voice-forbidden lines are refused on speakers) but produce no sound. No runtime TTS.
 */
import type { LanguageTag } from '@shriii/contracts';
import type {
  AmbienceId,
  AudioHandle,
  AudioOutput,
  AudioService,
  Clock,
  LineId,
  MusicCueId,
  SfxId,
  SfxOptions,
  Unsubscribe,
  VoicePlayback,
  VoicePlaybackResult,
  VoicePlayOptions,
  VoiceService,
} from '../../core/contracts.ts';
import { SpeakingTracker } from '../../voice/speaking.ts';

export class SilentAudioService implements AudioService {
  private readonly clock: Clock;
  unlocked = false;
  output: AudioOutput = 'speaker';
  masterVolume = 0.8;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  async unlock(): Promise<void> {
    this.unlocked = true;
  }

  playSfx(_id: SfxId, options?: SfxOptions): AudioHandle {
    return {
      onsetMs: options?.atMs ?? this.clock.now(),
      ended: Promise.resolve('completed'),
      stop: () => undefined,
    };
  }

  playMusic(_cue: MusicCueId): void {}
  stopMusic(): void {}
  setAmbience(_id: AmbienceId | null): void {}
  duck(): () => void {
    return () => undefined;
  }
  setMasterVolume(volume: number): void {
    this.masterVolume = Math.min(1, Math.max(0, volume));
  }
  stopAll(): void {}
}

/** Voice lines resolve after `lineMs` of session time (0 = immediately). */
export class SilentVoiceService implements VoiceService {
  language: LanguageTag;
  readonly isDevPlaceholder = false;
  private readonly clock: Clock;
  private readonly lineMs: number;
  private readonly forbidden: ReadonlySet<string>;
  private readonly output: () => AudioOutput;
  private current: { interrupt(): void } | null = null;
  private lastInstruction: LineId | null = null;
  private readonly speakingTracker = new SpeakingTracker();

  /** True while a (silent, timed) clip is "playing". */
  get speaking(): boolean {
    return this.speakingTracker.speaking;
  }

  onSpeakingChange(listener: (speaking: boolean) => void): Unsubscribe {
    return this.speakingTracker.subscribe(listener);
  }

  constructor(
    clock: Clock,
    options: {
      readonly language?: LanguageTag;
      readonly lineMs?: number;
      readonly voiceForbidden?: readonly LineId[];
      readonly output?: () => AudioOutput;
    } = {},
  ) {
    this.clock = clock;
    this.language = options.language ?? 'en-IN';
    this.lineMs = options.lineMs ?? 0;
    this.forbidden = new Set(options.voiceForbidden ?? []);
    this.output = options.output ?? (() => 'speaker');
  }

  has(_lineId: LineId): boolean {
    return true;
  }

  isVoiceForbidden(lineId: LineId): boolean {
    return this.forbidden.has(lineId);
  }

  play(lineId: LineId, options: VoicePlayOptions = {}): VoicePlayback {
    return this.playSequence([lineId], options);
  }

  playSequence(lineIds: readonly LineId[], options: VoicePlayOptions = {}): VoicePlayback {
    if (options.interruptCurrent !== false) this.current?.interrupt();
    const onsetMs = this.clock.now();
    const refused = this.output() === 'speaker' && lineIds.some((l) => this.forbidden.has(l));
    const duration = refused ? 0 : this.lineMs * lineIds.length;
    const lineId = lineIds[0] ?? '';
    if (lineIds.length > 0) this.lastInstruction = lineIds[lineIds.length - 1] ?? null;
    let interruptFn: () => void = () => undefined;
    const ended = new Promise<VoicePlaybackResult>((resolve) => {
      const ac = new AbortController();
      const endSpeaking = refused || duration <= 0 ? () => undefined : this.speakingTracker.begin();
      let done = false;
      const finish = (status: 'completed' | 'interrupted'): void => {
        if (done) return;
        done = true;
        ac.abort();
        endSpeaking();
        const endMs = this.clock.now();
        resolve({
          lineId,
          language: this.language,
          status,
          onsetMs,
          endMs,
          durationMs: endMs - onsetMs,
          output: this.output(),
          manifestVersion: '0.0.0',
          sha256: null,
          placeholder: false,
        });
      };
      interruptFn = () => finish('interrupted');
      options.signal?.addEventListener('abort', () => finish('interrupted'), { once: true });
      this.clock.delay(refused ? 0 : duration, ac.signal).then(
        () => finish(refused ? 'interrupted' : 'completed'),
        () => undefined,
      );
    });
    const playback: VoicePlayback = {
      lineId,
      started: Promise.resolve(onsetMs),
      ended,
      interrupt: () => interruptFn(),
    };
    this.current = playback;
    return playback;
  }

  replayLast(options?: VoicePlayOptions): VoicePlayback | null {
    return this.lastInstruction
      ? this.play(this.lastInstruction, { ...options, replay: true })
      : null;
  }

  stop(): void {
    this.current?.interrupt();
  }

  async preload(): Promise<void> {}

  async setLanguage(language: LanguageTag): Promise<void> {
    this.language = language;
  }
}
