/**
 * Renderer watchdog policy (KSK-01: a killed or hung renderer relaunches to attract within 5 s).
 *
 * Pure state machine; `main/index.ts` feeds it Electron events and executes the returned actions.
 * - Renderer gone (crash, kill, OOM): reload after `reloadDelayMs`.
 * - Unresponsive, or heartbeat silence beyond `hangTimeoutMs` once heartbeats started: force-crash
 *   the renderer (which then reloads through the gone path).
 * - Crash loop (`maxCrashes` within `windowMs`): relaunch the whole app process once; if the loop
 *   continues after `maxRelaunches` relaunches inside `relaunchWindowMs`, show the static
 *   out-of-service page instead of spinning (operators see it on the heartbeat).
 */

export interface WatchdogPolicy {
  readonly reloadDelayMs: number;
  readonly hangTimeoutMs: number;
  readonly maxCrashes: number;
  readonly windowMs: number;
  readonly maxRelaunches: number;
  readonly relaunchWindowMs: number;
}

export const DEFAULT_WATCHDOG_POLICY: WatchdogPolicy = {
  reloadDelayMs: 300,
  hangTimeoutMs: 15_000,
  maxCrashes: 5,
  windowMs: 60_000,
  maxRelaunches: 3,
  relaunchWindowMs: 10 * 60_000,
};

export type WatchdogAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'reload'; readonly delayMs: number; readonly reason: string }
  | { readonly kind: 'force_crash'; readonly reason: string }
  | { readonly kind: 'relaunch_app'; readonly reason: string }
  | { readonly kind: 'out_of_service'; readonly reason: string };

export type WatchdogEvent =
  | { readonly type: 'renderer_gone'; readonly reason: string; readonly at: number }
  | { readonly type: 'unresponsive'; readonly at: number }
  | { readonly type: 'responsive'; readonly at: number }
  | { readonly type: 'heartbeat'; readonly at: number }
  | { readonly type: 'loaded'; readonly at: number }
  | { readonly type: 'tick'; readonly at: number };

export class RendererWatchdog {
  private readonly policy: WatchdogPolicy;
  private crashes: number[] = [];
  private readonly relaunches: number[];
  private lastHeartbeat: number | null = null;
  private recovering = false;
  private outOfService = false;

  /** `relaunchHistory`: timestamps of previous app relaunches (persisted across processes). */
  constructor(policy: Partial<WatchdogPolicy> = {}, relaunchHistory: readonly number[] = []) {
    this.policy = { ...DEFAULT_WATCHDOG_POLICY, ...policy };
    this.relaunches = [...relaunchHistory];
  }

  get relaunchHistory(): readonly number[] {
    return this.relaunches;
  }

  get isOutOfService(): boolean {
    return this.outOfService;
  }

  private onCrash(reason: string, at: number): WatchdogAction {
    this.crashes = this.crashes.filter((t) => at - t < this.policy.windowMs);
    this.crashes.push(at);
    this.lastHeartbeat = null;
    if (this.outOfService) return { kind: 'none' };
    if (this.crashes.length >= this.policy.maxCrashes) {
      const recent = this.relaunches.filter((t) => at - t < this.policy.relaunchWindowMs);
      if (recent.length >= this.policy.maxRelaunches) {
        this.outOfService = true;
        return {
          kind: 'out_of_service',
          reason: `crash loop persists after ${recent.length} relaunches`,
        };
      }
      this.relaunches.push(at);
      this.crashes = [];
      return { kind: 'relaunch_app', reason: `crash loop: ${this.policy.maxCrashes} crashes` };
    }
    this.recovering = true;
    return { kind: 'reload', delayMs: this.policy.reloadDelayMs, reason };
  }

  handle(event: WatchdogEvent): WatchdogAction {
    switch (event.type) {
      case 'renderer_gone':
        return this.onCrash(event.reason, event.at);
      case 'unresponsive':
        if (this.outOfService || this.recovering) return { kind: 'none' };
        this.recovering = true;
        return { kind: 'force_crash', reason: 'unresponsive' };
      case 'responsive':
        this.recovering = false;
        return { kind: 'none' };
      case 'heartbeat':
        this.lastHeartbeat = event.at;
        this.recovering = false;
        return { kind: 'none' };
      case 'loaded':
        this.recovering = false;
        this.lastHeartbeat = null;
        return { kind: 'none' };
      case 'tick':
        if (this.outOfService || this.recovering || this.lastHeartbeat === null)
          return { kind: 'none' };
        if (event.at - this.lastHeartbeat > this.policy.hangTimeoutMs) {
          this.recovering = true;
          return { kind: 'force_crash', reason: 'heartbeat_timeout' };
        }
        return { kind: 'none' };
    }
  }
}
