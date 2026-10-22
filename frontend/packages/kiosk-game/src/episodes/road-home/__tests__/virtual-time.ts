/**
 * Discrete-event virtual time for headless episode runs: a {@link SessionClock} whose timers and
 * animation frames fire in virtual time as soon as every pending microtask has settled, so a
 * 200-second episode plays in well under a second of wall time with exact session timestamps.
 */
import type { TimingProfile } from '../../../core/contracts.ts';
import { DEV_TIMING_PROFILE, SessionClock } from '../../../engine/clock.ts';

/** A certified test profile (zero offsets) so headless sessions grade like a certified kiosk. */
export const TEST_CERTIFIED_PROFILE: TimingProfile = {
  version: 'test-certified-v1',
  certified: true,
  displayOffsetMs: 0,
  audioOutputOffsetMs: 0,
  touchOffsetMs: 0,
  refreshHz: 60,
};

interface Timer {
  readonly at: number;
  readonly seq: number;
  readonly fn: () => void;
}

const FRAME_MS = 1000 / 60;

export class VirtualTime {
  private t = 0;
  private seq = 0;
  private queue: Timer[] = [];
  private readonly cancelled = new Set<number>();
  readonly clock: SessionClock;

  constructor(certified = true) {
    this.clock = new SessionClock({
      anchorPerfMs: 0,
      profile: certified ? TEST_CERTIFIED_PROFILE : DEV_TIMING_PROFILE,
      platform: {
        perfNow: () => this.t,
        wallNow: () => 1_760_000_000_000 + this.t,
        requestFrame: (cb) => {
          const next = (Math.floor(this.t / FRAME_MS) + 1) * FRAME_MS;
          return this.schedule(next, () => cb(next));
        },
        setTimer: (cb, ms) => this.schedule(this.t + Math.max(0, ms), cb),
        clearTimer: (h) => {
          this.cancelled.add(h as number);
        },
      },
    });
  }

  get now(): number {
    return this.t;
  }

  private schedule(at: number, fn: () => void): number {
    const seq = this.seq++;
    this.queue.push({ at, seq, fn });
    return seq;
  }

  private static async settle(): Promise<void> {
    for (let i = 0; i < 4; i += 1) await new Promise<void>((r) => setImmediate(r));
  }

  /** Advance virtual time until `done` settles (or `maxMs` of virtual time passes). */
  async run<T>(done: Promise<T>, maxMs = 600_000): Promise<T> {
    let settled = false;
    let value: T | undefined;
    let error: unknown = null;
    done.then(
      (v) => {
        settled = true;
        value = v;
      },
      (e: unknown) => {
        settled = true;
        error = e ?? new Error('rejected');
      },
    );
    for (;;) {
      await VirtualTime.settle();
      if (settled) break;
      this.queue = this.queue.filter((x) => !this.cancelled.has(x.seq));
      this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.queue.shift();
      if (!next) throw new Error('virtual time: deadlock (no timers pending)');
      if (next.at > maxMs) throw new Error(`virtual time: exceeded ${maxMs} ms`);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    if (error !== null) throw error;
    return value as T;
  }
}
