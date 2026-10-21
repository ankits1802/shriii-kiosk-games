/**
 * Soft-cap wrap-up signal (ENG-05). The module host requests a wrap-up at `budget.soft_cap_ms`; the
 * session controller requests one when the play state's time is about to run out. A module that
 * honours it finishes the current trial, keeps block minimums, plays its outro and completes.
 */
import type { Unsubscribe, WrapUpReason, WrapUpSignal } from '../core/contracts.ts';

/** Owner side of a {@link WrapUpSignal}. */
export class WrapUpController {
  private readonly ac = new AbortController();
  private readonly listeners = new Set<(reason: WrapUpReason) => void>();
  private currentReason: WrapUpReason | null = null;
  private atMs: number | null = null;
  private readonly now: () => number;
  /** The read-only signal handed to the module. */
  readonly signal: WrapUpSignal;

  constructor(now: () => number) {
    this.now = now;
    const self = this;
    this.signal = {
      get requested() {
        return self.currentReason !== null;
      },
      get reason() {
        return self.currentReason;
      },
      get requestedAtMs() {
        return self.atMs;
      },
      signal: this.ac.signal,
      onRequest(listener: (reason: WrapUpReason) => void): Unsubscribe {
        if (self.currentReason !== null) {
          listener(self.currentReason);
          return () => undefined;
        }
        self.listeners.add(listener);
        return () => {
          self.listeners.delete(listener);
        };
      },
    };
  }

  /** Request a wrap-up; only the first request counts. Returns true when this call requested it. */
  request(reason: WrapUpReason): boolean {
    if (this.currentReason !== null) return false;
    this.currentReason = reason;
    this.atMs = this.now();
    this.ac.abort(reason);
    const ls = [...this.listeners];
    this.listeners.clear();
    for (const l of ls) {
      try {
        l(reason);
      } catch (err) {
        console.error('[wrap-up] listener failed', err);
      }
    }
    return true;
  }

  get requested(): boolean {
    return this.currentReason !== null;
  }
}
