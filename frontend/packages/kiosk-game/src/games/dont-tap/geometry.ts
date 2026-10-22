/**
 * Don't-Tap layout (pure; shared by the logic, the bot and the view). The fruit pedestal is the single
 * response target: >= 20 mm (in practice ~60 mm), centred in the lower two-thirds (KSK-06).
 */
import type { Layout, Point, Rect } from '../../core/contracts.ts';

export interface DontTapGeometry {
  /** Centre of the fruit on the pedestal. */
  readonly fruit: Point;
  /** Fruit radius (px). */
  readonly fruitRadius: number;
  /** Response target (the fruit and the lit pedestal top). */
  readonly target: Rect;
  /** Where served fruit lands (the basket on its stool). */
  readonly basket: Point;
  /** Where unserved fruit goes (the compost crate). */
  readonly crate: Point;
  /** Guide standing point (feet). */
  readonly guide: Point;
  /** Customer standing point (feet). */
  readonly customer: Point;
  /** Booth: centre x, width, arch top, counter top and ground line. */
  readonly booth: {
    readonly cx: number;
    readonly width: number;
    readonly top: number;
    readonly counterY: number;
    readonly groundY: number;
  };
  /** Character scale. */
  readonly characterScale: number;
  readonly portrait: boolean;
}

export function dontTapGeometry(
  layout: Pick<Layout, 'width' | 'height' | 'metrics'>,
): DontTapGeometry {
  const { width: W, height: H, metrics } = layout;
  const portrait = H > W;
  const u = Math.min(W, H) / 1080;
  const fruitRadius = Math.max(metrics.minTargetPx * 0.9, (portrait ? 104 : 96) * u);
  const fruit: Point = { x: W / 2, y: portrait ? H * 0.55 : H * 0.6 };
  const side = Math.max(metrics.minTargetPx * 2, fruitRadius * 2.7);
  const counterY = fruit.y + fruitRadius * 1.25;
  return {
    fruit,
    fruitRadius,
    target: { x: fruit.x - side / 2, y: fruit.y - side / 2, width: side, height: side },
    basket: portrait ? { x: W * 0.74, y: H * 0.79 } : { x: W * 0.805, y: H * 0.7 },
    crate: portrait ? { x: W * 0.3, y: H * 0.86 } : { x: W * 0.205, y: H * 0.87 },
    guide: portrait ? { x: W * 0.13, y: H * 0.985 } : { x: W * 0.095, y: H * 0.93 },
    customer: portrait ? { x: W * 0.88, y: H * 0.985 } : { x: W * 0.905, y: H * 0.93 },
    booth: {
      cx: W / 2,
      width: portrait ? W * 0.94 : Math.min(W * 0.52, 1000 * u),
      top: portrait ? H * 0.24 : H * 0.13,
      counterY,
      groundY: portrait ? counterY + H * 0.12 : H * 0.86,
    },
    characterScale: portrait ? 1.0 : 1.12,
    portrait,
  };
}
