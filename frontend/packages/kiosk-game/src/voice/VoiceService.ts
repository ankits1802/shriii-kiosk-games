/**
 * Pre-recorded voice by line id x language (VOX-01) implementing the contract {@link VoiceService}.
 *
 * - Resolves clips through the signed manifest; fetches, verifies the sha256 and decodes the Opus clip,
 *   applies the loudness correction and plays it on the engine's voice bus with music/ambience ducked.
 * - Onset is scheduled on `AudioContext.currentTime`; `started` resolves with the session-clock onset
 *   (SKU audio offset applied through `Clock.fromAudioTime`).
 * - Never-voice lines (`voice_forbidden`) are refused on the speaker output (KSK-05).
 * - Logs `audio.played` (key, manifest version, sha256, duration, completed|interrupted, output) and
 *   `instruction_replay` for player replays.
 * - Production plays recorded files only. The Web Speech placeholder exists only when
 *   `import.meta.env.DEV && VITE_DEV_VOICE_PLACEHOLDER === 'true'` (compiled out of production builds)
 *   AND the host asked for it; it shows a "DEV VOICE" badge. Subtitles are never shown.
 * - `speaking` / `onSpeakingChange` report when narration is audible (the walkaway timer pauses).
 */

import type { VoiceAudioHost } from '../audio/AudioEngine.ts';
import type {
  Clock,
  EventLogger,
  LanguageTag,
  LineId,
  Unsubscribe,
  VoicePlayback,
  VoicePlaybackResult,
  VoicePlayOptions,
  VoiceService,
} from '../core/contracts.ts';
import { LINES } from './catalogue/lines.generated.ts';
import type { LineMeta } from './catalogue/types.ts';
import { type ResolvedClip, resolveClip, type VoiceManifest } from './manifest.ts';
import { SpeakingTracker } from './speaking.ts';

/** True only in dev builds with VITE_DEV_VOICE_PLACEHOLDER=true (statically false in production). */
export const DEV_VOICE_PLACEHOLDER_ALLOWED: boolean =
  import.meta.env.DEV === true && import.meta.env.VITE_DEV_VOICE_PLACEHOLDER === 'true';

/** Duck depth for music/ambience under speech. */
export const VOICE_DUCK = 0.65;
/** Interrupt fade (VOX-01). */
export const INTERRUPT_FADE_MS = 30;
/** Scheduling lead so the onset lands on a known AudioContext time. */
const SCHEDULE_LEAD_S = 0.03;

export type ClipFetcher = (url: string) => Promise<ArrayBuffer>;

/** Shape of the dev placeholder module (type-only; erased at build time). */
type PlaceholderModule = typeof import('./devPlaceholder.ts');

export interface VoiceServiceOptions {
  readonly host: VoiceAudioHost;
  readonly manifest: VoiceManifest | null;
  readonly language: LanguageTag;
  readonly clock?: Clock;
  readonly logger?: EventLogger;
  readonly fetchClip?: ClipFetcher;
  /** Request the dev placeholder (honoured only when {@link DEV_VOICE_PLACEHOLDER_ALLOWED}). */
  readonly devPlaceholder?: boolean;
  /** Line catalogue (defaults to the generated catalogue). */
  readonly catalogue?: Readonly<Record<string, LineMeta>>;
  /** Verify clip hashes before playing (default true when WebCrypto exists). */
  readonly verifyHashes?: boolean;
}

const defaultFetch: ClipFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`voice clip ${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
};

async function sha256Hex(data: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface InFlight {
  readonly playback: VoicePlayback;
  interrupt(): void;
}

export class ManifestVoiceService implements VoiceService {
  private lang: LanguageTag;
  private readonly host: VoiceAudioHost;
  private manifest: VoiceManifest | null;
  private readonly clock: Clock | undefined;
  private readonly logger: EventLogger | undefined;
  private readonly fetchClip: ClipFetcher;
  private readonly catalogue: Readonly<Record<string, LineMeta>>;
  private readonly verify: boolean;
  private readonly placeholderRequested: boolean;
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private current: InFlight | null = null;
  private lastInstruction: LineId | null = null;
  private replayCounts = new Map<LineId, number>();
  private readonly speakingTracker = new SpeakingTracker();

  constructor(opts: VoiceServiceOptions) {
    this.host = opts.host;
    this.manifest = opts.manifest;
    this.lang = opts.language;
    this.clock = opts.clock;
    this.logger = opts.logger;
    this.fetchClip = opts.fetchClip ?? defaultFetch;
    this.catalogue = opts.catalogue ?? LINES;
    this.verify = opts.verifyHashes ?? true;
    this.placeholderRequested = opts.devPlaceholder === true;
  }

  get language(): LanguageTag {
    return this.lang;
  }

  /** True while a clip is audible. */
  get speaking(): boolean {
    return this.speakingTracker.speaking;
  }

  onSpeakingChange(listener: (speaking: boolean) => void): Unsubscribe {
    return this.speakingTracker.subscribe(listener);
  }

  get isDevPlaceholder(): boolean {
    return DEV_VOICE_PLACEHOLDER_ALLOWED && this.placeholderRequested;
  }

  /** Swap in a newly verified manifest (OTA content update between sessions). */
  setManifest(manifest: VoiceManifest | null): void {
    this.manifest = manifest;
    this.buffers.clear();
  }

  has(lineId: LineId): boolean {
    if (resolveClip(this.manifest, lineId, this.lang)) return true;
    return this.isDevPlaceholder && lineId in this.catalogue;
  }

  isVoiceForbidden(lineId: LineId): boolean {
    return (
      this.catalogue[lineId]?.voiceForbidden === true ||
      resolveClip(this.manifest, lineId, this.lang)?.voiceForbidden === true
    );
  }

  play(lineId: LineId, options: VoicePlayOptions = {}): VoicePlayback {
    return this.playLines([lineId], options);
  }

  playSequence(lineIds: readonly LineId[], options: VoicePlayOptions = {}): VoicePlayback {
    return this.playLines(lineIds, options);
  }

  replayLast(options: VoicePlayOptions = {}): VoicePlayback | null {
    if (!this.lastInstruction) return null;
    return this.play(this.lastInstruction, { ...options, replay: true });
  }

  stop(): void {
    this.current?.interrupt();
    this.current = null;
  }

  async preload(lineIds: readonly LineId[]): Promise<void> {
    await Promise.all(
      lineIds.map(async (id) => {
        const clip = resolveClip(this.manifest, id, this.lang);
        if (clip) await this.loadBuffer(clip);
      }),
    );
  }

  async setLanguage(language: LanguageTag): Promise<void> {
    if (language === this.lang) return;
    this.stop();
    this.lang = language;
  }

  /* ---------------------------------------------------------------------------------------------- */

  private now(): number {
    return this.clock
      ? this.clock.now()
      : typeof performance !== 'undefined'
        ? performance.now()
        : Date.now();
  }

  private loadBuffer(clip: ResolvedClip): Promise<AudioBuffer | null> {
    const key = `${clip.language}|${clip.key}|${clip.sha256}`;
    const cached = this.buffers.get(key);
    if (cached) return cached;
    const ctx = this.host.context;
    const p = (async (): Promise<AudioBuffer | null> => {
      if (!ctx) return null;
      try {
        const data = await this.fetchClip(clip.url);
        if (this.verify) {
          const hex = await sha256Hex(data);
          // Fail closed: a clip that cannot be verified (no WebCrypto) is treated like a mismatch.
          if (hex === null || hex !== clip.sha256.toLowerCase()) {
            console.error(
              `voice: ${hex === null ? 'cannot verify' : 'sha256 mismatch for'} ${clip.key} (${clip.language}); refusing to play`,
            );
            return null;
          }
        }
        return await ctx.decodeAudioData(data.slice(0));
      } catch (err) {
        console.error(`voice: failed to load ${clip.key} (${clip.language})`, err);
        return null;
      }
    })();
    this.buffers.set(key, p);
    // Do not cache failures: a transient fetch error must not silence the line for the whole session.
    void p.then((b) => {
      if (b === null && this.buffers.get(key) === p) this.buffers.delete(key);
    });
    return p;
  }

  private playLines(lineIds: readonly LineId[], options: VoicePlayOptions): VoicePlayback {
    const first = lineIds[0] ?? '';
    if (options.interruptCurrent !== false) this.stop();
    const output = this.host.output;
    const forbidden = lineIds.some((id) => this.isVoiceForbidden(id));
    if (options.replay) {
      const n = (this.replayCounts.get(first) ?? 0) + 1;
      this.replayCounts.set(first, n);
      this.logger?.log('instruction_replay', { line_id: first, replay_index: n });
    } else if (lineIds.length === 1 && this.isInstruction(first)) {
      this.lastInstruction = first;
    }
    if (forbidden && output === 'speaker') {
      // KSK-05: never-voice clips are refused on the speakers.
      return this.immediate(first, 'interrupted', false);
    }
    const clips = lineIds.map((id) => resolveClip(this.manifest, id, this.lang));
    const anyRecorded = clips.some((c) => c !== null);
    if (anyRecorded && this.host.context && this.host.voiceInput) {
      return this.playRecorded(lineIds, clips, options);
    }
    if (import.meta.env.DEV && import.meta.env.VITE_DEV_VOICE_PLACEHOLDER === 'true') {
      // The only reference to the placeholder module; Vite folds this branch away in production.
      if (this.placeholderRequested)
        return this.playPlaceholder(lineIds, options, import('./devPlaceholder.ts'));
    }
    if (import.meta.env.DEV)
      console.warn(`voice: no recorded clip for ${lineIds.join(', ')} (${this.lang})`);
    return this.immediate(first, 'interrupted', false);
  }

  private isInstruction(lineId: LineId): boolean {
    const cat = this.catalogue[lineId]?.category;
    return cat !== undefined && cat !== 'feedback' && cat !== 'system';
  }

  private immediate(
    lineId: LineId,
    status: 'completed' | 'interrupted',
    placeholder: boolean,
  ): VoicePlayback {
    const t = this.now();
    const result: VoicePlaybackResult = {
      lineId,
      language: this.lang,
      status,
      onsetMs: t,
      endMs: t,
      durationMs: 0,
      output: this.host.output,
      manifestVersion: this.manifest?.version ?? '0.0.0',
      sha256: null,
      placeholder,
    };
    return {
      lineId,
      started: Promise.resolve(t),
      ended: Promise.resolve(result),
      interrupt: () => undefined,
    };
  }

  private playRecorded(
    lineIds: readonly LineId[],
    clips: readonly (ResolvedClip | null)[],
    options: VoicePlayOptions,
  ): VoicePlayback {
    const ctx = this.host.context;
    const dest = this.host.voiceInput;
    const first = lineIds[0] ?? '';
    let interrupted = false;
    let resolveStarted: (t: number) => void = () => undefined;
    let resolveEnded: (r: VoicePlaybackResult) => void = () => undefined;
    const started = new Promise<number>((r) => {
      resolveStarted = r;
    });
    const ended = new Promise<VoicePlaybackResult>((r) => {
      resolveEnded = r;
    });
    const sources: AudioBufferSourceNode[] = [];
    const gains: GainNode[] = [];
    let release: (() => void) | null = null;
    let endSpeaking: (() => void) | null = null;
    let finished = false;

    const finish = (
      status: 'completed' | 'interrupted',
      onsetMs: number,
      played: { clip: ResolvedClip; durationMs: number }[],
    ): void => {
      if (finished) return;
      finished = true;
      release?.();
      release = null;
      endSpeaking?.();
      endSpeaking = null;
      options.signal?.removeEventListener('abort', onAbort);
      const endMs = this.now();
      const durationMs = Math.max(0, endMs - onsetMs);
      for (const p of played) {
        this.logger?.log('audio.played', {
          key: p.clip.key,
          language: p.clip.language,
          manifest_version: this.manifest?.version ?? '0.0.0',
          sha256: p.clip.sha256,
          duration_ms: Math.round(
            status === 'completed' ? p.durationMs : Math.min(p.durationMs, durationMs),
          ),
          status,
          output: this.host.output,
        });
      }
      if (this.current?.playback === playback) this.current = null;
      resolveEnded({
        lineId: first,
        language: this.lang,
        status,
        onsetMs,
        endMs,
        durationMs,
        output: this.host.output,
        manifestVersion: this.manifest?.version ?? '0.0.0',
        sha256: played[0]?.clip.sha256 ?? null,
        placeholder: false,
      });
    };

    let onsetMs = this.now();
    let playedClips: { clip: ResolvedClip; durationMs: number }[] = [];
    const interrupt = (): void => {
      if (finished) return;
      interrupted = true;
      if (ctx) {
        const now = ctx.currentTime;
        for (const g of gains) {
          g.gain.cancelScheduledValues(now);
          g.gain.setValueAtTime(g.gain.value, now);
          g.gain.linearRampToValueAtTime(0, now + INTERRUPT_FADE_MS / 1000);
        }
        for (const s of sources) {
          try {
            s.stop(now + INTERRUPT_FADE_MS / 1000 + 0.01);
          } catch {
            // not started yet
          }
        }
      }
      resolveStarted(onsetMs);
      finish('interrupted', onsetMs, playedClips);
    };
    const onAbort = (): void => interrupt();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const playback: VoicePlayback = { lineId: first, started, ended, interrupt };
    this.current = { playback, interrupt };

    void (async () => {
      const loaded = await Promise.all(
        clips.map((c) =>
          c
            ? this.loadBuffer(c).then((b) => (b ? { clip: c, buffer: b } : null))
            : Promise.resolve(null),
        ),
      );
      const ready = loaded.filter(
        (x): x is { clip: ResolvedClip; buffer: AudioBuffer } => x !== null,
      );
      if (interrupted || finished) return;
      if (!ctx || !dest || ready.length === 0) {
        resolveStarted(this.now());
        finish('interrupted', this.now(), []);
        return;
      }
      if (options.duck !== false) release = this.host.duck(VOICE_DUCK, 120);
      // Gapless: each clip starts exactly where the previous one ends.
      let t = ctx.currentTime + SCHEDULE_LEAD_S;
      const t0 = t;
      let last: AudioBufferSourceNode | null = null;
      for (const r of ready) {
        const src = ctx.createBufferSource();
        src.buffer = r.buffer;
        const g = ctx.createGain();
        g.gain.value = r.clip.gain;
        src.connect(g).connect(dest);
        src.start(t);
        sources.push(src);
        gains.push(g);
        t += r.buffer.duration;
        last = src;
      }
      playedClips = ready.map((r) => ({ clip: r.clip, durationMs: r.buffer.duration * 1000 }));
      endSpeaking = this.speakingTracker.begin();
      onsetMs = this.clock ? this.clock.fromAudioTime(t0) : this.now() + SCHEDULE_LEAD_S * 1000;
      resolveStarted(onsetMs);
      if (last) {
        last.onended = () => {
          for (const g of gains) {
            try {
              g.disconnect();
            } catch {
              // ignore
            }
          }
          if (!interrupted) finish('completed', onsetMs, playedClips);
        };
      }
    })();
    return playback;
  }

  /**
   * DEV ONLY: drives the Web Speech placeholder. The module promise comes from the compile-time-gated
   * branch above, so production bundles contain neither the module nor any speech synthesis code.
   */
  private playPlaceholder(
    lineIds: readonly LineId[],
    options: VoicePlayOptions,
    modulePromise: Promise<PlaceholderModule>,
  ): VoicePlayback {
    const first = lineIds[0] ?? '';
    const target = lineIds.reduce(
      (sum, id) => sum + (this.catalogue[id]?.targetDurationMs ?? 2000),
      0,
    );
    let resolveStarted: (t: number) => void = () => undefined;
    let resolveEnded: (r: VoicePlaybackResult) => void = () => undefined;
    const started = new Promise<number>((r) => {
      resolveStarted = r;
    });
    const ended = new Promise<VoicePlaybackResult>((r) => {
      resolveEnded = r;
    });
    let cancel: () => void = () => undefined;
    let cancelled = false;
    const release = options.duck !== false ? this.host.duck(VOICE_DUCK, 120) : null;
    const playback: VoicePlayback = {
      lineId: first,
      started,
      ended,
      interrupt: () => {
        cancelled = true;
        cancel();
      },
    };
    this.current = { playback, interrupt: playback.interrupt };
    options.signal?.addEventListener('abort', () => playback.interrupt(), { once: true });
    void modulePromise.then((mod) => {
      if (cancelled) {
        release?.();
        const t = this.now();
        resolveStarted(t);
        resolveEnded({
          lineId: first,
          language: this.lang,
          status: 'interrupted',
          onsetMs: t,
          endMs: t,
          durationMs: 0,
          output: this.host.output,
          manifestVersion: this.manifest?.version ?? '0.0.0',
          sha256: null,
          placeholder: true,
        });
        return;
      }
      const endSpeaking = this.speakingTracker.begin();
      const speech = mod.speakPlaceholder(lineIds, target, () => this.now());
      cancel = speech.cancel;
      void speech.started.then(resolveStarted);
      void speech.ended.then(async (r) => {
        release?.();
        endSpeaking();
        const onset = await speech.started;
        if (this.current?.playback === playback) this.current = null;
        resolveEnded({
          lineId: first,
          language: this.lang,
          status: r.status,
          onsetMs: onset,
          endMs: onset + r.durationMs,
          durationMs: r.durationMs,
          output: this.host.output,
          manifestVersion: this.manifest?.version ?? '0.0.0',
          sha256: null,
          placeholder: true,
        });
      });
    });
    return playback;
  }
}

/** Create the voice service. */
export function createVoiceService(opts: VoiceServiceOptions): ManifestVoiceService {
  return new ManifestVoiceService(opts);
}
