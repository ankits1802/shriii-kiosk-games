/**
 * Balloon layout (pure; shared by logic, bot and view): the balloon on the seller's brass hand-pump
 * (the pump plunger is the PUMP target), and the glass jar on the stall counter (the COLLECT target).
 * Both are large (>= 30 mm) and well apart.
 */
import type { Layout, Point, Rect } from '../../core/contracts.ts';

export interface BalloonGeometry {
  /** Balloon knot (bottom of the balloon, on the pump nozzle). */
  readonly knot: Point;
  /** Radius of a just-attached balloon and of a fully inflated one. */
  readonly r0: number;
  readonly rMax: number;
  /** Pump target (plunger handle and barrel). */
  readonly pump: Rect;
  /** Jar target (collect). */
  readonly jar: Rect;
  readonly seller: Point;
  readonly guide: Point;
  readonly characterScale: number;
  readonly portrait: boolean;
}

export function balloonGeometry(
  layout: Pick<Layout, 'width' | 'height' | 'metrics'>,
): BalloonGeometry {
  const { width: W, height: H, metrics } = layout;
  const portrait = H > W;
  const u = Math.min(W, H) / 1080;
  const pumpW = Math.max(metrics.minTargetPx * 1.6, 170 * u);
  const pumpH = Math.max(metrics.minTargetPx * 2, 280 * u);
  const jarW = Math.max(metrics.minTargetPx * 1.8, 210 * u);
  const jarH = jarW * 1.2;
  const knot: Point = portrait ? { x: W * 0.4, y: H * 0.56 } : { x: W * 0.4, y: H * 0.6 };
  // The counter top (pump foot) line; the jar stands on it.
  const counterTop = knot.y + 40 * u + pumpH * 0.92;
  return {
    knot,
    r0: 46 * u,
    rMax: portrait ? Math.min(W * 0.3, 300 * u) : 290 * u,
    pump: { x: knot.x - pumpW / 2, y: knot.y + 40 * u, width: pumpW, height: pumpH },
    jar: portrait
      ? { x: W * 0.78 - jarW / 2, y: counterTop - jarH, width: jarW, height: jarH }
      : { x: W * 0.68 - jarW / 2, y: counterTop - jarH, width: jarW, height: jarH },
    seller: portrait ? { x: W * 0.84, y: H * 0.6 } : { x: W * 0.86, y: H * 0.93 },
    guide: portrait ? { x: W * 0.14, y: H * 0.99 } : { x: W * 0.09, y: H * 0.95 },
    characterScale: portrait ? 0.92 : 1.1,
    portrait,
  };
}
