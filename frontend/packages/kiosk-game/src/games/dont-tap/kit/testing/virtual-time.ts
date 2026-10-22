/**
 * Virtual time for headless runs: a {@link SessionClock} platform whose timers and animation frames
 * run on a simulated timeline. `runUntil` advances to the next due timer only after the promise
 * microtask queue has drained, so a 90 s module plays in well under a second while every
 * `clock.delay`, `nextFrame` and pointer timestamp keeps its exact simulated time.
 */

import type { TimingProfile } from '../../../../core/contracts.ts';
import type { ClockPlatform } from '../../../../engine/clock.ts';
import { SessionClock } from '../../../../engine/clock.ts';

/** Certified synthetic timing profile for frame-exact virtual time (tests and bot exports only). */
export const VIRTUAL_BENCH: TimingProfile = {
  version: 'virtual-bench',
  certified: true,
  displayOffsetMs: 0,
  audioOutputOffsetMs: 0,
  touchOffsetMs: 0,
  refreshHz: 60,
};

interface Timer {
  readonly id: number;
  readonly t: number;
  readonly cb: () => void;
  cancelled: boolean;
}

/** Simulated timeline (ms). */
export class VirtualTime {
  /** Simulated `performance.now()`. */
  now = 1000;
  readonly frameMs: number;
  private seq = 0;
  private readonly timers: Timer[] = [];

  constructor(refreshHz = 60) {
    this.frameMs = 1000 / refreshHz;
  }

  /** Platform hooks for {@link SessionClock}. */
  platform(): ClockPlatform {
    return {
      perfNow: () => this.now,
      wallNow: () => Date.UTC(2026, 9, 22, 6, 0, 0) + this.now,
      requestFrame: (cb) => {
        const next = (Math.floor(this.now / this.frameMs) + 1) * this.frameMs;
        return this.schedule(next, () => cb(next));
      },
      setTimer: (cb, ms) => this.schedule(this.now + Math.max(0, ms), cb),
      clearTimer: (h) => {
        const t = this.timers.find((x) => x.id === h);
        if (t) t.cancelled = true;
      },
    };
  }

  /**
   * A session clock on this timeline. Virtual time is frame-exact, so the default profile is a
   * certified synthetic bench (`timing_flag: ok`); pass a profile to test uncertified handling.
   */
  clock(profile: TimingProfile = VIRTUAL_BENCH): SessionClock {
    return new SessionClock({ platform: this.platform(), profile });
  }

  private schedule(t: number, cb: () => void): number {
    const id = ++this.seq;
    this.timers.push({ id, t, cb, cancelled: false });
    return id;
  }

  /** Pending (non-cancelled) timers. */
  get pending(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  /**
   * Run the timeline until `done` settles (or `maxMs` of simulated time passes). Returns the value.
   * Throws when the timeline runs dry before `done` settles (a deadlock in the module under test).
   */
  async runUntil<T>(done: Promise<T>, maxMs = 600_000): Promise<T> {
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
    const limit = this.now + maxMs;
    while (!settled) {
      await drain();
      if (settled) break;
      const live = this.timers.filter((t) => !t.cancelled);
      if (live.length === 0) {
        await drain();
        if (settled) break;
        throw new Error(`virtual time ran dry at ${Math.round(this.now)} ms before completion`);
      }
      live.sort((a, b) => a.t - b.t || a.id - b.id);
      const next = live[0] as Timer;
      if (next.t > limit) throw new Error(`virtual time limit ${maxMs} ms exceeded`);
      next.cancelled = true;
      this.timers.splice(this.timers.indexOf(next), 1);
      if (next.t > this.now) this.now = next.t;
      next.cb();
      // Compact cancelled timers now and then.
      if (this.timers.length > 512) {
        for (let i = this.timers.length - 1; i >= 0; i -= 1) {
          if (this.timers[i]?.cancelled) this.timers.splice(i, 1);
        }
      }
    }
    if (error !== null) throw error;
    return value as T;
  }
}

/** Let pending promise callbacks (and their follow-ups) run. */
async function drain(): Promise<void> {
  // Microtask turns first (cheap), then one macrotask turn for anything scheduled with real timers.
  for (let i = 0; i < 24; i += 1) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
}
