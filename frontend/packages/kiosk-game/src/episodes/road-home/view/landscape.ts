/**
 * Side-view parallax landscape for the journey: far hills with a hilltop temple and village whose
 * windows light up at dusk, a mid ridge with tree lines, scattered palms/neems/banyans, crop fields,
 * the dirt road the cart travels and a foreground of grass and wildflowers. Every band scrolls at its
 * own depth factor as the camera moves; colours follow the palette (tint per depth with haze), and
 * light sources live on an untinted layer so they glow against the night.
 *
 * Deliberately no lanterns or lamp posts here: the lantern is the fork cue and must not appear
 * anywhere else on the road (no confusable stimulus).
 */
import { Container, Graphics, type Sprite } from 'pixi.js';
import {
  drawBanyan,
  drawNeem,
  drawPalm,
  drawTuft,
  fillRidge,
  ridgePoints,
} from '../../../art/backdrop/nature.ts';
import { drawHouse, drawTemple } from '../../../art/backdrop/structures.ts';
import { darken, lighten, mixColor } from '../../../art/color.ts';
import { marigold, softShadow, vgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { ArtRandom } from '../../../art/rand.ts';
import type { EpisodeArt } from './art.ts';
import { ROAD_COLOR } from './fork.ts';
import type { RoadPalette } from './palette.ts';

interface Band {
  readonly view: Container;
  readonly tiles: Container[];
  readonly factor: number;
  readonly tileW: number;
  /** How strongly the band takes the haze (far = more). */
  readonly haze: number;
  readonly kind: 'ridge_far' | 'ridge_mid' | 'art';
}

interface WindowLight {
  readonly sprite: Container;
  readonly band: Band;
  readonly x: number;
  readonly flicker: number;
}

interface Firefly {
  readonly sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
}

/** Ground metrics shared with the set pieces and the cart. */
export interface GroundMetrics {
  readonly horizonY: number;
  /** Road surface line (wheels touch it). */
  readonly roadY: number;
  /** Road band thickness. */
  readonly roadH: number;
  /** Where the cart sits horizontally on screen. */
  readonly cartX: number;
}

export function groundMetrics(w: number, h: number): GroundMetrics {
  const portrait = h > w;
  return {
    horizonY: h * (portrait ? 0.53 : 0.57),
    roadY: h * (portrait ? 0.69 : 0.8),
    roadH: h * (portrait ? 0.055 : 0.085),
    cartX: w * (portrait ? 0.25 : 0.3),
  };
}

export class JourneyLandscape {
  readonly view = new Container();
  /** World-space container for set pieces (scrolls with the road). */
  readonly world = new Container();
  /** Foreground band (in front of the cart). */
  readonly front = new Container();
  private readonly ground = new Graphics();
  private readonly lights = new Container();
  private readonly flies = new Container();
  private readonly bands: Band[] = [];
  private readonly frontBands: Band[] = [];
  private readonly windows: WindowLight[] = [];
  private readonly fireflies: Firefly[] = [];
  private palette: RoadPalette | null = null;
  private cam = 0;
  private t = 0;
  private w = 1;
  private h = 1;
  metrics: GroundMetrics = groundMetrics(1, 1);

  constructor(private readonly art: EpisodeArt) {
    this.view.label = 'landscape';
    this.view.eventMode = 'none';
    this.world.label = 'world';
    this.front.label = 'foreground';
  }

  get camera(): number {
    return this.cam;
  }

  /** (Re)build every band for a stage size. */
  build(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.metrics = groundMetrics(w, h);
    for (const b of [...this.bands, ...this.frontBands]) b.view.destroy({ children: true });
    this.bands.length = 0;
    this.frontBands.length = 0;
    this.windows.length = 0;
    for (const c of this.lights.removeChildren()) c.destroy();
    this.view.removeChildren();
    this.front.removeChildren();
    const m = this.metrics;
    const u = this.art.unit;
    const tileW = Math.ceil(Math.max(w, h) * 1.6);

    this.addBand('ridge_far', 0.05, tileW, 1, (g, rnd) => {
      const pts = ridgePoints(tileW, m.horizonY + 4, h * 0.15, rnd.range(0, 9), tileW / 1.5, 96);
      seamless(pts, tileW);
      fillRidge(g, pts, m.horizonY + 8, 0xffffff, 0xd8d8e6);
    });
    this.addBand('art', 0.08, tileW, 0.85, (g, rnd, c, band) => {
      // Hilltop temple and the far village (windows light up at dusk).
      const temple = drawTemple(h * 0.11);
      temple.view.position.set(tileW * 0.72, m.horizonY - h * 0.075);
      c.addChild(temple.view);
      for (let i = 0; i < 9; i += 1) {
        const x = tileW * (0.08 + i * 0.07 + rnd.range(-0.015, 0.015));
        const s = h * rnd.range(0.035, 0.05);
        const house = drawHouse(s, 700 + i);
        const y = m.horizonY - h * 0.02 + rnd.range(-0.02, 0.01) * h;
        house.view.position.set(x, y);
        c.addChild(house.view);
        for (const l of house.lights) this.addWindow(band, x + l.x, y + l.y, s * 0.16, rnd.next());
      }
      void g;
    });
    this.addBand('ridge_mid', 0.16, tileW, 0.65, (g, rnd) => {
      const pts = ridgePoints(
        tileW,
        m.horizonY + h * 0.035,
        h * 0.07,
        rnd.range(0, 9),
        tileW / 2.2,
        96,
      );
      seamless(pts, tileW);
      fillRidge(g, pts, m.horizonY + h * 0.06, 0xffffff, 0xd0d0dc);
      // An organic tree line hugging the ridge: one bumpy silhouette, not separate blobs.
      const crown: { x: number; y: number }[] = [];
      for (let x = 0; x <= tileW; x += 6 * u) {
        const p = pts[Math.min(pts.length - 1, Math.round((x / tileW) * (pts.length - 1)))];
        const bump =
          Math.abs(Math.sin(x / (23 * u) + 1.7)) * 9 * u + Math.abs(Math.sin(x / (61 * u))) * 7 * u;
        crown.push({ x, y: (p?.y ?? m.horizonY) - bump });
      }
      crown.push({ x: tileW, y: m.horizonY + h * 0.06 }, { x: 0, y: m.horizonY + h * 0.06 });
      g.poly(crown.flatMap((p) => [p.x, p.y])).fill(0xb4bac4);
      void rnd;
    });
    this.addBand('art', 0.32, tileW, 0.4, (g, rnd, c) => {
      // Fields between the hills and the road.
      const top = m.horizonY + h * 0.035;
      const bottom = m.roadY - m.roadH * 0.6;
      for (let i = 0; i < 18; i += 1) {
        const x = rnd.range(0, tileW);
        const depth = rnd.next();
        const y = top + (bottom - top) * (0.15 + depth * 0.7);
        const fw = (140 + 260 * depth) * u;
        const fh = (10 + 22 * depth) * u;
        const col = rnd.pick([0xc9b45a, 0x8fae4e, 0xd8a85a, 0x7fa04a, 0xb8c46a]);
        g.roundRect(x - fw / 2, y - fh / 2, fw, fh, fh * 0.4).fill(col);
        for (let r = 1; r < 4; r += 1) {
          const yy = y - fh / 2 + (fh / 4) * r;
          g.moveTo(x - fw * 0.46, yy)
            .lineTo(x + fw * 0.46, yy)
            .stroke({ width: Math.max(1, fh * 0.06), color: darken(col, 0.2), alpha: 0.6 });
        }
      }
      // Haystacks and a distant palm or two.
      for (let i = 0; i < 4; i += 1) {
        const x = rnd.range(0.05, 0.95) * tileW;
        const y = top + (bottom - top) * rnd.range(0.3, 0.8);
        haystack(g, x, y, (22 + rnd.range(0, 16)) * u);
      }
      for (let i = 0; i < 3; i += 1) {
        const p = drawPalm(h * rnd.range(0.12, 0.16), 760 + i);
        const x = rnd.range(0.1, 0.9) * tileW;
        const tree = new Container();
        tree.addChild(p.trunk, p.canopy);
        tree.position.set(x, top + (bottom - top) * rnd.range(0.2, 0.5));
        c.addChild(tree);
      }
    });
    this.addBand('art', 0.62, tileW, 0.15, (g, rnd, c) => {
      // Roadside trees just behind the road.
      const y = m.roadY - m.roadH * 0.75;
      const kinds = ['neem', 'banyan', 'neem', 'palm'] as const;
      for (let i = 0; i < 5; i += 1) {
        const k = kinds[i % kinds.length] ?? 'neem';
        const s = h * (k === 'banyan' ? 0.19 : 0.34) * rnd.range(0.85, 1.1);
        const tree =
          k === 'banyan'
            ? drawBanyan(s, 780 + i)
            : k === 'palm'
              ? drawPalm(s, 780 + i)
              : drawNeem(s, 780 + i);
        const holder = new Container();
        holder.addChild(tree.trunk, tree.canopy);
        holder.position.set(tileW * (0.1 + i * 0.19 + rnd.range(-0.04, 0.04)), y);
        c.addChild(holder);
      }
      // A low bamboo fence along the far verge.
      for (let f = 0; f < 3; f += 1) {
        const fx0 = rnd.range(0, tileW - 260 * u);
        const fy = y + 6 * u;
        for (let k = 0; k <= 6; k += 1)
          g.rect(fx0 + k * 40 * u, fy - 30 * u, 5 * u, 32 * u).fill(0xa08050);
        g.rect(fx0, fy - 25 * u, 245 * u, 4 * u).fill(0x8a6a40);
        g.rect(fx0, fy - 12 * u, 245 * u, 4 * u).fill(0x8a6a40);
      }
      for (let i = 0; i < 26; i += 1) {
        const t = drawTuft((18 + rnd.range(0, 16)) * u, 790 + i, rnd.chance(0.4));
        t.position.set(rnd.range(0, tileW), y + rnd.range(-4, 6) * u);
        c.addChild(t);
      }
      void g;
    });
    // The road itself: ruts, pebbles and wheel tracks at the cart's depth (factor 1).
    this.addBand('art', 1, tileW, 0, (g, rnd) => {
      const top = m.roadY - m.roadH * 0.55;
      const bottom = m.roadY + m.roadH * 0.45;
      g.rect(0, top, tileW, bottom - top).fill(ROAD_COLOR);
      g.rect(0, top - 2 * u, tileW, 4 * u).fill({ color: 0xa88a5e, alpha: 0.6 });
      for (const k of [0.32, 0.72]) {
        const y = top + (bottom - top) * k;
        g.rect(0, y, tileW, 3.2 * u).fill({ color: 0x9c7c52, alpha: 0.55 });
      }
      for (let i = 0; i < 160; i += 1) {
        const x = rnd.range(0, tileW);
        const y = rnd.range(top + 4 * u, bottom - 3 * u);
        const r = rnd.range(1, 3.4) * u;
        g.ellipse(x, y, r * 1.3, r).fill({
          color: rnd.chance(0.5) ? 0xa9875c : 0xf0dcb4,
          alpha: 0.75,
        });
      }
    });
    // Ground below the road (painted live from the palette in apply()).
    this.view.addChildAt(this.ground, 0);
    // Foreground grass and flowers, in front of the cart.
    this.addBand(
      'art',
      1.35,
      tileW,
      0,
      (g, rnd, c) => {
        const y = h + 6 * u;
        for (let i = 0; i < 18; i += 1) {
          const t = drawTuft((46 + rnd.range(0, 40)) * u, 820 + i, rnd.chance(0.6));
          t.position.set(rnd.range(0, tileW), y - rnd.range(0, 26) * u);
          c.addChild(t);
        }
        // Tall screens leave a deep meadow under the road: a second, mid-depth row of tufts and
        // flower clumps fills it so the portrait frame never reads as an empty band.
        if (h > w) {
          const midY = m.roadY + m.roadH + (h - m.roadY - m.roadH) * 0.45;
          for (let i = 0; i < 10; i += 1) {
            const t = drawTuft((34 + rnd.range(0, 30)) * u, 900 + i, rnd.chance(0.7));
            t.position.set(rnd.range(0, tileW), midY + rnd.range(-40, 40) * u);
            c.addChild(t);
          }
          for (let i = 0; i < 40; i += 1) {
            const fx = rnd.range(0, tileW);
            const fy = midY + rnd.range(-70, 120) * u;
            g.circle(fx, fy, rnd.range(2.4, 4.6) * u).fill(
              rnd.pick([MELA.marigold, MELA.rose, 0xffffff, MELA.saffron]),
            );
          }
        }
        // Wildflower drifts and a low bamboo fence along the meadow.
        for (let i = 0; i < 70; i += 1) {
          const fx = rnd.range(0, tileW);
          const fy = m.roadY + m.roadH * 0.6 + rnd.range(0, h - m.roadY - m.roadH * 0.6);
          g.circle(fx, fy, rnd.range(1.6, 3.4) * u).fill(
            rnd.pick([MELA.marigold, MELA.rose, 0xffffff, MELA.saffron]),
          );
        }
        for (let i = 0; i < 8; i += 1) {
          const x = rnd.range(0, tileW);
          const yy = y - rnd.range(14, 46) * u;
          softShadow(g, x, yy + 6 * u, 26 * u, 6 * u, MELA.ink, 0.25);
          g.ellipse(x, yy, 24 * u, 15 * u).fill(0x9a8a7a);
          g.ellipse(x - 6 * u, yy - 5 * u, 12 * u, 6 * u).fill({ color: 0xc8b8a4, alpha: 0.7 });
        }
      },
      true,
    );
    this.view.addChild(this.lights, this.world, this.flies);
    this.buildFireflies();
    this.setCamera(this.cam);
    if (this.palette) this.apply(this.palette);
  }

  private addBand(
    kind: Band['kind'],
    factor: number,
    tileW: number,
    haze: number,
    draw: (g: Graphics, rnd: ArtRandom, c: Container, band: Band) => void,
    front = false,
  ): void {
    const view = new Container();
    const tiles: Container[] = [];
    const band: Band = { view, tiles, factor, tileW, haze, kind };
    for (let i = 0; i < 2; i += 1) {
      const tile = new Container();
      const g = new Graphics();
      tile.addChild(g);
      // Identical content in both tiles (same seed), offset by one tile width.
      draw(g, new ArtRandom(`road_home.band.${factor}.${kind}`), tile, i === 0 ? band : NO_BAND);
      tile.x = i * tileW;
      view.addChild(tile);
      tiles.push(tile);
    }
    (front ? this.front : this.view).addChild(view);
    (front ? this.frontBands : this.bands).push(band);
  }

  private addWindow(band: Band, x: number, y: number, r: number, flicker: number): void {
    if (band === NO_BAND) return;
    for (let i = 0; i < 2; i += 1) {
      const holder = new Container();
      const glow = this.art.glow(r * 2.4, 0xffb04a, 1);
      const core = new Graphics().rect(-r * 0.45, -r * 0.4, r * 0.9, r * 0.8).fill(0xffd27a);
      holder.addChild(glow, core);
      holder.alpha = 0;
      this.lights.addChild(holder);
      this.windows.push({ sprite: holder, band, x: x + i * band.tileW, flicker });
      holder.y = y;
    }
  }

  private buildFireflies(): void {
    for (const c of this.flies.removeChildren()) c.destroy();
    this.fireflies.length = 0;
    const n = Math.round(46 * Math.max(0.3, this.art.profile.particleScale));
    const rnd = new ArtRandom('road_home.fireflies');
    const m = this.metrics;
    for (let i = 0; i < n; i += 1) {
      const s = this.art.glow(9 * this.art.unit, 0xd8ff7a, 0);
      this.flies.addChild(s);
      this.fireflies.push({
        sprite: s,
        x: rnd.range(0, this.w),
        y: rnd.range(m.horizonY + 10, this.h),
        vx: rnd.range(-14, 14),
        vy: rnd.range(-8, 8),
        phase: rnd.range(0, Math.PI * 2),
      });
    }
  }

  /** Scroll the world: `x` grows as the cart travels right. */
  setCamera(x: number): void {
    this.cam = x;
    for (const b of [...this.bands, ...this.frontBands]) {
      const off = (((x * b.factor) % b.tileW) + b.tileW) % b.tileW;
      b.view.x = -off;
    }
    for (const wl of this.windows) {
      const off = (((x * wl.band.factor) % wl.band.tileW) + wl.band.tileW) % wl.band.tileW;
      wl.sprite.x = wl.x - off;
    }
    this.world.x = -x;
  }

  apply(p: RoadPalette): void {
    this.palette = p;
    const m = this.metrics;
    this.ground.clear();
    // Banded ground: hazy fields up to the road, a meadow in front of it (no gradient textures
    // are rebuilt while the light animates).
    // The meadow keeps its green at sunset and sinks into moonlit shade at night (never a pale band).
    const meadow = mixColor(
      mixColor(0x7f9a50, p.lightTint, 0.35),
      mixColor(0x2f4a3a, p.groundShade, 0.4),
      p.night * 0.85,
    );
    const top = m.horizonY - 2;
    const bands = 28;
    for (let i = 0; i < bands; i += 1) {
      const y0 = top + ((this.h - top) * i) / bands;
      const yy = y0 + (this.h - top) / bands / 2;
      let color: number;
      if (yy < m.roadY) {
        const k = (yy - top) / Math.max(1, m.roadY - top);
        color = mixColor(mixColor(p.ground, p.haze, 0.35), p.ground, k);
      } else {
        const k = (yy - m.roadY) / Math.max(1, this.h - m.roadY);
        color = mixColor(mixColor(p.ground, meadow, 0.55), mixColor(p.groundShade, meadow, 0.3), k);
      }
      this.ground.rect(0, y0, this.w, (this.h - top) / bands + 1).fill(color);
    }
    for (const b of [...this.bands, ...this.frontBands]) {
      if (b.kind === 'ridge_far') b.view.tint = mixColor(p.hillFar, p.haze, 0.25);
      else if (b.kind === 'ridge_mid') b.view.tint = p.hillMid;
      else b.view.tint = mixColor(lighten(p.lightTint, 0.12), p.haze, b.haze * 0.7);
    }
    this.lights.alpha = 1;
  }

  update(dt: number): void {
    this.t += dt;
    const p = this.palette;
    if (!p) return;
    const m = this.art.motion;
    for (const wl of this.windows) {
      wl.sprite.alpha =
        p.lights * (0.75 + 0.25 * Math.sin(this.t * (0.6 + wl.flicker) + wl.flicker * 9) * m);
    }
    const fireAlpha = p.fireflies;
    this.flies.visible = fireAlpha > 0.02;
    if (this.flies.visible) {
      const top = this.metrics.horizonY + 10;
      for (const f of this.fireflies) {
        f.phase += dt;
        f.vx += Math.sin(f.phase * 0.9) * 6 * dt;
        f.vy += Math.cos(f.phase * 1.3) * 6 * dt;
        f.x += f.vx * dt * m;
        f.y += f.vy * dt * m;
        if (f.x < 0) f.x += this.w;
        if (f.x > this.w) f.x -= this.w;
        if (f.y < top) f.vy = Math.abs(f.vy);
        if (f.y > this.h) f.vy = -Math.abs(f.vy);
        f.sprite.position.set(f.x, f.y);
        f.sprite.alpha = fireAlpha * (0.25 + 0.75 * Math.max(0, Math.sin(f.phase * 1.7)));
      }
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
    this.front.destroy({ children: true });
  }
}

const NO_BAND: Band = {
  view: new Container(),
  tiles: [],
  factor: 0,
  tileW: 1,
  haze: 0,
  kind: 'art',
};

/** Make a ridge tile wrap seamlessly by blending its ends. */
function seamless(pts: { x: number; y: number }[], tileW: number): void {
  const n = pts.length;
  const first = pts[0];
  const last = pts[n - 1];
  if (!first || !last) return;
  const avg = (first.y + last.y) / 2;
  const blend = Math.max(2, Math.floor(n * 0.12));
  for (let i = 0; i < blend; i += 1) {
    const k = 1 - i / blend;
    const a = pts[i];
    const b = pts[n - 1 - i];
    if (a) a.y = a.y * (1 - k) + avg * k;
    if (b) b.y = b.y * (1 - k) + avg * k;
  }
  last.x = tileW;
}

/** A small domed haystack. */
export function haystack(g: Graphics, x: number, y: number, s: number): void {
  softShadow(g, x, y, s * 1.1, s * 0.22, MELA.ink, 0.28);
  g.moveTo(x - s, y)
    .quadraticCurveTo(x - s * 0.9, y - s * 1.3, x, y - s * 1.45)
    .quadraticCurveTo(x + s * 0.9, y - s * 1.3, x + s, y)
    .closePath()
    .fill(
      vgrad([
        [0, 0xf0d382],
        [1, 0xc59a46],
      ]),
    );
  for (let i = 0; i < 6; i += 1) {
    const yy = y - s * (0.2 + i * 0.2);
    g.moveTo(x - s * (0.9 - i * 0.12), yy)
      .lineTo(x + s * (0.9 - i * 0.12), yy)
      .stroke({ width: 1, color: 0xa47e34, alpha: 0.5 });
  }
  g.rect(x - s * 0.06, y - s * 1.7, s * 0.12, s * 0.3).fill(MELA.wood);
  marigold(g, x, y - s * 1.72, s * 0.08, MELA.marigold);
}
