/**
 * Card Sort layout (pure; shared by logic, bot and view): four key-card piles in a row on the
 * fortune-teller's table (each a >= 20 mm target, >= 8 mm apart) and the drawn card above them.
 */
import type { Layout, Point, Rect } from '../../core/contracts.ts';
import type { Pile } from '../../paradigms/card-sort.ts';
import { PILES } from '../../paradigms/card-sort.ts';

export interface CardSortGeometry {
  /** Pile targets in pile order (`pile_1`..`pile_4`). */
  readonly piles: readonly Rect[];
  /** Centre of the drawn (stimulus) card. */
  readonly card: Point;
  /** Card width/height. */
  readonly cardW: number;
  readonly cardH: number;
  /** Fortune-teller seat (feet) and guide spot. */
  readonly teller: Point;
  readonly guide: Point;
  /** Table top line and centre. */
  readonly tableY: number;
  readonly characterScale: number;
  readonly portrait: boolean;
}

export function cardSortGeometry(
  layout: Pick<Layout, 'width' | 'height' | 'metrics'>,
): CardSortGeometry {
  const { width: W, height: H, metrics } = layout;
  const portrait = H > W;
  const u = Math.min(W, H) / 1080;
  const gap = Math.max(metrics.minSpacingPx * 1.6, (portrait ? 26 : 34) * u);
  const usable = portrait ? W * 0.94 : Math.min(W * 0.66, 1280 * u);
  const cardW = Math.max(metrics.minTargetPx * 1.6, (usable - gap * 3) / 4);
  const cardH = cardW * 1.38;
  const rowY = portrait ? H * 0.74 : H * 0.765;
  const x0 = W / 2 - (cardW * 4 + gap * 3) / 2;
  const piles = PILES.map((_, i) => ({
    x: x0 + i * (cardW + gap),
    y: rowY - cardH / 2,
    width: cardW,
    height: cardH,
  }));
  return {
    piles,
    card: { x: W / 2, y: portrait ? H * 0.46 : H * 0.38 },
    cardW,
    cardH,
    // Seated behind the table to the right of the drawn card (the table hides her lower body).
    teller: portrait
      ? { x: W * 0.8, y: rowY - cardH * 0.62 + 55 * u }
      : { x: W * 0.7, y: rowY - cardH * 0.62 + 70 * u },
    guide: portrait ? { x: W * 0.14, y: H * 0.99 } : { x: W * 0.09, y: H * 0.95 },
    tableY: rowY - cardH * 0.62,
    characterScale: portrait ? 1.0 : 1.1,
    portrait,
  };
}

/** Rect of a pile code. */
export function pileRect(g: CardSortGeometry, pile: Pile): Rect {
  const r = g.piles[PILES.indexOf(pile)];
  if (!r) throw new RangeError(`no pile ${pile}`);
  return r;
}
