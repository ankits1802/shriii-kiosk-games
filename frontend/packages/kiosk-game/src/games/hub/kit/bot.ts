/**
 * Scripted bot hand (ENG-05 AC: any module runs headlessly with a scripted bot). The bot never calls
 * module internals: it produces pointer input exactly like a player, so the input layer records,
 * classifies and logs every tap as it would on the kiosk.
 *
 * - With a live renderer (browser bot playthroughs) it dispatches real DOM `PointerEvent`s on the
 *   canvas, which reach both the input layer (bubbling to its host element) and Pixi's event system.
 * - Headless (vitest, no renderer) it injects samples straight into the input layer
 *   (`DomInputService.inject`), with timestamps on the session clock's performance timeline.
 */
import type { Point } from '../../../core/contracts.ts';
import type { PointerSample } from '../../../input/input-service.ts';
import type { GameRuntime } from './runtime.ts';
import type { TargetBoard } from './targets.ts';

type Injector = (sample: PointerSample) => void;

export class BotHand {
  private nextPointer = 11;
  private readonly listeners = new Set<
    (kind: 'down' | 'up', pointerId: number, p: Point) => void
  >();
  private readonly rt: GameRuntime;
  private readonly board: TargetBoard;

  constructor(rt: GameRuntime, board: TargetBoard) {
    this.rt = rt;
    this.board = board;
  }

  /**
   * Observe the bot's own pointer downs/ups (headless runs, where no Pixi pointer events exist, use it
   * to track holds the way the scene does from real pointer events).
   */
  onPointer(listener: (kind: 'down' | 'up', pointerId: number, p: Point) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tap a registered target after `afterMs` (jittered inside the target). */
  async tapTarget(id: string, afterMs = 0, rand: () => number = () => 0.5): Promise<void> {
    await this.rt.sleep(afterMs);
    const b = this.board.bounds(id);
    if (!b) return;
    const p = {
      x: b.x + b.width * (0.3 + 0.4 * rand()),
      y: b.y + b.height * (0.3 + 0.4 * rand()),
    };
    this.tapNow(p);
  }

  /** Tap a stage point after `afterMs`. */
  async tapPoint(p: Point, afterMs = 0): Promise<void> {
    await this.rt.sleep(afterMs);
    this.tapNow(p);
  }

  /** Immediate tap (down, then up one frame later). */
  tapNow(p: Point): void {
    const id = this.press(p);
    void this.rt.ctx.clock.delay(60).then(() => this.release(id, p));
  }

  /**
   * Put a finger down; returns the pointer id. `rest: true` marks a resting hand that the scene
   * consumes itself (e.g. the Steady Hands plate): headless, it reaches only the pointer listeners.
   */
  press(p: Point, options: { readonly rest?: boolean } = {}): number {
    const id = this.nextPointer;
    this.nextPointer += 1;
    this.send('down', id, p, options.rest ?? false);
    return id;
  }

  /** Lift a finger. */
  release(pointerId: number, p: Point, options: { readonly rest?: boolean } = {}): void {
    this.send('up', pointerId, p, options.rest ?? false);
  }

  private send(kind: 'down' | 'up', pointerId: number, p: Point, rest = false): void {
    const { ctx } = this.rt;
    if (this.rt.aborted) return;
    for (const l of this.listeners) l(kind, pointerId, p);
    const canvas = this.rt.visual
      ? ((ctx.app as { canvas?: HTMLCanvasElement }).canvas ?? null)
      : null;
    if (canvas && typeof PointerEvent !== 'undefined') {
      const r = canvas.getBoundingClientRect();
      const sx = ctx.layout.width > 0 ? r.width / ctx.layout.width : 1;
      const sy = ctx.layout.height > 0 ? r.height / ctx.layout.height : 1;
      canvas.dispatchEvent(
        new PointerEvent(kind === 'down' ? 'pointerdown' : 'pointerup', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: r.left + p.x * sx,
          clientY: r.top + p.y * sy,
          pointerId,
          pointerType: 'touch',
          isPrimary: true,
          width: 9,
          height: 9,
          button: 0,
          buttons: kind === 'down' ? 1 : 0,
        }),
      );
      return;
    }
    if (rest) return;
    const input = ctx.input as unknown as { inject?: Injector };
    if (typeof input.inject !== 'function') {
      throw new Error('bot: the input service cannot inject pointer samples');
    }
    input.inject({
      kind,
      pointerId,
      clientX: p.x,
      clientY: p.y,
      timeStamp: ctx.clock.anchorPerfMs + ctx.clock.now() + ctx.clock.profile.touchOffsetMs,
      pointerType: 'touch',
      width: 8,
      height: 8,
    });
  }
}

/** Log-normal latency draw (ms) for bot policies: median `medianMs`, log-SD `sd`. */
export function lognormalMs(rand: () => number, medianMs: number, sd: number): number {
  // Box-Muller on two uniforms from the seeded stream.
  const u1 = Math.max(1e-9, rand());
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return medianMs * Math.exp(sd * z);
}
