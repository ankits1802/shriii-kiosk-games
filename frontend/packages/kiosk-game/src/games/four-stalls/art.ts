/**
 * Four Stalls props: the stall emblems (circle, triangle, square, star on a hanging board — each stall
 * differs by shape AND colour, never colour alone), the cheeky monkey that snatches mangoes, and the
 * errand thought bubble. Original vector art.
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../art/color.ts';
import { rgrad, softShadow } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import { drawGood, type GoodsKind } from '../../art/props/goods.ts';

export type EmblemShape = 'circle' | 'triangle' | 'square' | 'star';

/** Hanging emblem board; origin = hook. */
export function createEmblem(shape: EmblemShape, color: number, size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const s = size;
  g.moveTo(-s * 0.28, 0)
    .lineTo(0, -s * 0.18)
    .lineTo(s * 0.28, 0)
    .stroke({ width: s * 0.04, color: MELA.woodDark });
  g.roundRect(-s * 0.42, 0, s * 0.84, s * 0.84, s * 0.14).fill(darken(MELA.wood, 0.1));
  g.roundRect(-s * 0.36, s * 0.06, s * 0.72, s * 0.72, s * 0.1).fill(MELA.cream);
  const cx = 0;
  const cy = s * 0.42;
  const r = s * 0.24;
  const fill = rgrad(
    [
      [0, lighten(color, 0.3)],
      [1, darken(color, 0.15)],
    ],
    { x: 0.4, y: 0.35 },
    0.8,
  );
  if (shape === 'circle') g.circle(cx, cy, r).fill(fill);
  else if (shape === 'square')
    g.roundRect(cx - r * 0.9, cy - r * 0.9, r * 1.8, r * 1.8, r * 0.2).fill(fill);
  else if (shape === 'triangle')
    g.poly([cx, cy - r * 1.05, cx + r * 1.05, cy + r * 0.8, cx - r * 1.05, cy + r * 0.8]).fill(
      fill,
    );
  else {
    const pts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? r * 1.1 : r * 0.48;
      pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    g.poly(pts).fill(fill);
  }
  c.addChild(g);
  return c;
}

/** A cheeky langur-style monkey (crouching, tail curled); origin = feet. */
export function createMonkey(size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const s = size;
  const fur = 0x9c7a55;
  const face = 0x3b2a26;
  softShadow(g, 0, 0, s * 0.35, s * 0.07, MELA.ink, 0.35);
  // Tail.
  g.moveTo(s * 0.2, -s * 0.2)
    .bezierCurveTo(s * 0.75, -s * 0.2, s * 0.8, -s * 0.9, s * 0.45, -s * 0.95)
    .bezierCurveTo(s * 0.3, -s * 0.97, s * 0.32, -s * 0.8, s * 0.42, -s * 0.8)
    .stroke({ width: s * 0.07, color: darken(fur, 0.1), cap: 'round' });
  // Body.
  g.ellipse(0, -s * 0.32, s * 0.26, s * 0.3).fill(
    rgrad(
      [
        [0, lighten(fur, 0.25)],
        [1, darken(fur, 0.2)],
      ],
      { x: 0.4, y: 0.3 },
      0.8,
    ),
  );
  // Legs and arms.
  g.ellipse(-s * 0.16, -s * 0.06, s * 0.12, s * 0.07).fill(darken(fur, 0.1));
  g.ellipse(s * 0.16, -s * 0.06, s * 0.12, s * 0.07).fill(darken(fur, 0.1));
  g.roundRect(-s * 0.32, -s * 0.45, s * 0.1, s * 0.32, s * 0.05).fill(darken(fur, 0.05));
  g.roundRect(s * 0.22, -s * 0.45, s * 0.1, s * 0.32, s * 0.05).fill(darken(fur, 0.05));
  // Head with a grey ruff and a dark face.
  g.circle(0, -s * 0.7, s * 0.2).fill(lighten(fur, 0.35));
  g.ellipse(0, -s * 0.68, s * 0.13, s * 0.14).fill(face);
  g.circle(-s * 0.05, -s * 0.71, s * 0.025).fill(MELA.cream);
  g.circle(s * 0.05, -s * 0.71, s * 0.025).fill(MELA.cream);
  g.circle(-s * 0.05, -s * 0.71, s * 0.012).fill(MELA.ink);
  g.circle(s * 0.05, -s * 0.71, s * 0.012).fill(MELA.ink);
  g.moveTo(-s * 0.05, -s * 0.62)
    .quadraticCurveTo(0, -s * 0.58, s * 0.05, -s * 0.62)
    .stroke({ width: s * 0.015, color: MELA.cream });
  g.circle(-s * 0.19, -s * 0.72, s * 0.04).fill(face);
  g.circle(s * 0.19, -s * 0.72, s * 0.04).fill(face);
  c.addChild(g);
  return c;
}

/** Thought bubble with a pictured item (the errand); origin = tail tip. */
export function createWishBubble(kind: GoodsKind, count: number, size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const s = size;
  g.circle(-s * 0.05, -s * 0.08, s * 0.05).fill({ color: MELA.cream, alpha: 0.95 });
  g.circle(-s * 0.12, -s * 0.2, s * 0.08).fill({ color: MELA.cream, alpha: 0.95 });
  g.ellipse(-s * 0.2, -s * 0.55, s * 0.42, s * 0.3).fill({ color: MELA.cream, alpha: 0.97 });
  g.ellipse(-s * 0.2, -s * 0.55, s * 0.42, s * 0.3).stroke({
    width: s * 0.025,
    color: MELA.sandstone,
  });
  const items = new Graphics();
  const n = Math.max(1, Math.min(3, count));
  for (let i = 0; i < n; i++)
    drawGood(items, kind, -s * 0.2 + (i - (n - 1) / 2) * s * 0.2, -s * 0.45, s * 0.012 * 1.6);
  c.addChild(g, items);
  return c;
}
