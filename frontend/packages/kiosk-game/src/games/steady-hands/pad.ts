/**
 * Hold-pad tracking for the Steady Hands held block: which pointers rest on the brass plate, since
 * when, and when the hand last lifted. Fed by Pixi pointer events on the pad (kiosk and browser bot
 * runs) or, headless, by the bot hand's own pointer stream. Times are session ms (touch offset applied
 * via `Clock.fromPointerTime`).
 */
import type { Container, FederatedPointerEvent } from 'pixi.js';
import type { Point, Rect } from '../../core/contracts.ts';
import type { BotHand } from '../hub/kit/bot.ts';
import type { GameRuntime } from '../hub/kit/runtime.ts';

export interface HoldWindow {
  /** Hold time within [fromMs, toMs] that was continuous up to `toMs` (or up to the lift). */
  readonly holdMs: number;
  /** Held from `fromMs` through `toMs` without lifting. */
  readonly completed: boolean;
  /** The hand lifted inside the window. */
  readonly liftedMs: number | null;
}

export class HoldPadTracker {
  private readonly down = new Map<number, number>();
  private releases: number[] = [];
  private readonly listeners = new Set<(held: boolean) => void>();
  private readonly unsubs: (() => void)[] = [];

  constructor(private readonly rt: GameRuntime) {}

  get held(): boolean {
    return this.down.size > 0;
  }

  /** Earliest start among pointers currently on the pad, or null. */
  heldSince(): number | null {
    let best: number | null = null;
    for (const t of this.down.values()) if (best === null || t < best) best = t;
    return best;
  }

  /** Subscribe to held/released transitions. */
  onChange(listener: (held: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pressed(pointerId: number, tMs: number): void {
    const was = this.held;
    this.down.set(pointerId, tMs);
    if (!was) for (const l of this.listeners) l(true);
  }

  lifted(pointerId: number, tMs: number): void {
    if (!this.down.delete(pointerId)) return;
    if (!this.held) {
      this.releases.push(tMs);
      if (this.releases.length > 64) this.releases = this.releases.slice(-32);
      for (const l of this.listeners) l(false);
    }
  }

  /** Summarise the hold over a window (used for each held trial's `input.hold`). */
  window(fromMs: number, toMs: number): HoldWindow {
    const since = this.heldSince();
    const lift = this.releases.filter((t) => t > fromMs && t <= toMs).at(-1) ?? null;
    if (since !== null && since <= toMs) {
      const start = Math.max(fromMs, since);
      return {
        holdMs: Math.max(0, toMs - start),
        completed: since <= fromMs && lift === null,
        liftedMs: lift,
      };
    }
    if (lift !== null) {
      // Held for part of the window, then lifted before the end.
      return { holdMs: Math.max(0, lift - fromMs), completed: false, liftedMs: lift };
    }
    return { holdMs: 0, completed: false, liftedMs: null };
  }

  /**
   * Track Pixi pointer events on the pad view. The resting hand is consumed here (its native event
   * stops before the input layer's host listener): it is the instructed rest position, recorded per
   * trial as `input.hold`, and must not turn the answering touch into a multi-touch "interference".
   */
  attachView(view: Container): void {
    view.eventMode = 'static';
    const clock = this.rt.ctx.clock;
    const native = (
      e: FederatedPointerEvent,
    ): { timeStamp?: number; stopPropagation?: () => void } =>
      (e.nativeEvent as { timeStamp?: number; stopPropagation?: () => void } | undefined) ?? {};
    const time = (e: FederatedPointerEvent): number =>
      clock.fromPointerTime(native(e).timeStamp ?? clock.anchorPerfMs + clock.now());
    const onDown = (e: FederatedPointerEvent): void => {
      native(e).stopPropagation?.();
      this.pressed(e.pointerId, time(e));
    };
    const onUp = (e: FederatedPointerEvent): void => {
      native(e).stopPropagation?.();
      this.lifted(e.pointerId, time(e));
    };
    view.on('pointerdown', onDown);
    view.on('pointerup', onUp);
    view.on('pointerupoutside', onUp);
    view.on('pointercancel', onUp);
    this.unsubs.push(() => {
      view.off('pointerdown', onDown);
      view.off('pointerup', onUp);
      view.off('pointerupoutside', onUp);
      view.off('pointercancel', onUp);
    });
  }

  /** Track the headless bot's pointers that land inside `rect`. */
  attachBot(bot: BotHand, rect: () => Rect | null): void {
    const inside = (p: Point): boolean => {
      const r = rect();
      return (
        r !== null && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
      );
    };
    this.unsubs.push(
      bot.onPointer((kind, id, p) => {
        const t = this.rt.now();
        if (kind === 'down' && inside(p)) this.pressed(id, t);
        else if (kind === 'up') this.lifted(id, t);
      }),
    );
  }

  /** Forget current holds (block change). */
  reset(): void {
    this.down.clear();
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.listeners.clear();
  }
}
