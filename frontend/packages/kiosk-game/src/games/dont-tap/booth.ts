/**
 * The firefly fruit-toss booth (static set art for Don't-Tap): a carved wooden frame with a cusped
 * Mughal arch opening onto a block-printed cloth wall strung with fairy lights, a scalloped striped
 * valance with tassels, brass toss-rings on the pillars, glowing firefly jars on the counter ends,
 * two hanging lanterns and a carved counter with a marigold-motif front and cloth skirt.
 * Original procedural vector art; no text, no numerals.
 */
import { Container, Graphics } from 'pixi.js';
import { drawLantern, drawPaisley } from '../../art/backdrop/props.ts';
import { darken, lighten } from '../../art/color.ts';
import { catenary, glowDisc, marigold, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import type { DontTapGeometry } from './geometry.ts';
import { contactShadow } from './kit/scene/fx.ts';

export interface BoothArt {
  /** Static art (bake it). */
  readonly view: Container;
  /** Animated additive glows, drawn above the static art. */
  readonly glowLayer: Container;
  /** Additive glows that flicker (lanterns, fairy bulbs, jars). */
  readonly glows: readonly Container[];
  /** Firefly-jar centres (for in-jar fireflies). */
  readonly jars: readonly { readonly x: number; readonly y: number; readonly r: number }[];
}

/** Cusped (multifoil) arch path from (x0, springY) over the top to (x1, springY). */
function cuspedArch(g: Graphics, x0: number, x1: number, springY: number, apexY: number): void {
  const cx = (x0 + x1) / 2;
  const half = (x1 - x0) / 2;
  const lobes = 7;
  g.moveTo(x0, springY);
  for (let i = 0; i < lobes; i += 1) {
    const a0 = Math.PI - (i / lobes) * Math.PI;
    const a1 = Math.PI - ((i + 1) / lobes) * Math.PI;
    const p0 = { x: cx + Math.cos(a0) * half, y: springY - Math.sin(a0) * (springY - apexY) };
    const p1 = { x: cx + Math.cos(a1) * half, y: springY - Math.sin(a1) * (springY - apexY) };
    const mid = (a0 + a1) / 2;
    const bulge = 0.12 * half;
    const c = {
      x: cx + Math.cos(mid) * (half + bulge * 0.2),
      y: springY - Math.sin(mid) * (springY - apexY) - bulge,
    };
    if (i === 0) g.lineTo(p0.x, p0.y);
    g.quadraticCurveTo(c.x, c.y, p1.x, p1.y);
  }
  g.lineTo(x1, springY);
}

export function drawBooth(geo: DontTapGeometry, u: number): BoothArt {
  const view = new Container();
  const glowLayer = new Container();
  const glows: Container[] = [];
  const jars: { x: number; y: number; r: number }[] = [];
  const { cx, width: w, top, counterY, groundY } = geo.booth;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const pillar = w * 0.075;
  const springY = top + (counterY - top) * 0.36;
  const apexY = top + (counterY - top) * 0.08;

  // Ground shadow.
  const sh = contactShadow(w * 0.6, 30 * u, 0.42);
  sh.position.set(cx, groundY + 4 * u);
  view.addChild(sh);

  // Back wall: block-printed indigo-teal cloth, lit warmer toward the centre.
  const wall = new Graphics();
  wall.rect(x0 + pillar * 0.6, top, w - pillar * 1.2, counterY - top).fill(
    vgrad([
      [0, 0x1e2a4f],
      [0.6, 0x23305a],
      [1, 0x2a1f46],
    ]),
  );
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 11; col += 1) {
      const px = x0 + pillar + ((col + (row % 2 ? 0.5 : 0)) / 11) * (w - pillar * 2);
      const py = top + (counterY - top) * (0.12 + row * 0.11);
      drawPaisley(wall, px, py, 9 * u, row % 2 ? MELA.brass : MELA.rose);
    }
  }
  wall.alpha = 1;
  view.addChild(wall);
  const wallGlow = new Graphics();
  glowDisc(wallGlow, cx, counterY - (counterY - top) * 0.25, w * 0.42, 0xffc06a, 0.32);
  wallGlow.blendMode = 'add';
  glowLayer.addChild(wallGlow);
  glows.push(wallGlow);

  // Fairy lights across the wall.
  const lights = new Graphics();
  const bulbs = new Graphics();
  for (let k = 0; k < 3; k += 1) {
    const y = top + (counterY - top) * (0.42 + k * 0.17);
    const pts = catenary(x0 + pillar, y, x1 - pillar, y, 26 * u, 22);
    lights.moveTo(pts[0]?.x ?? 0, pts[0]?.y ?? 0);
    for (const p of pts) lights.lineTo(p.x, p.y);
    lights.stroke({ width: 1.6 * u, color: 0x0f0c1c, alpha: 0.8 });
    pts.forEach((p, i) => {
      if (i === 0 || i === pts.length - 1) return;
      const c = [0xfff1b0, 0xffc76a, 0xffe08a][i % 3] as number;
      glowDisc(bulbs, p.x, p.y + 4 * u, 13 * u, c, 0.75);
      bulbs.circle(p.x, p.y + 4 * u, 3 * u).fill(0xfffbe6);
    });
  }
  bulbs.blendMode = 'add';
  view.addChild(lights);
  glowLayer.addChild(bulbs);
  glows.push(bulbs);

  // Lanterns hanging inside the arch.
  for (const f of [0.18, 0.82]) {
    const lx = x0 + w * f;
    const ly = springY - (counterY - top) * 0.02;
    const lant = drawLantern(2.1 * u, f < 0.5 ? MELA.vermilion : MELA.saffron);
    lant.view.position.set(lx, ly - 56 * u);
    const glow = new Graphics();
    glowDisc(glow, lx, ly + 6 * u, 150 * u, 0xffb347, 0.8);
    glow.blendMode = 'add';
    glows.push(glow);
    glowLayer.addChild(glow);
    view.addChild(lant.view);
    const cord = new Graphics()
      .moveTo(lx, top)
      .lineTo(lx, ly - 56 * u)
      .stroke({ width: 2 * u, color: MELA.woodDark });
    view.addChild(cord);
  }

  // Carved wooden frame with the cusped arch opening (the opening is cut out of the frame).
  const frame = new Graphics();
  frame.roundRect(x0, top - 26 * u, w, counterY - top + 30 * u, 14 * u).fill(
    vgrad([
      [0, lighten(MELA.wood, 0.28)],
      [0.45, MELA.wood],
      [1, MELA.woodDark],
    ]),
  );
  cuspedArch(frame, x0 + pillar, x1 - pillar, counterY + 2 * u, apexY);
  frame
    .lineTo(x1 - pillar, counterY + 4 * u)
    .lineTo(x0 + pillar, counterY + 4 * u)
    .closePath();
  frame.cut();
  // Gold inlay following the arch and the pillars.
  const inlay = new Graphics();
  cuspedArch(inlay, x0 + pillar * 0.8, x1 - pillar * 0.8, counterY, apexY - 10 * u);
  inlay.stroke({ width: 4 * u, color: MELA.brass, alpha: 0.9 });
  for (const px of [x0 + pillar * 0.45, x1 - pillar * 0.45]) {
    for (let k = 0; k < 7; k += 1) {
      const yy = springY + k * ((counterY - springY) / 7);
      inlay.circle(px, yy, pillar * 0.12).fill({ color: MELA.brass, alpha: 0.9 });
    }
  }
  // Crown cornice with a little marigold finial row.
  inlay.roundRect(x0 - 10 * u, top - 46 * u, w + 20 * u, 26 * u, 8 * u).fill(
    vgrad([
      [0, lighten(MELA.wood, 0.35)],
      [1, MELA.woodDark],
    ]),
  );
  for (let i = 0; i <= 12; i += 1) {
    marigold(inlay, x0 + (i / 12) * w, top - 52 * u, 9 * u, i % 2 ? MELA.marigold : MELA.saffron);
  }
  view.addChild(frame, inlay);

  // Scalloped, shaded striped valance with tassels under the cornice.
  const val = new Graphics();
  const n = 14;
  const vTop = top - 20 * u;
  const vBot = top + 34 * u;
  const sw = (w - 8 * u) / n;
  for (let i = 0; i < n; i += 1) {
    const sx = x0 + 4 * u + i * sw;
    const c = i % 2 ? MELA.cream : MELA.saffron;
    val
      .moveTo(sx, vTop)
      .lineTo(sx + sw, vTop)
      .lineTo(sx + sw, vBot)
      .quadraticCurveTo(sx + sw / 2, vBot + 22 * u, sx, vBot)
      .closePath()
      .fill(
        vgrad([
          [0, lighten(c, 0.15)],
          [1, darken(c, 0.12)],
        ]),
      );
    // Tassel.
    val
      .moveTo(sx + sw, vBot)
      .lineTo(sx + sw, vBot + 16 * u)
      .stroke({ width: 2 * u, color: MELA.marigoldDeep });
    val.circle(sx + sw, vBot + 19 * u, 4.5 * u).fill(MELA.vermilion);
  }
  val.rect(x0 + 4 * u, vTop, w - 8 * u, 5 * u).fill(MELA.brass);
  view.addChild(val);

  // Brass toss-rings hung on pillar pegs.
  const rings = new Graphics();
  for (const px of [x0 + pillar * 0.5, x1 - pillar * 0.5]) {
    for (let k = 0; k < 3; k += 1) {
      const ry = springY + 30 * u + k * 74 * u;
      rings.circle(px, ry - 26 * u, 4 * u).fill(MELA.woodDark);
      rings
        .ellipse(px, ry, 19 * u, 25 * u)
        .stroke({ width: 6 * u, color: k === 1 ? MELA.vermilion : MELA.brass });
      rings
        .ellipse(px - 6 * u, ry - 10 * u, 6 * u, 4 * u)
        .stroke({ width: 2 * u, color: 0xffffff, alpha: 0.4 });
    }
  }
  view.addChild(rings);

  // Counter: brass-trimmed top, carved front with marigold motifs, scalloped cloth skirt.
  const counter = new Graphics();
  const cTop = counterY;
  counter.roundRect(x0 - 12 * u, cTop - 8 * u, w + 24 * u, 22 * u, 6 * u).fill(
    vgrad([
      [0, lighten(MELA.wood, 0.4)],
      [1, MELA.wood],
    ]),
  );
  counter.rect(x0 - 12 * u, cTop + 10 * u, w + 24 * u, 4 * u).fill(MELA.brass);
  counter.rect(x0, cTop + 14 * u, w, groundY - cTop - 14 * u).fill(
    vgrad([
      [0, lighten(MELA.peacockDeep, 0.12)],
      [1, darken(MELA.peacockDeep, 0.3)],
    ]),
  );
  const motifs = 9;
  for (let i = 0; i < motifs; i += 1) {
    const mx = x0 + ((i + 0.5) / motifs) * w;
    const my = cTop + 14 * u + (groundY - cTop) * 0.36;
    for (let p = 0; p < 8; p += 1) {
      const a = (p / 8) * Math.PI * 2;
      counter.ellipse(mx + Math.cos(a) * 13 * u, my + Math.sin(a) * 13 * u, 8 * u, 5 * u).fill({
        color: p % 2 ? MELA.marigold : MELA.saffron,
        alpha: 0.85,
      });
    }
    counter.circle(mx, my, 6 * u).fill(MELA.vermilion);
  }
  const skirtTop = groundY - (groundY - cTop) * 0.24;
  const sk = 16;
  for (let i = 0; i < sk; i += 1) {
    const sx = x0 + (i / sk) * w;
    const swk = w / sk;
    counter
      .moveTo(sx, skirtTop)
      .lineTo(sx + swk, skirtTop)
      .lineTo(sx + swk, groundY - 10 * u)
      .quadraticCurveTo(sx + swk / 2, groundY + 6 * u, sx, groundY - 10 * u)
      .closePath()
      .fill(i % 2 ? MELA.kumkum : darken(MELA.kumkum, 0.18));
  }
  counter.rect(x0, skirtTop - 4 * u, w, 5 * u).fill(MELA.marigold);
  view.addChild(counter);

  // Firefly jars on the counter ends.
  const jarG = new Graphics();
  for (const f of [0.1, 0.9]) {
    const jx = x0 + w * f;
    const r = 30 * u;
    const base = cTop - 6 * u;
    glowDisc(jarG, jx, base - r * 1.2, r * 2.6, 0xfff07a, 0.55);
    jarG
      .roundRect(jx - r * 0.78, base - r * 2.4, r * 1.56, r * 2.4, r * 0.38)
      .fill({ color: 0xcdeee8, alpha: 0.22 });
    jarG.roundRect(jx - r * 0.78, base - r * 2.4, r * 1.56, r * 2.4, r * 0.38).stroke({
      width: 2.4 * u,
      color: 0xf2fff9,
      alpha: 0.6,
    });
    jarG.roundRect(jx - r * 0.62, base - r * 2.75, r * 1.24, r * 0.38, r * 0.12).fill(MELA.kumkum);
    jarG
      .ellipse(jx - r * 0.4, base - r * 1.7, r * 0.12, r * 0.5)
      .fill({ color: 0xffffff, alpha: 0.35 });
    jars.push({ x: jx, y: base - r * 1.2, r });
  }
  jarG.blendMode = 'normal';
  view.addChild(jarG);
  return { view, glowLayer, glows, jars };
}
