/**
 * Diegetic props for The Stall (original procedural vector art, no text, no numerals):
 * the counter seen from the vendor's side, the banana-leaf serving plate (the go target), the three
 * painted tone medallions (warm / neutral / firm), the probe offers (a bowl of coins and a covered
 * pot), the diya timer of the rush (a ring of marigold petals that falls away), the thought bubble and
 * the customers' speech balloons whose SHAPE pictures their tone.
 *
 * Each builder draws around a local origin in stage pixels for a given unit (short edge / 1080).
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten, mixColor } from '../../../art/color.ts';
import { glowDisc, lgrad, marigold, rgba, rgrad, softShadow, vgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { ArtRandom } from '../../../art/rand.ts';
import type { StallItem, ToneCode } from '../schedule.ts';
import { drawStallItem } from './items.ts';

/* ============================================ counter =========================================== */

/**
 * The stall counter seen from behind (the player's side): a deep plank surface receding to the far edge
 * (the customers stand beyond it), a cloth runner with mirror-work along the far edge and a carved near
 * lip. Origin at the far edge's left end; `w` x `h` stage pixels.
 */
export function drawCounter(w: number, h: number, u: number): Graphics {
  const g = new Graphics();
  const lip = Math.max(26 * u, h * 0.16);
  const surfaceH = h - lip;
  // Plank surface with a warm sun gradient.
  g.rect(0, 0, w, surfaceH).fill(
    vgrad([
      [0, 0x8a5634],
      [0.35, 0xa36a3e],
      [1, 0x7b4a2b],
    ]),
  );
  // Planks: slightly converging seams for depth.
  const planks = 7;
  for (let i = 1; i < planks; i++) {
    const yFar = (surfaceH * i) / planks;
    g.moveTo(0, yFar)
      .lineTo(w, yFar)
      .stroke({ width: Math.max(1, 2 * u), color: 0x4a2b17, alpha: 0.45 });
    g.moveTo(0, yFar + 2 * u)
      .lineTo(w, yFar + 2 * u)
      .stroke({ width: 1, color: 0xd9a26a, alpha: 0.18 });
  }
  // Wood grain.
  const rnd = new ArtRandom('stall-counter-grain');
  for (let i = 0; i < 90; i++) {
    const y = rnd.range(4 * u, surfaceH - 4 * u);
    const x = rnd.range(-40 * u, w);
    const len = rnd.range(80, 260) * u;
    g.moveTo(x, y)
      .bezierCurveTo(
        x + len * 0.3,
        y - 3 * u,
        x + len * 0.6,
        y + 3 * u,
        x + len,
        y + rnd.range(-2, 2) * u,
      )
      .stroke({
        width: Math.max(1, rnd.range(0.8, 1.8) * u),
        color: 0x5a3420,
        alpha: rnd.range(0.12, 0.28),
      });
  }
  // Knots.
  for (let i = 0; i < 6; i++) {
    const x = rnd.range(0, w);
    const y = rnd.range(surfaceH * 0.2, surfaceH * 0.9);
    g.ellipse(x, y, 9 * u, 4 * u).stroke({ width: 1.5 * u, color: 0x4a2b17, alpha: 0.35 });
  }
  // Far-edge shadow (the edge drops away towards the customers).
  g.rect(0, 0, w, 10 * u).fill({ color: 0x2b170c, alpha: 0.35 });
  // Cloth runner along the far edge: kumkum red with saffron border and mirror-work.
  const runH = 34 * u;
  g.rect(0, 6 * u, w, runH).fill(
    vgrad([
      [0, lighten(MELA.kumkum, 0.12)],
      [1, darken(MELA.kumkum, 0.18)],
    ]),
  );
  g.rect(0, 6 * u, w, 5 * u).fill(MELA.marigold);
  g.rect(0, 6 * u + runH - 5 * u, w, 5 * u).fill(MELA.marigold);
  const step = 46 * u;
  for (let x = step / 2; x < w; x += step) {
    const cy = 6 * u + runH / 2;
    g.circle(x, cy, 7 * u).fill(MELA.brassLight);
    g.circle(x, cy, 4.5 * u).fill(0xdfeef5);
    g.circle(x - 1.5 * u, cy - 1.5 * u, 1.6 * u).fill({ color: 0xffffff, alpha: 0.9 });
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      g.circle(x + Math.cos(a) * 11 * u, cy + Math.sin(a) * 11 * u, 2 * u).fill(MELA.saffron);
    }
  }
  // Tassels hanging towards the player.
  for (let x = step; x < w; x += step) {
    const y0 = 6 * u + runH;
    g.moveTo(x, y0)
      .lineTo(x, y0 + 14 * u)
      .stroke({ width: 2 * u, color: MELA.marigold });
    g.circle(x, y0 + 16 * u, 4 * u).fill(MELA.vermilion);
  }
  // Near lip: thick carved edge with brass inlay.
  g.rect(0, surfaceH, w, lip).fill(
    vgrad([
      [0, 0x5c3520],
      [0.25, 0x6d4026],
      [1, 0x3a2012],
    ]),
  );
  g.rect(0, surfaceH, w, 4 * u).fill({ color: 0xe0a86c, alpha: 0.6 });
  g.rect(0, surfaceH + lip * 0.42, w, 4 * u).fill(MELA.brass);
  const motif = 70 * u;
  for (let x = motif / 2; x < w; x += motif) {
    const cy = surfaceH + lip * 0.72;
    g.ellipse(x, cy, 16 * u, 7 * u).fill({ color: 0x2b170c, alpha: 0.5 });
    marigold(g, x, cy, 6 * u, MELA.marigoldDeep);
  }
  return g;
}

/** A small heap of one item kind on a brass thali or in a basket (counter decoration). */
export function drawGoodsDisplay(
  item: StallItem,
  count: number,
  itemPx: number,
  u: number,
  seed: string,
): Container {
  const c = new Container();
  const rnd = new ArtRandom(seed);
  const base = new Graphics();
  const w = itemPx * Math.max(2.2, Math.sqrt(count) * 1.25);
  softShadow(base, 0, 0, w * 0.62, w * 0.12, 0x000000, 0.35);
  const basket = item === 'mango' || item === 'banana' || item === 'guava';
  if (basket) {
    // Woven bamboo basket.
    base.ellipse(0, -itemPx * 0.15, w * 0.56, w * 0.16).fill(darken(0xc9954f, 0.35));
    base
      .moveTo(-w * 0.56, -itemPx * 0.15)
      .quadraticCurveTo(-w * 0.5, itemPx * 0.25, -w * 0.38, itemPx * 0.28)
      .lineTo(w * 0.38, itemPx * 0.28)
      .quadraticCurveTo(w * 0.5, itemPx * 0.25, w * 0.56, -itemPx * 0.15)
      .closePath()
      .fill(
        lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
          [0, 0xd9a35c],
          [1, 0x8a5a2a],
        ]),
      );
    for (let k = 0; k < 4; k++) {
      const y = -itemPx * 0.08 + k * itemPx * 0.09;
      base
        .moveTo(-w * 0.52, y)
        .lineTo(w * 0.52, y)
        .stroke({ width: 1.2 * u, color: 0x6b4520, alpha: 0.5 });
    }
  } else {
    // Brass thali.
    base.ellipse(0, 0, w * 0.6, w * 0.16).fill(
      rgrad([
        [0, MELA.brassLight],
        [0.7, MELA.brass],
        [1, darken(MELA.brass, 0.3)],
      ]),
    );
    base
      .ellipse(0, -2 * u, w * 0.48, w * 0.12)
      .stroke({ width: 1.5 * u, color: darken(MELA.brass, 0.25), alpha: 0.6 });
  }
  c.addChild(base);
  // Heap: rows narrowing upwards.
  let placed = 0;
  for (let row = 0; placed < count; row++) {
    const perRow = Math.max(1, Math.ceil(Math.sqrt(count * 2)) - row);
    for (let i = 0; i < perRow && placed < count; i++, placed++) {
      const g = drawStallItem(item, false);
      const s = (itemPx / 100) * rnd.range(0.82, 0.95);
      g.scale.set(s * (rnd.chance(0.5) ? 1 : -1), s);
      g.rotation = rnd.range(-0.25, 0.25);
      g.position.set((i - (perRow - 1) / 2) * itemPx * 0.66, -itemPx * (0.3 + row * 0.36));
      c.addChild(g);
    }
  }
  return c;
}

/* ========================================== serving plate ======================================= */

/** Banana-leaf serving plate on a low brass stand (the go target). Centred on its target point. */
export function drawServingPlate(r: number): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, 0, r * 0.35, r * 1.05, r * 0.32, 0x000000, 0.45);
  // Brass stand.
  g.ellipse(0, r * 0.22, r * 0.98, r * 0.42).fill(
    rgrad([
      [0, MELA.brassLight],
      [0.6, MELA.brass],
      [1, darken(MELA.brass, 0.35)],
    ]),
  );
  g.ellipse(0, r * 0.14, r * 0.92, r * 0.38).stroke({
    width: Math.max(1.5, r * 0.02),
    color: darken(MELA.brass, 0.3),
  });
  // Banana leaf (pointed oval) with midrib and veins.
  const leafC = 0x3f8f3a;
  g.moveTo(-r * 1.02, r * 0.05)
    .bezierCurveTo(-r * 0.6, -r * 0.48, r * 0.6, -r * 0.48, r * 1.08, -r * 0.02)
    .bezierCurveTo(r * 0.6, r * 0.4, -r * 0.6, r * 0.42, -r * 1.02, r * 0.05)
    .closePath()
    .fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, lighten(leafC, 0.25)],
        [0.55, leafC],
        [1, darken(leafC, 0.25)],
      ]),
    );
  g.moveTo(-r * 0.98, r * 0.04)
    .quadraticCurveTo(0, -r * 0.02, r * 1.04, -r * 0.02)
    .stroke({
      width: Math.max(1.5, r * 0.025),
      color: lighten(leafC, 0.45),
      alpha: 0.8,
    });
  for (let i = -6; i <= 6; i++) {
    if (i === 0) continue;
    const x = i * r * 0.14;
    g.moveTo(x, 0)
      .quadraticCurveTo(x + r * 0.05, -r * 0.16 * Math.sign(i) * 0 - r * 0.2, x + r * 0.1, -r * 0.3)
      .stroke({ width: 1, color: lighten(leafC, 0.35), alpha: 0.4 });
    g.moveTo(x, 0.01)
      .quadraticCurveTo(x + r * 0.05, r * 0.18, x + r * 0.1, r * 0.28)
      .stroke({ width: 1, color: lighten(leafC, 0.35), alpha: 0.4 });
  }
  g.ellipse(-r * 0.4, -r * 0.18, r * 0.25, r * 0.06).fill({ color: 0xffffff, alpha: 0.16 });
  c.addChild(g);
  return c;
}

/** Soft marigold glow ring under the plate while it can be tapped (same on every trial). */
export function drawReadyRing(r: number): Graphics {
  const g = new Graphics();
  g.ellipse(0, r * 0.1, r * 1.22, r * 0.6).fill(
    rgrad([
      [0, rgba(MELA.marigold, 0)],
      [0.72, rgba(MELA.marigold, 0.0)],
      [0.86, rgba(MELA.marigold, 0.45)],
      [1, rgba(MELA.marigold, 0)],
    ]),
  );
  return g;
}

/* ========================================== tone medallions ===================================== */

const TONE_STYLE: Readonly<
  Record<ToneCode, { rim: number; face: number; rimShape: 'petals' | 'circle' | 'octagon' }>
> = {
  warm: { rim: MELA.marigoldDeep, face: 0xf7d9a8, rimShape: 'petals' },
  neutral: { rim: MELA.brass, face: 0xf3dcb4, rimShape: 'circle' },
  firm: { rim: MELA.peacockDeep, face: 0xead2aa, rimShape: 'octagon' },
};

/**
 * A painted tone medallion: a face whose expression is the reply (warm: beaming, crinkled eyes and
 * folded hands; neutral: level gaze, straight mouth; firm: lowered brows, tight mouth and a raised open
 * palm). The rim SHAPE differs too (petals / circle / octagon) so colour is never the only cue.
 */
export function drawToneMedallion(code: ToneCode, r: number): Container {
  const c = new Container();
  const st = TONE_STYLE[code];
  const g = new Graphics();
  softShadow(g, 0, r * 0.92, r * 1.1, r * 0.24, 0x000000, 0.45);
  // Dark carved plinth so the medallion reads clearly over the busy counter.
  g.circle(0, 0, r * 1.24).fill(
    rgrad([
      [0, 0x5a3420],
      [0.8, 0x3a2012],
      [1, 0x24130a],
    ]),
  );
  g.circle(0, 0, r * 1.24).stroke({ width: Math.max(2, r * 0.05), color: MELA.brass });
  // Rim.
  if (st.rimShape === 'petals') {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      g.circle(Math.cos(a) * r * 0.88, Math.sin(a) * r * 0.88, r * 0.2).fill(st.rim);
    }
    g.circle(0, 0, r * 0.9).fill(st.rim);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.22;
      g.circle(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9, r * 0.08).fill(MELA.marigold);
    }
  } else if (st.rimShape === 'octagon') {
    const pts: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      pts.push(Math.cos(a) * r * 1.02, Math.sin(a) * r * 1.02);
    }
    g.poly(pts).fill(st.rim);
    g.poly(pts.map((v) => v * 0.9)).stroke({
      width: Math.max(2, r * 0.05),
      color: lighten(st.rim, 0.35),
    });
  } else {
    g.circle(0, 0, r).fill(
      rgrad([
        [0, MELA.brassLight],
        [0.75, st.rim],
        [1, darken(st.rim, 0.3)],
      ]),
    );
    g.circle(0, 0, r * 0.9).stroke({ width: Math.max(2, r * 0.04), color: darken(st.rim, 0.3) });
  }
  // Face disc.
  const fr = r * 0.74;
  g.circle(0, 0, fr).fill(
    rgrad(
      [
        [0, lighten(st.face, 0.2)],
        [0.7, st.face],
        [1, darken(st.face, 0.12)],
      ],
      { x: 0.4, y: 0.35 },
      0.7,
    ),
  );
  const ink = 0x3a2416;
  const lw = Math.max(2.5, fr * 0.075);
  const ey = -fr * 0.12;
  const ex = fr * 0.34;
  if (code === 'warm') {
    // Crinkled happy eyes (arcs), lifted brows, wide open smile with teeth, rosy cheeks.
    for (const s of [-1, 1]) {
      g.moveTo(s * ex - fr * 0.15, ey + fr * 0.02)
        .quadraticCurveTo(s * ex, ey - fr * 0.16, s * ex + fr * 0.15, ey + fr * 0.02)
        .stroke({ width: lw, color: ink, cap: 'round' });
      g.moveTo(s * ex - fr * 0.16, ey - fr * 0.3)
        .quadraticCurveTo(s * ex, ey - fr * 0.4, s * ex + fr * 0.16, ey - fr * 0.32)
        .stroke({ width: lw * 0.8, color: ink, cap: 'round' });
      g.circle(s * fr * 0.52, fr * 0.16, fr * 0.13).fill({ color: 0xe86a6a, alpha: 0.45 });
    }
    g.moveTo(-fr * 0.38, fr * 0.16)
      .quadraticCurveTo(0, fr * 0.68, fr * 0.38, fr * 0.16)
      .closePath()
      .fill(0x8a2a22);
    g.moveTo(-fr * 0.3, fr * 0.19)
      .lineTo(fr * 0.3, fr * 0.19)
      .lineTo(fr * 0.24, fr * 0.27)
      .lineTo(-fr * 0.24, fr * 0.27)
      .closePath()
      .fill(0xffffff);
  } else if (code === 'neutral') {
    for (const s of [-1, 1]) {
      g.circle(s * ex, ey, fr * 0.075).fill(ink);
      g.moveTo(s * ex - fr * 0.15, ey - fr * 0.25)
        .lineTo(s * ex + fr * 0.15, ey - fr * 0.25)
        .stroke({ width: lw * 0.8, color: ink, cap: 'round' });
    }
    g.moveTo(-fr * 0.28, fr * 0.32)
      .lineTo(fr * 0.28, fr * 0.32)
      .stroke({ width: lw, color: ink, cap: 'round' });
  } else {
    // Firm: brows angled down to the centre, narrowed eyes, tight downturned mouth.
    for (const s of [-1, 1]) {
      g.moveTo(s * ex - fr * 0.12, ey)
        .lineTo(s * ex + fr * 0.12, ey)
        .stroke({ width: lw * 1.1, color: ink, cap: 'round' });
      g.moveTo(s * (ex + fr * 0.18), ey - fr * 0.32)
        .lineTo(s * (ex - fr * 0.18), ey - fr * 0.2)
        .stroke({ width: lw, color: ink, cap: 'round' });
    }
    g.moveTo(-fr * 0.3, fr * 0.36)
      .quadraticCurveTo(0, fr * 0.26, fr * 0.3, fr * 0.36)
      .stroke({ width: lw, color: ink, cap: 'round' });
  }
  c.addChild(g);
  // Hands below the face (a second, shape-based cue).
  const hands = new Graphics();
  const hc = 0xc98a5a;
  if (code === 'warm') {
    // Folded hands (namaste).
    hands
      .moveTo(0, r * 0.62)
      .bezierCurveTo(-r * 0.2, r * 0.66, -r * 0.16, r * 0.98, 0, r * 1.06)
      .bezierCurveTo(r * 0.16, r * 0.98, r * 0.2, r * 0.66, 0, r * 0.62)
      .closePath()
      .fill(hc)
      .stroke({ width: Math.max(1.5, r * 0.03), color: darken(hc, 0.35) });
    hands
      .moveTo(0, r * 0.66)
      .lineTo(0, r * 1.02)
      .stroke({ width: 1.2, color: darken(hc, 0.4) });
  } else if (code === 'firm') {
    // Raised open palm beside the face.
    const px = r * 0.86;
    const py = r * 0.2;
    hands.roundRect(px - r * 0.17, py - r * 0.1, r * 0.34, r * 0.38, r * 0.1).fill(hc);
    for (let i = 0; i < 4; i++) {
      hands
        .roundRect(px - r * 0.17 + i * r * 0.088, py - r * 0.36, r * 0.07, r * 0.3, r * 0.035)
        .fill(hc);
    }
    hands.roundRect(px - r * 0.26, py, r * 0.1, r * 0.2, r * 0.05).fill(hc);
    hands
      .roundRect(px - r * 0.26, py - r * 0.36, r * 0.52, r * 0.66, r * 0.12)
      .stroke({ width: Math.max(1.5, r * 0.03), color: darken(hc, 0.35), alpha: 0.0 });
  }
  c.addChild(hands);
  return c;
}

/* ========================================== probe offers ======================================== */

/** The sure offer: a brass bowl with `coins` coins clearly countable (pictured quantity). */
export function drawSureOffer(size: number, coins: number): Container {
  const c = new Container();
  const r = size / 2;
  const g = new Graphics();
  // Woven mat (the touch area).
  g.circle(0, 0, r).fill(
    rgrad([
      [0, 0xe8c48a],
      [0.8, 0xc9954f],
      [1, 0x8a5a2a],
    ]),
  );
  for (let k = 1; k <= 4; k++)
    g.circle(0, 0, (r * k) / 4.4).stroke({ width: 1.2, color: 0x7a4a22, alpha: 0.35 });
  softShadow(g, 0, r * 0.3, r * 0.62, r * 0.14, 0x000000, 0.35);
  // Bowl.
  g.moveTo(-r * 0.58, -r * 0.02)
    .quadraticCurveTo(-r * 0.5, r * 0.36, 0, r * 0.38)
    .quadraticCurveTo(r * 0.5, r * 0.36, r * 0.58, -r * 0.02)
    .closePath()
    .fill(
      lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
        [0, darken(MELA.brass, 0.2)],
        [0.35, MELA.brassLight],
        [1, darken(MELA.brass, 0.3)],
      ]),
    );
  g.ellipse(0, -r * 0.02, r * 0.58, r * 0.13).fill(darken(MELA.brass, 0.45));
  c.addChild(g);
  // Coins fanned on the rim so each one is visible.
  const coinG = new Graphics();
  const n = Math.max(1, coins);
  const cr = r * 0.17;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * cr * 1.55;
    const y = -r * 0.1 - Math.abs(i - (n - 1) / 2) * -cr * 0.15;
    coinG.circle(x, y, cr).fill(
      rgrad([
        [0, 0xfff0b0],
        [0.6, 0xf2c94c],
        [1, 0xb8862a],
      ]),
    );
    coinG
      .circle(x, y, cr * 0.72)
      .stroke({ width: Math.max(1, cr * 0.1), color: 0xb8862a, alpha: 0.8 });
    coinG
      .rect(x - cr * 0.18, y - cr * 0.18, cr * 0.36, cr * 0.36)
      .fill({ color: 0x8a5a1a, alpha: 0.65 });
  }
  c.addChild(coinG);
  return c;
}

/** The risky offer: a clay pot tied with a red cloth; its contents are hidden (sparkles hint at luck). */
export function drawRiskyOffer(size: number): Container {
  const c = new Container();
  const r = size / 2;
  const g = new Graphics();
  g.circle(0, 0, r).fill(
    rgrad([
      [0, 0xd9b6e6],
      [0.8, 0x7a5a9a],
      [1, 0x4a3266],
    ]),
  );
  for (let k = 1; k <= 4; k++)
    g.circle(0, 0, (r * k) / 4.4).stroke({ width: 1.2, color: 0x2e1f44, alpha: 0.35 });
  softShadow(g, 0, r * 0.42, r * 0.5, r * 0.12, 0x000000, 0.35);
  // Clay pot.
  g.ellipse(0, r * 0.08, r * 0.46, r * 0.36).fill(
    rgrad(
      [
        [0, lighten(MELA.terracotta, 0.3)],
        [0.6, MELA.terracotta],
        [1, darken(MELA.terracotta, 0.4)],
      ],
      { x: 0.35, y: 0.3 },
      0.8,
    ),
  );
  g.rect(-r * 0.46, r * 0.02, r * 0.92, r * 0.05).fill({ color: MELA.cream, alpha: 0.55 });
  // Neck and red cloth tied over the mouth.
  g.roundRect(-r * 0.2, -r * 0.36, r * 0.4, r * 0.14, r * 0.05).fill(darken(MELA.terracotta, 0.2));
  g.moveTo(-r * 0.32, -r * 0.3)
    .quadraticCurveTo(0, -r * 0.56, r * 0.32, -r * 0.3)
    .quadraticCurveTo(0, -r * 0.22, -r * 0.32, -r * 0.3)
    .closePath()
    .fill(MELA.vermilion);
  g.moveTo(r * 0.05, -r * 0.3)
    .quadraticCurveTo(r * 0.3, -r * 0.18, r * 0.24, -r * 0.04)
    .stroke({ width: Math.max(2, r * 0.05), color: MELA.vermilion, cap: 'round' });
  g.moveTo(-r * 0.22, -r * 0.27)
    .lineTo(r * 0.22, -r * 0.27)
    .stroke({ width: Math.max(1.5, r * 0.035), color: MELA.marigold });
  c.addChild(g);
  // Four-point sparkles around the pot (luck, not a number).
  const sp = new Graphics();
  for (const [x, y, s] of [
    [-r * 0.6, -r * 0.42, 1],
    [r * 0.62, -r * 0.24, 0.8],
    [r * 0.48, r * 0.5, 0.6],
  ] as const) {
    const k = r * 0.12 * s;
    sp.moveTo(x, y - k * 2)
      .quadraticCurveTo(x, y, x + k * 2, y)
      .quadraticCurveTo(x, y, x, y + k * 2)
      .quadraticCurveTo(x, y, x - k * 2, y)
      .quadraticCurveTo(x, y, x, y - k * 2)
      .fill(0xfff1b8);
  }
  c.addChild(sp);
  return c;
}

/* ========================================== diya timer ========================================== */

/**
 * The rush timer: a clay diya whose ring of marigold petals falls away over the response window while
 * the flame shrinks. A pictured countdown, never a number.
 */
export class DiyaTimer {
  readonly view = new Container();
  readonly petals: Graphics[] = [];
  readonly flame = new Container();
  private readonly glow = new Graphics();
  constructor(readonly r: number) {
    this.view.eventMode = 'none';
    const g = new Graphics();
    softShadow(g, 0, r * 0.35, r * 0.9, r * 0.2, 0x000000, 0.4);
    glowDisc(this.glow, 0, -r * 0.55, r * 1.6, 0xffb347, 0.5);
    this.glow.blendMode = 'add';
    // Petal ring (12 petals).
    const ring = new Container();
    for (let i = 0; i < 12; i++) {
      const p = new Graphics();
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      p.ellipse(0, -r * 0.2, r * 0.13, r * 0.24).fill(i % 2 === 0 ? MELA.marigold : MELA.saffron);
      p.position.set(Math.cos(a) * r * 1.02, Math.sin(a) * r * 0.62 - r * 0.1);
      p.rotation = a + Math.PI / 2;
      ring.addChild(p);
      this.petals.push(p);
    }
    // Clay diya bowl.
    g.moveTo(-r * 0.62, -r * 0.12)
      .quadraticCurveTo(-r * 0.4, r * 0.32, 0, r * 0.34)
      .quadraticCurveTo(r * 0.4, r * 0.32, r * 0.7, -r * 0.14)
      .quadraticCurveTo(r * 0.9, -r * 0.3, r * 0.74, -r * 0.2)
      .quadraticCurveTo(0, -r * 0.02, -r * 0.62, -r * 0.12)
      .closePath()
      .fill(
        lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
          [0, lighten(MELA.terracotta, 0.2)],
          [1, darken(MELA.terracotta, 0.35)],
        ]),
      );
    g.ellipse(-r * 0.02, -r * 0.1, r * 0.58, r * 0.1).fill(0x6a3a10);
    for (let i = 0; i < 5; i++)
      g.circle(-r * 0.4 + i * r * 0.2, r * 0.12, r * 0.04).fill(MELA.cream);
    // Flame (teardrop) with a hot core.
    const f = new Graphics();
    f.moveTo(0, 0)
      .bezierCurveTo(-r * 0.24, -r * 0.2, -r * 0.12, -r * 0.62, 0, -r * 0.86)
      .bezierCurveTo(r * 0.12, -r * 0.62, r * 0.24, -r * 0.2, 0, 0)
      .fill(0xffb347);
    f.moveTo(0, -r * 0.04)
      .bezierCurveTo(-r * 0.12, -r * 0.16, -r * 0.06, -r * 0.42, 0, -r * 0.56)
      .bezierCurveTo(r * 0.06, -r * 0.42, r * 0.12, -r * 0.16, 0, -r * 0.04)
      .fill(0xfff2c0);
    this.flame.addChild(f);
    this.flame.position.set(r * 0.62, -r * 0.2);
    this.view.addChild(this.glow, ring, g, this.flame);
  }

  /** Flame flicker (called by the scene ticker). */
  flicker(t: number): void {
    const k = 1 + Math.sin(t * 11) * 0.05 + Math.sin(t * 17.3) * 0.04;
    this.flame.scale.x = this.flame.scale.y * 0.9 + 0.1 * k;
    this.glow.alpha = 0.75 + Math.sin(t * 9) * 0.1;
  }
}

/* ======================================== bubbles and balloons ================================== */

/** Thought bubble (cloud of circles) with trailing dots pointing towards (`tailX`, `tailY`) (local). */
export function drawThoughtBubble(r: number, tailX: number, tailY: number): Graphics {
  const g = new Graphics();
  const lobes: [number, number, number][] = [
    [0, -r * 0.3, r * 0.62],
    [-r * 0.52, -r * 0.05, r * 0.5],
    [r * 0.52, -r * 0.08, r * 0.52],
    [-r * 0.28, r * 0.36, r * 0.5],
    [r * 0.3, r * 0.36, r * 0.5],
    [0, 0.02, r * 0.66],
  ];
  // Soft shadow and outline (drawn as a slightly larger dark cloud underneath).
  for (const [x, y, rr] of lobes)
    g.circle(x + r * 0.05, y + r * 0.08, rr).fill({ color: 0x000000, alpha: 0.12 });
  for (const [x, y, rr] of lobes) g.circle(x, y, rr + Math.max(2, r * 0.035)).fill(0x5a3a26);
  for (const [x, y, rr] of lobes) g.circle(x, y, rr).fill(MELA.cream);
  g.ellipse(-r * 0.25, -r * 0.55, r * 0.3, r * 0.1).fill({ color: 0xffffff, alpha: 0.7 });
  // Trailing thought dots.
  const len = Math.hypot(tailX, tailY);
  const ux = len > 0 ? tailX / len : 0;
  const uy = len > 0 ? tailY / len : 1;
  for (const [t, rr] of [
    [0.78, r * 0.16],
    [0.92, r * 0.1],
  ] as const) {
    const x = ux * len * t;
    const y = uy * len * t;
    g.circle(x, y, rr + Math.max(2, r * 0.03)).fill(0x5a3a26);
    g.circle(x, y, rr).fill(MELA.cream);
  }
  return g;
}

/**
 * Speech balloon whose SHAPE pictures the customer's tone (a stimulus property, mirrored from the
 * recorded voice): 0 smooth round with a flower, 1 round with a music note, 2 wobbly with a squiggle,
 * 3 spiky with a lightning bolt, 4 large spiky with lightning and steam puffs.
 */
export function drawSpeechBalloon(
  level: 0 | 1 | 2 | 3 | 4,
  r: number,
  tailLeft: boolean,
): Container {
  const c = new Container();
  const g = new Graphics();
  const ink = 0x4a2a1a;
  const fill = level >= 3 ? 0xfff0e0 : MELA.cream;
  const pts: number[] = [];
  const spikes = level >= 3 ? (level === 4 ? 16 : 13) : 28;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2;
    let rr = r;
    if (level >= 3) rr = i % 2 === 0 ? r * (level === 4 ? 1.22 : 1.14) : r * 0.82;
    else if (level === 2) rr = r * (1 + 0.07 * Math.sin(a * 5));
    pts.push(Math.cos(a) * rr * 1.25, Math.sin(a) * rr * 0.85);
  }
  const tx = tailLeft ? -r * 0.7 : r * 0.7;
  g.poly([
    tx - r * 0.2,
    r * 0.5,
    tx + (tailLeft ? -r * 0.55 : r * 0.55),
    r * 1.15,
    tx + r * 0.25,
    r * 0.55,
  ])
    .fill(fill)
    .stroke({ width: Math.max(2, r * 0.06), color: ink });
  g.poly(pts)
    .fill(fill)
    .stroke({ width: Math.max(2, r * 0.06), color: ink, join: 'round' });
  c.addChild(g);
  const sym = new Graphics();
  if (level === 0) {
    marigold(sym, 0, 0, r * 0.38, MELA.marigold);
  } else if (level === 1) {
    sym.circle(-r * 0.14, r * 0.24, r * 0.16).fill(ink);
    sym.rect(-r * 0.0, -r * 0.42, r * 0.06, r * 0.66).fill(ink);
    sym
      .moveTo(r * 0.06, -r * 0.42)
      .quadraticCurveTo(r * 0.4, -r * 0.3, r * 0.3, -r * 0.05)
      .stroke({ width: r * 0.08, color: ink, cap: 'round' });
  } else if (level === 2) {
    sym.moveTo(-r * 0.6, 0);
    for (let i = 0; i <= 12; i++)
      sym.lineTo(-r * 0.6 + (i * r * 1.2) / 12, (i % 2 === 0 ? -1 : 1) * r * 0.16);
    sym.stroke({ width: r * 0.1, color: 0x8a5a2a, cap: 'round', join: 'round' });
  } else {
    // Storm cloud with a lightning bolt.
    for (const [x, y, rr] of [
      [-r * 0.25, -r * 0.12, r * 0.28],
      [r * 0.1, -r * 0.22, r * 0.32],
      [r * 0.38, -r * 0.06, r * 0.24],
    ] as const)
      sym.circle(x, y, rr).fill(0x5d5a6e);
    sym
      .poly([
        r * 0.05,
        r * 0.02,
        -r * 0.14,
        r * 0.38,
        r * 0.02,
        r * 0.36,
        -r * 0.08,
        r * 0.7,
        r * 0.26,
        r * 0.24,
        r * 0.08,
        r * 0.26,
        r * 0.18,
        r * 0.02,
      ])
      .fill(0xffd23f)
      .stroke({ width: Math.max(1, r * 0.03), color: 0x8a5a00 });
    if (level === 4) {
      for (const s of [-1, 1]) {
        sym.circle(s * r * 0.82, -r * 0.62, r * 0.12).fill({ color: 0xffffff, alpha: 0.9 });
        sym.circle(s * r * 0.98, -r * 0.8, r * 0.08).fill({ color: 0xffffff, alpha: 0.8 });
      }
    }
  }
  c.addChild(sym);
  return c;
}

/** Warm marigold coin (payment / probe pick feedback). */
export function drawCoin(r: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, r).fill(
    rgrad([
      [0, 0xfff0b0],
      [0.6, 0xf2c94c],
      [1, 0xb8862a],
    ]),
  );
  g.circle(0, 0, r * 0.7).stroke({ width: Math.max(1, r * 0.12), color: 0xb8862a, alpha: 0.8 });
  g.rect(-r * 0.2, -r * 0.2, r * 0.4, r * 0.4).fill({ color: 0x8a5a1a, alpha: 0.65 });
  return g;
}

/** Wooden awning post with a marigold garland (frames the stall edges). */
export function drawPost(h: number, u: number): Graphics {
  const g = new Graphics();
  const w = 26 * u;
  g.rect(-w / 2, 0, w, h).fill(
    lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
      [0, 0x4a2a16],
      [0.4, 0x8a5634],
      [1, 0x3a2012],
    ]),
  );
  for (let y = h * 0.1; y < h; y += 90 * u) g.rect(-w / 2, y, w, 6 * u).fill(MELA.brass);
  // Garland spiralling down the post.
  for (let i = 0; i < 26; i++) {
    const t = i / 26;
    const y = h * 0.08 + t * h * 0.5;
    const x = Math.sin(t * Math.PI * 6) * w * 0.5;
    marigold(g, x, y, 9 * u, i % 3 === 0 ? MELA.vermilion : MELA.marigold);
  }
  return g;
}

/** Mix the shared scene light into a prop tint (keeps stimuli legible: never darker than 55 % light). */
export function propTint(lightTint: number): number {
  return mixColor(lightTint, 0xffffff, 0.55);
}
