/**
 * Dev services for gallery previews of onboarding and report screens: the real art kit and audio
 * engine, a pointer input service (optionally auto-played by a script to reach a state for screenshots),
 * an in-memory logger and a voice service.
 *
 * Voice: when the dev placeholder is enabled at build time (VITE_DEV_VOICE_PLACEHOLDER) the real voice
 * service speaks reference text; otherwise a timed *silent* voice simulates each recorded line's target
 * duration so pacing and lip-sync are realistic without any TTS.
 */
import { type Application, Container } from 'pixi.js';
import { createArtKit, type MelaArtKit } from '../../art/ArtKit.ts';
import { createViewportLayout } from '../../art/layout.ts';
import { parseQualityTier } from '../../art/quality.ts';
import { AudioEngine } from '../../audio/AudioEngine.ts';
import type {
  LanguageTag,
  LineId,
  VoicePlayback,
  VoicePlaybackResult,
  VoicePlayOptions,
  VoiceService,
} from '../../core/contracts.ts';
import { LINES } from '../../voice/catalogue/lines.generated.ts';
import { createVoiceService, DEV_VOICE_PLACEHOLDER_ALLOWED } from '../../voice/VoiceService.ts';
import type { OnboardingConfig, OnboardingServices } from '../types.ts';
import { DEFAULT_ONBOARDING_CONFIG } from '../types.ts';
import { createDevClock, DEV_LANGUAGES, DevRng, MemoryLogger } from './basics.ts';
import { PointerInput, type TapScript } from './inputs.ts';

/** Silent voice that "plays" each line for its catalogue target duration (dev previews only). */
export class TimedSilentVoice implements VoiceService {
  readonly isDevPlaceholder = false;
  private current: { interrupt(): void } | null = null;
  private last: LineId | null = null;
  constructor(
    private lang: LanguageTag,
    private readonly now: () => number,
    private readonly speed = 1,
  ) {}
  get language(): LanguageTag {
    return this.lang;
  }
  has(lineId: LineId): boolean {
    return lineId in LINES;
  }
  isVoiceForbidden(lineId: LineId): boolean {
    return LINES[lineId]?.voiceForbidden === true;
  }
  play(lineId: LineId, options: VoicePlayOptions = {}): VoicePlayback {
    return this.playSequence([lineId], options);
  }
  playSequence(lineIds: readonly LineId[], options: VoicePlayOptions = {}): VoicePlayback {
    if (options.interruptCurrent !== false) this.current?.interrupt();
    const first = lineIds[0] ?? '';
    this.last = first;
    const dur =
      lineIds.reduce((s, id) => s + (LINES[id]?.targetDurationMs ?? 1500), 0) * this.speed;
    const onset = this.now();
    let done: (r: VoicePlaybackResult) => void = () => undefined;
    const ended = new Promise<VoicePlaybackResult>((r) => {
      done = r;
    });
    const make = (status: 'completed' | 'interrupted'): VoicePlaybackResult => {
      const end = this.now();
      return {
        lineId: first,
        language: this.lang,
        status,
        onsetMs: onset,
        endMs: end,
        durationMs: end - onset,
        output: 'speaker',
        manifestVersion: '0.0.0',
        sha256: null,
        placeholder: false,
      };
    };
    const timer = setTimeout(() => done(make('completed')), dur);
    const ctl = {
      interrupt: () => {
        clearTimeout(timer);
        done(make('interrupted'));
      },
    };
    options.signal?.addEventListener('abort', ctl.interrupt, { once: true });
    this.current = ctl;
    return { lineId: first, started: Promise.resolve(onset), ended, interrupt: ctl.interrupt };
  }
  replayLast(options: VoicePlayOptions = {}): VoicePlayback | null {
    return this.last ? this.play(this.last, options) : null;
  }
  stop(): void {
    this.current?.interrupt();
  }
  async preload(): Promise<void> {}
  async setLanguage(language: LanguageTag): Promise<void> {
    this.lang = language;
  }
}

export interface DevServices {
  readonly services: OnboardingServices;
  readonly config: OnboardingConfig;
  readonly art: MelaArtKit;
  readonly logger: MemoryLogger;
  readonly input: PointerInput;
  readonly audio: AudioEngine;
  dispose(): void;
}

/** Default dev onboarding config (warm-up timing mirrors content/games/shared/warmup.json L2). */
export function devOnboardingConfig(overrides: Partial<OnboardingConfig> = {}): OnboardingConfig {
  return {
    ...DEFAULT_ONBOARDING_CONFIG,
    languages: DEV_LANGUAGES,
    packVersion: '0.1.0',
    manifestHash: 'a'.repeat(64),
    consentScriptId: 'consent.core.v0',
    consentVersionHash: 'b'.repeat(64),
    policyVersion: '0.1.0',
    practice: { tapWindowMs: 2500, holdRequiredMs: 1200, passesRequired: 2, maxAttempts: 4 },
    ...overrides,
  };
}

/** Build dev services on an application (gallery). */
export function createDevServices(
  app: Application,
  options: { readonly autoplay?: TapScript | null; readonly language?: LanguageTag } = {},
): DevServices {
  const params =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const layout = createViewportLayout(app, Number(params.get('pxPerMm') ?? 4));
  const art = createArtKit({
    app,
    layout,
    quality: {
      tier: parseQualityTier(params.get('tier')),
      reducedMotion: params.has('reducedMotion'),
    },
  });
  const clock = createDevClock();
  const logger = new MemoryLogger(undefined, undefined, undefined, clock);
  const input = new PointerInput(
    clock,
    layout.metrics,
    app.canvas,
    () => ({ w: layout.width, h: layout.height }),
    options.autoplay ?? null,
  );
  const audio = new AudioEngine({ clock });
  const language = options.language ?? 'en-IN';
  const voice: VoiceService = DEV_VOICE_PLACEHOLDER_ALLOWED
    ? createVoiceService({
        host: audio.voiceHost(),
        manifest: null,
        language,
        clock,
        logger,
        devPlaceholder: true,
      })
    : new TimedSilentVoice(language, () => clock.now());
  const stage = new Container();
  stage.label = 'dev-stage';
  app.stage.addChildAt(stage, 0);
  // Session abort signal: dispose() aborts it so running screens stop cleanly (as a session wipe does).
  const abort = new AbortController();
  const services: OnboardingServices = {
    signal: abort.signal,
    app,
    stage,
    layout,
    art,
    audio,
    voice,
    input,
    logger,
    clock,
    rng: new DevRng('00c0ffee00c0ffee'),
  };
  // Expose recorded events for the Playwright QA run and manual inspection.
  (globalThis as { __shriiiEvents?: unknown }).__shriiiEvents = logger.events;
  return {
    services,
    config: devOnboardingConfig(),
    art,
    logger,
    input,
    audio,
    dispose: () => {
      abort.abort();
      voice.stop();
      audio.stopAll();
      input.dispose();
      art.destroy();
      layout.dispose();
      for (const c of app.stage.removeChildren()) c.destroy({ children: true });
    },
  };
}
