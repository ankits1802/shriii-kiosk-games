/**
 * Larger structures of the fair and the road home: temple silhouette (nagara shikhara with kalash and
 * flag), giant wheel, weighing post with brass balance, village houses with windows that glow at dusk,
 * bullock cart, tent drapes, the banyan platform (chabutra), the stall-front counter, rangoli, sky
 * lanterns, lamp posts and the marigold-and-mango-leaf toran.
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../color.ts';
import {
  catenary,
  hgrad,
  mangoLeaf,
  marigold,
  rgrad,
  scallopPath,
  softShadow,
  vgrad,
} from '../draw.ts';
import { MELA } from '../palettes.ts';
import { ArtRandom } from '../rand.ts';
import { drawLantern, drawPaisley, type PropArt } from './props.ts';

type Light = { x: number; y: number; r: number; color: number };

/** Temple silhouette. `s` = shikhara height. Origin = base centre. */
export function drawTemple(s: number): {
  view: Container;
  flag: Graphics;
  flagAnchor: { x: number; y: number };
} {
  const view = new Container();
  const g = new Graphics();
  const stone = MELA.sandstone;
  const shade = darken(stone, 0.25);
  // Plinth steps.
  for (let i = 0; i < 3; i++) {
    const w = s * (1.25 - i * 0.12);
    g.rect(-w / 2, -s * 0.05 * (i + 1), w, s * 0.05).fill(i % 2 === 0 ? shade : stone);
  }
  // Mandapa (hall) with pillars and a small dome.
  const mx = -s * 0.32;
  g.rect(mx - s * 0.22, -s * 0.42, s * 0.44, s * 0.27).fill(stone);
  for (let k = 0; k < 4; k++)
    g.rect(mx - s * 0.19 + k * s * 0.12, -s * 0.38, s * 0.04, s * 0.22).fill(shade);
  g.rect(mx - s * 0.25, -s * 0.46, s * 0.5, s * 0.05).fill(lighten(stone, 0.1));
  g.moveTo(mx - s * 0.2, -s * 0.46)
    .quadraticCurveTo(mx, -s * 0.72, mx + s * 0.2, -s * 0.46)
    .closePath()
    .fill(stone);
  g.circle(mx, -s * 0.66, s * 0.03).fill(MELA.brass);
  // Main shikhara: convex curvilinear tower.
  const bx = s * 0.12;
  const bw = s * 0.27;
  const top = -s * 1.12;
  g.moveTo(bx - bw, -s * 0.15)
    .lineTo(bx - bw, -s * 0.42)
    .bezierCurveTo(bx - bw * 1.02, -s * 0.75, bx - bw * 0.55, -s * 1.0, bx - bw * 0.22, top)
    .lineTo(bx + bw * 0.22, top)
    .bezierCurveTo(bx + bw * 0.55, -s * 1.0, bx + bw * 1.02, -s * 0.75, bx + bw, -s * 0.42)
    .lineTo(bx + bw, -s * 0.15)
    .closePath()
    .fill(
      vgrad([
        [0, lighten(stone, 0.12)],
        [1, shade],
      ]),
    );
  // Right-side shade for volume.
  g.moveTo(bx + bw * 0.2, top)
    .bezierCurveTo(bx + bw * 0.5, -s * 1.0, bx + bw * 0.98, -s * 0.75, bx + bw, -s * 0.42)
    .lineTo(bx + bw, -s * 0.15)
    .lineTo(bx + bw * 0.35, -s * 0.15)
    .closePath()
    .fill({ color: 0x000000, alpha: 0.14 });
  // Horizontal ribs.
  for (let i = 1; i < 9; i++) {
    const y = -s * 0.42 - i * ((s * 0.68) / 9);
    const t = i / 9;
    const half = bw * (1 - t * 0.72);
    g.moveTo(bx - half, y)
      .lineTo(bx + half, y)
      .stroke({ width: Math.max(1, s * 0.008), color: darken(stone, 0.35), alpha: 0.6 });
  }
  // Amalaka + kalash.
  g.ellipse(bx, top - s * 0.02, bw * 0.34, s * 0.03).fill(lighten(stone, 0.05));
  for (let k = -3; k <= 3; k++)
    g.moveTo(bx + k * bw * 0.09, top - s * 0.045)
      .lineTo(bx + k * bw * 0.09, top + s * 0.005)
      .stroke({ width: 1, color: shade, alpha: 0.7 });
  g.circle(bx, top - s * 0.075, s * 0.03).fill(MELA.brass);
  g.moveTo(bx, top - s * 0.1)
    .lineTo(bx, top - s * 0.22)
    .stroke({ width: Math.max(1.5, s * 0.008), color: MELA.woodDark });
  // Door glow niche.
  g.roundRect(bx - s * 0.07, -s * 0.36, s * 0.14, s * 0.21, s * 0.06).fill(darken(stone, 0.55));
  view.addChild(g);
  const flag = new Graphics();
  flag.poly([0, 0, s * 0.16, s * 0.04, 0, s * 0.09]).fill(MELA.saffron);
  const flagAnchor = { x: bx, y: top - s * 0.22 };
  flag.position.set(flagAnchor.x, flagAnchor.y);
  view.addChild(flag);
  return { view, flag, flagAnchor };
}

/** Giant wheel: static frame, rotating wheel and gondolas kept upright. `r` = wheel radius. */
export function drawFerrisWheel(r: number): {
  frame: Container;
  wheel: Container;
  gondolas: Container[];
  hub: { x: number; y: number };
  bulbs: Light[];
} {
  const hub = { x: 0, y: -r * 1.18 };
  const frame = new Container();
  const fg = new Graphics();
  softShadow(fg, 0, 0, r * 0.7, r * 0.06, MELA.ink, 0.3);
  for (const sx of [-1, 1]) {
    fg.moveTo(hub.x, hub.y)
      .lineTo(sx * r * 0.62, 0)
      .stroke({ width: r * 0.035, color: 0x8a3c2c });
    fg.moveTo(hub.x, hub.y)
      .lineTo(sx * r * 0.42, 0)
      .stroke({ width: r * 0.025, color: 0x6e2f22 });
  }
  fg.rect(-r * 0.7, -r * 0.03, r * 1.4, r * 0.03).fill(0x6e2f22);
  frame.addChild(fg);

  const wheel = new Container();
  wheel.position.set(hub.x, hub.y);
  const wg = new Graphics();
  const spokes = 16;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    wg.moveTo(0, 0)
      .lineTo(Math.cos(a) * r, Math.sin(a) * r)
      .stroke({ width: r * 0.012, color: 0xf3e2c0 });
  }
  wg.circle(0, 0, r).stroke({ width: r * 0.03, color: MELA.vermilion });
  wg.circle(0, 0, r * 0.93).stroke({ width: r * 0.012, color: MELA.marigold });
  wg.circle(0, 0, r * 0.35).stroke({ width: r * 0.015, color: MELA.marigold });
  for (let i = 0; i < spokes; i++) {
    const a = ((i + 0.5) / spokes) * Math.PI * 2;
    wg.moveTo(Math.cos(a - Math.PI / spokes) * r, Math.sin(a - Math.PI / spokes) * r)
      .lineTo(Math.cos(a) * r * 0.93, Math.sin(a) * r * 0.93)
      .lineTo(Math.cos(a + Math.PI / spokes) * r, Math.sin(a + Math.PI / spokes) * r)
      .stroke({ width: r * 0.008, color: 0xf3e2c0, alpha: 0.8 });
  }
  wg.circle(0, 0, r * 0.07).fill(MELA.brass);
  wheel.addChild(wg);
  const bulbs: Light[] = [];
  for (let i = 0; i < spokes * 2; i++) {
    const a = (i / (spokes * 2)) * Math.PI * 2;
    bulbs.push({
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      r: r * 0.06,
      color: i % 2 === 0 ? 0xffd27a : 0xff8a6a,
    });
  }
  const colours = [
    MELA.peacock,
    MELA.marigold,
    MELA.rose,
    MELA.lapis,
    MELA.mango,
    MELA.vermilion,
    MELA.saffron,
    MELA.indigo,
  ];
  const gondolas: Container[] = [];
  for (let i = 0; i < 8; i++) {
    const c = new Container();
    const gg = new Graphics();
    const col = colours[i % colours.length] ?? MELA.rose;
    gg.moveTo(0, 0)
      .lineTo(0, r * 0.08)
      .stroke({ width: r * 0.01, color: 0x5a4a3a });
    gg.roundRect(-r * 0.1, r * 0.08, r * 0.2, r * 0.13, r * 0.03).fill(col);
    gg.moveTo(-r * 0.12, r * 0.08)
      .quadraticCurveTo(0, r * 0.02, r * 0.12, r * 0.08)
      .closePath()
      .fill(lighten(col, 0.25));
    gg.rect(-r * 0.1, r * 0.15, r * 0.2, r * 0.02).fill({ color: 0xffffff, alpha: 0.5 });
    c.addChild(gg);
    gondolas.push(c);
  }
  return { frame, wheel, gondolas, hub, bulbs };
}

/** Weighing post: thatched shade, beam balance with brass pans, sacks and brass weights (no numerals). */
export function drawWeighingPost(
  s: number,
  seed: number,
): PropArt & { balance: Container; balancePivot: { x: number; y: number } } {
  const rnd = new ArtRandom(seed);
  const view = new Container();
  const g = new Graphics();
  const lights: Light[] = [];
  softShadow(g, 0, 0, s * 0.95, s * 0.07, MELA.ink, 0.4);
  // Four poles + thatch roof.
  for (const px of [-0.78, -0.42, 0.42, 0.78]) {
    g.rect(px * s - s * 0.018, -s * 0.95, s * 0.036, s * 0.95).fill(
      vgrad([
        [0, lighten(MELA.wood, 0.2)],
        [1, darken(MELA.wood, 0.3)],
      ]),
    );
  }
  g.moveTo(-s * 0.98, -s * 0.9)
    .lineTo(-s * 0.55, -s * 1.22)
    .lineTo(s * 0.55, -s * 1.22)
    .lineTo(s * 0.98, -s * 0.9)
    .quadraticCurveTo(0, -s * 0.84, -s * 0.98, -s * 0.9)
    .fill(
      vgrad([
        [0, 0xd8b56a],
        [1, 0xa8823e],
      ]),
    );
  for (let i = 0; i < 70; i++) {
    const x = rnd.range(-s * 0.95, s * 0.95);
    const t = Math.abs(x) / (s * 0.98);
    const yTop = -s * 1.22 + Math.max(0, t - 0.56) * s * 0.75;
    g.moveTo(x, yTop + rnd.range(0, s * 0.05))
      .lineTo(x + rnd.range(-s * 0.02, s * 0.02), -s * 0.88 - (1 - t) * s * 0.02)
      .stroke({
        width: Math.max(1, s * 0.004),
        color: rnd.chance(0.5) ? 0x8f6a2e : 0xe8c87a,
        alpha: 0.7,
      });
  }
  g.moveTo(-s * 0.98, -s * 0.9)
    .quadraticCurveTo(0, -s * 0.84, s * 0.98, -s * 0.9)
    .stroke({ width: s * 0.012, color: 0x7a5a26 });
  // Sacks.
  const sack = (x: number, w: number, h: number, c: number): void => {
    g.moveTo(x - w / 2, 0)
      .bezierCurveTo(x - w * 0.62, -h * 0.5, x - w * 0.45, -h * 0.9, x - w * 0.18, -h)
      .lineTo(x + w * 0.18, -h)
      .bezierCurveTo(x + w * 0.45, -h * 0.9, x + w * 0.62, -h * 0.5, x + w / 2, 0)
      .closePath()
      .fill(
        rgrad(
          [
            [0, lighten(c, 0.2)],
            [0.7, c],
            [1, darken(c, 0.3)],
          ],
          { x: 0.4, y: 0.4 },
          0.8,
        ),
      );
    g.moveTo(x - w * 0.2, -h * 0.95)
      .lineTo(x + w * 0.2, -h * 0.95)
      .stroke({ width: s * 0.01, color: darken(c, 0.4) });
    for (let k = 1; k < 5; k++)
      g.moveTo(x - w * 0.45, -h * k * 0.2)
        .lineTo(x + w * 0.45, -h * k * 0.2)
        .stroke({ width: 1, color: darken(c, 0.2), alpha: 0.4 });
    g.ellipse(x, -h * 1.02, w * 0.22, h * 0.06).fill(c === 0xd9c08e ? 0xf2d27a : 0xf6f0e0);
  };
  sack(-s * 0.68, s * 0.24, s * 0.3, 0xd9c08e);
  sack(-s * 0.48, s * 0.2, s * 0.24, 0xc9ab78);
  sack(s * 0.62, s * 0.26, s * 0.32, 0xd9c08e);
  // Brass weights (cylinders with knobs; never numerals).
  for (let k = 0; k < 4; k++) {
    const wx = s * 0.3 + k * s * 0.055;
    const wh = s * (0.03 + k * 0.012);
    g.roundRect(wx - wh * 0.6, -wh, wh * 1.2, wh, wh * 0.2).fill(
      vgrad([
        [0, MELA.brassLight],
        [1, darken(MELA.brass, 0.3)],
      ]),
    );
    g.circle(wx, -wh - wh * 0.18, wh * 0.18).fill(MELA.brass);
  }
  // Central post with crossbar.
  g.rect(-s * 0.02, -s * 0.84, s * 0.04, s * 0.84).fill(
    vgrad([
      [0, lighten(MELA.woodDark, 0.25)],
      [1, MELA.woodDark],
    ]),
  );
  g.roundRect(-s * 0.1, -s * 0.03, s * 0.2, s * 0.03, s * 0.01).fill(MELA.woodDark);
  view.addChild(g);
  // Balance (beam + chains + pans), pivoting at the top of the post.
  const balancePivot = { x: 0, y: -s * 0.84 };
  const balance = new Container();
  balance.position.set(balancePivot.x, balancePivot.y);
  const bg = new Graphics();
  bg.roundRect(-s * 0.36, -s * 0.012, s * 0.72, s * 0.024, s * 0.012).fill(
    vgrad([
      [0, MELA.brassLight],
      [1, darken(MELA.brass, 0.2)],
    ]),
  );
  bg.circle(0, 0, s * 0.03).fill(MELA.brass);
  bg.poly([-s * 0.02, -s * 0.03, s * 0.02, -s * 0.03, 0, -s * 0.11]).fill(MELA.brass);
  for (const sx of [-1, 1]) {
    const ex = sx * s * 0.34;
    for (const dx of [-0.08, 0, 0.08])
      bg.moveTo(ex, 0)
        .lineTo(ex + dx * s, s * 0.28)
        .stroke({ width: Math.max(1, s * 0.004), color: 0x8a6a2a });
    bg.moveTo(ex - s * 0.11, s * 0.28)
      .quadraticCurveTo(ex, s * 0.36, ex + s * 0.11, s * 0.28)
      .closePath()
      .fill(
        vgrad([
          [0, MELA.brassLight],
          [1, darken(MELA.brass, 0.35)],
        ]),
      );
    bg.ellipse(ex, s * 0.28, s * 0.11, s * 0.015).fill(lighten(MELA.brass, 0.2));
  }
  balance.addChild(bg);
  view.addChild(balance);
  const lan = drawLantern(s / 300, MELA.marigold);
  lan.view.position.set(-s * 0.42, -s * 0.9);
  view.addChild(lan.view);
  for (const l of lan.lights) lights.push({ ...l, x: l.x + lan.view.x, y: l.y + lan.view.y });
  return { view, lights, balance, balancePivot };
}

/** Village house with windows that glow at dusk. `s` = width. */
export function drawHouse(s: number, seed: number): PropArt {
  const rnd = new ArtRandom(seed);
  const view = new Container();
  const g = new Graphics();
  const wall = rnd.pick([0xe8c99a, 0xdcb48a, 0xf0dcc0, 0xd9a878]);
  const roof = rnd.pick([MELA.terracotta, 0xa0522d, 0xc06a3e]);
  const h = s * 0.55;
  g.rect(-s / 2, -h, s, h).fill(
    vgrad([
      [0, lighten(wall, 0.05)],
      [1, darken(wall, 0.2)],
    ]),
  );
  g.rect(-s / 2, -h * 0.12, s, h * 0.12).fill(darken(wall, 0.3));
  // Tiled roof.
  g.poly([-s * 0.6, -h, s * 0.6, -h, s * 0.42, -h - s * 0.32, -s * 0.42, -h - s * 0.32]).fill(
    vgrad([
      [0, lighten(roof, 0.1)],
      [1, darken(roof, 0.25)],
    ]),
  );
  for (let i = 1; i < 5; i++) {
    const y = -h - (s * 0.32 * i) / 5;
    const half = s * 0.6 - (s * 0.18 * i) / 5;
    g.moveTo(-half, y)
      .lineTo(half, y)
      .stroke({ width: Math.max(1, s * 0.01), color: darken(roof, 0.35), alpha: 0.6 });
  }
  const lights: Light[] = [];
  g.roundRect(-s * 0.09, -h * 0.72, s * 0.18, h * 0.72, s * 0.08).fill(darken(wall, 0.6));
  for (const wx of [-s * 0.3, s * 0.3]) {
    g.rect(wx - s * 0.08, -h * 0.7, s * 0.16, s * 0.14).fill(0x3a2a24);
    g.rect(wx - s * 0.08, -h * 0.7, s * 0.16, s * 0.14).stroke({
      width: Math.max(1, s * 0.015),
      color: MELA.woodDark,
    });
    lights.push({ x: wx, y: -h * 0.7 + s * 0.07, r: s * 0.35, color: 0xffb04a });
  }
  // Rangoli dots at the threshold.
  for (let k = -2; k <= 2; k++) g.circle(k * s * 0.04, -s * 0.01, s * 0.008).fill(0xffffff);
  view.addChild(g);
  // Window panes that light up (separate so the scene can raise their alpha).
  return { view, lights };
}

/** Bullock cart (resting, without animal). `s` = length. */
export function drawCart(s: number): Container {
  const view = new Container();
  const g = new Graphics();
  softShadow(g, 0, 0, s * 0.6, s * 0.06, MELA.ink, 0.35);
  g.moveTo(-s * 0.1, -s * 0.28)
    .lineTo(s * 0.62, -s * 0.02)
    .stroke({ width: s * 0.025, color: MELA.wood });
  g.poly([
    -s * 0.5,
    -s * 0.38,
    s * 0.15,
    -s * 0.38,
    s * 0.12,
    -s * 0.28,
    -s * 0.48,
    -s * 0.28,
  ]).fill(lighten(MELA.wood, 0.1));
  for (let k = 0; k < 7; k++)
    g.rect(-s * 0.48 + k * s * 0.1, -s * 0.52, s * 0.018, s * 0.15).fill(MELA.wood);
  g.rect(-s * 0.5, -s * 0.53, s * 0.66, s * 0.025).fill(lighten(MELA.wood, 0.2));
  // Hay load.
  g.ellipse(-s * 0.18, -s * 0.47, s * 0.3, s * 0.12).fill(0xe2c26e);
  for (let i = 0; i < 20; i++)
    g.moveTo(-s * 0.45 + i * s * 0.03, -s * 0.42)
      .lineTo(-s * 0.42 + i * s * 0.03, -s * 0.56)
      .stroke({ width: 1, color: 0xb8963e, alpha: 0.7 });
  // Wheel.
  const wx = -s * 0.18;
  const wy = -s * 0.2;
  const wr = s * 0.2;
  g.circle(wx, wy, wr).stroke({ width: s * 0.03, color: MELA.woodDark });
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    g.moveTo(wx, wy)
      .lineTo(wx + Math.cos(a) * wr, wy + Math.sin(a) * wr)
      .stroke({ width: s * 0.012, color: MELA.wood });
  }
  g.circle(wx, wy, s * 0.035).fill(MELA.brass);
  view.addChild(g);
  return view;
}

/** Tent drapes for the card tent: top swags and tied side curtains. */
export function drawTentDrape(width: number, height: number, u: number): Container {
  const view = new Container();
  const g = new Graphics();
  const main = MELA.kumkum;
  const alt = MELA.marigold;
  // Canopy band.
  g.rect(0, 0, width, height * 0.1).fill(
    vgrad([
      [0, darken(main, 0.35)],
      [1, main],
    ]),
  );
  const swags = Math.max(4, Math.round(width / (260 * u)));
  const sw = width / swags;
  for (let i = 0; i < swags; i++) {
    const x = i * sw;
    g.moveTo(x, height * 0.1)
      .quadraticCurveTo(x + sw / 2, height * 0.24, x + sw, height * 0.1)
      .lineTo(x + sw, height * 0.08)
      .lineTo(x, height * 0.08)
      .closePath()
      .fill(i % 2 === 0 ? main : MELA.peacockDeep);
    scallopPath(g, x, x + sw, height * 0.1, height * 0.07, 1).stroke({ width: 5 * u, color: alt });
    for (let k = 0; k < 6; k++) {
      const t = (k + 0.5) / 6;
      const yy = height * 0.1 + Math.sin(t * Math.PI) * height * 0.13;
      g.circle(x + sw * t, yy + 8 * u, 4 * u).fill(alt);
    }
    drawPaisley(g, x + sw / 2, height * 0.13, 10 * u, alt);
    g.moveTo(x + sw, height * 0.1)
      .lineTo(x + sw, height * 0.17)
      .stroke({ width: 2 * u, color: alt });
    g.circle(x + sw, height * 0.18, 7 * u).fill(MELA.vermilion);
  }
  // Side curtains tied back.
  for (const side of [0, 1]) {
    const x0 = side === 0 ? 0 : width;
    const dir = side === 0 ? 1 : -1;
    g.moveTo(x0, 0)
      .lineTo(x0 + dir * width * 0.12, 0)
      .bezierCurveTo(
        x0 + dir * width * 0.1,
        height * 0.3,
        x0 + dir * width * 0.03,
        height * 0.45,
        x0 + dir * width * 0.05,
        height * 0.55,
      )
      .bezierCurveTo(
        x0 + dir * width * 0.09,
        height * 0.7,
        x0 + dir * width * 0.08,
        height * 0.9,
        x0 + dir * width * 0.1,
        height,
      )
      .lineTo(x0, height)
      .closePath()
      .fill(
        vgrad([
          [0, darken(main, 0.2)],
          [1, darken(main, 0.5)],
        ]),
      );
    for (let k = 1; k < 5; k++) {
      g.moveTo(x0 + dir * width * 0.025 * k, 0)
        .quadraticCurveTo(
          x0 + dir * width * 0.02 * k,
          height * 0.45,
          x0 + dir * width * 0.022 * k,
          height,
        )
        .stroke({
          width: 3 * u,
          color: 0x000000,
          alpha: 0.12,
        });
    }
    // Tie-back: a cord from a hook on the tent frame, wrapped round the cinched curtain, knotted at
    // the curtain's edge with a hanging tassel (reads as fabric holding fabric, not a floating bar).
    const ty = height * 0.55;
    const edge = x0 + dir * (width * 0.05 + 6 * u);
    const hookX = x0 + dir * 3 * u;
    g.circle(hookX, ty - 14 * u, 5 * u).stroke({ width: 3 * u, color: darken(alt, 0.35) });
    for (const [w, c] of [
      [11 * u, darken(alt, 0.45)],
      [7 * u, alt],
    ] as const) {
      g.moveTo(hookX, ty - 10 * u)
        .quadraticCurveTo((hookX + edge) / 2, ty + 10 * u, edge, ty)
        .stroke({ width: w, color: c, cap: 'round' });
    }
    g.moveTo(hookX + dir * 6 * u, ty - 3 * u)
      .quadraticCurveTo((hookX + edge) / 2, ty + 14 * u, edge - dir * 4 * u, ty + 6 * u)
      .stroke({ width: 2 * u, color: lighten(alt, 0.35), alpha: 0.8, cap: 'round' });
    g.circle(edge, ty, 8 * u).fill(darken(alt, 0.15));
    g.circle(edge - dir * 2 * u, ty - 2 * u, 3 * u).fill(lighten(alt, 0.3));
    g.moveTo(edge, ty + 6 * u)
      .lineTo(edge + dir * 2 * u, ty + 34 * u)
      .stroke({ width: 3 * u, color: darken(alt, 0.3) });
    g.poly([
      edge + dir * 2 * u - 6 * u,
      ty + 34 * u,
      edge + dir * 2 * u + 6 * u,
      ty + 34 * u,
      edge + dir * 2 * u + 9 * u,
      ty + 58 * u,
      edge + dir * 2 * u - 9 * u,
      ty + 58 * u,
    ]).fill(MELA.vermilion);
    g.circle(edge + dir * 2 * u, ty + 34 * u, 4 * u).fill(alt);
  }
  view.addChild(g);
  return view;
}

/** Chabutra: round raised platform around a tree trunk. `r` = radius. */
export function drawChabutra(r: number): Graphics {
  const g = new Graphics();
  softShadow(g, 0, 0, r * 1.15, r * 0.2, MELA.ink, 0.35);
  g.ellipse(0, -r * 0.05, r, r * 0.3).fill(darken(0xcdb48c, 0.25));
  g.rect(-r, -r * 0.27, r * 2, r * 0.22).fill(
    hgrad([
      [0, darken(0xcdb48c, 0.25)],
      [0.4, 0xcdb48c],
      [1, darken(0xcdb48c, 0.35)],
    ]),
  );
  g.ellipse(0, -r * 0.27, r, r * 0.3).fill(lighten(0xcdb48c, 0.1));
  g.ellipse(0, -r * 0.27, r * 0.85, r * 0.24).stroke({
    width: r * 0.02,
    color: darken(0xcdb48c, 0.15),
  });
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI;
    g.moveTo(Math.cos(a) * r, -r * 0.27 + Math.sin(a) * r * 0.3)
      .lineTo(Math.cos(a) * r, -r * 0.05 + Math.sin(a) * r * 0.3)
      .stroke({
        width: 1,
        color: darken(0xcdb48c, 0.35),
        alpha: 0.6,
      });
  }
  return g;
}

/** Stall-front counter for close-up scenes (spans `width`). Origin = top-left of the counter. */
export function drawCounter(width: number, height: number, u: number): Container {
  const view = new Container();
  const g = new Graphics();
  g.rect(0, 0, width, height).fill(
    vgrad([
      [0, lighten(MELA.wood, 0.1)],
      [1, darken(MELA.wood, 0.45)],
    ]),
  );
  g.rect(0, 0, width, 18 * u).fill(lighten(MELA.wood, 0.35));
  g.rect(0, 18 * u, width, 6 * u).fill({ color: 0x000000, alpha: 0.25 });
  // Carved panels.
  const panels = Math.max(3, Math.round(width / (300 * u)));
  const pw = width / panels;
  for (let i = 0; i < panels; i++) {
    const x = i * pw + 24 * u;
    const y = 44 * u;
    const w = pw - 48 * u;
    const h = height - 70 * u;
    g.roundRect(x, y, w, h, 14 * u).fill(darken(MELA.wood, 0.2));
    g.roundRect(x + 8 * u, y + 8 * u, w - 16 * u, h - 16 * u, 10 * u).stroke({
      width: 3 * u,
      color: lighten(MELA.wood, 0.25),
      alpha: 0.6,
    });
    // Lotus carving.
    const cx = x + w / 2;
    const cy = y + h / 2;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      g.ellipse(cx + Math.cos(a) * 18 * u, cy + Math.sin(a) * 18 * u, 12 * u, 6 * u).fill({
        color: lighten(MELA.wood, 0.3),
        alpha: 0.45,
      });
    }
    g.circle(cx, cy, 9 * u).fill(MELA.brass);
  }
  for (const x of [0, width]) {
    g.rect(x - 14 * u, 0, 28 * u, height).fill(darken(MELA.wood, 0.3));
    g.rect(x - 14 * u, 0, 28 * u, 18 * u).fill(MELA.brass);
  }
  // Cloth runner along the top edge.
  g.rect(0, 2 * u, width, 10 * u).fill(MELA.vermilion);
  for (let x = 0; x < width; x += 22 * u)
    g.poly([x, 12 * u, x + 11 * u, 26 * u, x + 22 * u, 12 * u]).fill(MELA.vermilion);
  view.addChild(g);
  return view;
}

/** Rangoli mandala drawn flat (scale.y it for ground perspective). `r` = radius. */
export function drawRangoli(r: number): Graphics {
  const g = new Graphics();
  const cols = [MELA.vermilion, MELA.marigold, MELA.peacock, MELA.rose, MELA.indigo, MELA.cream];
  g.circle(0, 0, r).fill({ color: 0xffffff, alpha: 0.12 });
  // Outer leaf ring.
  const outer = 16;
  for (let i = 0; i < outer; i++) {
    const a = (i / outer) * Math.PI * 2;
    const x = Math.cos(a) * r * 0.86;
    const y = Math.sin(a) * r * 0.86;
    const g2 = cols[i % 2 === 0 ? 2 : 4] ?? MELA.peacock;
    g.ellipse(x, y, r * 0.12, r * 0.055).fill(g2);
    g.circle(
      Math.cos(a + Math.PI / outer) * r * 0.97,
      Math.sin(a + Math.PI / outer) * r * 0.97,
      r * 0.025,
    ).fill(MELA.cream);
  }
  // Petal ring.
  const petals = 12;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const tip = { x: c * r * 0.75, y: s * r * 0.75 };
    const l = { x: Math.cos(a - 0.26) * r * 0.42, y: Math.sin(a - 0.26) * r * 0.42 };
    const rr = { x: Math.cos(a + 0.26) * r * 0.42, y: Math.sin(a + 0.26) * r * 0.42 };
    g.moveTo(l.x, l.y)
      .quadraticCurveTo(Math.cos(a - 0.2) * r * 0.7, Math.sin(a - 0.2) * r * 0.7, tip.x, tip.y)
      .quadraticCurveTo(Math.cos(a + 0.2) * r * 0.7, Math.sin(a + 0.2) * r * 0.7, rr.x, rr.y)
      .closePath()
      .fill(i % 2 === 0 ? MELA.vermilion : MELA.marigold);
    g.moveTo(Math.cos(a) * r * 0.46, Math.sin(a) * r * 0.46)
      .lineTo(Math.cos(a) * r * 0.66, Math.sin(a) * r * 0.66)
      .stroke({
        width: r * 0.015,
        color: MELA.cream,
      });
  }
  g.circle(0, 0, r * 0.42).fill(MELA.peacockDeep);
  // Inner lotus.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.ellipse(Math.cos(a) * r * 0.22, Math.sin(a) * r * 0.22, r * 0.13, r * 0.07).fill(MELA.rose);
  }
  g.circle(0, 0, r * 0.12).fill(MELA.marigold);
  g.circle(0, 0, r * 0.05).fill(MELA.cream);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.circle(Math.cos(a) * r * 0.37, Math.sin(a) * r * 0.37, r * 0.016).fill(MELA.cream);
  }
  return g;
}

/** Floating sky lantern (glowing paper). */
export function drawSkyLantern(s: number): PropArt {
  const view = new Container();
  const g = new Graphics();
  g.moveTo(-s * 0.32, -s)
    .lineTo(s * 0.32, -s)
    .lineTo(s * 0.22, 0)
    .lineTo(-s * 0.22, 0)
    .closePath()
    .fill(
      rgrad(
        [
          [0, 0xfff3c4],
          [0.5, 0xffc26a],
          [1, 0xe8792e],
        ],
        { x: 0.5, y: 0.85 },
        0.9,
      ),
    );
  g.moveTo(-s * 0.32, -s)
    .lineTo(s * 0.32, -s)
    .stroke({ width: s * 0.04, color: 0xf6d8a0 });
  view.addChild(g);
  return { view, lights: [{ x: 0, y: -s * 0.3, r: s * 1.6, color: 0xffa347 }] };
}

/** Bamboo lamp post with a hanging lantern. `s` = height. */
export function drawLampPost(s: number, color: number): PropArt {
  const view = new Container();
  const g = new Graphics();
  softShadow(g, 0, 0, s * 0.08, s * 0.015, MELA.ink, 0.3);
  g.rect(-s * 0.012, -s, s * 0.024, s).fill(0x9a7a4a);
  for (let k = 1; k < 6; k++) g.rect(-s * 0.014, -s * (k / 6), s * 0.028, s * 0.008).fill(0x7a5a2a);
  g.moveTo(0, -s * 0.97)
    .lineTo(s * 0.14, -s * 0.97)
    .stroke({ width: s * 0.012, color: 0x7a5a2a });
  view.addChild(g);
  const lan = drawLantern(s / 260, color);
  lan.view.position.set(s * 0.13, -s * 0.97);
  view.addChild(lan.view);
  return {
    view,
    lights: lan.lights.map((l) => ({ ...l, x: l.x + lan.view.x, y: l.y + lan.view.y })),
  };
}

/** Toran across the top edge: a rope with mango leaves and marigold clusters. */
export function drawToran(width: number, u: number, seed: number): Graphics {
  const rnd = new ArtRandom(seed);
  const g = new Graphics();
  const pts = catenary(-20 * u, 6 * u, width + 20 * u, 6 * u, 28 * u, 80);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a && b)
      g.moveTo(a.x, a.y)
        .lineTo(b.x, b.y)
        .stroke({ width: 4 * u, color: 0x8a5a2a });
  }
  const step = 34 * u;
  for (let x = 0; x < width; x += step) {
    const t = x / width;
    const y = 6 * u + 28 * u * 4 * t * (1 - t);
    const idx = Math.round(x / step);
    if (idx % 3 === 1) {
      for (let k = 0; k < 4; k++)
        marigold(
          g,
          x,
          y + 10 * u + k * 13 * u,
          8.5 * u,
          k % 2 === 0 ? MELA.marigold : MELA.saffron,
        );
      g.circle(x, y + 66 * u, 5 * u).fill(MELA.vermilion);
    } else {
      mangoLeaf(
        g,
        x,
        y,
        (44 + rnd.range(-6, 6)) * u,
        rnd.range(-0.12, 0.12),
        rnd.chance(0.5) ? 0x3f7a2e : 0x4f8f3a,
      );
    }
  }
  return g;
}
