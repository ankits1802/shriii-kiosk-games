/**
 * The hero brass beam scale (tarazu) of The Weighing Post: carved teak plinth, a ringed brass column
 * with a peacock finial, a beam on a knife-edge pivot, two deep brass pans hanging on three chains each,
 * and a fan-shaped dial with tick marks (no numerals, ENG-11) read by a long needle.
 *
 * Physics: the beam is an under-damped spring whose stiffness is derived from the level's
 * `needle_settle_ms`, so the needle visibly settles exactly when the response window may open (identical
 * at every frame rate and in every language). An ambiguous reading adds a slow, irregular wobble of about
 * half a tick that persists until {@link HeroScale.steady}. Pans swing as pendulums driven by the beam.
 * Units: one needle tick = {@link TICK_ANGLE} radians of beam tilt; positive = right (weights) pan down =
 * short weight.
 */
import { Container, Graphics, type Ticker } from 'pixi.js';
import { darken, lighten } from '../../../art/color.ts';
import { glowDisc, lgrad, rgrad, softShadow } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';

/** Beam tilt per needle tick (radians). */
export const TICK_ANGLE = 0.1;
/** Ticks drawn on each side of the dial's centre. */
export const DIAL_TICKS = 4;
/** Damping ratio of the beam spring (a little overshoot, then calm). */
const ZETA = 0.38;
/** Residual (fraction of the initial deflection) accepted at the settle time before the final ease. */
const SETTLE_LOG = 4.2;

class Pendulum {
  angle = 0;
  vel = 0;
  constructor(
    private readonly omega: number,
    private readonly damping: number,
  ) {}
  update(dt: number, drive: number): void {
    const acc = -this.omega * this.omega * Math.sin(this.angle) - this.damping * this.vel - drive;
    this.vel += acc * dt;
    this.angle += this.vel * dt;
    this.angle = Math.max(-0.6, Math.min(0.6, this.angle));
  }
}

export interface HeroScaleOptions {
  /** Height of the whole scale in local units before scaling (design height 520). */
  readonly reach?: number;
}

/** Ornate brass beam scale. Local origin: centre of the plinth's floor contact. */
export class HeroScale {
  readonly view = new Container();
  /** Goods go here (origin = centre of the left pan surface). */
  readonly leftLoad = new Container();
  /** Brass weights go here (origin = centre of the right pan surface). */
  readonly rightLoad = new Container();
  readonly reach: number;
  readonly pivotY: number;
  private readonly chainLen: number;
  private readonly beam = new Container();
  private readonly needle = new Graphics();
  private readonly chains = new Graphics();
  private readonly panL = new Container();
  private readonly panR = new Container();
  private readonly dialGlow = new Graphics();
  private angle = 0;
  private vel = 0;
  private target = 0;
  private omega = 8;
  private settleUntil = 0;
  private wobble = 0;
  private wobbleTarget = 0;
  private time = 0;
  private readonly swingL = new Pendulum(4.2, 1.6);
  private readonly swingR = new Pendulum(4.2, 1.6);
  private prev = { lx: 0, rx: 0, vl: 0, vr: 0 };
  private ticker: Ticker | null = null;
  private readonly tick = (t: Ticker): void => this.update(Math.min(0.05, t.deltaMS / 1000));
  private onSwing: ((speed: number) => void) | null = null;
  private lastSwingCue = 0;

  constructor(opts: HeroScaleOptions = {}) {
    this.reach = opts.reach ?? 190;
    this.pivotY = -372;
    this.chainLen = 150;
    this.view.label = 'hero-scale';
    const base = new Graphics();
    this.drawPlinth(base);
    const column = new Graphics();
    this.drawColumn(column);
    const dial = new Graphics();
    this.drawDial(dial);
    this.dialGlow.position.set(0, this.pivotY);
    this.beam.position.set(0, this.pivotY);
    const beamG = new Graphics();
    this.drawBeam(beamG);
    this.beam.addChild(beamG);
    for (const [pan, load] of [
      [this.panL, this.leftLoad],
      [this.panR, this.rightLoad],
    ] as const) {
      const back = new Graphics();
      const front = new Graphics();
      this.drawPan(back, front);
      load.position.set(0, -6);
      pan.addChild(back, load, front);
    }
    const crest = new Graphics();
    this.drawCrest(crest);
    this.view.addChild(
      base,
      column,
      this.dialGlow,
      dial,
      this.chains,
      this.panL,
      this.panR,
      this.needle,
      this.beam,
      crest,
    );
    this.layout(0);
  }

  /** Displayed balance in ticks (positive = short weight). */
  get ticks(): number {
    return (this.angle + this.wobble) / TICK_ANGLE;
  }

  /** True once the beam rests on its target (no wobble). */
  get isSettled(): boolean {
    return (
      Math.abs(this.angle - this.target) < 0.002 &&
      Math.abs(this.vel) < 0.01 &&
      this.wobbleTarget === 0 &&
      Math.abs(this.wobble) < 0.002
    );
  }

  /** Sound cue on large swings (creak), throttled by the caller's audio. */
  setSwingListener(listener: ((speed: number) => void) | null): void {
    this.onSwing = listener;
  }

  attach(ticker: Ticker): void {
    this.ticker?.remove(this.tick);
    this.ticker = ticker;
    ticker.add(this.tick);
  }

  /**
   * Swing to `ticks` and settle within `settleMs` (spring stiffness from the settle time). An ambiguous
   * reading keeps wobbling around the target until {@link steady}.
   */
  weigh(ticks: number, settleMs: number, ambiguous: boolean, kick = 0): void {
    const limit = (DIAL_TICKS + 0.4) * TICK_ANGLE;
    this.target = Math.max(-limit, Math.min(limit, ticks * TICK_ANGLE));
    const t = Math.max(0.25, settleMs / 1000);
    this.omega = SETTLE_LOG / (ZETA * t);
    this.settleUntil = this.time + t;
    this.vel += kick;
    this.wobbleTarget = ambiguous ? 0.55 * TICK_ANGLE : 0;
  }

  /** Stop the ambiguous wobble (after a re-weigh) and settle within `settleMs`. */
  steady(settleMs: number): void {
    this.wobbleTarget = 0;
    const t = Math.max(0.25, settleMs / 1000);
    this.omega = SETTLE_LOG / (ZETA * t);
    this.settleUntil = this.time + t;
  }

  /** Level the beam (pans emptied / lifted). */
  level(settleMs: number): void {
    this.weigh(0, settleMs, false);
  }

  /** Jump without motion (layout, reduced motion). */
  snap(ticks: number): void {
    this.target = ticks * TICK_ANGLE;
    this.angle = this.target;
    this.vel = 0;
    this.wobble = 0;
    this.wobbleTarget = 0;
    this.layout(0);
  }

  /** Brightness of the warm dial glow (0..1), e.g. while the needle is the stimulus. */
  setDialGlow(alpha: number): void {
    this.dialGlow.alpha = alpha;
  }

  /** Local position of the left pan surface (follows the swing). */
  panPosition(side: 'l' | 'r'): { x: number; y: number } {
    const p = side === 'l' ? this.panL : this.panR;
    return { x: p.x, y: p.y - 6 };
  }

  update(dt: number): void {
    const step = Math.max(0, Math.min(0.05, dt));
    this.time += step;
    let left = step;
    while (left > 1e-6) {
      const h = Math.min(1 / 240, left);
      left -= h;
      const w = this.omega;
      const acc = -w * w * (this.angle - this.target) - 2 * ZETA * w * this.vel;
      this.vel += acc * h;
      this.angle += this.vel * h;
    }
    // Final ease: at the settle time any residual is removed smoothly within ~80 ms.
    if (this.time >= this.settleUntil) {
      const k = 1 - Math.exp(-step / 0.035);
      this.angle += (this.target - this.angle) * k;
      this.vel *= 1 - k;
    }
    // Ambiguous wobble: two incommensurate slow sines with an eased amplitude.
    const amp = this.wobbleTarget;
    if (Math.abs(this.wobble) > 0 || amp > 0) {
      const raw =
        amp *
        (0.7 * Math.sin(this.time * 2 * Math.PI * 0.92) +
          0.45 * Math.sin(this.time * 2 * Math.PI * 1.73 + 1.3));
      const k = 1 - Math.exp(-step / (amp > 0 ? 0.25 : 0.06));
      this.wobble += (raw - this.wobble) * k;
      if (amp === 0 && Math.abs(this.wobble) < 0.0005) this.wobble = 0;
    }
    const speed = Math.abs(this.vel);
    if (this.onSwing && speed > 0.35 && this.time - this.lastSwingCue > 0.6) {
      this.lastSwingCue = this.time;
      this.onSwing(speed);
    }
    this.layout(step);
  }

  destroy(): void {
    this.ticker?.remove(this.tick);
    this.ticker = null;
    this.view.destroy({ children: true });
  }

  /* ------------------------------------------- drawing ------------------------------------------- */

  private layout(dt: number): void {
    const a = this.angle + this.wobble;
    this.beam.rotation = a;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const lx = -this.reach * c;
    const ly = this.pivotY - this.reach * s;
    const rx = this.reach * c;
    const ry = this.pivotY + this.reach * s;
    if (dt > 0) {
      const vl = (lx - this.prev.lx) / dt;
      const vr = (rx - this.prev.rx) / dt;
      this.swingL.update(dt, ((vl - this.prev.vl) / dt) * 0.004);
      this.swingR.update(dt, ((vr - this.prev.vr) / dt) * 0.004);
      this.prev = { lx, rx, vl, vr };
    }
    const ch = this.chains;
    ch.clear();
    for (const [x, y, sw, pan] of [
      [lx, ly, this.swingL.angle, this.panL],
      [rx, ry, this.swingR.angle, this.panR],
    ] as const) {
      const px = x + Math.sin(sw) * this.chainLen;
      const py = y + Math.cos(sw) * this.chainLen;
      pan.position.set(px, py);
      pan.rotation = sw * 0.5;
      const cos = Math.cos(sw * 0.5);
      const sin = Math.sin(sw * 0.5);
      for (const off of [-58, 0, 58]) {
        const ex = px + off * cos;
        const ey = py - 10 + off * sin;
        // Chain: a dark core with bright links.
        ch.moveTo(x, y + 8)
          .lineTo(ex, ey)
          .stroke({ width: 3.2, color: darken(MELA.brass, 0.45) });
        const n = 9;
        for (let i = 1; i < n; i++) {
          const t = i / n;
          ch.circle(x + (ex - x) * t, y + 8 + (ey - y - 8) * t, 1.7).fill(MELA.brassLight);
        }
      }
      ch.circle(x, y + 8, 7).fill(MELA.brass);
      ch.circle(x, y + 8, 3).fill(darken(MELA.brass, 0.4));
    }
    // Long needle from the pivot up over the dial.
    const n = this.needle;
    n.clear();
    const len = 206;
    const tipX = Math.sin(a) * len;
    const tipY = this.pivotY - Math.cos(a) * len;
    const bx = Math.sin(a + Math.PI / 2) * 7;
    const by = -Math.cos(a + Math.PI / 2) * 7;
    n.moveTo(-bx, this.pivotY - by)
      .lineTo(tipX, tipY)
      .lineTo(bx, this.pivotY + by)
      .closePath()
      .fill(MELA.ink);
    n.moveTo(0, this.pivotY)
      .lineTo(tipX * 0.98, this.pivotY + (tipY - this.pivotY) * 0.98)
      .stroke({ width: 1.2, color: lighten(MELA.ink, 0.35) });
    // Lotus-bud tip (vermilion) so the needle reads at a glance.
    n.circle(tipX, tipY, 9).fill(MELA.vermilion);
    n.circle(tipX, tipY, 9).stroke({ width: 2.5, color: darken(MELA.vermilion, 0.45) });
    n.circle(tipX - 2.5, tipY - 2.5, 2.8).fill({ color: 0xffffff, alpha: 0.7 });
    // Counterweight below the pivot.
    n.circle(-Math.sin(a) * 30, this.pivotY + Math.cos(a) * 30, 9).fill(MELA.brass);
  }

  private drawPlinth(g: Graphics): void {
    softShadow(g, 0, 0, 170, 22, MELA.ink, 0.42);
    const wood = MELA.wood;
    // Stepped teak plinth with carved panels.
    g.roundRect(-150, -34, 300, 34, 8).fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, lighten(wood, 0.22)],
        [0.5, wood],
        [1, darken(wood, 0.35)],
      ]),
    );
    g.roundRect(-118, -60, 236, 30, 6).fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, lighten(wood, 0.3)],
        [1, darken(wood, 0.15)],
      ]),
    );
    for (let i = -3; i <= 3; i++) {
      g.roundRect(i * 40 - 14, -28, 28, 22, 4).fill(darken(wood, 0.25));
      g.roundRect(i * 40 - 11, -25, 22, 16, 3).fill(lighten(wood, 0.05));
      g.circle(i * 40, -17, 3).fill(MELA.brass);
    }
    // Brass inlay strips.
    g.rect(-150, -36, 300, 4).fill(MELA.brass);
    g.rect(-118, -62, 236, 3).fill(MELA.brassLight);
    // Brass foot of the column.
    g.ellipse(0, -66, 52, 12).fill(darken(MELA.brass, 0.25));
    g.moveTo(-50, -66)
      .quadraticCurveTo(-30, -96, -18, -112)
      .lineTo(18, -112)
      .quadraticCurveTo(30, -96, 50, -66)
      .closePath()
      .fill(
        lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
          [0, darken(MELA.brass, 0.35)],
          [0.35, MELA.brassLight],
          [0.6, MELA.brass],
          [1, darken(MELA.brass, 0.45)],
        ]),
      );
  }

  private drawColumn(g: Graphics): void {
    const top = this.pivotY + 14;
    g.moveTo(-14, -110)
      .lineTo(-9, top)
      .lineTo(9, top)
      .lineTo(14, -110)
      .closePath()
      .fill(
        lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
          [0, darken(MELA.brass, 0.4)],
          [0.32, MELA.brassLight],
          [0.55, MELA.brass],
          [1, darken(MELA.brass, 0.5)],
        ]),
      );
    // Rings and a lotus collar.
    for (const y of [-140, -196, -252, -300]) {
      g.roundRect(-18, y, 36, 9, 4).fill(
        lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
          [0, darken(MELA.brass, 0.3)],
          [0.4, 0xfff0b8],
          [1, darken(MELA.brass, 0.35)],
        ]),
      );
    }
    for (let k = -3; k <= 3; k++) {
      const x = k * 7;
      g.ellipse(x, top + 8, 5, 11).fill(k % 2 === 0 ? MELA.brass : MELA.brassLight);
    }
  }

  private drawDial(g: Graphics): void {
    const y = this.pivotY;
    const r0 = 96;
    const r1 = 226;
    const half = (DIAL_TICKS + 0.55) * TICK_ANGLE;
    const a0 = -Math.PI / 2 - half;
    const a1 = -Math.PI / 2 + half;
    const sector = (ra: number, rb: number, from: number, to: number): Graphics => {
      g.moveTo(Math.cos(from) * ra, y + Math.sin(from) * ra);
      g.arc(0, y, rb, from, to);
      g.arc(0, y, ra, to, from, true);
      return g.closePath();
    };
    // Brass backing plate with a scalloped rim.
    sector(r0 - 10, r1 + 16, a0 - 0.03, a1 + 0.03).fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, 0xfff0b8],
        [0.5, MELA.brass],
        [1, darken(MELA.brass, 0.4)],
      ]),
    );
    for (let i = 0; i <= 18; i++) {
      const a = a0 + ((a1 - a0) * i) / 18;
      g.circle(Math.cos(a) * (r1 + 16), y + Math.sin(a) * (r1 + 16), 7).fill(MELA.brass);
      g.circle(Math.cos(a) * (r1 + 16), y + Math.sin(a) * (r1 + 16), 2.6).fill(
        darken(MELA.brass, 0.45),
      );
    }
    // Enamel cells between ticks: a calm teal band marks "balanced"; the cells alternate light and
    // deeper parchment so each step of the needle is easy to count by eye (no numerals).
    for (let k = -DIAL_TICKS; k <= DIAL_TICKS; k++) {
      const from = -Math.PI / 2 + (k - 0.5) * TICK_ANGLE;
      const to = -Math.PI / 2 + (k + 0.5) * TICK_ANGLE;
      const col = k === 0 ? MELA.peacockLight : Math.abs(k) % 2 === 1 ? MELA.cream : MELA.parchment;
      sector(r0, r1, Math.max(a0, from), Math.min(a1, to)).fill(col);
    }
    sector(r0, r1, a0, a1).stroke({ width: 4, color: darken(MELA.brass, 0.25) });
    // Bold ticks; the centre tick is tall with a lotus cap.
    for (let k = -DIAL_TICKS; k <= DIAL_TICKS; k++) {
      const a = -Math.PI / 2 + k * TICK_ANGLE;
      const centre = k === 0;
      const ri = centre ? r0 + 8 : r1 - 58;
      const ro = r1 - 4;
      g.moveTo(Math.cos(a) * ri, y + Math.sin(a) * ri)
        .lineTo(Math.cos(a) * ro, y + Math.sin(a) * ro)
        .stroke({
          width: centre ? 7 : 3.5,
          color: centre ? MELA.peacockDeep : MELA.woodDark,
          cap: 'round',
        });
    }
    const top = -Math.PI / 2;
    for (let p = -1; p <= 1; p++) {
      const a = top + p * 0.05;
      g.ellipse(Math.cos(a) * (r1 + 4), y + Math.sin(a) * (r1 + 4), 6, 12).fill(
        p === 0 ? MELA.lotus : lighten(MELA.lotus, 0.25),
      );
    }
    // Warm glow behind the dial (driven by setDialGlow).
    glowDisc(this.dialGlow, 0, -r1 * 0.72, r1 * 1.1, 0xffd27a, 0.55);
    this.dialGlow.alpha = 0;
  }

  private drawCrest(g: Graphics): void {
    const y = this.pivotY;
    g.circle(0, y, 16).fill(
      rgrad(
        [
          [0, 0xfff4c8],
          [0.6, MELA.brass],
          [1, darken(MELA.brass, 0.4)],
        ],
        { x: 0.4, y: 0.35 },
        0.8,
      ),
    );
    g.circle(0, y, 5).fill(MELA.ink);
    // Peacock finial above the dial.
    const fy = y - 284;
    g.moveTo(0, y - 244)
      .lineTo(0, fy + 14)
      .stroke({ width: 4, color: MELA.brass });
    g.ellipse(0, fy, 13, 19).fill(MELA.peacock);
    g.ellipse(0, fy - 2, 7, 10).fill(MELA.peacockLight);
    g.circle(0, fy - 3, 4).fill(MELA.lapis);
    g.circle(0, fy - 22, 7).fill(MELA.brass);
    for (const s of [-1, 1]) {
      g.moveTo(0, fy + 6)
        .quadraticCurveTo(s * 28, fy - 6, s * 22, fy - 26)
        .stroke({ width: 3, color: MELA.peacockDeep, cap: 'round' });
      g.circle(s * 22, fy - 26, 5).fill(MELA.peacock);
    }
  }

  private drawBeam(g: Graphics): void {
    const r = this.reach;
    g.moveTo(-r, -7)
      .quadraticCurveTo(0, -20, r, -7)
      .lineTo(r, 7)
      .quadraticCurveTo(0, 15, -r, 7)
      .closePath()
      .fill(
        lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
          [0, 0xfff0b8],
          [0.35, MELA.brassLight],
          [0.6, MELA.brass],
          [1, darken(MELA.brass, 0.45)],
        ]),
      );
    g.moveTo(-r, -7)
      .quadraticCurveTo(0, -20, r, -7)
      .stroke({ width: 1.6, color: 0xfff6d0, alpha: 0.8 });
    // Engraved vine along the beam.
    for (let i = -6; i <= 6; i++) {
      if (i === 0) continue;
      const x = (i / 7) * r;
      g.ellipse(x, 1, 7, 3).stroke({ width: 1.2, color: darken(MELA.brass, 0.35), alpha: 0.7 });
    }
    // Curled finials at both ends.
    for (const sx of [-1, 1]) {
      g.circle(sx * r, 0, 11).fill(MELA.brass);
      g.circle(sx * r, 0, 5).fill(darken(MELA.brass, 0.4));
      g.moveTo(sx * r, -10)
        .quadraticCurveTo(sx * (r + 24), -26, sx * (r + 20), -4)
        .quadraticCurveTo(sx * (r + 16), 6, sx * (r + 8), 2)
        .stroke({ width: 4, color: MELA.brass, cap: 'round' });
    }
  }

  private drawPan(back: Graphics, front: Graphics): void {
    const w = 96;
    back.ellipse(0, -8, w, 18).fill(darken(MELA.brass, 0.45));
    front
      .moveTo(-w, -8)
      .bezierCurveTo(-w * 0.9, 36, w * 0.9, 36, w, -8)
      .quadraticCurveTo(0, 8, -w, -8)
      .fill(
        rgrad(
          [
            [0, 0xfff0b8],
            [0.45, MELA.brassLight],
            [0.8, MELA.brass],
            [1, darken(MELA.brass, 0.45)],
          ],
          { x: 0.38, y: 0.2 },
          0.85,
        ),
      );
    front.ellipse(0, -8, w, 18).stroke({ width: 3.5, color: lighten(MELA.brass, 0.15) });
    front
      .moveTo(-w * 0.62, 12)
      .quadraticCurveTo(-w * 0.3, 24, -w * 0.05, 22)
      .stroke({
        width: 4,
        color: 0xffffff,
        alpha: 0.32,
        cap: 'round',
      });
    for (let i = -4; i <= 4; i++) {
      front.circle(i * (w / 5), 20 - Math.abs(i) * 2.4, 2).fill(darken(MELA.brass, 0.3));
    }
  }
}
