/**
 * Wait-or-Now props, drawn procedurally in the Mela style (no text, no numerals):
 * brass thali on a banana leaf with a pile of laddoos, a glass cloche (for "later" plates), the
 * sun-and-moon chain that pictures how many days and nights the wait lasts, the little churn badge of
 * the "more for churning" plate, the big butter churn (hold pad), the leaf parcel kept for later, the
 * player's wicker basket and the shop shelf.
 *
 * Every shape cue is redundant with colour (cloche outline, sun rays vs crescent, churn silhouette), so
 * colour is never the only cue.
 */
import { Container, Graphics } from 'pixi.js';
import { drawPot } from '../../art/backdrop/props.ts';
import { darken, lighten } from '../../art/color.ts';
import { glowDisc, marigold, rgba, rgrad, softShadow, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import { drawLaddoo } from '../dont-tap/kit/scene/ProbeLayer.ts';
import { sweetPile } from './geometry.ts';

/** Laddoo radius for a plate of radius `plateR`. */
export function laddooRadius(plateR: number): number {
  return plateR * 0.165;
}

/** Brass thali with a banana leaf, centred at (0, 0) (the plate's visual centre). */
export function drawThali(plateR: number): Container {
  const c = new Container();
  const g = new Graphics();
  const rx = plateR;
  const ry = plateR * 0.36;
  softShadow(g, 0, ry * 0.75, rx * 1.05, ry * 0.7, 0x1a0d08, 0.4);
  // Rim and dish.
  g.ellipse(0, ry * 0.1, rx, ry).fill(
    vgrad([
      [0, MELA.brassLight],
      [0.45, MELA.brass],
      [1, 0x8a5c16],
    ]),
  );
  g.ellipse(0, 0, rx * 0.86, ry * 0.8).fill(
    vgrad([
      [0, 0xa8741f],
      [1, MELA.brassLight],
    ]),
  );
  g.ellipse(0, 0, rx * 0.86, ry * 0.8).stroke({
    width: Math.max(1.5, plateR * 0.014),
    color: 0x7a4f12,
    alpha: 0.6,
  });
  // Engraved dots on the rim.
  for (let i = 0; i < 22; i += 1) {
    const a = (i / 22) * Math.PI * 2;
    g.circle(Math.cos(a) * rx * 0.93, ry * 0.1 + Math.sin(a) * ry * 0.9, plateR * 0.012).fill({
      color: 0x7a4f12,
      alpha: 0.6,
    });
  }
  // Banana leaf, slightly diagonal.
  const leaf = new Graphics();
  const lw = rx * 0.78;
  const lh = ry * 0.62;
  leaf
    .moveTo(-lw, lh * 0.1)
    .bezierCurveTo(-lw * 0.6, -lh * 1.1, lw * 0.6, -lh * 1.0, lw, -lh * 0.1)
    .bezierCurveTo(lw * 0.6, lh * 1.1, -lw * 0.6, lh * 1.05, -lw, lh * 0.1)
    .closePath()
    .fill(
      vgrad([
        [0, lighten(MELA.mango, 0.18)],
        [1, darken(MELA.banyan, 0.05)],
      ]),
    );
  leaf
    .moveTo(-lw * 0.95, lh * 0.05)
    .lineTo(lw * 0.95, -lh * 0.05)
    .stroke({ width: Math.max(1.5, plateR * 0.016), color: lighten(MELA.mango, 0.45), alpha: 0.9 });
  for (let k = -5; k <= 5; k += 1) {
    const x = (k / 6) * lw;
    leaf
      .moveTo(x, -lh * 0.02 * (k / 6))
      .lineTo(x + lw * 0.12, -lh * 0.62)
      .stroke({ width: 1, color: lighten(MELA.mango, 0.35), alpha: 0.45 });
    leaf
      .moveTo(x, -lh * 0.02 * (k / 6))
      .lineTo(x + lw * 0.12, lh * 0.62)
      .stroke({ width: 1, color: darken(MELA.banyan, 0.2), alpha: 0.35 });
  }
  leaf.rotation = -0.06;
  // Rim highlight.
  g.ellipse(-rx * 0.3, -ry * 0.62, rx * 0.34, ry * 0.12).fill({ color: 0xffffff, alpha: 0.28 });
  c.addChild(g, leaf);
  return c;
}

/** The pile of `n` laddoos for a plate of radius `plateR`; each laddoo is its own Graphics (they can fly). */
export function drawPile(n: number, plateR: number): Graphics[] {
  const r = laddooRadius(plateR);
  return sweetPile(n, r).map((p) => {
    const g = new Graphics();
    softShadow(g, 0, r * 0.8, r * 0.95, r * 0.28, 0x3a1a08, 0.35);
    drawLaddoo(g, 0, 0, r);
    g.position.set(p.x, p.y);
    return g;
  });
}

/** Height (px above the plate centre) of the tallest pile of `n` laddoos. */
export function pileHeight(n: number, plateR: number): number {
  const r = laddooRadius(plateR);
  const pts = sweetPile(n, r);
  return pts.length ? -Math.min(...pts.map((p) => p.y)) + r : 0;
}

/** Glass cloche over a plate (domed glass with a brass knob), base at y = 0, `h` tall. */
export function drawCloche(plateR: number, h: number): Container {
  const c = new Container();
  const w = plateR * 0.84;
  const g = new Graphics();
  const dome = (q: Graphics): Graphics =>
    q
      .moveTo(-w, 0)
      .bezierCurveTo(-w, -h * 0.75, -w * 0.55, -h, 0, -h)
      .bezierCurveTo(w * 0.55, -h, w, -h * 0.75, w, 0)
      .closePath();
  dome(g).fill({ color: 0xe8f7f8, alpha: 0.16 });
  dome(g).stroke({ width: Math.max(2.5, plateR * 0.022), color: 0xf6ffff, alpha: 0.85 });
  // Glass rim ring and reflections (a strong shape cue).
  g.ellipse(0, 0, w, plateR * 0.09).stroke({
    width: Math.max(2.5, plateR * 0.02),
    color: 0xffffff,
    alpha: 0.7,
  });
  g.moveTo(-w * 0.7, -h * 0.25)
    .bezierCurveTo(-w * 0.72, -h * 0.62, -w * 0.45, -h * 0.86, -w * 0.18, -h * 0.92)
    .stroke({ width: Math.max(4, plateR * 0.05), color: 0xffffff, alpha: 0.55, cap: 'round' });
  g.moveTo(w * 0.62, -h * 0.2)
    .bezierCurveTo(w * 0.66, -h * 0.4, w * 0.6, -h * 0.55, w * 0.52, -h * 0.64)
    .stroke({ width: Math.max(2, plateR * 0.022), color: 0xffffff, alpha: 0.4, cap: 'round' });
  // Brass knob.
  g.ellipse(0, -h - plateR * 0.02, plateR * 0.1, plateR * 0.035).fill(darken(MELA.brass, 0.2));
  g.circle(0, -h - plateR * 0.08, plateR * 0.065).fill(
    rgrad(
      [
        [0, MELA.brassLight],
        [1, darken(MELA.brass, 0.25)],
      ],
      { x: 0.35, y: 0.3 },
      0.7,
    ),
  );
  c.addChild(g);
  return c;
}

/** A small sun disc with rays (radius r) centred at (x, y). */
export function drawSun(g: Graphics, x: number, y: number, r: number): void {
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    g.poly([
      x + Math.cos(a - 0.22) * r * 0.78,
      y + Math.sin(a - 0.22) * r * 0.78,
      x + Math.cos(a) * r * 1.38,
      y + Math.sin(a) * r * 1.38,
      x + Math.cos(a + 0.22) * r * 0.78,
      y + Math.sin(a + 0.22) * r * 0.78,
    ]).fill(MELA.marigoldDeep);
  }
  g.circle(x, y, r * 0.82).fill(
    rgrad(
      [
        [0, 0xfff3b0],
        [0.6, MELA.marigold],
        [1, MELA.marigoldDeep],
      ],
      { x: 0.4, y: 0.35 },
      0.7,
    ),
  );
}

/** A crescent moon (radius r) centred at (x, y), with a deep-indigo night disc behind it. */
export function drawMoon(g: Graphics, x: number, y: number, r: number): void {
  g.circle(x, y, r * 1.05).fill(MELA.indigo);
  g.circle(x, y, r * 1.05).stroke({
    width: Math.max(1, r * 0.08),
    color: lighten(MELA.indigo, 0.35),
  });
  // Crescent: outer arc right, inner arc offset.
  g.moveTo(x + r * 0.1, y - r * 0.82)
    .bezierCurveTo(
      x + r * 0.95,
      y - r * 0.55,
      x + r * 0.95,
      y + r * 0.55,
      x + r * 0.1,
      y + r * 0.82,
    )
    .bezierCurveTo(x + r * 0.5, y + r * 0.4, x + r * 0.5, y - r * 0.4, x + r * 0.1, y - r * 0.82)
    .closePath()
    .fill(0xf3f0dc);
  g.circle(x - r * 0.45, y - r * 0.4, r * 0.08).fill({ color: 0xfff7cf, alpha: 0.9 });
  g.circle(x - r * 0.25, y + r * 0.45, r * 0.06).fill({ color: 0xfff7cf, alpha: 0.8 });
}

/**
 * The wait picture: `days` sun+moon pairs strung on a marigold thread, up to 4 pairs per row, centred
 * on (0, 0) (top row first). Returns the container and its height.
 */
export function drawSunMoonChain(days: number, iconR: number): { view: Container; height: number } {
  const c = new Container();
  const g = new Graphics();
  const perRow = 4;
  const rows = Math.max(1, Math.ceil(days / perRow));
  const pairW = iconR * 4.9;
  const rowH = iconR * 3.1;
  for (let row = 0; row < rows; row += 1) {
    const n = Math.min(perRow, days - row * perRow);
    const y = row * rowH - ((rows - 1) * rowH) / 2;
    const x0 = -((n - 1) * pairW) / 2;
    // Thread.
    if (n > 0) {
      g.moveTo(x0 - pairW * 0.42, y)
        .quadraticCurveTo(0, y + iconR * 0.5, x0 + (n - 1) * pairW + pairW * 0.42, y)
        .stroke({ width: Math.max(1.5, iconR * 0.12), color: MELA.marigoldDeep, alpha: 0.9 });
    }
    for (let i = 0; i < n; i += 1) {
      const cx = x0 + i * pairW;
      drawSun(g, cx - iconR * 1.15, y, iconR);
      drawMoon(g, cx + iconR * 1.15, y, iconR);
    }
  }
  c.addChild(g);
  return { view: c, height: rows * rowH };
}

/** Badge for the hard (churning) option: a little clay churn with its stick and a pressing hand. */
export function drawChurnBadge(size: number): Container {
  const c = new Container();
  const g = new Graphics();
  glowDisc(g, 0, 0, size * 0.95, 0xffe6a8, 0.35);
  drawPot(g, 0, size * 0.55, size * 0.95, MELA.terracotta, size / 90);
  // Stick and cross handle.
  g.roundRect(-size * 0.05, -size * 0.75, size * 0.1, size * 0.95, size * 0.04).fill(
    lighten(MELA.wood, 0.25),
  );
  g.roundRect(-size * 0.32, -size * 0.8, size * 0.64, size * 0.12, size * 0.06).fill(MELA.wood);
  // Rope turns.
  for (let k = 0; k < 3; k += 1) {
    g.ellipse(0, -size * 0.38 + k * size * 0.1, size * 0.12, size * 0.035).stroke({
      width: Math.max(1.5, size * 0.03),
      color: MELA.parchment,
    });
  }
  // Pressing hand (palm down) over the handle.
  const h = new Graphics();
  h.roundRect(-size * 0.22, -size * 1.12, size * 0.44, size * 0.26, size * 0.12).fill(0xc68a5a);
  for (let f = 0; f < 4; f += 1) {
    h.roundRect(
      -size * 0.2 + f * size * 0.105,
      -size * 0.92,
      size * 0.085,
      size * 0.16,
      size * 0.04,
    ).fill(0xb87a4c);
  }
  h.roundRect(-size * 0.28, -size * 1.06, size * 0.1, size * 0.18, size * 0.05).fill(0xb87a4c);
  // Motion arcs.
  for (const s of [-1, 1]) {
    g.moveTo(s * size * 0.42, -size * 0.62)
      .quadraticCurveTo(s * size * 0.58, -size * 0.45, s * size * 0.44, -size * 0.25)
      .stroke({ width: Math.max(2, size * 0.04), color: 0xfff1c8, alpha: 0.85, cap: 'round' });
  }
  c.addChild(g, h);
  return c;
}

/** Big butter churn (the hold pad): clay pot, churning stick with knob, rope. Origin = pot base. */
export interface ChurnArt {
  readonly view: Container;
  /** The stick (rotates/oscillates while churning). */
  readonly stick: Container;
  /** Butter froth inside the mouth (scaled up as the hold progresses). */
  readonly froth: Graphics;
  /** Progress beads around the pot (lit one by one; never a number). */
  readonly beads: Graphics[];
  readonly beadsCentre: { x: number; y: number };
}

export function drawChurn(size: number): ChurnArt {
  const view = new Container();
  const u = size / 250;
  const back = new Graphics();
  // Round wooden base (chowki) with a warm pool of light, so the churn reads as its own object.
  glowDisc(back, 0, -size * 0.3, size * 0.62, 0xffd27a, 0.4);
  softShadow(back, 0, size * 0.04, size * 0.5, size * 0.08, 0x1a0d08, 0.5);
  back.ellipse(0, 0, size * 0.47, size * 0.11).fill(
    vgrad([
      [0, lighten(MELA.wood, 0.4)],
      [1, MELA.wood],
    ]),
  );
  back.rect(-size * 0.47, 0, size * 0.94, size * 0.05).fill(MELA.woodDark);
  back.ellipse(0, size * 0.05, size * 0.47, size * 0.1).fill(MELA.woodDark);
  back
    .ellipse(0, 0, size * 0.47, size * 0.11)
    .stroke({ width: Math.max(1.5, size * 0.012), color: MELA.brassLight, alpha: 0.7 });
  const potH = size * 0.56;
  drawPot(back, 0, 0, potH, MELA.terracotta, u * 1.6);
  // Painted rangoli band.
  for (let i = -3; i <= 3; i += 1) {
    marigold(
      back,
      i * potH * 0.13,
      -potH * 0.5,
      potH * 0.035,
      i % 2 ? MELA.marigold : MELA.saffron,
    );
  }
  const froth = new Graphics();
  froth.ellipse(0, 0, potH * 0.22, potH * 0.07).fill(0xfff6dc);
  froth.circle(-potH * 0.1, -potH * 0.03, potH * 0.04).fill(0xffffff);
  froth.circle(potH * 0.08, -potH * 0.02, potH * 0.035).fill(0xffffff);
  froth.position.set(0, -potH * 0.95);
  froth.scale.set(0.4);
  froth.alpha = 0.85;
  const stick = new Container();
  const sg = new Graphics();
  sg.roundRect(-8 * u, -size * 0.8, 16 * u, size * 0.5, 6 * u).fill(
    vgrad([
      [0, lighten(MELA.wood, 0.35)],
      [1, MELA.wood],
    ]),
  );
  // Handle knob (where the hand presses).
  sg.circle(0, -size * 0.82, 28 * u).fill(
    rgrad(
      [
        [0, lighten(MELA.vermilion, 0.35)],
        [0.7, MELA.vermilion],
        [1, darken(MELA.vermilion, 0.35)],
      ],
      { x: 0.35, y: 0.3 },
      0.7,
    ),
  );
  sg.circle(-8 * u, -size * 0.82 - 9 * u, 7 * u).fill({ color: 0xffffff, alpha: 0.45 });
  for (let k = 0; k < 4; k += 1) {
    sg.ellipse(0, -size * 0.6 + k * 12 * u, 20 * u, 5 * u).stroke({
      width: 3 * u,
      color: MELA.parchment,
    });
  }
  // The stick turns about the pot mouth: the container sits there, the drawing is offset back.
  sg.position.set(0, potH * 0.92);
  stick.addChild(sg);
  stick.position.set(0, -potH * 0.92);
  const beads: Graphics[] = [];
  const beadsCentre = { x: 0, y: -potH * 0.5 };
  const n = 12;
  for (let i = 0; i < n; i += 1) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const b = new Graphics();
    marigold(b, 0, 0, 13 * u, MELA.marigold);
    b.position.set(
      beadsCentre.x + Math.cos(a) * size * 0.46,
      beadsCentre.y + Math.sin(a) * size * 0.3,
    );
    b.alpha = 0.22;
    b.scale.set(0.8);
    beads.push(b);
  }
  view.addChild(back, froth, stick, ...beads);
  return { view, stick, froth, beads, beadsCentre };
}

/** Leaf parcel (kept for later) tied with string and a little sun-moon tag. Centred at (0, 0). */
export function drawParcel(s: number): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, 0, s * 0.45, s * 0.55, s * 0.12, 0x1a0d08, 0.35);
  g.roundRect(-s * 0.5, -s * 0.38, s, s * 0.8, s * 0.22).fill(
    vgrad([
      [0, lighten(MELA.mango, 0.12)],
      [1, MELA.banyan],
    ]),
  );
  g.moveTo(-s * 0.5, -s * 0.05)
    .quadraticCurveTo(0, -s * 0.25, s * 0.5, -s * 0.05)
    .stroke({ width: Math.max(1, s * 0.04), color: lighten(MELA.mango, 0.4), alpha: 0.8 });
  g.moveTo(0, -s * 0.38)
    .lineTo(0, s * 0.42)
    .stroke({ width: Math.max(1.5, s * 0.06), color: MELA.parchment });
  g.moveTo(-s * 0.5, s * 0.05)
    .lineTo(s * 0.5, s * 0.05)
    .stroke({ width: Math.max(1.5, s * 0.06), color: MELA.parchment });
  g.circle(0, s * 0.05, s * 0.08).fill(MELA.parchment);
  // Tag: half sun, half moon.
  drawSun(g, s * 0.32, -s * 0.48, s * 0.1);
  drawMoon(g, s * 0.56, -s * 0.48, s * 0.1);
  c.addChild(g);
  return c;
}

/** Wicker basket (origin = base centre); `contents` sits inside the rim. */
export function drawBasket(w: number): {
  view: Container;
  back: Graphics;
  contents: Container;
  front: Graphics;
} {
  const view = new Container();
  const h = w * 0.5;
  const back = new Graphics();
  softShadow(back, 0, 0, w * 0.58, w * 0.08, 0x1a0d08, 0.45);
  back.ellipse(0, -h, w * 0.5, w * 0.12).fill(darken(MELA.sandstone, 0.45));
  const contents = new Container();
  contents.position.set(0, -h);
  const front = new Graphics();
  front
    .moveTo(-w * 0.5, -h)
    .lineTo(w * 0.5, -h)
    .lineTo(w * 0.4, 0)
    .lineTo(-w * 0.4, 0)
    .closePath()
    .fill(
      vgrad([
        [0, lighten(MELA.sandstone, 0.1)],
        [1, darken(MELA.sandstone, 0.3)],
      ]),
    );
  for (let r = 1; r < 5; r += 1) {
    const y = -h + (r / 5) * h;
    const half = w * 0.5 - (r / 5) * w * 0.1;
    front
      .moveTo(-half, y)
      .lineTo(half, y)
      .stroke({ width: Math.max(1, w * 0.012), color: darken(MELA.sandstone, 0.4), alpha: 0.7 });
  }
  for (let k = -6; k <= 6; k += 1) {
    front
      .moveTo(k * w * 0.075, -h)
      .lineTo(k * w * 0.06, 0)
      .stroke({ width: Math.max(1, w * 0.01), color: darken(MELA.sandstone, 0.35), alpha: 0.55 });
  }
  front
    .ellipse(0, -h, w * 0.5, w * 0.06)
    .stroke({ width: Math.max(3, w * 0.04), color: darken(MELA.sandstone, 0.15) });
  front
    .ellipse(-w * 0.2, -h - w * 0.02, w * 0.12, w * 0.015)
    .fill({ color: 0xffffff, alpha: 0.25 });
  // Handle.
  back
    .moveTo(-w * 0.42, -h)
    .bezierCurveTo(-w * 0.4, -h - w * 0.55, w * 0.4, -h - w * 0.55, w * 0.42, -h)
    .stroke({ width: Math.max(4, w * 0.05), color: darken(MELA.sandstone, 0.2) });
  view.addChild(back, contents, front);
  return { view, back, contents, front };
}

/** Warm spotlight pool on the counter under a plate. */
export function drawPool(r: number, color = 0xffd9a0, alpha = 0.32): Graphics {
  const g = new Graphics();
  g.ellipse(0, 0, r, r * 0.36).fill(
    rgrad([
      [0, rgba(color, alpha)],
      [0.6, rgba(color, alpha * 0.4)],
      [1, rgba(color, 0)],
    ]),
  );
  g.blendMode = 'add';
  return g;
}

/**
 * Parchment sign on a slim bamboo stick (centred at x = 0): the board is `w` x `h` centred at `cy`,
 * the stick runs down to `stickBottom`. Frames the plate's picture so it reads as part of the plate.
 */
export function drawSign(
  w: number,
  h: number,
  cy: number,
  stickBottom: number,
  u: number,
): Graphics {
  const g = new Graphics();
  g.roundRect(-3 * u, cy, 6 * u, stickBottom - cy, 3 * u).fill(lighten(MELA.sandstone, 0.1));
  softShadow(g, 4 * u, cy + 8 * u, w * 0.5, h * 0.5, 0x1a0d08, 0.18);
  g.roundRect(-w / 2, cy - h / 2, w, h, Math.min(w, h) * 0.3).fill(
    vgrad([
      [0, lighten(MELA.cream, 0.2)],
      [1, MELA.parchment],
    ]),
  );
  g.roundRect(-w / 2, cy - h / 2, w, h, Math.min(w, h) * 0.3).stroke({
    width: Math.max(2, 4 * u),
    color: MELA.brass,
  });
  g.roundRect(
    -w / 2 + 7 * u,
    cy - h / 2 + 7 * u,
    w - 14 * u,
    h - 14 * u,
    Math.min(w, h) * 0.24,
  ).stroke({ width: Math.max(1, 1.5 * u), color: MELA.marigoldDeep, alpha: 0.6 });
  return g;
}
