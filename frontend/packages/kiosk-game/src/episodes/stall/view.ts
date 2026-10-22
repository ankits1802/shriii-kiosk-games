/**
 * The seam between The Stall's measurement logic and its presentation.
 *
 * {@link StallEpisode} owns timing, input and logging; a {@link StallView} only draws. Every method the
 * measured path calls during a trial is synchronous and fire-and-forget (animations run on the ticker
 * and never delay, gate or obscure a stimulus); only the unmeasured beats (intro, block handovers,
 * outro) return promises the episode awaits. `presentServe` / `presentTone` / `presentProbe` are called
 * inside `presentStimulus`'s render callback, so the stimulus is committed with that animation frame
 * and its onset is the next frame (ENG-01).
 *
 * {@link NullStallView} is the headless implementation (ENG-05: the module runs without rendering for
 * scripted bots and tests).
 */
import type { BlockConfig } from '@shriii/contracts';
import type { VoicePlayback } from '../../core/contracts.ts';
import type { StallGeometry } from './layout.ts';
import type {
  ProbeCode,
  ProbeTrial,
  ServeTrial,
  StallPlan,
  StallTrial,
  ToneCode,
  ToneTrial,
} from './schedule.ts';

/** How a serving trial resolved (drives the customer's reaction; never shown as a score). */
export type ServeResolution = 'served' | 'held_back';

/** Unmeasured story beats between blocks. */
export type StallBeat = 'practice' | 'service' | 'tone_calm' | 'timed_rush' | 'rude_run' | 'probe';

export interface StallView {
  /** Geometry shared with the input targets. */
  readonly geometry: StallGeometry;
  /** Build the scene for this plan (preload art). */
  prepare(plan: StallPlan): Promise<void>;
  /** Cinematic opening; `speech` is the guide's intro line (lip-sync), when voiced. */
  intro(speech: VoicePlayback | null, signal: AbortSignal): Promise<void>;
  /** Handover into a block (lighting, music-independent staging, guide gestures, teaching hints). */
  enterBlock(
    beat: StallBeat,
    block: BlockConfig,
    speech: VoicePlayback | null,
    signal: AbortSignal,
  ): Promise<void>;
  /** The next customer steps up during the ISI (must finish within `durationMs`). */
  customerApproach(trial: StallTrial, durationMs: number): void;
  /** Render a serving stimulus (bubble + plate item). Called inside the stimulus frame. */
  presentServe(trial: ServeTrial): void;
  /** Rush only: the timer lamp burns down over the response window. */
  startTimer(windowMs: number): void;
  /** Immediate tap feedback on the plate (squash). */
  serveTapped(trial: ServeTrial): void;
  /** End of the response window: hand the item over or hold it back; the customer reacts and leaves. */
  resolveServe(trial: ServeTrial, resolution: ServeResolution): void;
  /** Render a tone stimulus (customer's tone + the three tone faces). Called inside the stimulus frame. */
  presentTone(trial: ToneTrial, codes: readonly ToneCode[]): void;
  /** Lip-sync the customer to their line. */
  customerSpeak(trial: ToneTrial, speech: VoicePlayback | null): void;
  /** The player picked a tone (or the window closed: null). */
  toneChosen(trial: ToneTrial, code: ToneCode | null): void;
  /** End of a tone trial: the customer collects the item and leaves. */
  resolveTone(trial: ToneTrial): void;
  /** Render a probe (two offers). Called inside the stimulus frame. */
  presentProbe(trial: ProbeTrial, codes: readonly ProbeCode[]): void;
  /** The player picked an offer (or the window closed: null). */
  probeChosen(trial: ProbeTrial, code: ProbeCode | null): void;
  /** Practice hint: point at the plate (serve), wag at a spoiled item (hold back), or nothing. */
  showHint(kind: 'serve' | 'hold_back' | null): void;
  /** Closing beat; `speech` is the guide's outro line. */
  outro(speech: VoicePlayback | null, signal: AbortSignal): Promise<void>;
  /** Release everything. Idempotent. */
  destroy(): void;
}

/** Headless view: geometry only, no rendering. */
export class NullStallView implements StallView {
  readonly geometry: StallGeometry;
  constructor(geometry: StallGeometry) {
    this.geometry = geometry;
  }
  async prepare(): Promise<void> {}
  async intro(): Promise<void> {}
  async enterBlock(): Promise<void> {}
  customerApproach(): void {}
  presentServe(): void {}
  startTimer(): void {}
  serveTapped(): void {}
  resolveServe(): void {}
  presentTone(): void {}
  customerSpeak(): void {}
  toneChosen(): void {}
  resolveTone(): void {}
  presentProbe(): void {}
  probeChosen(): void {}
  showHint(): void {}
  async outro(): Promise<void> {}
  destroy(): void {}
}
