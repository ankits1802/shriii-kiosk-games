/**
 * A fork in the road (rule-reversal trials). In the side view the cart travels screen-right, so its
 * LEFT branch climbs away into the distance (upper) and its RIGHT branch swings down towards the
 * viewer (lower). One branch mouth carries a lantern post, the other a whitewashed milestone: two
 * different shapes, so colour is never the only cue (KSK-06). Cues are hidden while the fork slides
 * in and appear together, instantly, on the onset frame (`reveal`). A dead-end hedge appears only as
 * feedback after a choice.
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Sprite } from 'pixi.js';
import { drawTuft } from '../../../art/backdrop/nature.ts';
import { darken, lighten } from '../../../art/color.ts';
import { softShadow, vgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { HandLantern } from '../../../art/props/index.ts';
import { ArtRandom } from '../../../art/rand.ts';
import type { Rect } from '../../../core/contracts.ts';
import type { Branch } from '../../../paradigms/reversal.ts';
import { type EpisodeArt, splitLit } from './art.ts';
import type { GroundMetrics } from './landscape.ts';

export type BranchCue = 'lantern' | 'milestone';

/** Flat road colour shared with the journey road band (no seam where the branches begin). */
export const ROAD_COLOR = 0xd8b886;

/** One coordinate of a cubic Bezier at `t`. */
function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Geometry of one branch in piece-local coordinates (x from the junction, y in stage px). */
interface BranchGeom {
  readonly startTop: number;
  readonly startBottom: number;
  readonly endX: number;
  readonly endTop: number;
  readonly endBottom: number;
  /** Where the cue stands. */
  readonly cue: { readonly x: number; readonly y: number; readonly scale: number };
  /** Where a dead end blocks the branch, and where the cart stops before it. */
  readonly hedge: { readonly x: number; readonly y: number; readonly scale: number };
  /** Cart offset and scale when it drives in. */
  readonly drive: { readonly dx: number; readonly dy: number; readonly scale: number };
}

export class ForkPiece {
  readonly view = new Container();
  private readonly cues = new Container();
  private readonly glows: Sprite[] = [];
  private readonly lanterns: HandLantern[] = [];
  private hedge: Container | null = null;
  /** Unlit art (takes the scene light). */
  readonly body: Container;
  private milestoneView: Container | null = null;
  readonly geom: Readonly<Record<Branch, BranchGeom>>;
  private t = 0;
  private readonly tick = (): void => {
    const dt = Math.min(0.05, this.art.ticker.deltaMS / 1000);
    this.t += dt;
    for (const l of this.lanterns) l.update(dt, this.art.motion);
    for (const [i, g] of this.glows.entries()) {
      g.alpha = 0.28 + 0.14 * Math.sin(this.t * 2.2 + i * 1.3) * this.art.motion;
    }
  };

  constructor(
    private readonly art: EpisodeArt,
    private readonly m: GroundMetrics,
    readonly lanternSide: Branch,
    seed: number,
  ) {
    this.view.label = 'fork';
    this.view.eventMode = 'none';
    const { w, h, unit: u } = art;
    const span = w * (art.portrait ? 0.62 : 0.6);
    this.geom = {
      left: {
        startTop: m.roadY - m.roadH * 0.55,
        startBottom: m.roadY - m.roadH * 0.02,
        endX: span,
        endTop: m.horizonY + h * 0.03,
        endBottom: m.horizonY + h * 0.03 + m.roadH * 0.32,
        cue: { x: 0, y: 0, scale: 0.8 },
        hedge: { x: span * 0.45, y: m.roadY - m.roadH * 1.85, scale: 0.75 },
        drive: { dx: span * 0.28, dy: -m.roadH * 1.15, scale: 0.8 },
      },
      right: {
        startTop: m.roadY + m.roadH * 0.02,
        startBottom: m.roadY + m.roadH * 0.45,
        endX: span * 1.05,
        endTop: h * 1.02,
        endBottom: h * 1.02 + m.roadH * 2.2,
        cue: { x: 0, y: 0, scale: 1.1 },
        hedge: { x: span * 0.46, y: h - m.roadH * 0.6, scale: 1.2 },
        drive: { dx: span * 0.3, dy: m.roadH * 1.25, scale: 1.12 },
      },
    };
    // Each cue stands on the OUTER verge of its own branch, a third of the way along: above the
    // far branch, below the near branch; nothing stands on the island between them.
    for (const b of ['left', 'right'] as const) {
      const g = this.geom[b];
      const t = 0.3;
      const x = cubic(0, g.endX * 0.45, g.endX * 0.6, g.endX, t);
      const edge =
        b === 'left'
          ? cubic(g.startTop, g.startTop, g.endTop, g.endTop, t) - 6 * u
          : cubic(g.startBottom, g.startBottom, g.endBottom, g.endBottom, t) + 70 * u;
      (g.cue as { x: number; y: number }).x = x;
      (g.cue as { x: number; y: number }).y = edge;
    }
    const ground = new Graphics();
    // The island between the branches covers the straight road beyond the junction.
    ground
      .moveTo(m.roadH * 1.2, m.roadY - m.roadH * 0.62)
      .lineTo(span * 1.12, m.roadY - m.roadH * 0.62)
      .lineTo(span * 1.12, m.roadY + m.roadH * 0.58)
      .lineTo(m.roadH * 1.2, m.roadY + m.roadH * 0.58)
      .closePath()
      .fill(0x86a056);
    for (const b of ['left', 'right'] as const) this.drawBranch(ground, this.geom[b]);
    // The island's rounded nose parts the road into the two branches.
    ground.ellipse(m.roadH * 1.6, m.roadY, m.roadH * 1.7, m.roadH * 0.2).fill(0x86a056);
    this.view.addChild(ground);
    const rnd = new ArtRandom(seed);
    // Island dressing: tufts, a boulder, a little tulsi bush.
    for (let i = 0; i < 9; i += 1) {
      const t = drawTuft((18 + rnd.range(0, 14)) * u, 1300 + i, rnd.chance(0.5));
      t.position.set(rnd.range(0.08, 0.5) * w, m.roadY + rnd.range(-0.3, 0.35) * m.roadH);
      this.view.addChild(t);
    }
    const rock = new Graphics();
    softShadow(rock, w * 0.34, m.roadY + m.roadH * 0.14, 34 * u, 7 * u, MELA.ink, 0.3);
    rock.ellipse(w * 0.34, m.roadY + m.roadH * 0.06, 30 * u, 18 * u).fill(0x8f8478);
    rock
      .ellipse(w * 0.33, m.roadY + m.roadH * 0.0, 16 * u, 8 * u)
      .fill({ color: 0xbdb2a2, alpha: 0.7 });
    this.view.addChild(rock);
    this.view.addChild(this.cues);
    this.cues.visible = false;
    this.cues.label = 'lit';
    for (const b of ['left', 'right'] as const) {
      const cue: BranchCue = b === lanternSide ? 'lantern' : 'milestone';
      const g = this.geom[b];
      const glow = art.glow(110 * u * g.cue.scale, 0xfff2c4, 0);
      glow.position.set(g.cue.x, g.cue.y - 30 * u * g.cue.scale);
      this.cues.addChild(glow);
      this.glows.push(glow);
      const post = cue === 'lantern' ? this.lanternPost(g.cue.scale) : this.milestone(g.cue.scale);
      post.position.set(g.cue.x, g.cue.y);
      this.cues.addChild(post);
    }
    this.body = splitLit(this.view);
    art.ticker.add(this.tick);
  }

  /** Scene light: tint the unlit art (the lantern carries its own light). */
  applyLight(tint: number): void {
    this.body.tint = tint;
    if (this.milestoneView) this.milestoneView.tint = tint;
  }

  private drawBranch(g: Graphics, b: BranchGeom): void {
    const midX = b.endX * 0.45;
    const x0 = -this.m.roadH * 1.6;
    g.moveTo(x0, b.startTop)
      .lineTo(0, b.startTop)
      .bezierCurveTo(midX, b.startTop, b.endX * 0.6, b.endTop, b.endX, b.endTop)
      .lineTo(b.endX, b.endBottom)
      .bezierCurveTo(b.endX * 0.6, b.endBottom, midX, b.startBottom, 0, b.startBottom)
      .lineTo(x0, b.startBottom)
      .closePath()
      .fill(ROAD_COLOR);
    // Wheel ruts.
    for (const k of [0.33, 0.7]) {
      const y0 = b.startTop + (b.startBottom - b.startTop) * k;
      const y1 = b.endTop + (b.endBottom - b.endTop) * k;
      g.moveTo(0, y0)
        .bezierCurveTo(midX, y0, b.endX * 0.6, y1, b.endX, y1)
        .stroke({ width: 2.4 * this.art.unit, color: 0x9c7c52, alpha: 0.5 });
    }
  }

  private lanternPost(scale: number): Container {
    const u = this.art.unit * scale;
    const c = new Container();
    const g = new Graphics();
    softShadow(g, 0, 0, 22 * u, 5 * u, MELA.ink, 0.35);
    g.rect(-5 * u, -230 * u, 10 * u, 230 * u).fill(
      vgrad([
        [0, 0xb08a52],
        [1, 0x7a5a2a],
      ]),
    );
    for (let k = 1; k < 7; k += 1) g.rect(-6 * u, -230 * u * (k / 7), 12 * u, 3 * u).fill(0x6a4a22);
    g.moveTo(0, -222 * u)
      .lineTo(58 * u, -222 * u)
      .stroke({ width: 5 * u, color: 0x6a4a22, cap: 'round' });
    g.moveTo(52 * u, -222 * u)
      .lineTo(52 * u, -214 * u)
      .stroke({ width: 2 * u, color: 0x3a2a1a });
    // Marigold garland on the post.
    for (let k = 0; k < 7; k += 1) {
      const a = (k / 6) * Math.PI;
      g.circle(Math.cos(a) * 12 * u, -170 * u + Math.sin(a) * 14 * u, 4.5 * u).fill(
        k % 2 ? MELA.marigold : MELA.saffron,
      );
    }
    c.addChild(g);
    const lantern = new HandLantern(1.15 * u);
    lantern.view.position.set(52 * u, -214 * u);
    const glow = this.art.glow(
      120 * u,
      this.art.lighting.palette.lights > 0.5 ? 0xffb04a : 0xffc46a,
      0.9,
    );
    lantern.setGlow(glow);
    lantern.setLit(1);
    c.addChild(lantern.view);
    this.lanterns.push(lantern);
    return c;
  }

  private milestone(scale: number): Container {
    const u = this.art.unit * scale;
    const c = new Container();
    const g = new Graphics();
    softShadow(g, 0, 0, 30 * u, 7 * u, MELA.ink, 0.35);
    // Whitewashed milestone with a saffron cap: a squat stone, unmistakably not a lantern.
    g.moveTo(-26 * u, 0)
      .lineTo(-24 * u, -58 * u)
      .quadraticCurveTo(0, -92 * u, 24 * u, -58 * u)
      .lineTo(26 * u, 0)
      .closePath()
      .fill(
        vgrad([
          [0, 0xfbf6ea],
          [1, 0xd8cfbe],
        ]),
      );
    g.moveTo(-24 * u, -58 * u)
      .quadraticCurveTo(0, -92 * u, 24 * u, -58 * u)
      .lineTo(22 * u, -50 * u)
      .quadraticCurveTo(0, -80 * u, -22 * u, -50 * u)
      .closePath()
      .fill(MELA.saffron);
    g.rect(-26 * u, -8 * u, 52 * u, 8 * u).fill(0xbfb4a0);
    // Three painted bands (pictured, no numerals).
    for (let k = 0; k < 3; k += 1)
      g.rect(-14 * u, (-40 + k * 9) * u, 28 * u, 3.4 * u).fill({ color: MELA.kumkum, alpha: 0.75 });
    c.addChild(g);
    this.milestoneView = c;
    return c;
  }

  /** Show both cues at once (onset frame). */
  reveal(): void {
    this.cues.visible = true;
  }

  /** Stage-space rectangles for the two branch targets, given the piece's screen x. */
  targets(screenX: number): Readonly<Record<Branch, Rect>> {
    const { w, h } = this.art;
    const m = this.m;
    const x0 = Math.max(screenX - 10 * this.art.unit, 0);
    const width = w - x0 - this.art.mm(6);
    return {
      left: {
        x: x0,
        y: m.horizonY - h * 0.1,
        width,
        height: m.roadY - m.roadH * 0.3 - (m.horizonY - h * 0.1),
      },
      right: {
        x: x0,
        y: m.roadY + m.roadH * 0.55,
        width,
        height: h - (m.roadY + m.roadH * 0.55) - this.art.mm(4),
      },
    };
  }

  /** Dead end: a thorn hedge and boulders close the chosen branch (feedback only). */
  showDeadEnd(branch: Branch): void {
    const g0 = this.geom[branch].hedge;
    const u = this.art.unit * g0.scale;
    const c = new Container();
    const g = new Graphics();
    softShadow(g, 0, 0, 120 * u, 14 * u, MELA.ink, 0.35);
    const rnd = new ArtRandom(`hedge.${branch}`);
    for (let i = 0; i < 11; i += 1) {
      const x = (i - 5) * 20 * u;
      const r = rnd.range(26, 40) * u;
      g.circle(x, -r * 0.8, r).fill(darken(0x4f6b34, rnd.range(0, 0.2)));
    }
    for (let i = 0; i < 26; i += 1) {
      const x = rnd.range(-110, 110) * u;
      const y = -rnd.range(10, 80) * u;
      g.moveTo(x, y)
        .lineTo(x + rnd.range(-12, 12) * u, y - 10 * u)
        .stroke({ width: 2 * u, color: 0x2f3a1f });
    }
    for (const x of [-70, 60]) {
      g.ellipse(x * u, -10 * u, 34 * u, 22 * u).fill(0x8a7f72);
      g.ellipse((x - 8) * u, -18 * u, 16 * u, 8 * u).fill({
        color: lighten(0x8a7f72, 0.3),
        alpha: 0.7,
      });
    }
    c.addChild(g);
    c.position.set(g0.x, g0.y);
    c.scale.set(0.2, 0.2);
    this.body.addChild(c);
    this.hedge = c;
    gsap.to(c.scale, { x: 1, y: 1, duration: 0.28, ease: 'back.out(2.2)' });
  }

  /** Piece-local point at the mouth of a branch (for sparkles). */
  mouth(branch: Branch): { x: number; y: number } {
    const g = this.geom[branch];
    return { x: g.endX * 0.32, y: (g.startTop + g.endTop) / 2 + (g.endBottom - g.endTop) * 0.4 };
  }

  destroy(): void {
    this.art.ticker.remove(this.tick);
    if (this.hedge) gsap.killTweensOf(this.hedge.scale);
    this.lanterns.length = 0;
    this.view.destroy({ children: true });
  }
}
