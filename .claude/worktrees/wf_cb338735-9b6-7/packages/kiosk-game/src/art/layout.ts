/**
 * Layout helpers: physical sizing (>= 20 mm targets, >= 8 mm spacing, KSK-05), the interactive safe area
 * in the lower two-thirds (KSK-06), and arrangement of 2-6 large choices for landscape and portrait.
 */
import type { Application, Container } from 'pixi.js';
import {
  type Layout,
  type PhysicalMetrics,
  type Point,
  type Rect,
  TOUCH_SPACING_MIN_MM,
  TOUCH_TARGET_MIN_MM,
  type Unsubscribe,
} from '../core/contracts.ts';

/** Default pixel density: a 21.5" 1920x1080 kiosk panel is ~4.0 px/mm. Configurable per SKU. */
export const DEFAULT_PX_PER_MM = 4.0;

/** Physical metrics for a pixel density. */
export function physicalMetrics(pxPerMm: number): PhysicalMetrics {
  return {
    pxPerMm,
    minTargetPx: Math.ceil(TOUCH_TARGET_MIN_MM * pxPerMm),
    minSpacingPx: Math.ceil(TOUCH_SPACING_MIN_MM * pxPerMm),
  };
}

/** Millimetres to stage pixels. */
export function mmToPx(mm: number, metrics: PhysicalMetrics): number {
  return mm * metrics.pxPerMm;
}

/** Interactive safe area: lower two-thirds, inset by a margin (KSK-06). */
export function safeAreaFor(width: number, height: number, metrics: PhysicalMetrics): Rect {
  const margin = Math.max(metrics.minSpacingPx * 2, Math.round(Math.min(width, height) * 0.03));
  const top = Math.round(height / 3);
  return { x: margin, y: top, width: width - margin * 2, height: height - top - margin };
}

/** Compute a static layout snapshot (no change notifications). */
export function staticLayout(width: number, height: number, pxPerMm = DEFAULT_PX_PER_MM): Layout {
  const metrics = physicalMetrics(pxPerMm);
  return {
    width,
    height,
    safeArea: safeAreaFor(width, height, metrics),
    orientation: width >= height ? 'landscape' : 'portrait',
    metrics,
    onChange: () => () => undefined,
  };
}

/**
 * Live layout bound to a Pixi application's screen. Listeners are notified after the renderer resizes.
 * The engine may provide its own Layout; this one serves the gallery and the dev harness.
 */
export function createViewportLayout(
  app: Application,
  pxPerMm = DEFAULT_PX_PER_MM,
): Layout & { dispose(): void } {
  const listeners = new Set<(l: Layout) => void>();
  const metrics = physicalMetrics(pxPerMm);
  const state = { width: app.screen.width, height: app.screen.height };
  const layout: Layout & { dispose(): void } = {
    get width() {
      return state.width;
    },
    get height() {
      return state.height;
    },
    get safeArea() {
      return safeAreaFor(state.width, state.height, metrics);
    },
    get orientation() {
      return state.width >= state.height ? ('landscape' as const) : ('portrait' as const);
    },
    metrics,
    onChange(listener: (l: Layout) => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      app.renderer.off('resize', onResize);
      listeners.clear();
    },
  };
  const onResize = (w: number, h: number): void => {
    if (w === state.width && h === state.height) return;
    state.width = w;
    state.height = h;
    for (const l of [...listeners]) l(layout);
  };
  app.renderer.on('resize', onResize);
  return layout;
}

/** Scale factor relative to a 1080 px short edge: keeps art proportions in both orientations. */
export function unitScale(layout: Pick<Layout, 'width' | 'height'>): number {
  return Math.min(layout.width, layout.height) / 1080;
}

/**
 * Centres for `count` equal square targets of edge `size`, arranged in the safe area. Landscape uses one
 * row when it fits; portrait (or overflow) wraps into a balanced grid. Spacing never drops below the
 * physical minimum.
 */
export function arrangeChoices(
  layout: Pick<Layout, 'safeArea' | 'metrics' | 'orientation'>,
  count: number,
  size: number,
  options: { readonly yBias?: number; readonly gap?: number; readonly maxPerRow?: number } = {},
): Point[] {
  const area = layout.safeArea;
  const gap = Math.max(layout.metrics.minSpacingPx, options.gap ?? size * 0.35);
  const fitPerRow = Math.max(1, Math.floor((area.width + gap) / (size + gap)));
  const maxPerRow = Math.min(
    fitPerRow,
    options.maxPerRow ?? (layout.orientation === 'portrait' ? 3 : 6),
  );
  const rows = Math.ceil(count / maxPerRow);
  const perRow = Math.ceil(count / rows);
  const totalH = rows * size + (rows - 1) * gap;
  const yCentre = area.y + area.height * (options.yBias ?? 0.55);
  const top = Math.min(
    Math.max(area.y + size / 2, yCentre - totalH / 2 + size / 2),
    area.y + area.height - totalH + size / 2,
  );
  const out: Point[] = [];
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(perRow, count - r * perRow);
    const rowW = inRow * size + (inRow - 1) * gap;
    const left = area.x + (area.width - rowW) / 2 + size / 2;
    for (let c = 0; c < inRow; c++)
      out.push({ x: left + c * (size + gap), y: top + r * (size + gap) });
  }
  return out;
}

/** Stage-space bounds of a display object (for {@link TargetSpec.bounds}). */
export function stageBoundsOf(view: Container): Rect {
  const b = view.getBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/** True when two rects are at least `gap` apart (spacing lint). */
export function rectsSeparated(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}
