/**
 * Session monotonic clock (ENG-01). Time zero is the session anchor; values are
 * `performance.now()`-based milliseconds that never decrease. Wall time is informational only.
 */
import type { Clock, TimingProfile } from '../core/contracts.ts';

/** Development timing profile: not certified, zero offsets (events carry `uncertified_timing_profile`). */
export const DEV_TIMING_PROFILE: TimingProfile = {
  version: 'uncertified-dev',
  certified: false,
  displayOffsetMs: 0,
  audioOutputOffsetMs: 0,
  touchOffsetMs: 0,
  refreshHz: 60,
};

/** Minimal AudioContext surface used for clock mapping (keeps the clock free of DOM types in tests). */
export interface AudioClockSource {
  readonly currentTime: number;
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
}

/** Injectable platform hooks (all default to the browser globals). */
export interface ClockPlatform {
  /** `performance.now()` equivalent. */
  readonly perfNow: () => number;
  /** `Date.now()` equivalent (wall clock, informational). */
  readonly wallNow: () => number;
  /** `requestAnimationFrame` equivalent; the callback receives a DOMHighResTimeStamp. */
  readonly requestFrame: (callback: (timestamp: number) => void) => number;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

function defaultPlatform(): ClockPlatform {
  const perf = globalThis.performance;
  const raf =
    typeof globalThis.requestAnimationFrame === 'function'
      ? (cb: (t: number) => void) => globalThis.requestAnimationFrame(cb)
      : (cb: (t: number) => void) =>
          globalThis.setTimeout(() => cb(perf.now()), 16) as unknown as number;
  return {
    perfNow: () => perf.now(),
    wallNow: () => Date.now(),
    requestFrame: raf,
    setTimer: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimer: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/** ISO-8601 with the local UTC offset, e.g. `2026-10-21T10:20:00.000+05:30`. */
export function formatWallTime(
  epochMs: number,
  offsetMinutes = -new Date(epochMs).getTimezoneOffset(),
): string {
  const local = new Date(epochMs + offsetMinutes * 60_000);
  const iso = local.toISOString().slice(0, 23); // YYYY-MM-DDTHH:mm:ss.sss (shifted to local)
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${iso}${sign}${hh}:${mm}`;
}

/** The engine's {@link Clock} implementation. */
export class SessionClock implements Clock {
  readonly anchorPerfMs: number;
  readonly profile: TimingProfile;
  private readonly platform: ClockPlatform;
  private last = 0;
  private audio: AudioClockSource | null = null;

  constructor(
    options: {
      readonly profile?: TimingProfile;
      readonly platform?: Partial<ClockPlatform>;
      /** Anchor in performance time (default: now). */
      readonly anchorPerfMs?: number;
    } = {},
  ) {
    this.platform = { ...defaultPlatform(), ...options.platform };
    this.profile = options.profile ?? DEV_TIMING_PROFILE;
    this.anchorPerfMs = options.anchorPerfMs ?? this.platform.perfNow();
  }

  /** Attach the AudioContext whose clock `fromAudioTime` maps. */
  attachAudio(source: AudioClockSource | null): void {
    this.audio = source;
  }

  now(): number {
    const t = this.platform.perfNow() - this.anchorPerfMs;
    // Guard against platform clock anomalies: session time never decreases.
    if (t > this.last) this.last = t;
    return this.last;
  }

  wallTime(): string {
    return formatWallTime(this.platform.wallNow());
  }

  fromPerformanceTime(perfMs: number): number {
    return perfMs - this.anchorPerfMs;
  }

  fromPointerTime(pointerTimeStamp: number): number {
    return this.fromPerformanceTime(pointerTimeStamp) - this.profile.touchOffsetMs;
  }

  fromAudioTime(audioContextSeconds: number): number {
    const source = this.audio;
    let perfMs: number;
    if (source) {
      const stamp = source.getOutputTimestamp?.();
      if (
        stamp &&
        typeof stamp.contextTime === 'number' &&
        typeof stamp.performanceTime === 'number' &&
        stamp.performanceTime > 0
      ) {
        perfMs = stamp.performanceTime + (audioContextSeconds - stamp.contextTime) * 1000;
      } else {
        perfMs = this.platform.perfNow() + (audioContextSeconds - source.currentTime) * 1000;
      }
    } else {
      perfMs = this.platform.perfNow();
    }
    return this.fromPerformanceTime(perfMs) + this.profile.audioOutputOffsetMs;
  }

  nextFrame(): Promise<number> {
    return new Promise((resolve) => {
      this.platform.requestFrame((timestamp) => {
        resolve(this.fromPerformanceTime(timestamp) + this.profile.displayOffsetMs);
      });
    });
  }

  delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => {
        this.platform.clearTimer(handle);
        reject(signal?.reason);
      };
      const handle = this.platform.setTimer(
        () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
