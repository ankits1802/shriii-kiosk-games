/**
 * Four Stalls stage geometry (pure): four stall targets (a row in landscape, 2 x 2 in portrait), the
 * player's basket, the errand villager's spot and the guide. Stall targets are large (>= 40 mm) with
 * generous gaps (>= 8 mm).
 */
import type { Point, Rect } from '../../core/contracts.ts';
import { rectAt } from '../hub/kit/targets.ts';

export interface FourStallsGeometry {
  readonly portrait: boolean;
  /** Stall base points (ground contact, centre), order stall_a..stall_d. */
  readonly bases: readonly [Point, Point, Point, Point];
  /** Touch targets (stall fronts), same order. */
  readonly targets: readonly [Rect, Rect, Rect, Rect];
  /** Stall drawing scale relative to the art unit. */
  readonly stallScale: number;
  readonly basket: Point;
  readonly basketWidth: number;
  readonly villager: Point;
  readonly villagerScale: number;
  readonly guide: Point;
  readonly guideScale: number;
}

export function fourStallsGeometry(layout: {
  readonly width: number;
  readonly height: number;
  readonly orientation: 'landscape' | 'portrait';
  readonly metrics: { readonly pxPerMm: number };
}): FourStallsGeometry {
  const W = layout.width;
  const H = layout.height;
  const mm = layout.metrics.pxPerMm;
  const portrait = layout.orientation === 'portrait';
  const u = Math.min(W, H) / 1080;
  let bases: [Point, Point, Point, Point];
  let stallW: number;
  if (!portrait) {
    stallW = Math.min(W * 0.2, 430 * u);
    const y = H * 0.66;
    bases = [
      { x: W * 0.2, y },
      { x: W * 0.4, y },
      { x: W * 0.6, y },
      { x: W * 0.8, y },
    ];
  } else {
    stallW = Math.min(W * 0.42, 470 * u);
    bases = [
      { x: W * 0.27, y: H * 0.43 },
      { x: W * 0.73, y: H * 0.43 },
      { x: W * 0.27, y: H * 0.68 },
      { x: W * 0.73, y: H * 0.68 },
    ];
  }
  // drawStall is 270 x 300 units at scale 1 (origin at the ground, centre).
  const stallScale = stallW / 270 / u;
  const stallH = stallW * (300 / 270);
  const tw = Math.max(40 * mm, stallW * 0.86);
  const th = Math.max(40 * mm, stallH * 0.78);
  const targets = bases.map((b) => rectAt({ x: b.x, y: b.y - stallH * 0.45 }, tw, th)) as [
    Rect,
    Rect,
    Rect,
    Rect,
  ];
  return {
    portrait,
    bases,
    targets,
    stallScale,
    basket: portrait ? { x: W * 0.5, y: H * 0.93 } : { x: W * 0.5, y: H * 0.95 },
    basketWidth: (portrait ? 230 : 250) * u,
    villager: portrait ? { x: W * 0.86, y: H * 0.99 } : { x: W * 0.87, y: H * 1.04 },
    villagerScale: portrait ? 1.15 : 1.55,
    guide: portrait ? { x: W * 0.13, y: H * 0.99 } : { x: W * 0.1, y: H * 1.04 },
    guideScale: portrait ? 1.1 : 1.55,
  };
}
