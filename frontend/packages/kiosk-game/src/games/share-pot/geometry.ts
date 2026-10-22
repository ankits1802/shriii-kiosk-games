/**
 * Share-the-Pot stage geometry (pure): where the player's coins, the open-palm "keep everything" spot,
 * the confirm tick, the tone faces, the brass pot and the characters sit, in landscape and portrait.
 * Targets are >= 24 mm with >= 8 mm spacing and live in the lower part of the screen (KSK-06).
 */
import type { Point, Rect } from '../../core/contracts.ts';
import { squareAt } from '../hub/kit/targets.ts';

export interface SharePotGeometry {
  readonly portrait: boolean;
  /** Slot 0 = open palm (share nothing), slots 1..N = coin k (share coins 1..k). */
  readonly slots: readonly Rect[];
  readonly confirm: Rect;
  /** Tone faces, in code order warm, neutral, firm. */
  readonly tones: readonly [Rect, Rect, Rect];
  /** Cloth mat behind the coins. */
  readonly mat: Rect;
  readonly pot: Point;
  readonly potSize: number;
  readonly partner: Point;
  readonly partnerScale: number;
  readonly guide: Point;
  readonly guideScale: number;
  readonly pouch: Point;
  /** Coin radius in px. */
  readonly coinR: number;
  /** Camera framing used during rounds. */
  readonly focus: { readonly x: number; readonly y: number; readonly zoom: number };
}

export function sharePotGeometry(
  layout: {
    readonly width: number;
    readonly height: number;
    readonly orientation: 'landscape' | 'portrait';
    readonly metrics: { readonly pxPerMm: number };
  },
  endowment: number,
): SharePotGeometry {
  const W = layout.width;
  const H = layout.height;
  const mm = layout.metrics.pxPerMm;
  const portrait = layout.orientation === 'portrait';
  const n = endowment + 1;
  const slots: Rect[] = [];
  let confirm: Rect;
  let mat: Rect;
  let size: number;
  if (!portrait) {
    size = Math.max(24 * mm, Math.min(W * 0.052, 34 * mm));
    const pitch = Math.max(size + 8 * mm, size * 1.3);
    const confirmSize = Math.max(30 * mm, size * 1.25);
    const total = (n - 1) * pitch + size + pitch * 0.5 + confirmSize;
    const x0 = Math.max(W * 0.05, (W - total) / 2 + W * 0.05);
    const y = H * 0.875;
    for (let i = 0; i < n; i++) slots.push(squareAt({ x: x0 + size / 2 + i * pitch, y }, size));
    const last = slots[n - 1] as Rect;
    confirm = squareAt({ x: last.x + last.width + pitch * 0.5 + confirmSize / 2, y }, confirmSize);
    mat = {
      x: x0 - size * 0.35,
      y: y - size * 0.85,
      width: last.x + last.width - x0 + size * 0.7,
      height: size * 1.7,
    };
  } else {
    // Two rows: palm + coins 1..5 on top, coins 6..10 below (aligned under coins 1..5).
    const perRow = Math.ceil((n - 1) / 2);
    size = Math.max(24 * mm, Math.min(W * 0.11, 34 * mm));
    const pitch = Math.max(size + 8 * mm, size * 1.28);
    const rowW = perRow * pitch + size;
    const x0 = (W - rowW) / 2;
    const y1 = H * 0.79;
    const y2 = y1 + Math.max(size + 9 * mm, size * 1.3);
    slots.push(squareAt({ x: x0 + size / 2, y: y1 + (y2 - y1) / 2 }, size));
    for (let k = 1; k < n; k++) {
      const row = k <= perRow ? 0 : 1;
      const col = row === 0 ? k : k - perRow;
      slots.push(squareAt({ x: x0 + size / 2 + col * pitch, y: row === 0 ? y1 : y2 }, size));
    }
    const confirmSize = Math.max(30 * mm, size * 1.2);
    confirm = squareAt({ x: W / 2, y: y2 + size / 2 + 10 * mm + confirmSize / 2 }, confirmSize);
    mat = {
      x: x0 - size * 0.4,
      y: y1 - size * 0.8,
      width: rowW + size * 0.8,
      height: y2 - y1 + size * 1.6,
    };
  }
  const toneSize = Math.max(34 * mm, Math.min(W, H) * (portrait ? 0.2 : 0.17));
  const toneGap = Math.max(12 * mm, toneSize * 0.28);
  const toneY = portrait ? H * 0.8 : H * 0.8;
  const tones: [Rect, Rect, Rect] = [
    squareAt({ x: W / 2 - toneSize - toneGap, y: toneY }, toneSize),
    squareAt({ x: W / 2, y: toneY }, toneSize),
    squareAt({ x: W / 2 + toneSize + toneGap, y: toneY }, toneSize),
  ];
  const u = Math.min(W, H) / 1080;
  return {
    portrait,
    slots,
    confirm,
    tones,
    mat,
    pot: portrait ? { x: W * 0.5, y: H * 0.655 } : { x: W * 0.5, y: H * 0.715 },
    potSize: (portrait ? 150 : 190) * u,
    partner: portrait ? { x: W * 0.76, y: H * 0.69 } : { x: W * 0.7, y: H * 0.795 },
    partnerScale: portrait ? 0.92 : 1.2,
    guide: portrait ? { x: W * 0.22, y: H * 0.69 } : { x: W * 0.27, y: H * 0.795 },
    guideScale: portrait ? 0.92 : 1.2,
    pouch: portrait
      ? { x: (slots[0]?.x ?? 0) - size * 0.2, y: confirm.y + confirm.height / 2 }
      : { x: (slots[0]?.x ?? 0) - size * 0.9, y: H * 0.875 },
    coinR: size * 0.4,
    focus: portrait
      ? { x: W * 0.5, y: H * 0.58, zoom: 1.08 }
      : { x: W * 0.5, y: H * 0.55, zoom: 1.1 },
  };
}
