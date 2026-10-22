/**
 * Journey set pieces after the forks:
 * - {@link FodderStop}: the night halt by a campfire where the player and the partner share fodder
 *   in one trough (public-goods rounds). Quantities are pictured bundles of hay (never numerals);
 *   the trough's doubling and the equal split are shown as bundles popping in and flying back;
 * - {@link HillPiece}: a ghat slope the cart must be pushed up (hold-to-push effort beat);
 * - {@link CrossingPiece}: a stream with a sturdy arched bridge and a quick line of stepping stones
 *   (the cross-episode safe/risky probe);
 * - {@link HomePiece}: the courtyard at home under the stars (outro).
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Sprite } from 'pixi.js';
import { drawTuft, drawTulsi } from '../../../art/backdrop/nature.ts';
import { drawDiya } from '../../../art/backdrop/props.ts';
import { drawHouse, drawTemple } from '../../../art/backdrop/structures.ts';
import type { ProceduralCharacter } from '../../../art/characters/index.ts';
import { CHILD_VARIANT } from '../../../art/characters/index.ts';
import { darken, lighten } from '../../../art/color.ts';
import { rgrad, softShadow, vgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { ArtRandom } from '../../../art/rand.ts';
import type { Rect } from '../../../core/contracts.ts';
import type { Branch } from '../../../paradigms/reversal.ts';
import { type EpisodeArt, splitLit } from './art.ts';
import type { GroundMetrics } from './landscape.ts';

/** A tied sheaf of hay (one pictured fodder unit). Origin at the base centre. */
export function drawBundle(s: number, seed = 1): Container {
  const c = new Container();
  const g = new Graphics();
  const rnd = new ArtRandom(seed);
  softShadow(g, 0, 0, 24 * s, 5 * s, MELA.ink, 0.28);
  g.moveTo(-20 * s, 0)
    .quadraticCurveTo(-26 * s, -26 * s, -16 * s, -46 * s)
    .lineTo(16 * s, -46 * s)
    .quadraticCurveTo(26 * s, -26 * s, 20 * s, 0)
    .closePath()
    .fill(
      vgrad([
        [0, 0xf3d98c],
        [1, 0xc89a46],
      ]),
    );
  for (let i = 0; i < 12; i += 1) {
    const x = -16 * s + i * 2.9 * s;
    g.moveTo(x, -2 * s)
      .lineTo(x + rnd.range(-3, 3) * s, -50 * s - rnd.range(0, 6) * s)
      .stroke({ width: 1.3 * s, color: i % 2 ? 0xb0863a : 0xf6e2a4, alpha: 0.85 });
  }
  g.roundRect(-19 * s, -27 * s, 38 * s, 6 * s, 3 * s).fill(MELA.vermilion);
  g.roundRect(-19 * s, -26 * s, 38 * s, 2 * s, 1 * s).fill({ color: 0xffffff, alpha: 0.3 });
  c.addChild(g);
  return c;
}

/** Shared trough + both fodder piles by the campfire. */
export class FodderStop {
  readonly view = new Container();
  readonly playerPile = new Container();
  readonly partnerPile = new Container();
  readonly troughBundles = new Container();
  private readonly fire = new Graphics();
  private readonly fireGlow: Sprite;
  private readonly troughGlow: Sprite;
  private t = 0;
  private sparkT = 0;
  private playerBundles: Container[] = [];
  private partnerBundles: Container[] = [];
  private inTrough: Container[] = [];
  private readonly s: number;
  /** Unlit art (takes the scene light). */
  readonly body: Container;
  /** Piece-local positions. */
  readonly at: {
    readonly playerPile: { x: number; y: number };
    readonly partnerPile: { x: number; y: number };
    readonly trough: { x: number; y: number };
    readonly partner: { x: number; y: number };
    readonly fire: { x: number; y: number };
  };
  private readonly tick = (): void => {
    const dt = Math.min(0.05, this.art.ticker.deltaMS / 1000);
    this.t += dt;
    this.drawFire();
    this.sparkT -= dt;
    if (this.sparkT <= 0 && this.art.profile.particleScale > 0.2) {
      this.sparkT = 0.5;
      this.art.burst(
        this.view,
        'sparkle',
        { x: this.at.fire.x, y: this.at.fire.y - 40 * this.s },
        4,
        1600,
      );
    }
  };

  constructor(
    private readonly art: EpisodeArt,
    m: GroundMetrics,
    readonly endowment: number,
  ) {
    this.view.label = 'fodder-stop';
    this.view.eventMode = 'none';
    const { w, unit } = art;
    this.s = unit * (art.portrait ? 0.95 : 1);
    const s = this.s;
    const spread = w * (art.portrait ? 0.28 : 0.2);
    this.at = {
      playerPile: { x: -spread, y: m.roadY + m.roadH * 0.9 },
      partnerPile: { x: spread, y: m.roadY + m.roadH * 0.9 },
      trough: { x: 0, y: m.roadY + m.roadH * 1.0 },
      partner: { x: spread + 70 * s, y: m.roadY + m.roadH * 0.45 },
      fire: { x: -spread * 0.15, y: m.roadY - m.roadH * 0.85 },
    };
    const back = new Graphics();
    // Trampled clearing and a log bench by the fire.
    back
      .ellipse(0, m.roadY + m.roadH * 0.6, spread * 1.7, m.roadH * 1.5)
      .fill({ color: 0xc8a676, alpha: 0.55 });
    back
      .roundRect(this.at.fire.x + 70 * s, this.at.fire.y - 18 * s, 120 * s, 22 * s, 10 * s)
      .fill(MELA.wood);
    back
      .ellipse(this.at.fire.x + 70 * s, this.at.fire.y - 7 * s, 11 * s, 11 * s)
      .fill(lighten(MELA.wood, 0.25));
    // Fire pit stones.
    for (let k = 0; k < 9; k += 1) {
      const a = (k / 9) * Math.PI * 2;
      back
        .ellipse(
          this.at.fire.x + Math.cos(a) * 34 * s,
          this.at.fire.y + Math.sin(a) * 9 * s,
          10 * s,
          7 * s,
        )
        .fill(0x7d7468);
    }
    this.fireGlow = art.glow(260 * s, 0xff8a3a, 0.75);
    this.fireGlow.position.set(this.at.fire.x, this.at.fire.y - 30 * s);
    this.view.addChild(this.fireGlow, back, this.fire);
    // The shared trough (carved wood on legs).
    const tr = new Graphics();
    const tx = this.at.trough.x;
    const ty = this.at.trough.y;
    softShadow(tr, tx, ty + 4 * s, 130 * s, 12 * s, MELA.ink, 0.35);
    for (const lx of [-92, 82])
      tr.rect(tx + lx * s, ty - 28 * s, 10 * s, 30 * s).fill(MELA.woodDark);
    tr.moveTo(tx - 118 * s, ty - 70 * s)
      .lineTo(tx + 118 * s, ty - 70 * s)
      .lineTo(tx + 100 * s, ty - 24 * s)
      .lineTo(tx - 100 * s, ty - 24 * s)
      .closePath()
      .fill(
        vgrad([
          [0, lighten(MELA.wood, 0.2)],
          [1, darken(MELA.wood, 0.2)],
        ]),
      );
    tr.rect(tx - 118 * s, ty - 74 * s, 236 * s, 7 * s).fill(lighten(MELA.wood, 0.3));
    for (let k = -5; k <= 5; k += 1)
      tr.circle(tx + k * 18 * s, ty - 46 * s, 2.4 * s).fill(MELA.marigold);
    this.troughGlow = art.glow(200 * s, 0xfff0a0, 0);
    this.troughGlow.position.set(tx, ty - 60 * s);
    this.view.addChild(tr, this.troughGlow, this.troughBundles, this.playerPile, this.partnerPile);
    this.fire.label = 'lit';
    this.resetPiles();
    this.body = splitLit(this.view);
    art.ticker.add(this.tick);
  }

  private drawFire(): void {
    const s = this.s;
    const f = this.fire;
    const { x, y } = this.at.fire;
    const m = this.art.motion;
    f.clear();
    for (let i = 0; i < 4; i += 1) {
      f.moveTo(x + (-30 + i * 18) * s, y - 4 * s)
        .lineTo(x + (-10 + i * 12) * s, y - 14 * s)
        .stroke({ width: 6 * s, color: 0x4a2c1a, cap: 'round' });
    }
    const layers: readonly (readonly [number, number, number])[] = [
      [0xe8551e, 1, 0],
      [0xffa630, 0.75, 1.3],
      [0xfff1a8, 0.45, 2.1],
    ];
    for (const [col, k, ph] of layers) {
      const hgt = (60 + 10 * Math.sin(this.t * 9 + ph) * m) * k * s;
      const wid = 30 * k * s;
      f.moveTo(x - wid, y - 8 * s)
        .quadraticCurveTo(
          x - wid * 0.8,
          y - hgt * 0.6,
          x + Math.sin(this.t * 6 + ph) * 6 * s * m,
          y - hgt,
        )
        .quadraticCurveTo(x + wid * 0.8, y - hgt * 0.6, x + wid, y - 8 * s)
        .closePath()
        .fill(col);
    }
    this.fireGlow.alpha = 0.62 + 0.1 * Math.sin(this.t * 7) * m;
  }

  private pileLayout(
    i: number,
    n: number,
    base: { x: number; y: number },
  ): { x: number; y: number } {
    const s = this.s;
    const perRow = Math.max(3, Math.ceil(n / 2));
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const inRow = Math.min(perRow, n - row * perRow);
    return {
      x: base.x + (col - (inRow - 1) / 2) * 46 * s + row * 8 * s,
      y: base.y - row * 38 * s,
    };
  }

  private troughSlot(i: number): { x: number; y: number } {
    const s = this.s;
    const col = i % 7;
    const row = Math.floor(i / 7);
    return {
      x: this.at.trough.x + (col - 3) * 31 * s,
      y: this.at.trough.y - 60 * s - row * 16 * s,
    };
  }

  /** Full piles, empty trough (start of a round). */
  resetPiles(): void {
    for (const c of [...this.playerBundles, ...this.partnerBundles, ...this.inTrough]) {
      gsap.killTweensOf(c);
      c.destroy({ children: true });
    }
    this.playerBundles = [];
    this.partnerBundles = [];
    this.inTrough = [];
    const n = this.endowment;
    for (let i = 0; i < n; i += 1) {
      const b = drawBundle(this.s * 1.2, i + 1);
      const p = this.pileLayout(i, n, this.at.playerPile);
      b.position.set(p.x, p.y);
      this.playerPile.addChild(b);
      this.playerBundles.push(b);
      const q = drawBundle(this.s * 1.2, i + 40);
      const pp = this.pileLayout(i, n, this.at.partnerPile);
      q.position.set(pp.x, pp.y);
      this.partnerPile.addChild(q);
      this.partnerBundles.push(q);
    }
    this.troughGlow.alpha = 0;
  }

  private fly(
    b: Container,
    to: { x: number; y: number },
    dur: number,
    delay = 0,
    scale = 0.8,
  ): void {
    const parent = this.troughBundles;
    const g = b.getGlobalPosition();
    const local = parent.toLocal(g);
    parent.addChild(b);
    b.position.set(local.x, local.y);
    const peak = Math.min(local.y, to.y) - 90 * this.s;
    gsap
      .timeline({ delay })
      .to(b, { x: (local.x + to.x) / 2, y: peak, duration: dur * 0.5, ease: 'power2.out' })
      .to(b, { x: to.x, y: to.y, duration: dur * 0.5, ease: 'power2.in' })
      .to(b.scale, { x: scale * 1.15, y: scale * 0.85, duration: 0.06 }, '>-0.02')
      .to(b.scale, { x: scale, y: scale, duration: 0.18, ease: 'back.out(3)' });
  }

  /** Show `tokens` bundles in the trough (player taps move them one at a time). */
  setPlayerTokens(tokens: number): void {
    const inTroughPlayer = this.inTrough.length;
    if (tokens > inTroughPlayer) {
      for (let i = inTroughPlayer; i < tokens; i += 1) {
        const b = this.playerBundles.pop();
        if (!b) break;
        this.inTrough.push(b);
        this.fly(b, this.troughSlot(this.inTrough.length - 1), 0.32);
      }
    } else {
      for (let i = inTroughPlayer; i > tokens; i -= 1) {
        const b = this.inTrough.pop();
        if (!b) break;
        this.playerBundles.push(b);
        const p = this.pileLayout(
          this.playerBundles.length - 1,
          this.endowment,
          this.at.playerPile,
        );
        this.fly(b, { x: p.x, y: p.y }, 0.3, 0, 1);
      }
    }
  }

  /**
   * The reveal: the partner's bundles go in (or spill), the trough doubles, and the pot is split
   * equally back to both sides. `partner` is the partner character standing at the stop.
   */
  async reveal(
    partnerTokens: number,
    isError: boolean,
    returnEach: number,
    partner: ProceduralCharacter,
    totalMs: number,
  ): Promise<void> {
    const sec = totalMs / 1000;
    const s = this.s;
    const give = this.partnerBundles.splice(-Math.max(0, partnerTokens));
    if (isError) {
      partner.react('surprised', 0.8);
      void partner.play('shrug');
      // Bundles tumble short of the trough.
      const carry = this.partnerBundles.splice(
        -Math.max(1, Math.min(3, this.partnerBundles.length)),
      );
      carry.forEach((b, i) => {
        const to = { x: this.at.trough.x + (60 + i * 30) * s, y: this.at.trough.y + 30 * s };
        this.fly(b, to, sec * 0.3, i * 0.04, 0.9);
        gsap.to(b, { rotation: 1.4 + i * 0.3, duration: sec * 0.3, delay: i * 0.04 });
      });
    } else if (give.length > 0) {
      partner.setExpression('happy');
      void partner.play('hand_over');
    } else {
      partner.setExpression('neutral');
      void partner.play('fold_arms');
    }
    give.forEach((b, i) => {
      this.inTrough.push(b);
      this.fly(b, this.troughSlot(this.inTrough.length - 1), sec * 0.25, i * 0.05);
    });
    await wait(totalMs * 0.38);
    // Doubling: each bundle in the trough sprouts a twin.
    gsap.to(this.troughGlow, { alpha: 0.9, duration: sec * 0.15, yoyo: true, repeat: 1 });
    const twins: Container[] = [];
    const now = [...this.inTrough];
    now.forEach((b, i) => {
      const twin = drawBundle(this.s * 1.2, 80 + i);
      const slot = this.troughSlot(now.length + i);
      twin.position.set(slot.x, slot.y);
      twin.scale.set(0);
      this.troughBundles.addChild(twin);
      twins.push(twin);
      gsap.to(twin.scale, {
        x: 0.8,
        y: 0.8,
        duration: sec * 0.14,
        delay: i * 0.02,
        ease: 'back.out(3)',
      });
      void b;
    });
    if (now.length > 0)
      this.art.burst(
        this.view,
        'sparkle',
        { x: this.at.trough.x, y: this.at.trough.y - 70 * s },
        14,
        1500,
      );
    await wait(totalMs * 0.22);
    // Equal split: half to each side.
    const all = [...now, ...twins];
    const half = Math.min(returnEach, Math.floor(all.length / 2));
    all.forEach((b, i) => {
      const toPlayer = i < half;
      const toPartner = i >= half && i < half * 2;
      if (!toPlayer && !toPartner) return;
      const base = toPlayer ? this.at.playerPile : this.at.partnerPile;
      const j = toPlayer ? i : i - half;
      const p = this.pileLayout(j, Math.max(half, 1), { x: base.x, y: base.y + 40 * s });
      this.fly(b, p, sec * 0.3, (i % 6) * 0.03, 0.85);
    });
    partner.setExpression(isError ? 'thinking' : 'pleased');
    await wait(totalMs * 0.4);
  }

  /** Targets (stage px) given the piece's screen x. */
  targets(screenX: number): { pile: Rect; trough: Rect; confirm: Rect } {
    const s = this.s;
    const mm = (v: number): number => this.art.mm(v);
    const pw = Math.max(mm(30), 190 * s);
    const ph = Math.max(mm(26), 130 * s);
    const pile = {
      x: screenX + this.at.playerPile.x - pw / 2,
      y: this.at.playerPile.y - ph + 16 * s,
      width: pw,
      height: ph,
    };
    const tw = Math.max(mm(36), 250 * s);
    const th = Math.max(mm(24), 120 * s);
    const trough = {
      x: screenX + this.at.trough.x - tw / 2,
      y: this.at.trough.y - th + 4 * s,
      width: tw,
      height: th,
    };
    const c = Math.max(mm(22), 96 * s);
    const confirm = {
      x: Math.max(mm(4), pile.x - c - mm(12)),
      y: pile.y + ph / 2 - c / 2,
      width: c,
      height: c,
    };
    return { pile, trough, confirm };
  }

  destroy(): void {
    this.art.ticker.remove(this.tick);
    for (const c of [...this.playerBundles, ...this.partnerBundles, ...this.inTrough])
      gsap.killTweensOf(c);
    gsap.killTweensOf(this.troughGlow);
    this.view.destroy({ children: true });
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A ghat slope: road up to a crest with a tiny shrine, then down again. */
export class HillPiece {
  readonly view = new Container();
  readonly length: number;
  readonly rise: number;
  readonly angle: number;
  private readonly glow: Sprite;
  private t = 0;
  private active = false;
  /** Unlit art (takes the scene light). */
  readonly body: Container;
  private readonly tick = (): void => {
    this.t += Math.min(0.05, this.art.ticker.deltaMS / 1000);
    if (this.active) this.glow.alpha = 0.3 + 0.12 * Math.sin(this.t * 2.2) * this.art.motion;
  };

  constructor(
    private readonly art: EpisodeArt,
    m: GroundMetrics,
    seed: number,
  ) {
    this.view.label = 'hill';
    this.view.eventMode = 'none';
    const { w, h, unit: u } = art;
    this.length = w * (art.portrait ? 0.5 : 0.42);
    this.rise = h * (art.portrait ? 0.12 : 0.17);
    this.angle = Math.atan2(this.rise, this.length);
    const L = this.length;
    const R = this.rise;
    const top = m.roadY - m.roadH * 0.55;
    const g = new Graphics();
    // Hill body.
    g.moveTo(-40 * u, m.roadY + m.roadH)
      .lineTo(0, m.roadY + m.roadH * 0.45)
      .bezierCurveTo(L * 0.3, m.roadY - R * 0.1, L * 0.7, m.roadY - R * 0.95, L, m.roadY - R)
      .lineTo(L * 1.5, m.roadY - R)
      .bezierCurveTo(
        L * 1.8,
        m.roadY - R * 0.95,
        L * 2.1,
        m.roadY + m.roadH * 0.3,
        L * 2.4,
        m.roadY + m.roadH,
      )
      .closePath()
      .fill(
        vgrad([
          [0, 0x8aa45a],
          [1, 0x5f7c3c],
        ]),
      );
    // Road climbing over it.
    g.moveTo(0, top)
      .bezierCurveTo(L * 0.3, top - R * 0.1, L * 0.7, top - R * 0.95, L, top - R)
      .lineTo(L * 1.5, top - R)
      .bezierCurveTo(L * 1.8, top - R * 0.95, L * 2.1, top, L * 2.4, top)
      .lineTo(L * 2.4, top + m.roadH)
      .bezierCurveTo(
        L * 2.1,
        top + m.roadH,
        L * 1.8,
        top + m.roadH - R * 0.95,
        L * 1.5,
        top + m.roadH - R,
      )
      .lineTo(L, top + m.roadH - R)
      .bezierCurveTo(
        L * 0.7,
        top + m.roadH - R * 0.95,
        L * 0.3,
        top + m.roadH - R * 0.1,
        0,
        top + m.roadH,
      )
      .closePath()
      .fill(
        vgrad([
          [0, 0xe0c497],
          [1, 0xc09a6c],
        ]),
      );
    this.view.addChild(g);
    const rnd = new ArtRandom(seed);
    for (let i = 0; i < 12; i += 1) {
      const t = drawTuft((16 + rnd.range(0, 16)) * u, 1500 + i, rnd.chance(0.5));
      const x = rnd.range(0.05, 2.3) * L;
      const k = x < L ? x / L : x < 1.5 * L ? 1 : Math.max(0, 1 - (x - 1.5 * L) / (0.9 * L));
      t.position.set(x, m.roadY + m.roadH * 0.6 - R * k * 0.95);
      this.view.addChild(t);
    }
    // Crest shrine and a lone tree against the sky.
    const temple = drawTemple(h * 0.09);
    temple.view.position.set(L * 1.32, m.roadY - R - m.roadH * 0.5);
    this.view.addChild(temple.view);
    this.glow = art.glow(170 * u, 0xfff0c0, 0);
    this.view.addChild(this.glow);
    this.body = splitLit(this.view);
    art.ticker.add(this.tick);
    void w;
  }

  /** Cart displacement along the slope at progress 0..1 (piece-local). */
  /**
   * Cart pose at climb `progress` (0..1). The cart's origin sits `0.55 * frontX` before the hill's
   * foot (see the presenter's placement) and its hooves `0.8 * frontX` ahead of the wheels, so the
   * pose follows the drawn road: the wheel and hoof contact points both sit on the surface and the
   * tilt is the chord between them (no floating bullock on the curved slope).
   */
  along(progress: number, frontX: number): { dx: number; dy: number; rotation: number } {
    const p = Math.max(0, Math.min(1, progress));
    const dx = this.length * p;
    const wheel = dx - 0.55 * frontX;
    const span = 0.8 * frontX;
    const yw = this.surface(wheel);
    const yh = this.surface(wheel + span);
    return { dx, dy: yw, rotation: Math.atan2(yh - yw, span) };
  }

  /** Road surface offset (<= 0, px) above the flat road at hill-local `x`. */
  surface(x: number): number {
    const L = this.length;
    const R = this.rise;
    const bez = (
      x0: number,
      x1: number,
      x2: number,
      x3: number,
      y: readonly number[],
      xx: number,
    ) => {
      // Solve x(t) = xx by bisection (x is monotonic on each span), then evaluate y(t).
      let lo = 0;
      let hi = 1;
      const bx = (t: number): number => {
        const u = 1 - t;
        return u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
      };
      const rising = x3 > x0;
      for (let i = 0; i < 24; i += 1) {
        const mid = (lo + hi) / 2;
        if (bx(mid) < xx === rising) lo = mid;
        else hi = mid;
      }
      const t = (lo + hi) / 2;
      const u = 1 - t;
      const [y0, y1, y2, y3] = y as [number, number, number, number];
      return u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
    };
    if (x <= 0) return 0;
    if (x <= L) return bez(0, 0.3 * L, 0.7 * L, L, [0, -0.1 * R, -0.95 * R, -R], x);
    if (x <= 1.5 * L) return -R;
    if (x <= 2.4 * L) return bez(1.5 * L, 1.8 * L, 2.1 * L, 2.4 * L, [-R, -0.95 * R, 0, 0], x);
    return 0;
  }

  /** Show the touchable glow over the cart (stage position). */
  showPushGlow(x: number, y: number): void {
    this.active = true;
    this.glow.position.set(x - this.view.x, y);
  }

  hidePushGlow(): void {
    this.active = false;
    this.glow.alpha = 0;
  }

  destroy(): void {
    this.art.ticker.remove(this.tick);
    this.view.destroy({ children: true });
  }
}

/** The probe crossing: a stream with a sturdy arched bridge and a quick line of stepping stones. */
export class CrossingPiece {
  readonly view = new Container();
  private readonly options = new Container();
  private readonly glows: Sprite[] = [];
  private t = 0;
  /** Unlit art (takes the scene light). */
  readonly body: Container;
  private readonly tick = (): void => {
    this.t += Math.min(0.05, this.art.ticker.deltaMS / 1000);
    for (const [i, g] of this.glows.entries())
      g.alpha = 0.26 + 0.12 * Math.sin(this.t * 2.2 + i) * this.art.motion;
  };
  /** Branch geometry like a fork: left = upper/far, right = lower/near. */
  readonly drive: Readonly<Record<Branch, { dx: number; dy: number; scale: number }>>;

  constructor(
    private readonly art: EpisodeArt,
    private readonly m: GroundMetrics,
    readonly safeSide: Branch,
  ) {
    this.view.label = 'crossing';
    this.view.eventMode = 'none';
    const { w, h, unit: u } = art;
    const span = w * 0.55;
    this.drive = {
      left: { dx: span * 0.42, dy: -m.roadH * 1.3, scale: 0.8 },
      right: { dx: span * 0.42, dy: m.roadH * 1.3, scale: 1.12 },
    };
    const g = new Graphics();
    // Island and the two approaches (fork-like).
    g.rect(0, m.roadY - m.roadH * 0.62, span * 1.15, m.roadH * 1.2).fill(0x7f9a50);
    const up = {
      y0: m.roadY - m.roadH * 0.55,
      y1: m.roadY - m.roadH * 0.05,
      ey0: m.roadY - m.roadH * 1.9,
      ey1: m.roadY - m.roadH * 1.45,
    };
    const lo = {
      y0: m.roadY + m.roadH * 0.05,
      y1: m.roadY + m.roadH * 0.5,
      ey0: m.roadY + m.roadH * 1.2,
      ey1: m.roadY + m.roadH * 2.0,
    };
    for (const b of [up, lo]) {
      g.moveTo(0, b.y0)
        .bezierCurveTo(span * 0.2, b.y0, span * 0.25, b.ey0, span * 0.45, b.ey0)
        .lineTo(span * 1.3, b.ey0)
        .lineTo(span * 1.3, b.ey1)
        .lineTo(span * 0.45, b.ey1)
        .bezierCurveTo(span * 0.25, b.ey1, span * 0.2, b.y1, 0, b.y1)
        .closePath()
        .fill(
          vgrad([
            [0, 0xe0c497],
            [1, 0xc9a574],
          ]),
        );
    }
    // The stream flows towards the viewer across both approaches.
    const sx = span * 0.62;
    g.moveTo(sx - 30 * u, m.horizonY + 6)
      .bezierCurveTo(
        sx - 60 * u,
        m.roadY - m.roadH,
        sx - 120 * u,
        m.roadY + m.roadH,
        sx - 200 * u,
        h + 10,
      )
      .lineTo(sx + 140 * u, h + 10)
      .bezierCurveTo(
        sx + 60 * u,
        m.roadY + m.roadH,
        sx + 30 * u,
        m.roadY - m.roadH,
        sx + 20 * u,
        m.horizonY + 6,
      )
      .closePath()
      .fill(
        vgrad([
          [0, 0x5d7fa8],
          [1, 0x3a5a86],
        ]),
      );
    for (let i = 0; i < 14; i += 1) {
      const yy = m.horizonY + ((h - m.horizonY) * (i + 0.5)) / 14;
      const k = (yy - m.horizonY) / (h - m.horizonY);
      g.moveTo(sx - 20 * u - k * 120 * u, yy)
        .quadraticCurveTo(sx - k * 60 * u, yy - 4 * u, sx + 10 * u - k * 20 * u, yy)
        .stroke({ width: 1.6 * u, color: 0xbfe0ff, alpha: 0.45 });
    }
    this.view.addChild(g, this.options);
    const bridgeAt = safeSide === 'left' ? up : lo;
    const stonesAt = safeSide === 'left' ? lo : up;
    const bridgeScale = safeSide === 'left' ? 0.85 : 1.15;
    const stoneScale = safeSide === 'left' ? 1.15 : 0.85;
    this.options.addChild(this.bridge(sx, (bridgeAt.ey0 + bridgeAt.ey1) / 2, bridgeScale));
    this.options.addChild(this.stones(sx, (stonesAt.ey0 + stonesAt.ey1) / 2, stoneScale));
    for (const b of [up, lo]) {
      const gl = art.glow(130 * u, 0xfff0c0, 0);
      gl.position.set(sx, (b.ey0 + b.ey1) / 2 - 20 * u);
      this.view.addChildAt(gl, 1);
      this.glows.push(gl);
    }
    this.options.visible = false;
    this.body = splitLit(this.view);
    art.ticker.add(this.tick);
  }

  private bridge(x: number, y: number, scale: number): Container {
    const u = this.art.unit * scale;
    const c = new Container();
    const g = new Graphics();
    softShadow(g, 0, 8 * u, 150 * u, 10 * u, MELA.ink, 0.35);
    g.moveTo(-150 * u, 0)
      .quadraticCurveTo(0, -80 * u, 150 * u, 0)
      .lineTo(150 * u, 18 * u)
      .quadraticCurveTo(0, -56 * u, -150 * u, 18 * u)
      .closePath()
      .fill(
        vgrad([
          [0, 0xd9c2a0],
          [1, 0xa88f6c],
        ]),
      );
    g.moveTo(-60 * u, 18 * u)
      .quadraticCurveTo(0, -30 * u, 60 * u, 18 * u)
      .fill(0x2f4466);
    for (let k = -6; k <= 6; k += 1) {
      const px = k * 22 * u;
      const py = -40 * u * (1 - (px / (150 * u)) ** 2);
      g.rect(px - 3 * u, py - 26 * u, 6 * u, 26 * u).fill(0xc8b090);
    }
    g.moveTo(-150 * u, -22 * u)
      .quadraticCurveTo(0, -104 * u, 150 * u, -22 * u)
      .stroke({ width: 5 * u, color: 0xb89c78 });
    c.addChild(g);
    c.position.set(x, y);
    return c;
  }

  private stones(x: number, y: number, scale: number): Container {
    const u = this.art.unit * scale;
    const c = new Container();
    const g = new Graphics();
    for (let k = -3; k <= 3; k += 1) {
      const sx = k * 34 * u;
      const sy = Math.sin(k * 1.3) * 5 * u;
      g.ellipse(sx, sy + 6 * u, 18 * u, 6 * u).fill({ color: 0xffffff, alpha: 0.35 });
      g.ellipse(sx, sy, 15 * u, 9 * u).fill(0x8a8276);
      g.ellipse(sx - 4 * u, sy - 3 * u, 7 * u, 3.5 * u).fill({ color: 0xc4bcae, alpha: 0.8 });
    }
    c.addChild(g);
    c.position.set(x, y);
    return c;
  }

  reveal(): void {
    this.options.visible = true;
  }

  targets(screenX: number): Readonly<Record<Branch, Rect>> {
    const { w, h } = this.art;
    const m = this.m;
    const x0 = Math.max(0, screenX - 10 * this.art.unit);
    const width = w - x0 - this.art.mm(6);
    return {
      left: {
        x: x0,
        y: m.horizonY - h * 0.08,
        width,
        height: m.roadY - m.roadH * 0.3 - (m.horizonY - h * 0.08),
      },
      right: {
        x: x0,
        y: m.roadY + m.roadH * 0.55,
        width,
        height: h - (m.roadY + m.roadH * 0.55) - this.art.mm(4),
      },
    };
  }

  destroy(): void {
    this.art.ticker.remove(this.tick);
    this.view.destroy({ children: true });
  }
}

/** Home at last: courtyard, lamps, tulsi, rangoli and the family waiting under the stars. */
export class HomePiece {
  readonly view = new Container();
  readonly family: ProceduralCharacter[] = [];
  private readonly flames: Graphics[] = [];
  private t = 0;
  /** Unlit art (takes the scene light). */
  readonly body: Container;
  private readonly tick = (): void => {
    this.t += Math.min(0.05, this.art.ticker.deltaMS / 1000);
    this.flames.forEach((f, i) => {
      f.scale.y = 1 + 0.12 * Math.sin(this.t * 12 + i) * this.art.motion;
    });
  };

  constructor(
    private readonly art: EpisodeArt,
    m: GroundMetrics,
  ) {
    this.view.label = 'home';
    this.view.eventMode = 'none';
    const { h, unit: u } = art;
    const s = h * (art.portrait ? 0.24 : 0.36);
    const house = drawHouse(s, 4242);
    const hy = m.roadY - m.roadH * 0.6;
    const hx = art.w * (art.portrait ? 0.3 : 0.27);
    house.view.position.set(hx, hy);
    this.view.addChild(house.view);
    for (const l of house.lights) {
      const g = art.glow(l.r * 1.4, 0xffb04a, 0.95);
      g.position.set(hx + l.x, hy + l.y);
      this.view.addChild(g);
      const pane = new Graphics().rect(-s * 0.075, -s * 0.06, s * 0.15, s * 0.12).fill(0xffd27a);
      pane.label = 'lit';
      pane.position.set(hx + l.x, hy + l.y);
      this.view.addChild(pane);
    }
    const tulsi = drawTulsi(s * 0.28, 11);
    tulsi.position.set(hx - s * 0.62, m.roadY + m.roadH * 0.05);
    this.view.addChild(tulsi);
    // Rangoli at the threshold.
    const rg = new Graphics();
    const rx = hx;
    const ry = m.roadY + m.roadH * 0.2;
    for (let ring = 3; ring >= 1; ring -= 1) {
      rg.ellipse(rx, ry, ring * 26 * u, ring * 8 * u).stroke({
        width: 3 * u,
        color: [MELA.marigold, MELA.rose, 0xffffff][ring - 1] ?? 0xffffff,
      });
    }
    for (let k = 0; k < 12; k += 1) {
      const a = (k / 12) * Math.PI * 2;
      rg.circle(rx + Math.cos(a) * 60 * u, ry + Math.sin(a) * 18 * u, 4 * u).fill(MELA.vermilion);
    }
    this.view.addChild(rg);
    // A row of diyas along the courtyard edge.
    for (let i = 0; i < 7; i += 1) {
      const d = drawDiya(u * 0.9);
      const c = new Container();
      c.addChild(d.bowl, d.flame);
      const gl = art.glow(d.light.r * 0.9, 0xffa347, 0.9);
      gl.position.set(d.light.x, d.light.y);
      c.addChild(gl);
      c.position.set(hx - s * 0.66 + i * s * 0.22, m.roadY + m.roadH * 1.05);
      c.label = 'lit';
      this.view.addChild(c);
      this.flames.push(d.flame);
    }
    // Family waiting: grandmother and a child.
    const granny = art.character({
      id: 'road_home.granny',
      role: 'vendor',
      variant: 1,
      view: 'three_quarter',
      facing: 'left',
      scale: 0.56,
    });
    granny.view.position.set(art.w * 0.05, m.roadY + m.roadH * 0.42);
    const child = art.character({
      id: 'road_home.child',
      role: 'customer',
      variant: CHILD_VARIANT,
      view: 'three_quarter',
      facing: 'left',
      scale: 0.44,
    });
    child.view.position.set(art.w * 0.11, m.roadY + m.roadH * 0.55);
    this.view.addChild(granny.view, child.view);
    this.family.push(granny, child);
    const glow = new Graphics();
    glow.circle(hx, hy - s * 0.2, s * 1.2).fill(
      rgrad([
        [0, '#ffb04a33'],
        [1, '#ffb04a00'],
      ]),
    );
    this.view.addChildAt(glow, 0);
    this.body = splitLit(this.view);
    art.ticker.add(this.tick);
  }

  /** The family greets the cart. */
  greet(): void {
    const [granny, child] = this.family;
    granny?.setExpression('delighted');
    child?.setExpression('delighted');
    if (granny) void granny.play('wave');
    if (child) void child.play('celebrate');
  }

  destroy(): void {
    this.art.ticker.remove(this.tick);
    for (const f of this.family) f.destroy();
    this.view.destroy({ children: true });
  }
}
