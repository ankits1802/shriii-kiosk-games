/**
 * Timing utilities (ENG-01, KSK-14): stimulus onset on the next animation frame after render,
 * frame-stall detection, timing flags, signed latency and RT validity marking.
 */
import type { Clock, LatencyAnchor, TimingFlag } from '../core/contracts.ts';

/** Severity order used when several timing problems coincide (most severe first). */
const FLAG_PRIORITY: readonly TimingFlag[] = [
  'clock_anomaly',
  'visibility_hidden',
  'audio_underrun',
  'late_onset',
  'frame_drop',
  'degrade_mode',
  'uncertified_timing_profile',
  'ok',
];

/** Combine timing flags into the single most severe one. */
export function combineTimingFlags(
  ...flags: readonly (TimingFlag | null | undefined)[]
): TimingFlag {
  let best: TimingFlag = 'ok';
  for (const f of flags) {
    if (f && FLAG_PRIORITY.indexOf(f) < FLAG_PRIORITY.indexOf(best)) best = f;
  }
  return best;
}

/** Options for {@link FrameMonitor}. */
export interface FrameMonitorOptions {
  /** Nominal refresh rate; a frame longer than `stallFactor` x nominal period is a stall. */
  readonly refreshHz: number;
  /** Default 1.5 (one dropped frame at 60 Hz is a 33 ms gap > 25 ms). */
  readonly stallFactor?: number;
  /** How many recent frame deltas to keep for p99 (default 600 = 10 s at 60 Hz). */
  readonly historySize?: number;
  readonly requestFrame?: (cb: (t: number) => void) => number;
  readonly cancelFrame?: (handle: number) => void;
  /** Returns true while the document is hidden. */
  readonly isHidden?: () => boolean;
}

/**
 * Watches animation frames, records stalls (in session time) and answers "was there a stall or a
 * hidden page between t0 and t1?" so trials can carry `timing_flag: frame_drop | visibility_hidden`.
 */
export class FrameMonitor {
  private readonly periodMs: number;
  private readonly stallMs: number;
  private readonly historySize: number;
  private readonly deltas: number[] = [];
  /** [startMs, endMs] session-time intervals with stalls or hidden page. */
  private readonly stalls: { start: number; end: number; flag: TimingFlag }[] = [];
  private lastFrameMs: number | null = null;
  private handle: number | null = null;
  private running = false;
  private droppedFrames = 0;
  private readonly clock: Clock;
  private readonly opts: FrameMonitorOptions;

  constructor(clock: Clock, options: FrameMonitorOptions) {
    this.clock = clock;
    this.opts = options;
    this.periodMs = 1000 / options.refreshHz;
    this.stallMs = this.periodMs * (options.stallFactor ?? 1.5);
    this.historySize = options.historySize ?? 600;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const raf =
      this.opts.requestFrame ?? ((cb: (t: number) => void) => globalThis.requestAnimationFrame(cb));
    const loop = (timestamp: number): void => {
      if (!this.running) return;
      this.recordFrame(this.clock.fromPerformanceTime(timestamp));
      this.handle = raf(loop);
    };
    this.handle = raf(loop);
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      const cancel = this.opts.cancelFrame ?? ((h: number) => globalThis.cancelAnimationFrame?.(h));
      cancel(this.handle);
    }
    this.handle = null;
    this.lastFrameMs = null;
  }

  /** Feed one frame timestamp (session ms). Public for tests and for renderers with their own ticker. */
  recordFrame(frameMs: number): void {
    const prev = this.lastFrameMs;
    this.lastFrameMs = frameMs;
    if (prev === null) return;
    const delta = frameMs - prev;
    if (delta <= 0) return;
    this.deltas.push(delta);
    if (this.deltas.length > this.historySize) this.deltas.shift();
    const hidden = this.opts.isHidden?.() ?? false;
    if (hidden || delta > this.stallMs) {
      this.droppedFrames += Math.max(1, Math.round(delta / this.periodMs) - 1);
      this.stalls.push({
        start: prev,
        end: frameMs,
        flag: hidden ? 'visibility_hidden' : 'frame_drop',
      });
      if (this.stalls.length > 256) this.stalls.shift();
    }
  }

  /** Most severe flag for stalls overlapping [fromMs, toMs] (session time). */
  flagBetween(fromMs: number, toMs: number): TimingFlag {
    let flag: TimingFlag = 'ok';
    for (const s of this.stalls) {
      if (s.end >= fromMs && s.start <= toMs) flag = combineTimingFlags(flag, s.flag);
    }
    return flag;
  }

  /** 99th percentile frame time over the recent history (device_health). */
  frameTimeP99(): number {
    if (this.deltas.length === 0) return this.periodMs;
    const sorted = [...this.deltas].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? this.periodMs;
  }

  get dropped(): number {
    return this.droppedFrames;
  }

  get nominalPeriodMs(): number {
    return this.periodMs;
  }
}

/** Estimate the display refresh rate from `frames` animation frames (median delta). */
export async function measureRefreshHz(
  requestFrame: (cb: (t: number) => void) => number = (cb) => globalThis.requestAnimationFrame(cb),
  frames = 30,
): Promise<number> {
  const stamps: number[] = [];
  await new Promise<void>((resolve) => {
    const step = (t: number): void => {
      stamps.push(t);
      if (stamps.length > frames) resolve();
      else requestFrame(step);
    };
    requestFrame(step);
  });
  const deltas = stamps
    .slice(1)
    .map((t, i) => t - (stamps[i] ?? t))
    .filter((d) => d > 0);
  if (deltas.length === 0) return 60;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)] ?? 1000 / 60;
  // Snap to common panel rates to avoid logging 59.94 vs 60 noise.
  const hz = 1000 / median;
  const common = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];
  const nearest = common.reduce((a, b) => (Math.abs(b - hz) < Math.abs(a - hz) ? b : a));
  return Math.abs(nearest - hz) / nearest < 0.05 ? nearest : Math.round(hz);
}

/** Result of presenting a stimulus. All times are session ms. */
export interface PresentedOnset {
  readonly requestedOnsetMs: number;
  /** Next rAF after the render commit, plus the per-SKU display offset. */
  readonly presentedOnsetMs: number;
  readonly timingFlag: TimingFlag;
}

/**
 * Render a stimulus and resolve with its presented onset: the timestamp of the animation frame after
 * the one in which `render` ran (the frame where the change is on screen), plus the display offset.
 * `late_onset` is flagged when presentation lags the request by more than one frame plus tolerance;
 * `frame_drop` when a stall overlaps the onset; `uncertified_timing_profile` on uncertified SKUs.
 */
export async function presentStimulus(
  clock: Clock,
  render: () => void,
  options: {
    readonly requestedOnsetMs?: number;
    readonly monitor?: FrameMonitor;
    /** Extra tolerance before `late_onset` (default half a frame). */
    readonly toleranceMs?: number;
  } = {},
): Promise<PresentedOnset> {
  const requestedOnsetMs = options.requestedOnsetMs ?? clock.now();
  // Render inside a frame callback so the change is committed with that frame.
  await clock.nextFrame();
  render();
  const presentedOnsetMs = await clock.nextFrame();
  const period = options.monitor?.nominalPeriodMs ?? 1000 / clock.profile.refreshHz;
  const tolerance = options.toleranceMs ?? period / 2;
  const lag = presentedOnsetMs - clock.profile.displayOffsetMs - requestedOnsetMs;
  const late = lag > 2 * period + tolerance ? 'late_onset' : 'ok';
  const stall = options.monitor?.flagBetween(requestedOnsetMs, presentedOnsetMs) ?? 'ok';
  const cert = clock.profile.certified ? 'ok' : 'uncertified_timing_profile';
  return {
    requestedOnsetMs,
    presentedOnsetMs,
    timingFlag: combineTimingFlags(late, stall, cert),
  };
}

/** Signed latency from an anchor (ENG-01). Negative values are barge-ins. */
export function signedLatency(
  responseMs: number,
  anchorMs: number,
): { readonly latencyMs: number; readonly bargeIn: boolean } {
  const latencyMs = Math.round((responseMs - anchorMs) * 1000) / 1000;
  return { latencyMs, bargeIn: latencyMs < 0 };
}

/** RT validity classes used to mark invalid RTs (they stay in the log; indicators exclude them). */
export type RtValidity = 'valid' | 'premature' | 'anticipatory' | 'timeout';

/**
 * Classify a latency. `anticipatoryMs` comes from the module config (e.g. Don't-Tap
 * `constraints.premature_threshold_ms`); never hard-code it.
 */
export function classifyRt(latencyMs: number | null, anticipatoryMs: number | null): RtValidity {
  if (latencyMs === null) return 'timeout';
  if (latencyMs < 0) return 'premature';
  if (anticipatoryMs !== null && latencyMs < anticipatoryMs) return 'anticipatory';
  return 'valid';
}

/** Default latency anchor for a prompt: spoken prompts anchor on audio end (ENG-01). */
export function defaultLatencyAnchor(spoken: boolean): LatencyAnchor {
  return spoken ? 'audio_end' : 'visual_onset';
}

/**
 * Re-derive a frame-count-independent duration: stimulus durations are stored in ms and stay in ms in
 * degrade mode; this returns how many frames the duration spans at `refreshHz` and the realised ms.
 */
export function framesForDuration(
  durationMs: number,
  refreshHz: number,
): { readonly frames: number; readonly realisedMs: number; readonly errorMs: number } {
  const period = 1000 / refreshHz;
  const frames = Math.max(1, Math.round(durationMs / period));
  const realisedMs = frames * period;
  return { frames, realisedMs, errorMs: realisedMs - durationMs };
}
