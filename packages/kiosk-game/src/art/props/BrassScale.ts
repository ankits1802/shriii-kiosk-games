/**
 * Brass weighing scale (tarazu) for The Weighing Post: an ornamented post, a beam on a knife-edge pivot,
 * two pans hanging on chains and a pointer that swings over a decorative arc (tick marks only, no
 * numerals; quantities are read from the needle and the pans, ENG-11).
 *
 * The beam follows its target balance as an under-damped spring (a little overshoot, then settles) and
 * the pans swing as pendulums driven by the beam's motion, so a load dropped into a pan reads naturally.
 */
import { Container, Graphics, type Ticker } from 'pixi.js';
import { Pendulum } from '../characters/rig/cloth.ts';
import { darken, lighten } from '../color.ts';
import { lgrad, rgrad, softShadow } from '../draw.ts';
import { MELA } from '../palettes.ts';

/** Balance in -1 (left pan down) .. 1 (right pan down) for two loads (saturating). */
export function balanceForWeights(left: number, right: number, sensitivity = 2.2): number {
  const total = Math.abs(left) + Math.abs(right);
  if (total <= 1e-9) return 0;
  return Math.tanh(((right - left) / total) * sensitivity);
}

export interface BrassScaleOptions {
  /** Beam half-length (rig units, default 74). */
  readonly reach?: number;
  /** Maximum beam tilt (radians, default 0.3). */
  readonly maxTilt?: number;
}

export class BrassScale {
  readonly view = new Container();
  /** Drop goods here (origin = centre of the pan surface). */
  readonly leftPan = new Container();
  readonly rightPan = new Container();
  private readonly beam = new Container();
  private readonly pointer = new Graphics();
  private readonly chains = new Graphics();
  private readonly panL = new Container();
  private readonly panR = new Container();
  private readonly reach: number;
  private readonly maxTilt: number;
  private readonly pivotY = -158;
  private readonly chainLen = 66;
  private angle = 0;
  private vel = 0;
  private target = 0;
  private readonly swingL = new Pendulum(66, 2.2);
  private readonly swingR = new Pendulum(66, 2.2);
  private prevEnds = { lx: 0, ly: 0, rx: 0, ry: 0, vl: 0, vr: 0 };
  private ticker: Ticker | null = null;
  private readonly tick = (t: Ticker): void => this.update(Math.min(0.1, t.deltaMS / 1000));
  private settleWaiters: (() => void)[] = [];

  constructor(opts: BrassScaleOptions = {}) {
    this.reach = opts.reach ?? 74;
    this.maxTilt = opts.maxTilt ?? 0.3;
    this.view.label = 'brass-scale';
    const base = new Graphics();
    this.drawStand(base);
    this.beam.position.set(0, this.pivotY);
    const beamG = new Graphics();
    this.drawBeam(beamG);
    this.beam.addChild(beamG);
    for (const [pan, sock] of [
      [this.panL, this.leftPan],
      [this.panR, this.rightPan],
    ] as const) {
      const g = new Graphics();
      this.drawPan(g);
      pan.addChild(g, sock);
      sock.position.set(0, -2);
    }
    const crest = new Graphics();
    this.drawCrest(crest);
    this.view.addChild(base, this.chains, this.panL, this.panR, this.pointer, this.beam, crest);
    this.layout(0);
  }

  /** Current balance (-1..1) as displayed. */
  get balance(): number {
    return this.angle / this.maxTilt;
  }

  /** Target balance (-1..1). `immediate` jumps without motion (layout, tests). */
  setBalance(balance: number, immediate = false): void {
    this.target = Math.max(-1, Math.min(1, balance)) * this.maxTilt;
    if (immediate) {
      this.angle = this.target;
      this.vel = 0;
      this.layout(0);
    }
  }

  /** Resolves when the beam has settled on its target. */
  settled(): Promise<void> {
    if (this.isSettled()) return Promise.resolve();
    return new Promise((r) => this.settleWaiters.push(r));
  }

  /** Drive the animation from a ticker (call once; `destroy` detaches). */
  attach(ticker: Ticker): void {
    this.ticker?.remove(this.tick);
    this.ticker = ticker;
    ticker.add(this.tick);
  }

  update(dt: number): void {
    const step = Math.max(0, Math.min(0.1, dt));
    let left = step;
    while (left > 0) {
      const h = Math.min(1 / 120, left);
      left -= h;
      const w = 7.5;
      const zeta = 0.32;
      const acc = -w * w * (this.angle - this.target) - 2 * zeta * w * this.vel;
      this.vel += acc * h;
      this.angle += this.vel * h;
    }
    this.layout(step);
    if (this.settleWaiters.length > 0 && this.isSettled()) {
      const ws = this.settleWaiters;
      this.settleWaiters = [];
      for (const r of ws) r();
    }
  }

  destroy(): void {
    this.ticker?.remove(this.tick);
    this.ticker = null;
    for (const r of this.settleWaiters) r();
    this.settleWaiters = [];
    this.view.destroy({ children: true });
  }

  private isSettled(): boolean {
    return Math.abs(this.angle - this.target) < 0.004 && Math.abs(this.vel) < 0.01;
  }

  private layout(dt: number): void {
    const a = this.angle;
    this.beam.rotation = a;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const lx = -this.reach * c;
    const ly = this.pivotY - this.reach * s;
    const rx = this.reach * c;
    const ry = this.pivotY + this.reach * s;
    if (dt > 0) {
      const vl = (lx - this.prevEnds.lx) / dt;
      const vr = (rx - this.prevEnds.rx) / dt;
      this.swingL.update(dt, (vl - this.prevEnds.vl) / dt + -this.vel * 40);
      this.swingR.update(dt, (vr - this.prevEnds.vr) / dt + -this.vel * 40);
      this.prevEnds = { lx, ly, rx, ry, vl, vr };
    } else {
      this.prevEnds = { lx, ly, rx, ry, vl: 0, vr: 0 };
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
      pan.rotation = sw * 0.6;
      for (const off of [-22, 0, 22]) {
        const ex = px + off * Math.cos(sw * 0.6);
        const ey = py - 3 + off * Math.sin(sw * 0.6);
        ch.moveTo(x, y + 4)
          .lineTo(ex, ey)
          .stroke({ width: 1.4, color: darken(MELA.brass, 0.35) });
      }
      ch.circle(x, y + 4, 3).fill(MELA.brass);
    }
    // Pointer swings with the beam over the arc.
    const p = this.pointer;
    p.clear();
    const len = 44;
    p.moveTo(0, this.pivotY)
      .lineTo(Math.sin(a) * len, this.pivotY - Math.cos(a) * len)
      .stroke({ width: 3, color: MELA.ink, cap: 'round' });
    p.circle(Math.sin(a) * len, this.pivotY - Math.cos(a) * len, 3).fill(MELA.vermilion);
  }

  private drawStand(g: Graphics): void {
    softShadow(g, 0, 0, 66, 9, MELA.ink, 0.35);
    const wood = MELA.wood;
    g.roundRect(-58, -16, 116, 16, 4).fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, lighten(wood, 0.15)],
        [1, darken(wood, 0.3)],
      ]),
    );
    g.roundRect(-44, -28, 88, 14, 4).fill(darken(wood, 0.1));
    g.moveTo(-8, -28)
      .lineTo(-5, this.pivotY + 6)
      .lineTo(5, this.pivotY + 6)
      .lineTo(8, -28)
      .closePath()
      .fill(
        lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
          [0, darken(MELA.brass, 0.25)],
          [0.4, MELA.brassLight],
          [1, darken(MELA.brass, 0.35)],
        ]),
      );
    for (const y of [-50, -95, -130]) g.roundRect(-9, y, 18, 6, 3).fill(MELA.brass);
  }

  private drawCrest(g: Graphics): void {
    const y = this.pivotY;
    // Decorative arc with tick marks (no numerals).
    g.moveTo(-34, y - 34)
      .quadraticCurveTo(0, y - 62, 34, y - 34)
      .stroke({ width: 3, color: MELA.brass });
    for (let k = -4; k <= 4; k++) {
      const a = (k / 4) * 0.62;
      const r0 = 46;
      const r1 = k === 0 ? 54 : 50;
      g.moveTo(Math.sin(a) * r0, y - Math.cos(a) * r0)
        .lineTo(Math.sin(a) * r1, y - Math.cos(a) * r1)
        .stroke({ width: k === 0 ? 2.6 : 1.6, color: darken(MELA.brass, 0.3) });
    }
    g.circle(0, y, 7).fill(
      rgrad(
        [
          [0, MELA.brassLight],
          [1, MELA.brass],
        ],
        { x: 0.4, y: 0.35 },
        0.8,
      ),
    );
    g.circle(0, y, 2.5).fill(MELA.ink);
    // Peacock finial.
    g.ellipse(0, y - 64, 6, 9).fill(MELA.peacock);
    g.circle(0, y - 74, 4).fill(MELA.brass);
  }

  private drawBeam(g: Graphics): void {
    const r = this.reach;
    g.moveTo(-r, -3)
      .quadraticCurveTo(0, -9, r, -3)
      .lineTo(r, 3)
      .quadraticCurveTo(0, 7, -r, 3)
      .closePath()
      .fill(
        lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
          [0, MELA.brassLight],
          [0.5, MELA.brass],
          [1, darken(MELA.brass, 0.35)],
        ]),
      );
    for (const sx of [-1, 1]) {
      g.circle(sx * r, 0, 5).fill(MELA.brass);
      g.circle(sx * r, 0, 2).fill(darken(MELA.brass, 0.4));
    }
  }

  private drawPan(g: Graphics): void {
    g.moveTo(-28, -2)
      .quadraticCurveTo(0, 18, 28, -2)
      .closePath()
      .fill(
        rgrad(
          [
            [0, MELA.brassLight],
            [0.6, MELA.brass],
            [1, darken(MELA.brass, 0.4)],
          ],
          { x: 0.4, y: 0.2 },
          0.8,
        ),
      );
    g.ellipse(0, -2, 28, 5).fill(darken(MELA.brass, 0.15));
    g.ellipse(0, -2, 28, 5).stroke({ width: 1.4, color: darken(MELA.brass, 0.4) });
    g.ellipse(-8, 4, 8, 2).fill({ color: 0xffffff, alpha: 0.35 });
  }
}
