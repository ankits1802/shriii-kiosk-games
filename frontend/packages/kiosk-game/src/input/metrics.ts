/**
 * Physical screen metrics (KSK-05): touch targets >= 20 mm with >= 8 mm spacing at the configured
 * density. `pxPerMm` is per kiosk SKU (stage/CSS pixels per millimetre of glass); the default assumes
 * the CSS reference density of 96 px per inch.
 */
import {
  type PhysicalMetrics,
  type Rect,
  TOUCH_SPACING_MIN_MM,
  TOUCH_TARGET_MIN_MM,
} from '../core/contracts.ts';

/** CSS reference density: 96 px per inch = 3.7795 px/mm. */
export const CSS_PX_PER_MM = 96 / 25.4;

/** Build metrics for a density (stage px per mm). */
export function physicalMetrics(pxPerMm: number = CSS_PX_PER_MM): PhysicalMetrics {
  if (!(pxPerMm > 0) || !Number.isFinite(pxPerMm))
    throw new RangeError(`invalid pxPerMm ${pxPerMm}`);
  return {
    pxPerMm,
    minTargetPx: Math.ceil(TOUCH_TARGET_MIN_MM * pxPerMm),
    minSpacingPx: Math.ceil(TOUCH_SPACING_MIN_MM * pxPerMm),
  };
}

/** mm -> stage px. */
export function mmToPx(mm: number, metrics: PhysicalMetrics): number {
  return mm * metrics.pxPerMm;
}

/** Edge-to-edge gap between two rects (0 when they touch or overlap). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.max(dx, dy);
}

/** True when `outer` fully contains `inner` (layered UI such as a tap-anywhere backdrop). */
export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** True when the point lies inside the rect. */
export function rectHit(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height;
}
