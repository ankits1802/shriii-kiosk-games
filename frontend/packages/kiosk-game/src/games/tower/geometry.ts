/**
 * Tower layout (pure; shared by logic, bot and view): three wooden pegs in the potter's courtyard
 * (each a tall >= 20 mm target), the goal picture on the potter's easel and the rest/skip mat.
 */
import type { Layout, Point, Rect } from '../../core/contracts.ts';

export interface TowerGeometry {
  /** Peg targets (columns), left to right. */
  readonly pegs: readonly Rect[];
  /** Base line the pots stand on. */
  readonly baseY: number;
  /** Pot body size (height of one stacked pot). */
  readonly potH: number;
  readonly potW: number;
  /** Goal picture (easel board) rect. */
  readonly goal: Rect;
  /** Skip / rest control rect (appears after `skip_icon_after_ms`). */
  readonly skip: Rect;
  readonly potter: Point;
  readonly guide: Point;
  readonly characterScale: number;
  readonly portrait: boolean;
}

export function towerGeometry(layout: Pick<Layout, 'width' | 'height' | 'metrics'>): TowerGeometry {
  const { width: W, height: H, metrics } = layout;
  const portrait = H > W;
  const u = Math.min(W, H) / 1080;
  const potH = (portrait ? 118 : 104) * u;
  const potW = potH * 1.25;
  const colW = Math.max(metrics.minTargetPx * 1.5, potW * 1.6);
  const gap = Math.max(metrics.minSpacingPx * 1.5, (portrait ? 30 : 70) * u);
  const total = colW * 3 + gap * 2;
  const x0 = portrait ? W / 2 - total / 2 : W * 0.43 - total / 2;
  const baseY = portrait ? H * 0.86 : H * 0.86;
  const colH = potH * 3 + 80 * u;
  const pegs = [0, 1, 2].map((i) => ({
    x: x0 + i * (colW + gap),
    y: baseY - colH,
    width: colW,
    height: colH + 30 * u,
  }));
  const goalW = portrait ? W * 0.44 : W * 0.21;
  const goalH = goalW * 0.78;
  const skipSize = Math.max(metrics.minTargetPx * 1.3, 120 * u);
  return {
    pegs,
    baseY,
    potH,
    potW,
    goal: portrait
      ? { x: W / 2 - goalW / 2, y: H * 0.26, width: goalW, height: goalH }
      : { x: W * 0.74, y: H * 0.2, width: goalW, height: goalH },
    skip: portrait
      ? { x: W - skipSize - 40 * u, y: H * 0.36, width: skipSize, height: skipSize }
      : { x: W * 0.845 - skipSize / 2, y: H * 0.7, width: skipSize, height: skipSize },
    potter: portrait ? { x: W * 0.84, y: H * 0.6 } : { x: W * 0.92, y: H * 0.95 },
    guide: portrait ? { x: W * 0.13, y: H * 0.77 } : { x: W * 0.07, y: H * 0.95 },
    characterScale: portrait ? 0.85 : 1.05,
    portrait,
  };
}
