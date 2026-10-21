/**
 * Test doubles for onboarding/report screen tests: a light art kit (plain containers, no renderer),
 * scripted input, a memory logger, an instant voice and a stub Pixi application.
 */

import type { Application } from 'pixi.js';
import { Container } from 'pixi.js';
import { staticLayout } from '../../art/layout.ts';
import type {
  ButtonSpec,
  CharacterSpec,
  LanguageTag,
  LineId,
  ParticleSpec,
  VoicePlayback,
  VoicePlaybackResult,
  VoicePlayOptions,
  VoiceService,
} from '../../core/contracts.ts';
import { createDevClock, DevRng, MemoryLogger } from '../harness/basics.ts';
import { devOnboardingConfig } from '../harness/devServices.ts';
import { ScriptedInput, type TapScript } from '../harness/inputs.ts';
import type {
  HandHintLike,
  OnboardingArt,
  OnboardingConfig,
  OnboardingServices,
  RichBackdrop,
  RichCharacter,
  SizedButton,
} from '../types.ts';

class FakeButton implements SizedButton {
  readonly view = new Container();
  selected = false;
  pulses = 0;
  constructor(
    readonly targetId: string,
    readonly sizePx: number,
  ) {}
  setEnabled(): void {}
  setSelected(s: boolean): void {
    this.selected = s;
  }
  pulse(): void {
    this.pulses++;
  }
  destroy(): void {
    if (!this.view.destroyed) this.view.destroy({ children: true });
  }
}

/** Minimal art kit: correct structure, no drawing. */
export class FakeArt implements OnboardingArt {
  readonly unit = 1;
  readonly characters: CharacterSpec[] = [];
  readonly buttons = new Map<string, FakeButton>();
  createBackdrop(sceneId: RichBackdrop['sceneId']): RichBackdrop {
    const view = new Container();
    return {
      view,
      sceneId,
      setTimeOfDay: async () => undefined,
      setParallax: () => undefined,
      panTo: async () => undefined,
      destroy: () => view.destroy(),
    };
  }
  createCharacter(spec: CharacterSpec): RichCharacter {
    this.characters.push(spec);
    const view = new Container();
    return {
      view,
      spec,
      setExpression: () => undefined,
      speak: async (pb: VoicePlayback) => {
        await pb.ended;
      },
      play: async () => undefined,
      lookAt: () => undefined,
      pointAt: async () => undefined,
      destroy: () => {
        if (!view.destroyed) view.destroy();
      },
    };
  }
  createButton(spec: ButtonSpec): SizedButton {
    const b = new FakeButton(spec.id, 120);
    this.buttons.set(spec.id, b);
    return b;
  }
  createIconButton(spec: Omit<ButtonSpec, 'variant'>): SizedButton {
    const b = new FakeButton(spec.id, 90);
    this.buttons.set(spec.id, b);
    return b;
  }
  createPictureTile(id: string, pictogram: Container): SizedButton {
    const b = new FakeButton(id, 160);
    b.view.addChild(pictogram);
    this.buttons.set(id, b);
    return b;
  }
  createHandHint(): HandHintLike {
    const view = new Container();
    return { view, show: () => undefined, stop: () => undefined, destroy: () => view.destroy() };
  }
  createParticles(_spec: ParticleSpec): {
    view: Container;
    burst(): void;
    stop(): void;
    destroy(): void;
  } {
    const view = new Container();
    return { view, burst: () => undefined, stop: () => undefined, destroy: () => view.destroy() };
  }
  async transition(_k: string, options?: { midpoint?: () => void | Promise<void> }): Promise<void> {
    await options?.midpoint?.();
  }
}

/** Voice that ends immediately (records what was played). */
export class InstantVoice implements VoiceService {
  readonly isDevPlaceholder = false;
  readonly played: LineId[] = [];
  readonly languages: LanguageTag[] = [];
  constructor(
    private lang: LanguageTag = 'en-IN',
    /** Simulated clip length (ms); 0 = ends immediately. */
    public delayMs = 0,
  ) {}
  get language(): LanguageTag {
    return this.lang;
  }
  has(): boolean {
    return true;
  }
  isVoiceForbidden(): boolean {
    return false;
  }
  play(lineId: LineId, options?: VoicePlayOptions): VoicePlayback {
    return this.playSequence([lineId], options);
  }
  playSequence(lineIds: readonly LineId[], _options?: VoicePlayOptions): VoicePlayback {
    this.played.push(...lineIds);
    const r: VoicePlaybackResult = {
      lineId: lineIds[0] ?? '',
      language: this.lang,
      status: 'completed',
      onsetMs: 0,
      endMs: 0,
      durationMs: 0,
      output: 'speaker',
      manifestVersion: '0.0.0',
      sha256: null,
      placeholder: false,
    };
    const ended =
      this.delayMs > 0
        ? new Promise<VoicePlaybackResult>((res) => setTimeout(() => res(r), this.delayMs))
        : Promise.resolve(r);
    return {
      lineId: lineIds[0] ?? '',
      started: Promise.resolve(0),
      ended,
      interrupt: () => undefined,
    };
  }
  replayLast(): VoicePlayback | null {
    return null;
  }
  stop(): void {}
  async preload(): Promise<void> {}
  async setLanguage(language: LanguageTag): Promise<void> {
    this.lang = language;
    this.languages.push(language);
  }
}

/** Silent audio service double. */
export const silentAudio = {
  unlocked: true,
  output: 'speaker' as const,
  masterVolume: 1,
  unlock: async () => undefined,
  playSfx: () => ({
    onsetMs: 0,
    ended: Promise.resolve('completed' as const),
    stop: () => undefined,
  }),
  playMusic: () => undefined,
  stopMusic: () => undefined,
  setAmbience: () => undefined,
  duck: () => () => undefined,
  setMasterVolume: () => undefined,
  stopAll: () => undefined,
};

export interface TestRig {
  readonly services: OnboardingServices;
  readonly config: OnboardingConfig;
  readonly logger: MemoryLogger;
  readonly input: ScriptedInput;
  readonly voice: InstantVoice;
  readonly art: FakeArt;
}

/** Build services for a screen test with a tap script. */
export function makeRig(script: TapScript, overrides: Partial<OnboardingConfig> = {}): TestRig {
  const clock = createDevClock();
  const layout = staticLayout(1920, 1080);
  const logger = new MemoryLogger(undefined, undefined, undefined, clock);
  const input = new ScriptedInput(clock, layout.metrics, script);
  const voice = new InstantVoice();
  const art = new FakeArt();
  const stage = new Container();
  const app = {
    stage,
    renderer: null,
    ticker: null,
    screen: { width: 1920, height: 1080 },
  } as unknown as Application;
  const services: OnboardingServices = {
    app,
    stage,
    layout,
    art,
    audio: silentAudio,
    voice,
    input,
    logger,
    clock,
    rng: new DevRng('0123456789abcdef'),
  };
  const config = devOnboardingConfig({
    pacing: 0,
    surveyTimeoutMs: 30,
    optInTimeoutMs: 30,
    ...overrides,
  });
  return { services, config, logger, input, voice, art };
}
