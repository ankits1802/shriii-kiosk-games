/**
 * Pure stage geometry for The Stall (no Pixi): where the counter, the serving plate, the tone faces,
 * the probe offers, the customer spot, the queue and the guide sit, in landscape and portrait.
 *
 * The same numbers drive the Pixi scene and the input targets (and the headless bot's taps), so a
 * target is exactly where its artwork is drawn. Every interactive target is >= 20 mm with >= 8 mm
 * spacing (KSK-05) and lies in the lower two-thirds of the screen (KSK-06).
 */
import type { Layout, Point, Rect } from '../../core/contracts.ts';
import { TOUCH_TARGET_MIN_MM } from '../../core/contracts.ts';

/** Physical sizes (mm). UI constants, not scientific thresholds. */
export const STALL_SIZES_MM = {
  /** Serving plate (the single go target). */
  plate: 56,
  /** Each tone face medallion. */
  toneFace: 34,
  /** Each probe offer tile. */
  probe: 44,
  /** Replay button during practice. */
  replay: 22,
} as const;

export interface StallGeometry {
  readonly width: number;
  readonly height: number;
  readonly portrait: boolean;
  /** Short edge / 1080: art scale unit. */
  readonly unit: number;
  readonly pxPerMm: number;
  /** y of the counter's top edge. */
  readonly counterTop: number;
  /** Serving plate centre and radius (target = bounding square). */
  readonly plate: { readonly center: Point; readonly radius: number; readonly rect: Rect };
  /** Tone face targets, in presentation order (warm, neutral, firm). */
  readonly toneFaces: readonly {
    readonly center: Point;
    readonly radius: number;
    readonly rect: Rect;
  }[];
  /** Probe offers: [safe, risky]. */
  readonly probes: readonly {
    readonly center: Point;
    readonly size: number;
    readonly rect: Rect;
  }[];
  /** Where the served customer stands (feet; hidden behind the counter) and their scale. */
  readonly customer: { readonly x: number; readonly feetY: number; readonly scale: number };
  /** Head-height anchor of the customer (for the bubble and the lookAt target). */
  readonly customerHead: Point;
  /** Thought-bubble centre and radius. */
  readonly bubble: { readonly center: Point; readonly radius: number };
  /** Queue slots, nearest first (feet positions and scales). */
  readonly queue: readonly { readonly x: number; readonly feetY: number; readonly scale: number }[];
  /** Exit x (off-screen right) at the customer's depth. */
  readonly exitX: number;
  /** Entry x (off-screen left) for the back of the queue. */
  readonly entryX: number;
  /** Guide stand-by spot (in front of the counter at the edge) and scale. */
  readonly guide: { readonly x: number; readonly feetY: number; readonly scale: number };
  /** Guide spot while presenting (intro / handovers). */
  readonly guideStage: { readonly x: number; readonly feetY: number; readonly scale: number };
  /** Rush timer lamp position. */
  readonly timer: Point;
  /** Replay button centre (practice only). */
  readonly replay: { readonly center: Point; readonly rect: Rect };
}

function square(c: Point, half: number): Rect {
  return { x: c.x - half, y: c.y - half, width: half * 2, height: half * 2 };
}

/** Compute the stall geometry for a layout. */
export function stallGeometry(
  layout: Pick<Layout, 'width' | 'height' | 'metrics'> & { readonly safeArea?: Rect },
): StallGeometry {
  const W = layout.width;
  const H = layout.height;
  const portrait = H > W;
  const unit = Math.min(W, H) / 1080;
  const mm = layout.metrics.pxPerMm;
  const counterTop = Math.round(H * (portrait ? 0.8 : 0.76));
  const counterH = H - counterTop;

  // Targets shrink on short screens (never below 20 mm) so they stay inside the counter band.
  const minHalf = (TOUCH_TARGET_MIN_MM * mm) / 2;
  const fitHalf = counterH * 0.43;
  const plateR = Math.max(minHalf, Math.min((STALL_SIZES_MM.plate * mm) / 2, fitHalf));
  const plateC = { x: W / 2, y: counterTop + counterH * (portrait ? 0.47 : 0.5) };

  const faceR = Math.max(minHalf, Math.min((STALL_SIZES_MM.toneFace * mm) / 2, fitHalf));
  // Choice options sit in different thirds of the safe area: distinct choices must land in distinct
  // cells of the scorer's 3 x 3 touch grid (careless same-position rule, scoring_params quality).
  const sa = layout.safeArea ?? { x: 0, y: H / 3, width: W, height: (H * 2) / 3 };
  const third = sa.width / 3;
  const faceSpan = third;
  const faceY = plateC.y;
  const toneFaces = [-1, 0, 1].map((k) => {
    const center = { x: sa.x + sa.width / 2 + k * faceSpan, y: faceY };
    return { center, radius: faceR, rect: square(center, faceR) };
  });

  const probeS = Math.max(minHalf * 2, Math.min(STALL_SIZES_MM.probe * mm, fitHalf * 2));
  const probeOffset = third;
  const probes = [-1, 1].map((k) => {
    const center = { x: sa.x + sa.width / 2 + k * probeOffset, y: plateC.y };
    return { center, size: probeS, rect: square(center, probeS / 2) };
  });

  const customerScale = (portrait ? 2.9 : 2.2) * unit;
  const customer = {
    x: W / 2,
    feetY: counterTop + counterH * (portrait ? 0.55 : 0.62),
    scale: customerScale,
  };
  // The rig is ~330 units tall; the head centre sits ~0.84 of the height above the feet.
  const customerHead = { x: customer.x, y: customer.feetY - 330 * 0.84 * customerScale };
  const bubbleR = (portrait ? 150 : 138) * unit;
  const bubble = portrait
    ? { center: { x: W / 2 + 230 * unit, y: customerHead.y - 260 * unit }, radius: bubbleR }
    : { center: { x: W / 2 + 330 * unit, y: customerHead.y - 120 * unit }, radius: bubbleR };

  const queue = portrait
    ? [
        { x: W * 0.16, feetY: H * 0.7, scale: 1.75 * unit },
        { x: -W * 0.02, feetY: H * 0.68, scale: 1.55 * unit },
      ]
    : [
        { x: W * 0.24, feetY: H * 0.73, scale: 1.4 * unit },
        { x: W * 0.13, feetY: H * 0.71, scale: 1.25 * unit },
        { x: W * 0.035, feetY: H * 0.7, scale: 1.12 * unit },
      ];

  const guide = portrait
    ? { x: W * 1.0, feetY: H + 330 * 0.42 * 2.4 * unit, scale: 2.4 * unit }
    : { x: W * 0.935, feetY: H + 330 * 0.36 * 2.3 * unit, scale: 2.3 * unit };
  const guideStage = portrait
    ? { x: W * 0.72, feetY: H + 330 * 0.3 * 2.6 * unit, scale: 2.6 * unit }
    : { x: W * 0.78, feetY: H + 330 * 0.28 * 2.5 * unit, scale: 2.5 * unit };

  const timer = portrait
    ? { x: plateC.x - plateR * 1.8, y: plateC.y + plateR * 0.5 }
    : { x: plateC.x - plateR - 150 * unit, y: plateC.y - plateR * 0.2 };
  const replayHalf = (STALL_SIZES_MM.replay * mm) / 2;
  const replayC = {
    x: Math.max(replayHalf + 16 * unit, W * 0.06),
    y: Math.max(H / 3 + replayHalf + 8, counterTop + counterH * 0.5),
  };
  return {
    width: W,
    height: H,
    portrait,
    unit,
    pxPerMm: mm,
    counterTop,
    plate: { center: plateC, radius: plateR, rect: square(plateC, plateR) },
    toneFaces,
    probes,
    customer,
    customerHead,
    bubble,
    queue,
    exitX: W + 260 * unit,
    entryX: -260 * unit,
    guide,
    guideStage,
    timer,
    replay: { center: replayC, rect: square(replayC, replayHalf) },
  };
}

/** Centre of a rect (bot taps, hand hints). */
export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
