/**
 * Low-level painterly vector helpers on top of Pixi Graphics: gradients, soft shadows, catenaries,
 * scallops, glows. Everything is original procedural art (no third-party images).
 */
import { FillGradient, type Graphics } from 'pixi.js';
import { darken, lighten, mixColor } from './color.ts';

/** Vertical linear gradient in local (0..1) space. Stops are [offset, colour]. */
export function vgrad(stops: readonly (readonly [number, number | string])[]): FillGradient {
  return new FillGradient({
    type: 'linear',
    start: { x: 0, y: 0 },
    end: { x: 0, y: 1 },
    colorStops: stops.map(([offset, color]) => ({ offset, color })),
    textureSpace: 'local',
  });
}

/** Horizontal linear gradient in local (0..1) space. */
export function hgrad(stops: readonly (readonly [number, number | string])[]): FillGradient {
  return new FillGradient({
    type: 'linear',
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
    colorStops: stops.map(([offset, color]) => ({ offset, color })),
    textureSpace: 'local',
  });
}

/** Linear gradient along an arbitrary local direction. */
export function lgrad(
  start: { x: number; y: number },
  end: { x: number; y: number },
  stops: readonly (readonly [number, number | string])[],
): FillGradient {
  return new FillGradient({
    type: 'linear',
    start,
    end,
    colorStops: stops.map(([offset, color]) => ({ offset, color })),
    textureSpace: 'local',
  });
}

/** Radial gradient in local space; `stops` may carry alpha via 0xRRGGBBAA strings. */
export function rgrad(
  stops: readonly (readonly [number, number | string])[],
  center: { x: number; y: number } = { x: 0.5, y: 0.5 },
  outerRadius = 0.5,
): FillGradient {
  return new FillGradient({
    type: 'radial',
    center,
    innerRadius: 0,
    outerCenter: center,
    outerRadius,
    colorStops: stops.map(([offset, color]) => ({ offset, color })),
    textureSpace: 'local',
  });
}

/** `#rrggbbaa` string for gradient stops with alpha. */
export function rgba(color: number, alpha: number): string {
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  return `#${color.toString(16).padStart(6, '0')}${a.toString(16).padStart(2, '0')}`;
}

/**
 * Soft contact shadow: stacked translucent ellipses approximating a Gaussian falloff.
 * Cheap enough to draw live; bakes beautifully.
 */
export function softShadow(
  g: Graphics,
  x: number,
  y: number,
  rx: number,
  ry: number,
  color: number,
  alpha: number,
): Graphics {
  const steps = 6;
  for (let i = steps; i >= 1; i--) {
    const k = i / steps;
    g.ellipse(x, y, rx * (0.55 + 0.45 * k), ry * (0.55 + 0.45 * k)).fill({
      color,
      alpha: (alpha / steps) * 1.4,
    });
  }
  return g;
}

/** Radial glow disc (for lamps, sun halo, diyas). Draws into `g` centred at (x, y). */
export function glowDisc(
  g: Graphics,
  x: number,
  y: number,
  r: number,
  color: number,
  alpha = 1,
): Graphics {
  g.circle(x, y, r).fill(
    rgrad([
      [0, rgba(lighten(color, 0.55), alpha)],
      [0.18, rgba(color, alpha * 0.85)],
      [0.5, rgba(color, alpha * 0.28)],
      [1, rgba(color, 0)],
    ]),
  );
  return g;
}

/** Points along a hanging string (catenary approximated by a parabola) between two anchors. */
export function catenary(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  sag: number,
  segments: number,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    pts.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t + sag * 4 * t * (1 - t) });
  }
  return pts;
}

/** Stroke a polyline. */
export function polyline(
  g: Graphics,
  pts: readonly { x: number; y: number }[],
  width: number,
  color: number,
  alpha = 1,
): Graphics {
  const first = pts[0];
  if (!first) return g;
  g.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (p) g.lineTo(p.x, p.y);
  }
  g.stroke({ width, color, alpha, cap: 'round', join: 'round' });
  return g;
}

/** Smooth closed/open curve through points using Catmull-Rom -> Bezier. */
export function smoothPath(
  g: Graphics,
  pts: readonly { x: number; y: number }[],
  close = false,
): Graphics {
  const n = pts.length;
  if (n < 2) return g;
  const at = (i: number): { x: number; y: number } => {
    const idx = close ? (i + n) % n : Math.max(0, Math.min(n - 1, i));
    return pts[idx] ?? { x: 0, y: 0 };
  };
  const p0 = at(0);
  g.moveTo(p0.x, p0.y);
  const last = close ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    const d = at(i + 2);
    g.bezierCurveTo(
      b.x + (c.x - a.x) / 6,
      b.y + (c.y - a.y) / 6,
      c.x - (d.x - b.x) / 6,
      c.y - (d.y - b.y) / 6,
      c.x,
      c.y,
    );
  }
  if (close) g.closePath();
  return g;
}

/** Scalloped edge (awning valance) from x1 to x2 at y with `count` scallops of depth `depth`. */
export function scallopPath(
  g: Graphics,
  x1: number,
  x2: number,
  y: number,
  depth: number,
  count: number,
): Graphics {
  const w = (x2 - x1) / count;
  g.moveTo(x1, y);
  for (let i = 0; i < count; i++) {
    const sx = x1 + i * w;
    g.quadraticCurveTo(sx + w / 2, y + depth * 2, sx + w, y);
  }
  return g;
}

/** Five-petal marigold-like flower (layered petals with a deep centre). */
export function marigold(g: Graphics, x: number, y: number, r: number, color: number): Graphics {
  const deep = darken(color, 0.25);
  g.circle(x, y, r).fill(deep);
  for (let ring = 0; ring < 2; ring++) {
    const petals = ring === 0 ? 9 : 7;
    const pr = r * (ring === 0 ? 0.55 : 0.4);
    const dist = r * (ring === 0 ? 0.52 : 0.28);
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * Math.PI * 2 + ring * 0.3;
      g.circle(x + Math.cos(a) * dist, y + Math.sin(a) * dist, pr).fill(
        ring === 0 ? color : lighten(color, 0.18),
      );
    }
  }
  g.circle(x, y, r * 0.22).fill(darken(color, 0.4));
  return g;
}

/** Mango leaf (toran) pointing down from (x, y). */
export function mangoLeaf(
  g: Graphics,
  x: number,
  y: number,
  len: number,
  angle: number,
  color: number,
): Graphics {
  const w = len * 0.28;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const tx = (px: number, py: number): [number, number] => [
    x + px * c - py * s,
    y + px * s + py * c,
  ];
  const [ax, ay] = tx(0, 0);
  const [b1x, b1y] = tx(-w, len * 0.35);
  const [b2x, b2y] = tx(-w * 0.6, len * 0.8);
  const [tipx, tipy] = tx(0, len);
  const [c1x, c1y] = tx(w * 0.6, len * 0.8);
  const [c2x, c2y] = tx(w, len * 0.35);
  g.moveTo(ax, ay)
    .bezierCurveTo(b1x, b1y, b2x, b2y, tipx, tipy)
    .bezierCurveTo(c1x, c1y, c2x, c2y, ax, ay)
    .fill(color);
  const [mx, my] = tx(0, len * 0.9);
  g.moveTo(ax, ay)
    .lineTo(mx, my)
    .stroke({ width: Math.max(1, len * 0.04), color: lighten(color, 0.3), alpha: 0.7 });
  return g;
}

/** Shaded sphere-ish blob (fruit, pot belly, canopy clump). */
export function shadedBlob(
  g: Graphics,
  x: number,
  y: number,
  rx: number,
  ry: number,
  color: number,
  lightDir = -0.6,
): Graphics {
  g.ellipse(x, y, rx, ry).fill(
    rgrad(
      [
        [0, lighten(color, 0.35)],
        [0.45, color],
        [1, darken(color, 0.35)],
      ],
      { x: 0.5 + lightDir * 0.25, y: 0.3 },
      0.75,
    ),
  );
  return g;
}

/** Mix helper re-exported for drawing code. */
export { darken, lighten, mixColor };

/** Arc that starts a fresh sub-path (Pixi's `arc` otherwise joins from the previous point). */
export function openArc(
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  anticlockwise = false,
): Graphics {
  g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
  return g.arc(cx, cy, r, a0, a1, anticlockwise);
}
