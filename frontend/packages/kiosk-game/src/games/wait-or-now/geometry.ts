/**
 * Wait-or-Now layout (pure; shared by logic, bot and view). The halwai's sweet counter at dusk: two
 * brass plates stand on the counter (the two choices, left and right, seeded per trial), the churning
 * pot waits at the front of the counter (the hold-to-earn pad, used only after a "more for churning"
 * choice), the player's own basket sits at the counter corner and the "later" shelf hangs on the shop
 * wall. All targets are far larger than 20 mm and well apart (checked by the strict input layer).
 */
import type { Layout, Point, Rect } from '../../core/contracts.ts';

export interface WaitOrNowGeometry {
  /** Left and right choice plates (whole plate + its picture above = the touch target). */
  readonly left: Rect;
  readonly right: Rect;
  /** Plate centre (the sweets sit on it) within each target. */
  readonly leftPlate: Point;
  readonly rightPlate: Point;
  readonly plateR: number;
  /** Hold pad (the churn's wooden handle and pot). */
  readonly churn: Rect;
  readonly churnCentre: Point;
  /** Counter top (y) and horizontal extent. */
  readonly counterTop: number;
  readonly counterX0: number;
  readonly counterX1: number;
  /** Player's basket (sweets taken now land here). */
  readonly basket: Point;
  /** "Later" shelf: left end, width (parcels kept for later line up here). */
  readonly shelf: Rect;
  readonly halwai: Point;
  readonly shop: Point;
  readonly guide: Point;
  readonly characterScale: number;
  readonly portrait: boolean;
  /** Art unit (1 = 1080 px short edge). */
  readonly u: number;
}

export function waitOrNowGeometry(
  layout: Pick<Layout, 'width' | 'height' | 'metrics'>,
): WaitOrNowGeometry {
  const { width: W, height: H, metrics } = layout;
  const portrait = H > W;
  const u = Math.min(W, H) / 1080;
  const plateW = Math.max(metrics.minTargetPx * 3, portrait ? W * 0.42 : 470 * u);
  const plateH = Math.max(metrics.minTargetPx * 3, 360 * u);
  const plateR = Math.min(plateW * 0.4, 175 * u);
  const cy = portrait ? H * 0.52 : H * 0.53;
  const lx = portrait ? W * 0.265 : W * 0.33;
  const rx = portrait ? W * 0.735 : W * 0.67;
  // Plate centre sits low in the target; the picture of the wait/effort sits above it.
  const plateY = cy + plateH * 0.22;
  const rect = (cx: number): Rect => ({
    x: cx - plateW / 2,
    y: cy - plateH / 2,
    width: plateW,
    height: plateH,
  });
  const churnSide = Math.max(metrics.minTargetPx * 2.6, 250 * u);
  const churnCy = portrait ? H * 0.715 : cy + plateH / 2 + 34 * u + churnSide / 2;
  const counterTop = plateY + plateR * 0.25;
  return {
    left: rect(lx),
    right: rect(rx),
    leftPlate: { x: lx, y: plateY },
    rightPlate: { x: rx, y: plateY },
    plateR,
    churn: {
      x: W / 2 - churnSide / 2,
      y: churnCy - churnSide / 2,
      width: churnSide,
      height: churnSide,
    },
    churnCentre: { x: W / 2, y: churnCy },
    counterTop,
    counterX0: portrait ? W * 0.02 : W * 0.12,
    counterX1: portrait ? W * 0.98 : W * 0.88,
    basket: portrait ? { x: W * 0.84, y: H * 0.86 } : { x: W * 0.85, y: H * 0.9 },
    shelf: portrait
      ? { x: W * 0.12, y: H * 0.155, width: W * 0.76, height: 60 * u }
      : { x: W * 0.03, y: H * 0.3, width: W * 0.2, height: 60 * u },
    // The halwai stands behind the counter: feet well below the counter top so only the upper body shows.
    halwai: { x: W * 0.5, y: counterTop + 125 * u },
    // The shop's own base sits just behind the counter top (its lower part is hidden by the counter).
    shop: { x: W * 0.5, y: counterTop + 12 * u },
    guide: portrait ? { x: W * 0.14, y: H * 0.99 } : { x: W * 0.07, y: H * 0.97 },
    characterScale: portrait ? 0.95 : 1.05,
    portrait,
    u,
  };
}

/** Pile positions (relative to the plate centre) for `n` pictured sweets of radius `r`. */
export function sweetPile(n: number, r: number): Point[] {
  const out: Point[] = [];
  if (n <= 0) return out;
  // Rows bottom-up: 4, 3, 2, 1, then wrap (never more than 10 tokens in this module).
  const caps = [4, 3, 2, 1, 4, 3];
  let left = n;
  let row = 0;
  while (left > 0 && row < caps.length) {
    const count = Math.min(left, caps[row] as number);
    for (let i = 0; i < count; i += 1) {
      out.push({ x: (i - (count - 1) / 2) * r * 1.95, y: -r * 0.55 - row * r * 1.5 });
    }
    left -= count;
    row += 1;
  }
  return out;
}
