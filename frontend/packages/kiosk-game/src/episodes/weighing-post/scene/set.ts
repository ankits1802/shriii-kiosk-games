/**
 * The weighing post set: a striped cloth canopy on a carved beam with marigold torans and brass
 * lanterns, painted pillars, and the long teak counter with a block-printed runner, a diya and the cash
 * box. Static parts are drawn once per layout; lantern flames and glows breathe with the time of day
 * (the shared {@link Lighting} palette's `lights` value).
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import { darken, lighten, mixColor } from '../../../art/color.ts';
import {
  catenary,
  glowDisc,
  lgrad,
  mangoLeaf,
  marigold,
  rgrad,
  softShadow,
  vgrad,
} from '../../../art/draw.ts';
import { motionSettings } from '../../../art/motion.ts';
import type { ScenePalette } from '../../../art/palettes.ts';
import { MELA } from '../../../art/palettes.ts';
import { ArtRandom } from '../../../art/rand.ts';
import type { SceneGeometry } from './layout.ts';

class SwingLamp {
  readonly view = new Container();
  readonly glow = new Graphics();
  private readonly flame = new Graphics();
  private t: number;
  constructor(len: number, s: number, phase: number) {
    this.t = phase;
    const g = new Graphics();
    g.moveTo(0, 0)
      .lineTo(0, len)
      .stroke({ width: 2.5 * s, color: darken(MELA.brass, 0.4) });
    const y = len;
    // Pierced brass lantern (dome, cage, base).
    g.moveTo(-22 * s, y + 10 * s)
      .quadraticCurveTo(0, y - 18 * s, 22 * s, y + 10 * s)
      .closePath()
      .fill(MELA.brass);
    g.roundRect(-18 * s, y + 10 * s, 36 * s, 44 * s, 8 * s).fill({ color: 0xfff1c0, alpha: 0.85 });
    for (const x of [-12, 0, 12])
      g.rect((x - 1.5) * s, y + 10 * s, 3 * s, 44 * s).fill(darken(MELA.brass, 0.25));
    g.roundRect(-22 * s, y + 52 * s, 44 * s, 8 * s, 3 * s).fill(MELA.brass);
    g.circle(0, y + 66 * s, 4 * s).fill(MELA.brass);
    glowDisc(this.glow, 0, y + 32 * s, 150 * s, 0xffb84d, 0.55);
    this.glow.blendMode = 'add';
    this.flame.position.set(0, y + 36 * s);
    this.view.addChild(this.glow, g, this.flame);
    this.drawFlame(s);
  }
  private drawFlame(s: number): void {
    this.flame.clear();
    this.flame
      .moveTo(0, -14 * s)
      .quadraticCurveTo(8 * s, 0, 0, 6 * s)
      .quadraticCurveTo(-8 * s, 0, 0, -14 * s)
      .fill(0xffd27a);
    this.flame.ellipse(0, 1 * s, 2.5 * s, 4 * s).fill(0xffffff);
  }
  update(dt: number, lights: number, motion: number): void {
    this.t += dt;
    this.view.rotation = Math.sin(this.t * 0.9) * 0.035 * motion;
    const flick = 0.9 + 0.1 * Math.sin(this.t * 13.1) * Math.sin(this.t * 7.3);
    this.glow.alpha = (0.18 + lights * 0.82) * flick;
    this.flame.scale.set(1, 0.9 + 0.12 * flick);
  }
}

/** The static + gently animated set. */
export class WeighingSet {
  /** Behind the characters: pillars' back halves and the back rail. */
  readonly back = new Container();
  /** In front of the characters: the counter (characters stand behind it). */
  readonly counter = new Container();
  /** Above everything in the frame: canopy, torans, lanterns, pillars. */
  readonly canopy = new Container();
  /** Warm additive light shafts across the frame. */
  readonly shafts = new Container();
  private readonly lamps: SwingLamp[] = [];
  private readonly diyaGlow = new Graphics();
  private readonly toran = new Graphics();
  private readonly shaftG = new Graphics();
  private t = 0;
  private lights = 0;
  private readonly g: SceneGeometry;
  /** Where coins go (cash box mouth) and luck tokens collect (brass bowl), stage px. */
  readonly cashBox: { x: number; y: number };
  readonly bowl: { x: number; y: number };

  constructor(geo: SceneGeometry) {
    this.g = geo;
    const u = geo.u;
    this.cashBox = { x: geo.width * (geo.portrait ? 0.86 : 0.9), y: geo.counterTop + 34 * u };
    this.bowl = { x: geo.width * (geo.portrait ? 0.14 : 0.1), y: geo.counterTop + 30 * u };
    this.buildCounter();
    this.buildCanopy();
    this.buildShafts();
  }

  private buildCounter(): void {
    const { width: W, height: H, counterTop: top, u } = this.g;
    const g = new Graphics();
    // Back rail the customers lean over (thin, behind the tokens).
    softShadow(g, W / 2, top + 6 * u, W * 0.6, 18 * u, MELA.ink, 0.35);
    // Counter top: warm teak with grain.
    g.rect(0, top, W, H - top).fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, lighten(MELA.wood, 0.28)],
        [0.25, lighten(MELA.wood, 0.12)],
        [1, darken(MELA.wood, 0.25)],
      ]),
    );
    const rnd = new ArtRandom(401);
    for (let i = 0; i < 26; i++) {
      const y = top + rnd.range(10, H - top - 6) * 1;
      const amp = rnd.range(3, 9) * u;
      g.moveTo(0, y);
      for (let x = 0; x <= W; x += W / 14) g.lineTo(x, y + Math.sin(x * 0.004 + i) * amp);
      g.stroke({
        width: rnd.range(0.8, 2.2) * u,
        color: darken(MELA.wood, 0.3),
        alpha: rnd.range(0.15, 0.4),
      });
    }
    for (let i = 0; i < 7; i++) {
      const x = rnd.range(0.05, 0.95) * W;
      const y = top + rnd.range(0.2, 0.9) * (H - top);
      g.ellipse(x, y, rnd.range(8, 16) * u, rnd.range(3, 5) * u).stroke({
        width: 1.2 * u,
        color: darken(MELA.wood, 0.35),
        alpha: 0.4,
      });
    }
    // Back edge: brass inlay and a highlight where the late sun grazes it.
    g.rect(0, top - 4 * u, W, 9 * u).fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, 0xfff0b8],
        [0.5, MELA.brass],
        [1, darken(MELA.brass, 0.4)],
      ]),
    );
    for (let x = 18 * u; x < W; x += 64 * u)
      g.circle(x, top + 0.5 * u, 3.2 * u).fill(darken(MELA.brass, 0.45));
    // Block-printed runner under the tokens.
    const ry = this.g.portrait ? top + (H - top) * 0.12 : top + (H - top) * 0.2;
    const rh = this.g.portrait ? (H - top) * 0.8 : (H - top) * 0.66;
    g.rect(0, ry, W, rh).fill(
      vgrad([
        [0, 0xa8322e],
        [1, 0x7e2226],
      ]),
    );
    g.rect(0, ry, W, rh).fill({ color: 0x000000, alpha: 0.04 });
    for (const yy of [ry + 8 * u, ry + rh - 14 * u]) {
      g.rect(0, yy, W, 6 * u).fill(MELA.marigold);
      for (let x = 10 * u; x < W; x += 28 * u) {
        g.moveTo(x, yy + 6 * u)
          .lineTo(x + 7 * u, yy + 14 * u)
          .lineTo(x + 14 * u, yy + 6 * u)
          .closePath()
          .fill(MELA.marigold);
      }
    }
    // Paisley (buta) motifs in a loose grid.
    for (let y = ry + 40 * u; y < ry + rh - 30 * u; y += 70 * u) {
      for (let x = 30 * u + ((y / (70 * u)) % 2) * 60 * u; x < W; x += 120 * u) {
        g.moveTo(x, y)
          .bezierCurveTo(x + 18 * u, y - 16 * u, x + 22 * u, y + 14 * u, x + 2 * u, y + 18 * u)
          .quadraticCurveTo(x - 10 * u, y + 8 * u, x, y)
          .fill({ color: 0xf2c46b, alpha: 0.35 });
        g.circle(x + 6 * u, y + 6 * u, 2.6 * u).fill({ color: MELA.cream, alpha: 0.4 });
      }
    }
    // Front lip with studs.
    g.rect(0, H - 16 * u, W, 16 * u).fill(darken(MELA.wood, 0.4));
    for (let x = 30 * u; x < W; x += 90 * u) g.circle(x, H - 8 * u, 4 * u).fill(MELA.brass);
    this.counter.addChild(g);

    // Cash box (right) and brass bowl (left) on the counter's back edge.
    const box = new Graphics();
    const { x: bx, y: by } = this.cashBox;
    softShadow(box, bx, by + 30 * u, 70 * u, 10 * u, MELA.ink, 0.4);
    box.roundRect(bx - 62 * u, by - 26 * u, 124 * u, 56 * u, 6 * u).fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, lighten(MELA.woodDark, 0.25)],
        [1, MELA.woodDark],
      ]),
    );
    box.rect(bx - 62 * u, by - 26 * u, 124 * u, 9 * u).fill(MELA.brass);
    box.roundRect(bx - 18 * u, by - 22 * u, 36 * u, 5 * u, 2 * u).fill(MELA.ink);
    box.circle(bx, by + 6 * u, 7 * u).fill(MELA.brass);
    box.circle(bx, by + 6 * u, 2.5 * u).fill(MELA.ink);
    this.counter.addChild(box);
    const bowl = new Graphics();
    const { x: wx, y: wy } = this.bowl;
    softShadow(bowl, wx, wy + 24 * u, 60 * u, 9 * u, MELA.ink, 0.4);
    bowl
      .moveTo(wx - 56 * u, wy - 6 * u)
      .bezierCurveTo(wx - 50 * u, wy + 30 * u, wx + 50 * u, wy + 30 * u, wx + 56 * u, wy - 6 * u)
      .closePath()
      .fill(
        rgrad(
          [
            [0, 0xfff0b8],
            [0.6, MELA.brass],
            [1, darken(MELA.brass, 0.45)],
          ],
          { x: 0.35, y: 0.2 },
          0.85,
        ),
      );
    bowl.ellipse(wx, wy - 6 * u, 56 * u, 12 * u).fill(darken(MELA.brass, 0.5));
    bowl.ellipse(wx, wy - 6 * u, 56 * u, 12 * u).stroke({ width: 3 * u, color: MELA.brassLight });
    this.counter.addChild(bowl);

    // A clay diya at the far corner (glows more as the sun sets).
    const diya = new Graphics();
    const dx = this.g.portrait ? W * 0.5 : W * 0.97;
    const dy = this.g.portrait ? H - 30 * u : top + 40 * u;
    glowDisc(this.diyaGlow, dx, dy - 22 * u, 120 * u, 0xffa53d, 0.6);
    this.diyaGlow.blendMode = 'add';
    diya
      .moveTo(dx - 26 * u, dy - 10 * u)
      .quadraticCurveTo(dx, dy + 14 * u, dx + 26 * u, dy - 10 * u)
      .quadraticCurveTo(dx + 34 * u, dy - 16 * u, dx + 30 * u, dy - 12 * u)
      .closePath()
      .fill(MELA.terracotta);
    diya
      .moveTo(dx + 24 * u, dy - 16 * u)
      .quadraticCurveTo(dx + 34 * u, dy - 30 * u, dx + 26 * u, dy - 42 * u)
      .quadraticCurveTo(dx + 18 * u, dy - 28 * u, dx + 24 * u, dy - 16 * u)
      .fill(0xffc75a);
    if (!this.g.portrait) this.counter.addChild(this.diyaGlow, diya);
  }

  private buildCanopy(): void {
    const { width: W, height: H, u, portrait } = this.g;
    const beamY = 0;
    const clothH = (portrait ? 0.075 : 0.105) * H;
    const g = new Graphics();
    // Striped cloth awning with a scalloped hem.
    const stripes = Math.round(W / (64 * u));
    const sw = W / stripes;
    for (let i = 0; i < stripes; i++) {
      const col = i % 2 === 0 ? MELA.saffron : MELA.cream;
      g.rect(i * sw, beamY, sw + 1, clothH).fill(
        vgrad([
          [0, darken(col, 0.18)],
          [0.7, col],
          [1, lighten(col, 0.05)],
        ]),
      );
    }
    // Scallops (each stripe ends in a rounded tongue) and tassels.
    for (let i = 0; i < stripes; i++) {
      const col = i % 2 === 0 ? MELA.saffron : MELA.cream;
      g.moveTo(i * sw, clothH)
        .quadraticCurveTo(i * sw + sw / 2, clothH + 30 * u, (i + 1) * sw, clothH)
        .closePath()
        .fill(col);
      g.moveTo(i * sw + sw / 2, clothH + 22 * u)
        .lineTo(i * sw + sw / 2, clothH + 40 * u)
        .stroke({ width: 2 * u, color: MELA.vermilion });
      g.circle(i * sw + sw / 2, clothH + 44 * u, 5 * u).fill(i % 2 ? MELA.vermilion : MELA.peacock);
    }
    g.rect(0, clothH - 10 * u, W, 8 * u).fill(MELA.vermilion);
    for (let x = 6 * u; x < W; x += 22 * u)
      g.circle(x, clothH - 6 * u, 2.6 * u).fill(MELA.marigold);
    // Soft shadow the canopy casts on the scene.
    g.rect(0, clothH + 8 * u, W, 40 * u).fill(
      vgrad([
        [0, '#2b1b1733'],
        [1, '#2b1b1700'],
      ]),
    );
    // Carved beam.
    g.rect(0, beamY, W, 22 * u).fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, lighten(MELA.wood, 0.2)],
        [1, darken(MELA.wood, 0.3)],
      ]),
    );
    for (let x = 0; x < W; x += 40 * u)
      g.circle(x + 20 * u, beamY + 11 * u, 4 * u).fill(MELA.brass);
    this.canopy.addChild(g);

    // Marigold torans swagged between the pillars, with mango leaves.
    this.drawToran(clothH);
    this.canopy.addChild(this.toran);

    // Pillars at both edges.
    const p = new Graphics();
    const pw = (portrait ? 34 : 46) * u;
    for (const x of [pw * 0.5, W - pw * 0.5]) {
      p.rect(x - pw / 2, 0, pw, this.g.counterTop + 4 * u).fill(
        lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
          [0, darken(MELA.wood, 0.35)],
          [0.35, lighten(MELA.wood, 0.2)],
          [1, darken(MELA.wood, 0.45)],
        ]),
      );
      for (const fy of [0.18, 0.4, 0.62]) {
        const y = this.g.counterTop * fy + clothH;
        p.rect(x - pw / 2 - 3 * u, y, pw + 6 * u, 10 * u).fill(MELA.brass);
        p.rect(x - pw / 2, y + 12 * u, pw, 16 * u).fill(MELA.vermilion);
        for (let k = 0; k < 3; k++)
          p.circle(x - pw * 0.3 + k * pw * 0.3, y + 20 * u, 2.6 * u).fill(MELA.marigold);
      }
    }
    this.canopy.addChild(p);

    // Two swinging brass lanterns.
    const s = u * (portrait ? 1.05 : 1.15);
    for (const fx of portrait ? [0.2, 0.8] : [0.14, 0.86]) {
      const lamp = new SwingLamp((portrait ? 0.05 : 0.08) * H, s, fx * 7);
      lamp.view.position.set(W * fx, clothH - 4 * u);
      this.lamps.push(lamp);
      this.canopy.addChild(lamp.view);
    }
  }

  private drawToran(y0: number): void {
    const { width: W, u } = this.g;
    const t = this.toran;
    t.clear();
    const swags = this.g.portrait ? 3 : 4;
    const rnd = new ArtRandom(77);
    for (let i = 0; i < swags; i++) {
      const x1 = (W * i) / swags;
      const x2 = (W * (i + 1)) / swags;
      const pts = catenary(x1, y0 + 26 * u, x2, y0 + 26 * u, (this.g.portrait ? 40 : 62) * u, 16);
      for (const [k, q] of pts.entries()) {
        marigold(t, q.x, q.y, 9 * u, k % 3 === 0 ? MELA.marigoldDeep : MELA.marigold);
        if (k % 4 === 2) mangoLeaf(t, q.x, q.y + 6 * u, 20 * u, rnd.range(-0.2, 0.2), MELA.neem);
      }
    }
  }

  private buildShafts(): void {
    const { width: W, height: H } = this.g;
    const g = this.shaftG;
    g.clear();
    const shafts: [number, number][] = [
      [0.1, 0.14],
      [0.3, 0.07],
      [0.52, 0.11],
      [0.78, 0.06],
    ];
    for (const [fx, w] of shafts) {
      const x = W * fx;
      g.moveTo(x - W * 0.02, 0)
        .lineTo(x + W * w * 0.4, 0)
        .lineTo(x + W * (w + 0.18), H * 0.85)
        .lineTo(x + W * 0.12, H * 0.85)
        .closePath()
        .fill(
          lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
            [0, '#fff1c02e'],
            [0.55, '#ffd27a10'],
            [1, '#ffd27a00'],
          ]),
        );
    }
    g.blendMode = 'add';
    this.shafts.addChild(g);
  }

  /** Respond to the scene light (time of day). */
  applyPalette(p: ScenePalette): void {
    this.lights = p.lights;
    const tint = mixColor(p.lightTint, 0xffffff, 0.5);
    this.counter.tint = tint;
    this.canopy.tint = mixColor(p.lightTint, 0xffffff, 0.4);
    // Kept subtle: the backdrop already carries god rays, and stacked shafts wash the people out.
    this.shaftG.alpha =
      Math.max(0, Math.min(1, p.godrays * 0.65 + p.dust * 0.2)) * (1 - p.lights * 0.75);
    this.diyaGlow.alpha = 0.2 + p.lights * 0.8;
  }

  update(dt: number): void {
    this.t += dt;
    const motion = motionSettings.reducedMotion ? 0 : 1;
    for (const l of this.lamps) l.update(dt, this.lights, motion);
    this.toran.y = Math.sin(this.t * 0.7) * 2 * this.g.u * motion;
    this.diyaGlow.scale.set(1 + 0.03 * Math.sin(this.t * 9.7) * motion);
    if (motion) this.shafts.x = Math.sin(this.t * 0.08) * 20 * this.g.u;
  }

  destroy(): void {
    gsap.killTweensOf(this.toran);
    for (const c of [this.back, this.counter, this.canopy, this.shafts])
      c.destroy({ children: true });
  }
}
