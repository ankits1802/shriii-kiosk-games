/**
 * Procedural Web Audio engine implementing the contract {@link AudioService}.
 *
 * Graph:
 *   music -> musicDuck ┐
 *   ambience -> ambDuck ┼-> master -> limiter (DynamicsCompressor) -> destination
 *   sfx ───────────────┤
 *   voice ─────────────┘
 *   music/sfx/ambience also send to a generated courtyard reverb (convolver) feeding the master.
 *
 * - Ducking: music and ambience duck under voice; overlapping duck requests take the deepest amount and
 *   release independently.
 * - Mute-safe: without Web Audio (SSR, tests, blocked autoplay) every call is a harmless no-op and
 *   handles resolve immediately.
 * - Onsets are reported on the session clock (`Clock.fromAudioTime`, SKU audio offset applied) when a
 *   clock is provided.
 */
import type {
  AmbienceId,
  AudioHandle,
  AudioOutput,
  AudioService,
  Clock,
  MusicCueId,
  SfxId,
  SfxOptions,
} from '../core/contracts.ts';
import { AmbienceController } from './ambience.ts';
import { MusicDirector } from './music/MusicDirector.ts';
import { SFX } from './sfx/library.ts';
import { createReverbImpulse, createSynthKit, type SynthKit } from './synth.ts';

/** Factory for an AudioContext (injectable for tests). Returns null when Web Audio is unavailable. */
export type AudioContextFactory = () => AudioContext | null;

/** Default factory: a real AudioContext in the browser, null elsewhere. */
export const defaultAudioContextFactory: AudioContextFactory = () => {
  try {
    const Ctor =
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
  } catch {
    return null;
  }
};

/** What the voice service needs from the engine. */
export interface VoiceAudioHost {
  readonly context: AudioContext | null;
  /** Voice bus input (already routed through master + limiter). */
  readonly voiceInput: AudioNode | null;
  duck(amount: number, rampMs?: number): () => void;
  readonly output: AudioOutput;
}

export interface AudioEngineOptions {
  readonly contextFactory?: AudioContextFactory;
  readonly clock?: Clock;
  /** Default master volume (0..1). */
  readonly masterVolume?: number;
  /** Maximum master volume allowed by policy (volume boost a11y may raise towards this). */
  readonly maxVolume?: number;
  readonly output?: AudioOutput;
}

/** Bus levels (relative mix). */
export const BUS_LEVELS = {
  music: 0.55,
  ambience: 0.45,
  sfx: 0.8,
  voice: 1.0,
  reverbReturn: 0.32,
} as const;

export class AudioEngine implements AudioService {
  private readonly factory: AudioContextFactory;
  private readonly clock: Clock | undefined;
  private ctx: AudioContext | null = null;
  private kit: SynthKit | null = null;
  private nodes: {
    master: GainNode;
    limiter: DynamicsCompressorNode;
    music: GainNode;
    musicDuck: GainNode;
    ambience: GainNode;
    ambDuck: GainNode;
    sfx: GainNode;
    voice: GainNode;
    reverb: ConvolverNode;
    reverbSend: GainNode;
  } | null = null;
  private music: MusicDirector | null = null;
  private ambienceCtl: AmbienceController | null = null;
  private volume: number;
  private readonly maxVolume: number;
  private readonly ducks = new Map<number, { amount: number; rampMs: number }>();
  private duckSeq = 0;
  private _output: AudioOutput;
  private initialised = false;

  constructor(options: AudioEngineOptions = {}) {
    this.factory = options.contextFactory ?? defaultAudioContextFactory;
    this.clock = options.clock;
    this.volume = options.masterVolume ?? 0.8;
    this.maxVolume = options.maxVolume ?? 1;
    this._output = options.output ?? 'speaker';
  }

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get output(): AudioOutput {
    return this._output;
  }

  /** Route change (headset plugged/unplugged). */
  setOutput(output: AudioOutput): void {
    this._output = output;
  }

  get masterVolume(): number {
    return this.volume;
  }

  /** The underlying context (null when unavailable). */
  get context(): AudioContext | null {
    this.ensureGraph();
    return this.ctx;
  }

  /** Build the graph lazily (contexts may only be created after a gesture on some platforms). */
  private ensureGraph(): boolean {
    if (this.initialised) return this.ctx !== null;
    this.initialised = true;
    const ctx = this.factory();
    if (!ctx) return false;
    try {
      this.ctx = ctx;
      this.kit = createSynthKit(ctx);
      const master = ctx.createGain();
      master.gain.value = this.volume;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 3;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.18;
      master.connect(limiter).connect(ctx.destination);
      const music = ctx.createGain();
      music.gain.value = BUS_LEVELS.music;
      const musicDuck = ctx.createGain();
      musicDuck.gain.value = 1;
      music.connect(musicDuck).connect(master);
      const ambience = ctx.createGain();
      ambience.gain.value = BUS_LEVELS.ambience;
      const ambDuck = ctx.createGain();
      ambDuck.gain.value = 1;
      ambience.connect(ambDuck).connect(master);
      const sfx = ctx.createGain();
      sfx.gain.value = BUS_LEVELS.sfx;
      sfx.connect(master);
      const voice = ctx.createGain();
      voice.gain.value = BUS_LEVELS.voice;
      voice.connect(master);
      const reverb = ctx.createConvolver();
      reverb.buffer = createReverbImpulse(ctx);
      const reverbSend = ctx.createGain();
      reverbSend.gain.value = BUS_LEVELS.reverbReturn;
      reverb.connect(reverbSend).connect(master);
      const musicSend = ctx.createGain();
      musicSend.gain.value = 0.5;
      musicDuck.connect(musicSend).connect(reverb);
      const sfxSend = ctx.createGain();
      sfxSend.gain.value = 0.25;
      sfx.connect(sfxSend).connect(reverb);
      const ambSend = ctx.createGain();
      ambSend.gain.value = 0.3;
      ambDuck.connect(ambSend).connect(reverb);
      this.nodes = {
        master,
        limiter,
        music,
        musicDuck,
        ambience,
        ambDuck,
        sfx,
        voice,
        reverb,
        reverbSend,
      };
      this.music = new MusicDirector(this.kit, music);
      this.ambienceCtl = new AmbienceController(this.kit, ambience);
      return true;
    } catch {
      this.ctx = null;
      this.kit = null;
      this.nodes = null;
      return false;
    }
  }

  async unlock(): Promise<void> {
    if (!this.ensureGraph() || !this.ctx) return;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        // stays locked; everything remains a no-op
      }
    }
  }

  private nowMs(t: number | null): number {
    if (t === null) return this.clock ? this.clock.now() : 0;
    return this.clock ? this.clock.fromAudioTime(t) : t * 1000;
  }

  private silentHandle(): AudioHandle {
    return {
      onsetMs: this.nowMs(null),
      ended: Promise.resolve('completed'),
      stop: () => undefined,
    };
  }

  playSfx(id: SfxId, options: SfxOptions = {}): AudioHandle {
    if (
      !this.ensureGraph() ||
      !this.ctx ||
      !this.kit ||
      !this.nodes ||
      this.ctx.state !== 'running'
    )
      return this.silentHandle();
    const ctx = this.ctx;
    let t = ctx.currentTime + 0.005;
    if (options.atMs !== undefined && this.clock) {
      const nowMs = this.clock.now();
      t = ctx.currentTime + Math.max(0, (options.atMs - nowMs) / 1000);
    }
    const out = ctx.createGain();
    out.gain.value = Math.max(0, Math.min(1, options.volume ?? 1));
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, options.pan ?? 0));
    out.connect(pan).connect(this.nodes.sfx);
    const synth = SFX[id];
    const dur = synth(this.kit, out, t);
    let done: (s: 'completed' | 'interrupted') => void = () => undefined;
    const ended = new Promise<'completed' | 'interrupted'>((r) => {
      done = r;
    });
    let finished = false;
    const timer = setTimeout(
      () => {
        finished = true;
        try {
          pan.disconnect();
        } catch {
          // ignore
        }
        done('completed');
      },
      (t - ctx.currentTime + dur) * 1000 + 50,
    );
    return {
      onsetMs: this.nowMs(t),
      ended,
      stop: (fadeMs = 30) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const now = ctx.currentTime;
        out.gain.cancelScheduledValues(now);
        out.gain.setValueAtTime(out.gain.value, now);
        out.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
        setTimeout(() => {
          try {
            pan.disconnect();
          } catch {
            // ignore
          }
        }, fadeMs + 20);
        done('interrupted');
      },
    };
  }

  playMusic(cue: MusicCueId, options: { readonly fadeMs?: number } = {}): void {
    if (!this.ensureGraph() || !this.music) return;
    this.music.play(cue, options.fadeMs ?? 1500);
  }

  stopMusic(fadeMs = 1200): void {
    this.music?.stop(fadeMs);
  }

  /** Blend the tension layer by block condition (0..1). Never driven by performance. */
  setTension(level: number): void {
    this.music?.setTension(level);
  }

  /** Current music cue (diagnostics). */
  get currentMusic(): MusicCueId | null {
    return this.music?.current ?? null;
  }

  setAmbience(id: AmbienceId | null, options: { readonly fadeMs?: number } = {}): void {
    if (!this.ensureGraph() || !this.ambienceCtl) return;
    this.ambienceCtl.set(id, options.fadeMs ?? 2000);
  }

  /** Current ambience (diagnostics). */
  get currentAmbience(): AmbienceId | null {
    return this.ambienceCtl?.current ?? null;
  }

  duck(amount: number, rampMs = 180): () => void {
    const id = ++this.duckSeq;
    this.ducks.set(id, { amount: Math.max(0, Math.min(1, amount)), rampMs });
    this.applyDuck(rampMs);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.ducks.delete(id);
      this.applyDuck(rampMs * 2);
    };
  }

  /** Effective duck amount (max of active requests). */
  get duckAmount(): number {
    let m = 0;
    for (const d of this.ducks.values()) m = Math.max(m, d.amount);
    return m;
  }

  private applyDuck(rampMs: number): void {
    if (!this.ctx || !this.nodes) return;
    const level = 1 - this.duckAmount;
    const now = this.ctx.currentTime;
    for (const g of [this.nodes.musicDuck, this.nodes.ambDuck]) {
      g.gain.cancelScheduledValues(now);
      g.gain.setTargetAtTime(Math.max(0.05, level), now, Math.max(0.01, rampMs / 3000));
    }
  }

  setMasterVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(this.maxVolume, volume));
    if (this.ctx && this.nodes) {
      const now = this.ctx.currentTime;
      this.nodes.master.gain.cancelScheduledValues(now);
      this.nodes.master.gain.setTargetAtTime(this.volume, now, 0.03);
    }
  }

  stopAll(): void {
    this.music?.kill();
    this.ambienceCtl?.kill();
    this.ducks.clear();
    if (this.ctx && this.nodes) {
      const now = this.ctx.currentTime;
      // Short silence on every bus, then restore levels for the next session.
      for (const [g, level] of [
        [this.nodes.sfx, BUS_LEVELS.sfx],
        [this.nodes.voice, BUS_LEVELS.voice],
        [this.nodes.music, BUS_LEVELS.music],
        [this.nodes.ambience, BUS_LEVELS.ambience],
      ] as const) {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(0, now);
        g.gain.setValueAtTime(level, now + 0.2);
      }
      this.applyDuck(10);
    }
  }

  /** Host interface for the voice service. */
  voiceHost(): VoiceAudioHost {
    this.ensureGraph();
    const self = this;
    return {
      get context() {
        return self.ctx;
      },
      get voiceInput() {
        return self.nodes?.voice ?? null;
      },
      duck: (amount, rampMs) => self.duck(amount, rampMs),
      get output() {
        return self._output;
      },
    };
  }

  /** Close the context (app teardown). */
  async dispose(): Promise<void> {
    this.stopAll();
    try {
      await this.ctx?.close();
    } catch {
      // ignore
    }
    this.ctx = null;
    this.nodes = null;
  }
}
