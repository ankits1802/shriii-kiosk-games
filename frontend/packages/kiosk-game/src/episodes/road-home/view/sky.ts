/**
 * Sky for the side-view journey: four-stop gradient, sun disc with halo and god-ray fan, a cratered
 * moon that rises as night falls, twinkling stars (gentle, far below 3 Hz), the occasional slow
 * shooting star and painterly clouds that take their colours from the palette.
 */
import { Container, Graphics, type Sprite } from 'pixi.js';
import { drawCloud } from '../../../art/backdrop/nature.ts';
import { darken, lighten, mixColor } from '../../../art/color.ts';
import { ArtRandom } from '../../../art/rand.ts';
import type { EpisodeArt } from './art.ts';
import type { RoadPalette } from './palette.ts';

interface Star {
  readonly sprite: Sprite;
  readonly base: number;
  readonly speed: number;
  readonly phase: number;
}

interface Cloud {
  readonly view: Container;
  readonly body: Container;
  readonly lit: Container;
  readonly speed: number;
  readonly yFrac: number;
}

export class SkyLayer {
  readonly view = new Container();
  private readonly gradient = new Graphics();
  private readonly rays = new Graphics();
  private readonly sunGlow: Sprite;
  private readonly sun = new Graphics();
  private readonly moonGlow: Sprite;
  private readonly moon = new Container();
  private readonly starField = new Container();
  private readonly stars: Star[] = [];
  private readonly clouds: Cloud[] = [];
  private readonly shooting = new Graphics();
  private shootT = -1;
  private shootFrom = { x: 0, y: 0 };
  private nextShoot = 9;
  private palette: RoadPalette | null = null;
  private t = 0;
  private w = 1;
  private h = 1;
  /** Horizon line as a fraction of the height. */
  private horizon = 0.6;
  private readonly rnd = new ArtRandom('road_home.sky');

  constructor(private readonly art: EpisodeArt) {
    this.view.label = 'sky';
    this.view.eventMode = 'none';
    this.sunGlow = art.glow(1, 0xffffff);
    this.moonGlow = art.glow(1, 0xffffff);
    this.view.addChild(
      this.gradient,
      this.starField,
      this.rays,
      this.sunGlow,
      this.sun,
      this.moonGlow,
      this.moon,
      this.shooting,
    );
    this.buildMoon();
    const n = Math.round(150 * Math.max(0.35, art.profile.particleScale));
    for (let i = 0; i < n; i += 1) {
      const big = this.rnd.chance(0.08);
      const s = art.dot(big ? 3.4 : this.rnd.range(1.1, 2.2), big ? 0xfff2cc : 0xeef0ff, 1);
      s.blendMode = 'add';
      this.starField.addChild(s);
      this.stars.push({
        sprite: s,
        base: this.rnd.range(0.45, 1),
        speed: this.rnd.range(0.35, 1.1),
        phase: this.rnd.range(0, Math.PI * 2),
      });
    }
    for (let i = 0; i < 5; i += 1) {
      const width = this.rnd.range(240, 420);
      // Baked with a soft blur: painterly clouds instead of hard-edged puffs.
      const body = art.bake(`road_home.cloud.body.${i}`, () => drawCloud(width, 900 + i).body, 3);
      const lit = art.bake(`road_home.cloud.lit.${i}`, () => drawCloud(width, 900 + i).lit, 4);
      const v = new Container();
      v.addChild(body, lit);
      lit.alpha = 0.55;
      this.view.addChildAt(v, 2);
      this.clouds.push({
        view: v,
        body,
        lit,
        speed: this.rnd.range(4, 11),
        yFrac: this.rnd.range(0.08, 0.36),
      });
    }
  }

  private buildMoon(): void {
    const g = new Graphics();
    const r = 40;
    g.circle(0, 0, r).fill(0xf4f1e2);
    const craters: readonly (readonly [number, number, number])[] = [
      [-12, -10, 9],
      [14, 6, 6],
      [-4, 16, 5],
      [10, -16, 4],
      [-18, 8, 3.5],
    ];
    for (const [x, y, cr] of craters) {
      g.circle(x, y, cr).fill({ color: 0xd8d2bc, alpha: 0.75 });
      g.circle(x - cr * 0.2, y - cr * 0.2, cr * 0.7).fill({ color: 0xe6e0c9, alpha: 0.6 });
    }
    g.circle(0, 0, r).stroke({ width: 2, color: 0xffffff, alpha: 0.5 });
    this.moon.addChild(g);
  }

  /** Lay out for a stage size; `horizon` is the fraction of the height where land meets sky. */
  resize(w: number, h: number, horizon: number): void {
    this.w = w;
    this.h = h;
    this.horizon = horizon;
    const sky = this.h * this.horizon;
    for (const s of this.stars) {
      s.sprite.position.set(this.rnd.range(0, w), this.rnd.range(0, sky * 0.92));
    }
    for (const c of this.clouds) c.view.x = this.rnd.range(-0.1, 1) * w;
    if (this.palette) this.apply(this.palette);
  }

  /** Repaint with a palette. Cheap enough to call every frame while the light animates. */
  apply(p: RoadPalette): void {
    this.palette = p;
    const { w, h } = this;
    const sky = h * this.horizon;
    this.gradient.clear();
    // Banded gradient (no gradient texture is rebuilt while the light animates).
    const bands = 48;
    const stops: readonly (readonly [number, number])[] = [
      [0, p.skyTop],
      [0.45, p.skyMid],
      [0.82, p.skyLow],
      [1, p.skyHorizon],
    ];
    for (let i = 0; i < bands; i += 1) {
      const k = (i + 0.5) / bands;
      let j = 0;
      while (j + 2 < stops.length && k > (stops[j + 1]?.[0] ?? 1)) j += 1;
      const [k0, c0] = stops[j] as readonly [number, number];
      const [k1, c1] = stops[j + 1] as readonly [number, number];
      const color = mixColor(c0, c1, Math.min(1, Math.max(0, (k - k0) / (k1 - k0))));
      this.gradient.rect(0, (sky + 4) * (i / bands), w, (sky + 4) / bands + 1).fill(color);
    }
    const u = this.art.unit;
    const sunR = p.sunRadius * h;
    const sx = p.sunX * w;
    const sy = p.sunY * h * (this.horizon / 0.55);
    this.sun.clear();
    const sunVisible = sy < sky + sunR;
    this.sun.visible = sunVisible;
    this.sunGlow.visible = sunVisible;
    if (sunVisible) {
      this.sun.circle(sx, sy, sunR).fill(p.sun);
      this.sun.circle(sx, sy, sunR * 0.82).fill(lighten(p.sun, 0.25));
      // Horizon clips the setting sun.
      this.sun.rect(sx - sunR * 1.2, sky, sunR * 2.4, sunR * 2).fill(p.skyHorizon);
      this.sunGlow.position.set(sx, sy);
      this.sunGlow.tint = p.sunHalo;
      this.sunGlow.scale.set((sunR * 6) / 64);
      this.sunGlow.alpha = 0.85;
    }
    this.rays.clear();
    if (sunVisible && p.godrays > 0.05 && this.art.profile.godrays) {
      for (let i = 0; i < 9; i += 1) {
        const a = -Math.PI + (i / 8) * Math.PI;
        const len = h * 0.9;
        const spread = 0.05;
        this.rays
          .moveTo(sx, sy)
          .lineTo(sx + Math.cos(a - spread) * len, sy + Math.sin(a - spread) * len)
          .lineTo(sx + Math.cos(a + spread) * len, sy + Math.sin(a + spread) * len)
          .closePath()
          .fill({ color: p.sunHalo, alpha: 0.05 * p.godrays });
      }
    }
    const mx = p.moonX * w;
    const my = p.moonY * sky;
    this.moon.position.set(mx, my);
    this.moon.scale.set(u * 1.05);
    this.moon.alpha = p.moonAlpha;
    this.moonGlow.position.set(mx, my);
    this.moonGlow.tint = 0xbfd0ff;
    this.moonGlow.scale.set((u * 230) / 64);
    this.moonGlow.alpha = p.moonAlpha * 0.55;
    for (const c of this.clouds) {
      c.body.tint = p.cloud;
      c.lit.tint = p.cloudLit;
      c.view.alpha = 0.92 - p.stars * 0.35;
    }
    this.starField.alpha = p.stars;
  }

  /** Advance animation by `dt` seconds. */
  update(dt: number): void {
    this.t += dt;
    const m = this.art.motion;
    if (this.starField.alpha > 0.01) {
      for (const s of this.stars) {
        // Twinkle well below 3 Hz (KSK-05): slow sine on alpha only.
        s.sprite.alpha = s.base * (0.7 + 0.3 * Math.sin(this.t * s.speed + s.phase) * m);
      }
    }
    for (const c of this.clouds) {
      c.view.x += c.speed * dt * m * this.art.unit;
      if (c.view.x > this.w + 300 * this.art.unit) c.view.x = -300 * this.art.unit;
      c.view.y = c.yFrac * this.h;
      c.view.scale.set(this.art.unit);
    }
    this.updateShootingStar(dt);
  }

  private updateShootingStar(dt: number): void {
    const p = this.palette;
    if (!p || p.stars < 0.6 || this.art.reducedMotion) {
      this.shooting.clear();
      return;
    }
    if (this.shootT < 0) {
      this.nextShoot -= dt;
      if (this.nextShoot <= 0) {
        this.shootT = 0;
        this.shootFrom = {
          x: this.rnd.range(0.3, 0.9) * this.w,
          y: this.rnd.range(0.05, 0.25) * this.h,
        };
        this.nextShoot = this.rnd.range(9, 16);
      }
      return;
    }
    this.shootT += dt;
    const k = this.shootT / 1.3;
    this.shooting.clear();
    if (k >= 1) {
      this.shootT = -1;
      return;
    }
    const len = 160 * this.art.unit;
    const x = this.shootFrom.x - k * 260 * this.art.unit;
    const y = this.shootFrom.y + k * 110 * this.art.unit;
    const a = Math.sin(k * Math.PI);
    this.shooting
      .moveTo(x, y)
      .lineTo(x + len * 0.9, y - len * 0.38)
      .stroke({ width: 2 * this.art.unit, color: 0xffffff, alpha: 0.65 * a, cap: 'round' });
    this.shooting.circle(x, y, 2.5 * this.art.unit).fill({ color: 0xffffff, alpha: a });
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

/** Darken/lighten helpers for silhouettes against the sky. */
export function silhouette(color: number, night: number): number {
  return night > 0.5 ? darken(color, 0.1 + night * 0.2) : color;
}
