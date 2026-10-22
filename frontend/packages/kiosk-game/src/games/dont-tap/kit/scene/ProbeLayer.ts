/**
 * The shared probe tray (see `../probe.ts`): a carved wooden chowki with a red cloth slides up over a
 * softly veiled scene; on it, a brass thali with a few laddoos (the sure treat) and a cloth-tied clay
 * handi with a dreamy bubble of ghosted laddoos above it (it may hold more). Identical in every module.
 * Pictured quantities only; no outcome is ever revealed.
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../../../art/color.ts';
import { rgba, rgrad, vgrad } from '../../../../art/draw.ts';
import { MELA } from '../../../../art/palettes.ts';
import type { ModuleContext, Rect } from '../../../../core/contracts.ts';
import { type ProbeChoice, type ProbeSituation, probeGeometry } from '../probe.ts';
import { contactShadow, type FxDeps, popRing, warmGlow } from './fx.ts';

/** One laddoo (besan sweet) centred at (x, y), radius r. */
export function drawLaddoo(g: Graphics, x: number, y: number, r: number, ghost = false): void {
  const a = ghost ? 0.38 : 1;
  g.circle(x, y, r).fill(
    rgrad(
      [
        [0, rgba(0xffd98a, a)],
        [0.55, rgba(0xf2a43a, a)],
        [1, rgba(0xc06a1c, a)],
      ],
      { x: 0.35, y: 0.3 },
      0.72,
    ),
  );
  if (!ghost) {
    // Grainy besan texture and a cashew-sliver highlight.
    for (let i = 0; i < 7; i += 1) {
      const ang = i * 2.4;
      const d = r * (0.25 + ((i * 37) % 10) / 22);
      g.circle(x + Math.cos(ang) * d, y + Math.sin(ang) * d, r * 0.07).fill({
        color: 0xa8561a,
        alpha: 0.55,
      });
    }
    g.ellipse(x - r * 0.32, y - r * 0.38, r * 0.26, r * 0.14).fill({
      color: 0xffffff,
      alpha: 0.45,
    });
  } else {
    g.circle(x, y, r).stroke({ width: Math.max(1.5, r * 0.08), color: 0xfff1c8, alpha: 0.55 });
  }
}

/** Positions of `n` laddoos piled in a pyramid around (cx, baseY). */
export function laddooPile(n: number, r: number): { x: number; y: number }[] {
  const rows: number[] =
    n <= 1 ? [1] : n === 2 ? [2] : n === 3 ? [2, 1] : n === 4 ? [3, 1] : [3, 2];
  const out: { x: number; y: number }[] = [];
  rows.forEach((count, row) => {
    for (let i = 0; i < count; i += 1) {
      out.push({ x: (i - (count - 1) / 2) * r * 1.9, y: -r - row * r * 1.55 });
    }
  });
  return out.slice(0, n);
}

export class ProbeLayer {
  readonly view = new Container();
  private readonly veil = new Graphics();
  private readonly tray = new Container();
  private readonly mats: [Container, Container];
  private readonly items = new Container();
  private safeItem: Container | null = null;
  private riskyItem: Container | null = null;
  private current: ProbeSituation | null = null;
  private readonly ctx: ModuleContext;
  private readonly fx: FxDeps;
  private readonly unit: number;

  constructor(ctx: ModuleContext, fx: FxDeps, unit: number) {
    this.ctx = ctx;
    this.fx = fx;
    this.unit = unit;
    const L = ctx.layout;
    this.view.label = 'probe-tray';
    this.view.visible = false;
    this.veil.rect(0, 0, L.width, L.height).fill({ color: MELA.indigoDeep, alpha: 0.42 });
    const g = probeGeometry(L);
    this.tray.addChild(this.buildChowki(g.left, g.right));
    this.mats = [this.buildMat(g.left), this.buildMat(g.right)];
    this.tray.addChild(this.mats[0], this.mats[1], this.items);
    this.view.addChild(this.veil, this.tray);
  }

  private buildChowki(left: Rect, right: Rect): Container {
    const c = new Container();
    const x0 = left.x - left.width * 0.28;
    const x1 = right.x + right.width * 1.28;
    const top = left.y + left.height * 0.62;
    const h = left.height * 0.2;
    const g = new Graphics();
    const shadow = contactShadow((x1 - x0) * 0.55, h * 0.9, 0.4);
    shadow.position.set((x0 + x1) / 2, top + h * 2.4);
    c.addChild(shadow);
    // Legs.
    for (const lx of [x0 + (x1 - x0) * 0.08, x1 - (x1 - x0) * 0.08]) {
      g.roundRect(lx - h * 0.28, top + h * 0.6, h * 0.56, h * 1.7, h * 0.16).fill(
        vgrad([
          [0, MELA.wood],
          [1, MELA.woodDark],
        ]),
      );
    }
    // Table top with carved apron.
    g.roundRect(x0, top, x1 - x0, h, h * 0.25).fill(
      vgrad([
        [0, lighten(MELA.wood, 0.25)],
        [1, MELA.wood],
      ]),
    );
    g.roundRect(x0 + h * 0.2, top + h * 0.75, x1 - x0 - h * 0.4, h * 0.55, h * 0.2).fill(
      MELA.woodDark,
    );
    for (let i = 0; i < 9; i += 1) {
      const cx = x0 + ((x1 - x0) * (i + 0.5)) / 9;
      g.circle(cx, top + h * 1.02, h * 0.13).fill({ color: MELA.brass, alpha: 0.85 });
    }
    // Red cloth runner with gold border.
    const cy = top - h * 0.05;
    g.roundRect(x0 + h * 0.3, cy - h * 0.25, x1 - x0 - h * 0.6, h * 0.5, h * 0.12).fill(
      MELA.kumkum,
    );
    g.roundRect(x0 + h * 0.3, cy - h * 0.25, x1 - x0 - h * 0.6, h * 0.5, h * 0.12).stroke({
      width: Math.max(2, h * 0.08),
      color: MELA.marigold,
    });
    c.addChild(g);
    return c;
  }

  private buildMat(r: Rect): Container {
    const c = new Container();
    const g = new Graphics();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height * 0.64;
    const rx = r.width * 0.46;
    const ry = r.height * 0.16;
    // Rangoli ring: petals around an ellipse (the touch zone cue, not colour alone: dotted border).
    g.ellipse(cx, cy, rx, ry).fill({ color: MELA.cream, alpha: 0.22 });
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * Math.PI * 2;
      g.circle(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, Math.max(2.5, rx * 0.035)).fill(
        i % 3 === 0 ? MELA.marigold : MELA.cream,
      );
    }
    c.addChild(g);
    return c;
  }

  private buildThali(n: number, r: Rect): Container {
    const c = new Container();
    const u = r.width / 300;
    const g = new Graphics();
    c.addChild(Object.assign(contactShadow(110 * u, 22 * u, 0.35), { y: 6 * u }));
    g.ellipse(0, 0, 112 * u, 30 * u).fill(
      rgrad(
        [
          [0, MELA.brassLight],
          [0.75, MELA.brass],
          [1, 0x8a5c16],
        ],
        { x: 0.4, y: 0.3 },
        0.8,
      ),
    );
    g.ellipse(0, -3 * u, 90 * u, 21 * u).fill({ color: lighten(MELA.brass, 0.18) });
    g.ellipse(-30 * u, -9 * u, 34 * u, 6 * u).fill({ color: 0xffffff, alpha: 0.3 });
    const lr = 30 * u;
    for (const p of laddooPile(n, lr)) drawLaddoo(g, p.x, p.y - 6 * u, lr);
    c.addChild(g);
    return c;
  }

  private buildHandi(n: number, r: Rect): Container {
    const c = new Container();
    const u = r.width / 300;
    const g = new Graphics();
    c.addChild(Object.assign(contactShadow(80 * u, 18 * u, 0.38), { y: 4 * u }));
    // Pot body.
    g.ellipse(0, -62 * u, 78 * u, 64 * u).fill(
      rgrad(
        [
          [0, lighten(MELA.terracotta, 0.3)],
          [0.6, MELA.terracotta],
          [1, darken(MELA.terracotta, 0.4)],
        ],
        { x: 0.36, y: 0.3 },
        0.75,
      ),
    );
    // Painted band (pattern so the pot is not identified by colour alone).
    g.ellipse(0, -66 * u, 74 * u, 14 * u).stroke({ width: 5 * u, color: MELA.cream, alpha: 0.85 });
    for (let i = -3; i <= 3; i += 1) g.circle(i * 19 * u, -52 * u, 4 * u).fill(MELA.cream);
    // Neck and cloth lid tied with string.
    g.roundRect(-40 * u, -132 * u, 80 * u, 22 * u, 8 * u).fill(darken(MELA.terracotta, 0.15));
    g.moveTo(-56 * u, -128 * u)
      .bezierCurveTo(-40 * u, -168 * u, 40 * u, -168 * u, 56 * u, -128 * u)
      .lineTo(42 * u, -118 * u)
      .lineTo(-42 * u, -118 * u)
      .closePath()
      .fill(MELA.kumkum);
    g.moveTo(-46 * u, -124 * u)
      .lineTo(46 * u, -124 * u)
      .stroke({ width: 4 * u, color: MELA.marigold });
    g.circle(0, -124 * u, 6 * u).fill(MELA.marigold);
    g.ellipse(-28 * u, -86 * u, 18 * u, 26 * u).fill({ color: 0xffffff, alpha: 0.16 });
    c.addChild(g);
    // Dream bubble of ghosted laddoos (it may hold this many).
    const b = new Graphics();
    const by = -228 * u;
    const br = 74 * u;
    for (const [dx, dy, rr] of [
      [-60, 32, 0.32],
      [-26, 8, 0.6],
      [30, 6, 0.62],
      [64, 30, 0.34],
      [0, -20, 0.8],
    ] as const) {
      b.circle(dx * u, by + dy * u, br * rr).fill({ color: 0xfff6e0, alpha: 0.88 });
    }
    b.circle(-34 * u, -168 * u, 9 * u).fill({ color: 0xfff6e0, alpha: 0.85 });
    b.circle(-22 * u, -150 * u, 5.5 * u).fill({ color: 0xfff6e0, alpha: 0.8 });
    const lr = 22 * u;
    for (const p of laddooPile(n, lr)) drawLaddoo(b, p.x, by + 22 * u + p.y + lr * 0.4, lr, true);
    c.addChild(b);
    return c;
  }

  /** Slide the tray up (between the module task and the probes). */
  async enter(reducedMotion: boolean): Promise<void> {
    const L = this.ctx.layout;
    this.view.visible = true;
    for (const c of this.items.removeChildren()) c.destroy({ children: true });
    this.veil.alpha = 0;
    this.tray.y = reducedMotion ? 0 : L.height * 0.5;
    this.tray.alpha = reducedMotion ? 0 : 1;
    this.ctx.audio.playSfx('whoosh', { volume: 0.4 });
    await Promise.all([
      to(this.veil, { alpha: 1, duration: reducedMotion ? 0.2 : 0.45 }),
      reducedMotion
        ? to(this.tray, { alpha: 1, duration: 0.2 })
        : to(this.tray, { y: 0, duration: 0.6, ease: 'back.out(1.2)' }),
    ]);
  }

  /** Place a situation synchronously (stimulus commit). */
  show(s: ProbeSituation): void {
    for (const c of this.items.removeChildren()) c.destroy({ children: true });
    const g = probeGeometry(this.ctx.layout);
    const safeRect = s.safeSide === 'left' ? g.left : g.right;
    const riskyRect = s.safeSide === 'left' ? g.right : g.left;
    const thali = this.buildThali(s.safeAmount, safeRect);
    thali.position.set(safeRect.x + safeRect.width / 2, safeRect.y + safeRect.height * 0.62);
    const handi = this.buildHandi(s.riskyAmount, riskyRect);
    handi.position.set(riskyRect.x + riskyRect.width / 2, riskyRect.y + riskyRect.height * 0.66);
    this.items.addChild(thali, handi);
    this.safeItem = thali;
    this.riskyItem = handi;
    this.current = s;
  }

  /** Acknowledge a choice: the chosen item lifts with a warm glow, the other rests dimmed. */
  async chosen(choice: ProbeChoice | null, reducedMotion: boolean): Promise<void> {
    const s = this.current;
    const safe = this.safeItem;
    const risky = this.riskyItem;
    if (!s || !safe || !risky) return;
    if (choice === null) {
      await Promise.all([
        to(safe, { alpha: 0.5, duration: 0.2 }),
        to(risky, { alpha: 0.5, duration: 0.2 }),
      ]);
      return;
    }
    const picked = choice === 'safe' ? safe : risky;
    const other = choice === 'safe' ? risky : safe;
    this.ctx.audio.playSfx('tap_soft', { volume: 0.7 });
    warmGlow(this.items, this.fx, { x: picked.x, y: picked.y - 60 * this.unit }, 150 * this.unit);
    popRing(
      this.items,
      { x: picked.x, y: picked.y - 40 * this.unit },
      110 * this.unit,
      MELA.marigold,
      reducedMotion,
    );
    await Promise.all([
      reducedMotion
        ? Promise.resolve()
        : to(picked, { y: picked.y - 18 * this.unit, duration: 0.18, ease: 'power2.out' }),
      to(other, { alpha: 0.4, duration: 0.2 }),
    ]);
  }

  async exit(reducedMotion: boolean): Promise<void> {
    const L = this.ctx.layout;
    await Promise.all([
      to(this.veil, { alpha: 0, duration: reducedMotion ? 0.2 : 0.4 }),
      reducedMotion
        ? to(this.tray, { alpha: 0, duration: 0.2 })
        : to(this.tray, { y: L.height * 0.5, duration: 0.45, ease: 'power2.in' }),
    ]);
    this.view.visible = false;
  }

  destroy(): void {
    gsap.killTweensOf(this.veil);
    gsap.killTweensOf(this.tray);
    this.view.destroy({ children: true });
  }
}

function to(target: object, vars: gsap.TweenVars): Promise<void> {
  return new Promise((resolve) => {
    gsap.to(target, { ...vars, onComplete: () => resolve(), onInterrupt: () => resolve() });
  });
}
