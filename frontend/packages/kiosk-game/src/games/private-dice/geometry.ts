/**
 * Private Dice stage geometry (pure): the cupped hands (tap to roll), the six report pictures (a row in
 * landscape, 3 x 2 in portrait), the "someone watching?" button and the guide.
 */
import type { Point, Rect } from '../../core/contracts.ts';
import { rectAt, squareAt } from '../hub/kit/targets.ts';

export interface PrivateDiceGeometry {
  readonly portrait: boolean;
  readonly hands: Rect;
  readonly handsCenter: Point;
  readonly handsWidth: number;
  /** Report pictures for faces 1..6. */
  readonly faces: readonly Rect[];
  readonly onlooker: Rect;
  readonly guide: Point;
  readonly guideScale: number;
}

export function privateDiceGeometry(
  layout: {
    readonly width: number;
    readonly height: number;
    readonly orientation: 'landscape' | 'portrait';
    readonly metrics: { readonly pxPerMm: number };
  },
  faces: number,
): PrivateDiceGeometry {
  const W = layout.width;
  const H = layout.height;
  const mm = layout.metrics.pxPerMm;
  const portrait = layout.orientation === 'portrait';
  const u = Math.min(W, H) / 1080;
  const handsWidth = (portrait ? 560 : 520) * u;
  const handsCenter = portrait ? { x: W / 2, y: H * 0.45 } : { x: W / 2, y: H * 0.47 };
  const tile = Math.max(30 * mm, Math.min(W, H) * (portrait ? 0.2 : 0.15));
  const gap = Math.max(10 * mm, tile * 0.22);
  const rects: Rect[] = [];
  if (!portrait) {
    const total = faces * tile + (faces - 1) * gap;
    const x0 = (W - total) / 2 + tile / 2;
    for (let i = 0; i < faces; i++)
      rects.push(squareAt({ x: x0 + i * (tile + gap), y: H * 0.8 }, tile));
  } else {
    const cols = 3;
    const rows = Math.ceil(faces / cols);
    const total = cols * tile + (cols - 1) * gap;
    const x0 = (W - total) / 2 + tile / 2;
    for (let i = 0; i < faces; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      rects.push(
        squareAt(
          {
            x: x0 + c * (tile + gap),
            y: H * 0.72 + r * (tile + gap) - ((rows - 1) * (tile + gap)) / 2 + tile * 0.5,
          },
          tile,
        ),
      );
    }
  }
  const ob = Math.max(24 * mm, 90 * u);
  return {
    portrait,
    hands: rectAt(
      handsCenter,
      Math.max(50 * mm, handsWidth * 0.9),
      Math.max(40 * mm, handsWidth * 0.62),
    ),
    handsCenter,
    handsWidth,
    faces: rects,
    onlooker: squareAt({ x: W - ob * 0.95, y: H - ob * 0.95 }, ob),
    guide: portrait ? { x: W * 0.15, y: H * 0.58 } : { x: W * 0.12, y: H * 0.86 },
    guideScale: portrait ? 0.95 : 1.3,
  };
}
