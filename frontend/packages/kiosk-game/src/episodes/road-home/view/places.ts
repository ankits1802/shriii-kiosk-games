/**
 * Storybook map art: small oblique-view places that stand at the map's waypoints (market, home,
 * potter, vaidya, well, mill, temple, banyan, hamlet, haystacks, mango grove, pond, tea stall, ghat,
 * landing), the errand pictures (clay pot, medicine pouch, water pot, grain sack) and the top-down
 * bullock-cart token. All original procedural vector art; nothing is written, nothing is a numeral.
 */
import { Container, Graphics } from 'pixi.js';
import { drawPot } from '../../../art/backdrop/props.ts';
import { darken, lighten } from '../../../art/color.ts';
import { marigold, softShadow, vgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { ArtRandom } from '../../../art/rand.ts';
import type { PlaceKind } from '../maps.ts';

function hut(g: Graphics, x: number, y: number, s: number, wall: number, roof: number): void {
  softShadow(g, x + s * 0.08, y + s * 0.02, s * 0.62, s * 0.14, MELA.ink, 0.3);
  g.rect(x - s * 0.42, y - s * 0.5, s * 0.84, s * 0.5).fill(
    vgrad([
      [0, lighten(wall, 0.06)],
      [1, darken(wall, 0.18)],
    ]),
  );
  g.roundRect(x - s * 0.1, y - s * 0.34, s * 0.2, s * 0.34, s * 0.06).fill(darken(wall, 0.6));
  g.moveTo(x - s * 0.56, y - s * 0.48)
    .lineTo(x, y - s * 0.98)
    .lineTo(x + s * 0.56, y - s * 0.48)
    .closePath()
    .fill(
      vgrad([
        [0, lighten(roof, 0.12)],
        [1, darken(roof, 0.22)],
      ]),
    );
  for (let k = 1; k < 5; k += 1) {
    const yy = y - s * 0.48 - (s * 0.5 * k) / 5;
    const half = s * 0.56 * (1 - k / 5);
    g.moveTo(x - half, yy)
      .lineTo(x + half, yy)
      .stroke({ width: Math.max(1, s * 0.015), color: darken(roof, 0.35), alpha: 0.5 });
  }
}

function stall(g: Graphics, x: number, y: number, s: number, a: number, b: number): void {
  softShadow(g, x, y + s * 0.02, s * 0.5, s * 0.1, MELA.ink, 0.28);
  g.rect(x - s * 0.4, y - s * 0.32, s * 0.8, s * 0.32).fill(MELA.wood);
  g.rect(x - s * 0.36, y - s * 0.4, s * 0.72, s * 0.1).fill(0xe8b04a);
  for (const px of [-0.44, 0.4])
    g.rect(x + px * s, y - s * 0.8, s * 0.04, s * 0.8).fill(MELA.woodDark);
  for (let k = 0; k < 6; k += 1) {
    g.moveTo(x - s * 0.5 + k * s * (1 / 6), y - s * 0.8)
      .lineTo(x - s * 0.5 + (k + 1) * s * (1 / 6), y - s * 0.8)
      .lineTo(x - s * 0.5 + (k + 0.5) * s * (1 / 6), y - s * 0.66)
      .closePath()
      .fill(k % 2 ? a : b);
  }
  g.rect(x - s * 0.5, y - s * 0.86, s, s * 0.07).fill(a);
}

function tree(g: Graphics, x: number, y: number, r: number, base: number, rnd: ArtRandom): void {
  softShadow(g, x + r * 0.35, y + r * 0.25, r * 1.1, r * 0.55, MELA.ink, 0.3);
  g.rect(x - r * 0.08, y - r * 0.6, r * 0.16, r * 0.6).fill(MELA.woodDark);
  for (let i = 0; i < 7; i += 1) {
    const a = rnd.range(0, Math.PI * 2);
    const d = rnd.range(0, r * 0.45);
    g.circle(
      x + Math.cos(a) * d,
      y - r * 0.9 + Math.sin(a) * d * 0.7,
      r * rnd.range(0.45, 0.62),
    ).fill(darken(base, rnd.range(0, 0.18)));
  }
  g.circle(x - r * 0.18, y - r * 1.1, r * 0.35).fill({ color: lighten(base, 0.2), alpha: 0.6 });
}

/** A place drawing standing at a waypoint (origin = the waypoint, art sits just above it). */
export function drawPlace(kind: PlaceKind, s: number, seed: number): Container {
  const c = new Container();
  const g = new Graphics();
  const rnd = new ArtRandom(seed);
  const y = -s * 0.3;
  switch (kind) {
    case 'market':
      stall(g, -s * 0.42, y, s * 0.62, MELA.vermilion, MELA.cream);
      stall(g, s * 0.4, y + s * 0.05, s * 0.6, MELA.peacock, MELA.marigold);
      g.ellipse(0, y + s * 0.12, s * 0.16, s * 0.06).fill(0xc9954f);
      for (let k = 0; k < 4; k += 1)
        g.circle(-s * 0.06 + k * s * 0.04, y + s * 0.07, s * 0.03).fill(MELA.mango);
      break;
    case 'home': {
      hut(g, 0, y, s * 0.95, 0xf0dcc0, MELA.terracotta);
      g.roundRect(s * 0.38, y - s * 0.24, s * 0.16, s * 0.24, s * 0.02).fill(0xe9d3b0);
      for (let i = 0; i < 16; i += 1)
        g.ellipse(
          s * 0.46 + rnd.range(-0.06, 0.06) * s,
          y - s * 0.3 - rnd.range(0, 0.12) * s,
          s * 0.025,
          s * 0.016,
        ).fill(0x4f7a3a);
      // Marigold toran over the door.
      for (let k = 0; k < 7; k += 1)
        marigold(
          g,
          -s * 0.12 + k * s * 0.04,
          y - s * 0.44 + Math.sin((k / 6) * Math.PI) * s * 0.04,
          s * 0.02,
          k % 2 ? MELA.marigold : MELA.saffron,
        );
      break;
    }
    case 'potter': {
      hut(g, -s * 0.12, y, s * 0.8, 0xdcb48a, 0xa0522d);
      drawPot(g, s * 0.42, y + s * 0.04, s * 0.26, MELA.terracotta, s / 120);
      drawPot(g, s * 0.62, y + s * 0.06, s * 0.2, 0xc06a3e, s / 120);
      g.ellipse(s * 0.4, y + s * 0.2, s * 0.12, s * 0.05).fill(0x6a4a2a);
      break;
    }
    case 'vaidya': {
      hut(g, 0, y, s * 0.82, 0xe8d8b0, 0x6e8b4a);
      for (let k = 0; k < 3; k += 1) {
        const jx = s * (0.42 + k * 0.1);
        g.roundRect(jx - s * 0.04, y - s * 0.14, s * 0.08, s * 0.14, s * 0.02).fill(
          [0x7aa33c, 0xd9a66b, 0x46b3a6][k] ?? 0x7aa33c,
        );
        g.rect(jx - s * 0.045, y - s * 0.17, s * 0.09, s * 0.03).fill(MELA.woodDark);
      }
      for (let i = 0; i < 10; i += 1)
        g.circle(-s * 0.5 + rnd.range(-0.04, 0.04) * s, y - s * 0.06 - i * s * 0.02, s * 0.03).fill(
          0x5f8f3a,
        );
      break;
    }
    case 'well': {
      softShadow(g, s * 0.05, y + s * 0.06, s * 0.36, s * 0.1, MELA.ink, 0.3);
      g.ellipse(0, y - s * 0.02, s * 0.3, s * 0.12).fill(0x8f8478);
      g.rect(-s * 0.3, y - s * 0.24, s * 0.6, s * 0.22).fill(
        vgrad([
          [0, 0xc8bcaa],
          [1, 0x968a78],
        ]),
      );
      g.ellipse(0, y - s * 0.24, s * 0.3, s * 0.12).fill(0xb8ac98);
      g.ellipse(0, y - s * 0.24, s * 0.22, s * 0.08).fill(0x2f4466);
      for (const px of [-0.26, 0.24])
        g.rect(px * s, y - s * 0.6, s * 0.04, s * 0.36).fill(MELA.woodDark);
      g.rect(-s * 0.28, y - s * 0.62, s * 0.56, s * 0.04).fill(MELA.wood);
      g.circle(0, y - s * 0.6, s * 0.05).fill(MELA.brass);
      g.moveTo(0, y - s * 0.56)
        .lineTo(0, y - s * 0.34)
        .stroke({ width: s * 0.012, color: 0x6a5a40 });
      drawPot(g, s * 0.42, y + s * 0.04, s * 0.18, MELA.brass, s / 120);
      break;
    }
    case 'mill': {
      hut(g, 0, y, s * 0.8, 0xe2cfaa, 0x8a6a4a);
      g.circle(s * 0.46, y - s * 0.1, s * 0.12).fill(0x9a9286);
      g.circle(s * 0.46, y - s * 0.1, s * 0.04).fill(0x6a6458);
      break;
    }
    case 'temple': {
      softShadow(g, 0, y + s * 0.04, s * 0.5, s * 0.1, MELA.ink, 0.3);
      g.rect(-s * 0.36, y - s * 0.16, s * 0.72, s * 0.16).fill(0xd9a66b);
      g.moveTo(-s * 0.22, y - s * 0.16)
        .quadraticCurveTo(-s * 0.24, y - s * 0.7, 0, y - s * 0.98)
        .quadraticCurveTo(s * 0.24, y - s * 0.7, s * 0.22, y - s * 0.16)
        .closePath()
        .fill(
          vgrad([
            [0, 0xf0c890],
            [1, 0xc08850],
          ]),
        );
      for (let k = 1; k < 6; k += 1)
        g.moveTo(-s * 0.2 * (1 - k * 0.12), y - s * 0.16 - k * s * 0.13)
          .lineTo(s * 0.2 * (1 - k * 0.12), y - s * 0.16 - k * s * 0.13)
          .stroke({ width: Math.max(1, s * 0.012), color: 0xa06a3a, alpha: 0.6 });
      g.moveTo(0, y - s * 0.98)
        .lineTo(0, y - s * 1.2)
        .stroke({ width: s * 0.015, color: 0x6a4a22 });
      g.poly([0, y - s * 1.2, s * 0.14, y - s * 1.14, 0, y - s * 1.08]).fill(MELA.saffron);
      break;
    }
    case 'banyan':
      tree(g, 0, y + s * 0.1, s * 0.48, MELA.banyan, rnd);
      break;
    case 'hamlet':
      hut(g, -s * 0.3, y, s * 0.6, 0xe8c99a, MELA.terracotta);
      hut(g, s * 0.32, y + s * 0.04, s * 0.55, 0xdcb48a, 0xc06a3e);
      break;
    case 'haystacks':
      for (const [hx, hs] of [
        [-0.25, 0.42],
        [0.22, 0.36],
      ] as const) {
        softShadow(g, hx * s + s * 0.06, y + s * 0.04, s * hs * 0.8, s * 0.08, MELA.ink, 0.3);
        g.moveTo(hx * s - s * hs * 0.6, y)
          .quadraticCurveTo(hx * s - s * hs * 0.55, y - s * hs * 1.4, hx * s, y - s * hs * 1.5)
          .quadraticCurveTo(hx * s + s * hs * 0.55, y - s * hs * 1.4, hx * s + s * hs * 0.6, y)
          .closePath()
          .fill(
            vgrad([
              [0, 0xf0d382],
              [1, 0xc59a46],
            ]),
          );
      }
      break;
    case 'grove':
      tree(g, -s * 0.28, y, s * 0.3, MELA.mango, rnd);
      tree(g, s * 0.24, y + s * 0.05, s * 0.34, MELA.neem, rnd);
      break;
    case 'pond':
      g.ellipse(0, y, s * 0.48, s * 0.2).fill(0x8aa45a);
      g.ellipse(0, y, s * 0.42, s * 0.16).fill(
        vgrad([
          [0, 0x6a9ac0],
          [1, 0x3f6a96],
        ]),
      );
      for (let k = 0; k < 4; k += 1) {
        const lx = rnd.range(-0.3, 0.3) * s;
        const ly = y + rnd.range(-0.08, 0.08) * s;
        g.circle(lx, ly, s * 0.04).fill(0x4f8a3a);
        g.circle(lx + s * 0.01, ly - s * 0.01, s * 0.018).fill(MELA.lotus);
      }
      break;
    case 'tea_stall':
      stall(g, 0, y, s * 0.6, MELA.saffron, MELA.cream);
      g.ellipse(s * 0.42, y - s * 0.02, s * 0.06, s * 0.05).fill(0x8a8a90);
      break;
    case 'ghat':
      for (let k = 0; k < 4; k += 1)
        g.rect(
          -s * 0.4 + k * s * 0.03,
          y + k * s * 0.05 - s * 0.1,
          s * (0.8 - k * 0.06),
          s * 0.05,
        ).fill(k % 2 ? 0xd2c4aa : 0xb8aa90);
      g.moveTo(s * 0.44, y - s * 0.3)
        .lineTo(s * 0.44, y + s * 0.1)
        .stroke({ width: s * 0.03, color: MELA.woodDark });
      g.poly([s * 0.44, y - s * 0.3, s * 0.6, y - s * 0.24, s * 0.44, y - s * 0.18]).fill(
        MELA.saffron,
      );
      break;
    case 'landing':
      for (let k = 0; k < 5; k += 1)
        g.rect(-s * 0.3 + k * s * 0.13, y - s * 0.04, s * 0.11, s * 0.1).fill(
          k % 2 ? MELA.wood : lighten(MELA.wood, 0.15),
        );
      for (const px of [-0.3, 0.3])
        g.rect(px * s, y - s * 0.1, s * 0.03, s * 0.2).fill(MELA.woodDark);
      break;
  }
  c.addChild(g);
  return c;
}

export type ErrandPicture = 'pot' | 'medicine' | 'water' | 'grain';

/** Errand pictures by errand index (errand_0 .. errand_3), matching `ERRAND_PLACES`. */
export const ERRAND_PICTURES: readonly ErrandPicture[] = ['pot', 'medicine', 'water', 'grain'];

/** An errand picture in a box of edge `s` (centred). */
export function drawErrandPicture(kind: ErrandPicture, s: number): Graphics {
  const g = new Graphics();
  switch (kind) {
    case 'pot':
      drawPot(g, 0, s * 0.38, s * 0.72, MELA.terracotta, s / 90);
      break;
    case 'medicine':
      g.roundRect(-s * 0.2, -s * 0.22, s * 0.4, s * 0.56, s * 0.08).fill(
        vgrad([
          [0, 0x8fcf9a],
          [1, 0x4f9a6a],
        ]),
      );
      g.rect(-s * 0.16, -s * 0.34, s * 0.32, s * 0.12).fill(MELA.woodDark);
      g.roundRect(-s * 0.13, -s * 0.06, s * 0.26, s * 0.2, s * 0.03).fill(MELA.cream);
      // A leaf (herbal medicine), not a cross.
      g.moveTo(0, s * 0.12)
        .bezierCurveTo(-s * 0.1, s * 0.04, -s * 0.08, -s * 0.04, 0, -s * 0.03)
        .bezierCurveTo(s * 0.08, -s * 0.04, s * 0.1, s * 0.04, 0, s * 0.12)
        .fill(0x3f8a4a);
      break;
    case 'water':
      drawPot(g, 0, s * 0.38, s * 0.72, MELA.brass, s / 90);
      for (const dx of [-0.08, 0.06]) {
        g.moveTo(dx * s, -s * 0.46)
          .quadraticCurveTo(dx * s - s * 0.05, -s * 0.38, dx * s, -s * 0.33)
          .quadraticCurveTo(dx * s + s * 0.05, -s * 0.38, dx * s, -s * 0.46)
          .fill(0x5aa0d0);
      }
      break;
    case 'grain':
      g.moveTo(-s * 0.26, s * 0.36)
        .bezierCurveTo(-s * 0.34, 0, -s * 0.3, -s * 0.26, -s * 0.12, -s * 0.32)
        .lineTo(s * 0.12, -s * 0.32)
        .bezierCurveTo(s * 0.3, -s * 0.26, s * 0.34, 0, s * 0.26, s * 0.36)
        .closePath()
        .fill(
          vgrad([
            [0, 0xe0c690],
            [1, 0xb89a5a],
          ]),
        );
      g.rect(-s * 0.14, -s * 0.34, s * 0.28, s * 0.06).fill(MELA.vermilion);
      break;
  }
  return g;
}

/** Top-down bullock-cart token, pointing along +x. `s` = length of the whole rig. */
export function drawCartToken(s: number): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, s * 0.06, s * 0.05, s * 0.55, s * 0.2, MELA.ink, 0.35);
  // Two bullocks side by side (white backs, painted horns), yoked.
  for (const dy of [-0.12, 0.12]) {
    g.ellipse(s * 0.28, dy * s, s * 0.17, s * 0.075).fill(0xf2ead8);
    g.ellipse(s * 0.42, dy * s, s * 0.06, s * 0.045).fill(0xe8dcc4);
    g.moveTo(s * 0.43, dy * s - s * 0.035)
      .lineTo(s * 0.49, dy * s - s * 0.07)
      .stroke({ width: s * 0.018, color: MELA.peacock, cap: 'round' });
    g.moveTo(s * 0.43, dy * s + s * 0.035)
      .lineTo(s * 0.49, dy * s + s * 0.07)
      .stroke({ width: s * 0.018, color: MELA.peacock, cap: 'round' });
    g.rect(s * 0.2, dy * s - s * 0.06, s * 0.12, s * 0.12).fill({
      color: MELA.vermilion,
      alpha: 0.9,
    });
  }
  g.rect(s * 0.33, -s * 0.18, s * 0.025, s * 0.36).fill(MELA.woodDark);
  g.rect(-s * 0.05, -s * 0.012, s * 0.4, s * 0.024).fill(MELA.wood);
  // Wheels and bed.
  for (const dy of [-0.15, 0.15])
    g.roundRect(-s * 0.3, dy * s - s * 0.02, s * 0.22, s * 0.04, s * 0.02).fill(MELA.woodDark);
  g.roundRect(-s * 0.42, -s * 0.13, s * 0.44, s * 0.26, s * 0.04).fill(
    vgrad([
      [0, lighten(MELA.wood, 0.2)],
      [1, MELA.wood],
    ]),
  );
  g.ellipse(-s * 0.24, 0, s * 0.12, s * 0.09).fill(0xc8a76a);
  g.circle(-s * 0.1, -s * 0.05, s * 0.05).fill(MELA.terracotta);
  // Driver (turban seen from above).
  g.circle(-s * 0.02, 0, s * 0.06).fill(0xffffff);
  g.circle(-s * 0.02, 0, s * 0.045).fill(MELA.saffron);
  c.addChild(g);
  return c;
}

/** A fallen tree lying across a road (top-down), length `s`, along +x. */
export function drawFallenTree(s: number): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, s * 0.04, s * 0.06, s * 0.55, s * 0.12, MELA.ink, 0.4);
  g.roundRect(-s * 0.45, -s * 0.05, s * 0.75, s * 0.1, s * 0.05).fill(
    vgrad([
      [0, 0x8a6a44],
      [1, 0x5a4024],
    ]),
  );
  for (let k = 0; k < 4; k += 1)
    g.moveTo(-s * 0.3 + k * s * 0.16, -s * 0.05)
      .lineTo(-s * 0.24 + k * s * 0.16, s * 0.05)
      .stroke({ width: 1, color: 0x3a2a1a, alpha: 0.5 });
  g.ellipse(-s * 0.46, 0, s * 0.03, s * 0.05).fill(0xd8b888);
  const rnd = new ArtRandom(77);
  for (let i = 0; i < 14; i += 1) {
    const a = rnd.range(0, Math.PI * 2);
    const d = rnd.range(0, s * 0.18);
    g.circle(s * 0.38 + Math.cos(a) * d, Math.sin(a) * d * 0.9, s * rnd.range(0.07, 0.12)).fill(
      darken(0x4f7a3a, rnd.range(0, 0.25)),
    );
  }
  c.addChild(g);
  return c;
}

/** A plank bridge (top-down) of length `s` along +x. */
export function drawBridge(s: number, w: number): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, 0, w * 0.35, s * 0.55, w * 0.3, MELA.ink, 0.35);
  const n = Math.max(5, Math.round(s / (w * 0.32)));
  for (let k = 0; k < n; k += 1) {
    const x = -s / 2 + (k * s) / n;
    g.rect(x + 1, -w / 2, s / n - 2, w).fill(k % 2 ? 0x9a7650 : 0xb08a5e);
  }
  g.rect(-s / 2, -w / 2 - w * 0.08, s, w * 0.12).fill(MELA.woodDark);
  g.rect(-s / 2, w / 2 - w * 0.04, s, w * 0.12).fill(MELA.woodDark);
  c.addChild(g);
  return c;
}

/** A small rowing boat (top-down) of length `s` along +x (the ferry). */
export function drawBoat(s: number): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, 0, s * 0.05, s * 0.55, s * 0.16, MELA.ink, 0.3);
  g.moveTo(-s * 0.5, 0)
    .quadraticCurveTo(-s * 0.3, -s * 0.2, s * 0.3, -s * 0.18)
    .quadraticCurveTo(s * 0.55, -s * 0.1, s * 0.6, 0)
    .quadraticCurveTo(s * 0.55, s * 0.1, s * 0.3, s * 0.18)
    .quadraticCurveTo(-s * 0.3, s * 0.2, -s * 0.5, 0)
    .closePath()
    .fill(
      vgrad([
        [0, 0x9a6a3a],
        [1, 0x6a4424],
      ]),
    );
  g.moveTo(-s * 0.42, 0)
    .quadraticCurveTo(-s * 0.25, -s * 0.13, s * 0.3, -s * 0.12)
    .quadraticCurveTo(s * 0.5, -s * 0.06, s * 0.52, 0)
    .quadraticCurveTo(s * 0.5, s * 0.06, s * 0.3, s * 0.12)
    .quadraticCurveTo(-s * 0.25, s * 0.13, -s * 0.42, 0)
    .closePath()
    .fill(0xc89a64);
  for (const x of [-0.15, 0.15])
    g.rect(x * s - s * 0.02, -s * 0.13, s * 0.04, s * 0.26).fill(MELA.woodDark);
  g.moveTo(s * 0.1, -s * 0.16)
    .lineTo(s * 0.22, -s * 0.42)
    .stroke({ width: s * 0.025, color: MELA.wood, cap: 'round' });
  c.addChild(g);
  return c;
}

/** A charpai (woven cot) with a folded blanket: the rest option on the flooded river. */
export function drawCharpai(s: number): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, 0, s * 0.02, s * 0.62, s * 0.1, MELA.ink, 0.35);
  for (const [lx, ly] of [
    [-0.46, 0],
    [0.46, 0],
    [-0.4, -0.14],
    [0.4, -0.14],
  ] as const) {
    g.rect(lx * s - s * 0.025, ly * s - s * 0.2, s * 0.05, s * 0.2).fill(MELA.woodDark);
  }
  g.poly([-s * 0.5, -s * 0.2, s * 0.5, -s * 0.2, s * 0.42, -s * 0.36, -s * 0.42, -s * 0.36]).fill(
    MELA.wood,
  );
  g.poly([
    -s * 0.45,
    -s * 0.22,
    s * 0.45,
    -s * 0.22,
    s * 0.38,
    -s * 0.34,
    -s * 0.38,
    -s * 0.34,
  ]).fill(0xe8d8b0);
  for (let k = 0; k < 9; k += 1) {
    const x0 = -s * 0.44 + k * s * 0.1;
    g.moveTo(x0, -s * 0.22)
      .lineTo(x0 + s * 0.06, -s * 0.34)
      .stroke({ width: Math.max(1, s * 0.012), color: 0xb89a6a });
  }
  g.roundRect(s * 0.06, -s * 0.36, s * 0.3, s * 0.1, s * 0.04).fill(MELA.peacock);
  g.roundRect(s * 0.06, -s * 0.33, s * 0.3, s * 0.025, s * 0.01).fill(MELA.marigold);
  g.roundRect(-s * 0.36, -s * 0.36, s * 0.18, s * 0.08, s * 0.04).fill(0xf6efe0);
  // A sleeping dog curled at the foot: rest, not hurry.
  g.ellipse(-s * 0.2, -s * 0.02, s * 0.14, s * 0.07).fill(0xc89a64);
  g.circle(-s * 0.08, -s * 0.05, s * 0.05).fill(0xb8864e);
  g.ellipse(-s * 0.05, -s * 0.07, s * 0.02, s * 0.012).fill(0x3a2a1a);
  c.addChild(g);
  return c;
}
