/**
 * Steady Hands stage geometry (pure): the brass lamp (the target), the hold plate, distractor anchors
 * and the guide, for landscape and portrait. The lamp target is a generous 44 mm square and the
 * plate sits in the lower third, a comfortable reach below the lamp (KSK-05/06).
 */
import type { Point, Rect } from '../../core/contracts.ts';
import { rectAt, squareAt } from '../hub/kit/targets.ts';

export interface SteadyHandsGeometry {
  readonly portrait: boolean;
  readonly lamp: Rect;
  readonly lampBase: Point;
  readonly lampSize: number;
  readonly pad: Rect;
  /** Distractor anchors (sky left, sky right, bell). */
  readonly sky: readonly [Point, Point];
  readonly bell: Point;
  readonly guide: Point;
  readonly guideScale: number;
  readonly focus: { readonly x: number; readonly y: number; readonly zoom: number };
}

export function steadyHandsGeometry(layout: {
  readonly width: number;
  readonly height: number;
  readonly orientation: 'landscape' | 'portrait';
  readonly metrics: { readonly pxPerMm: number };
}): SteadyHandsGeometry {
  const W = layout.width;
  const H = layout.height;
  const mm = layout.metrics.pxPerMm;
  const portrait = layout.orientation === 'portrait';
  const u = Math.min(W, H) / 1080;
  const lampSize = Math.max(44 * mm, (portrait ? 300 : 270) * u);
  const lampC = portrait ? { x: W / 2, y: H * 0.5 } : { x: W / 2, y: H * 0.47 };
  const padW = Math.max(60 * mm, (portrait ? 330 : 300) * u);
  const padH = Math.max(36 * mm, padW * 0.56);
  return {
    portrait,
    lamp: squareAt(lampC, lampSize),
    lampBase: { x: lampC.x, y: lampC.y + lampSize * 0.62 },
    lampSize,
    pad: rectAt({ x: W / 2, y: portrait ? H * 0.84 : H * 0.85 }, padW, padH),
    sky: portrait
      ? [
          { x: W * 0.22, y: H * 0.16 },
          { x: W * 0.8, y: H * 0.13 },
        ]
      : [
          { x: W * 0.18, y: H * 0.2 },
          { x: W * 0.83, y: H * 0.17 },
        ],
    bell: portrait ? { x: W * 0.84, y: H * 0.33 } : { x: W * 0.78, y: H * 0.36 },
    guide: portrait ? { x: W * 0.16, y: H * 0.72 } : { x: W * 0.13, y: H * 0.9 },
    guideScale: portrait ? 0.95 : 1.35,
    focus: { x: W / 2, y: H * 0.5, zoom: 1 },
  };
}
