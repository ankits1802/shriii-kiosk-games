/**
 * The market-rule placard: a carved board hanging from the canopy that pictures the current weighing
 * rule without words or numerals. Each row shows a small dial whose highlighted wedge marks the needle
 * positions that call for the stamp drawn beside it. When the new market rule is announced the board
 * turns over to the new rule (the context shift is visible as well as spoken).
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../../art/color.ts';
import { lgrad, marigold, softShadow } from '../../../art/draw.ts';
import { motionSettings } from '../../../art/motion.ts';
import { MELA } from '../../../art/palettes.ts';
import {
  correctDecision,
  type WeighDecision,
  type WeighRule,
} from '../../../paradigms/weighing-post.ts';
import { ChoiceToken } from './tokens.ts';

const MINI_TICKS = 3;
const MINI_TICK = 0.26;

/** Ticks (declared - true) in -MINI_TICKS..MINI_TICKS that the rule maps to `decision`. */
export function ticksFor(rule: WeighRule, decision: WeighDecision): number[] {
  const out: number[] = [];
  for (let d = -MINI_TICKS; d <= MINI_TICKS; d++) {
    if (correctDecision({ trueWeight: 10, declaredWeight: 10 + d }, rule) === decision) out.push(d);
  }
  return out;
}

function miniDial(g: Graphics, cx: number, cy: number, r: number, ticks: readonly number[]): void {
  const half = (MINI_TICKS + 0.5) * MINI_TICK;
  const a0 = -Math.PI / 2 - half;
  const a1 = -Math.PI / 2 + half;
  g.moveTo(cx, cy)
    .arc(cx, cy, r, a0, a1)
    .closePath()
    .fill(MELA.parchment)
    .stroke({ width: 2.5, color: MELA.brass });
  // Highlighted wedge cells (filled and hatched: readable without colour).
  for (const k of ticks) {
    const c0 = -Math.PI / 2 + (k - 0.5) * MINI_TICK;
    const c1 = -Math.PI / 2 + (k + 0.5) * MINI_TICK;
    g.moveTo(cx, cy)
      .arc(cx, cy, r * 0.96, c0, c1)
      .closePath()
      .fill({ color: MELA.marigold, alpha: 0.9 });
    for (let h = 0.35; h < 0.95; h += 0.18) {
      const a = (c0 + c1) / 2;
      g.moveTo(cx + Math.cos(c0) * r * h, cy + Math.sin(c0) * r * h)
        .lineTo(cx + Math.cos(a) * r * (h + 0.1), cy + Math.sin(a) * r * (h + 0.1))
        .stroke({ width: 1.2, color: darken(MELA.marigold, 0.45), alpha: 0.6 });
    }
  }
  for (let k = -MINI_TICKS; k <= MINI_TICKS; k++) {
    const a = -Math.PI / 2 + k * MINI_TICK;
    g.moveTo(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62)
      .lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95)
      .stroke({ width: k === 0 ? 3 : 1.6, color: k === 0 ? MELA.peacockDeep : MELA.ink });
  }
  // Needle into the middle of the wedge.
  const mid = ticks.length ? (ticks[0] ?? 0) + ((ticks.at(-1) ?? 0) - (ticks[0] ?? 0)) / 2 : 0;
  const a = -Math.PI / 2 + Math.max(-MINI_TICKS, Math.min(MINI_TICKS, mid)) * MINI_TICK;
  g.moveTo(cx, cy)
    .lineTo(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86)
    .stroke({ width: 3, color: MELA.ink, cap: 'round' });
  g.circle(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86, 3.5).fill(MELA.vermilion);
  g.circle(cx, cy, 4).fill(MELA.brass);
}

export class RulePlacard {
  readonly view = new Container();
  private readonly board = new Container();
  private readonly content = new Container();
  private readonly glow = new Graphics();
  private swing: gsap.core.Tween | null = null;
  private tl: gsap.core.Timeline | null = null;

  constructor(rule: WeighRule) {
    this.view.label = 'rule-placard';
    this.view.eventMode = 'none';
    const ropes = new Graphics();
    for (const x of [-92, 92]) {
      ropes
        .moveTo(x * 0.6, -330)
        .lineTo(x, -150)
        .stroke({ width: 3, color: 0x8a6a3a });
    }
    const g = new Graphics();
    softShadow(g, 8, 182, 120, 14, MELA.ink, 0.35);
    g.roundRect(-118, -158, 236, 340, 18).fill(darken(MELA.wood, 0.25));
    g.roundRect(-110, -150, 220, 324, 14).fill(
      lgrad({ x: 0, y: 0 }, { x: 1, y: 1 }, [
        [0, lighten(MELA.wood, 0.35)],
        [0.5, lighten(MELA.wood, 0.18)],
        [1, MELA.wood],
      ]),
    );
    for (let i = 0; i < 9; i++) {
      const y = -140 + i * 36;
      g.moveTo(-104, y)
        .quadraticCurveTo(0, y + 6, 104, y)
        .stroke({ width: 1, color: darken(MELA.wood, 0.25), alpha: 0.35 });
    }
    // Marigold corners and a brass header with a scale emblem (pictured, no words).
    for (const [x, y] of [
      [-98, -138],
      [98, -138],
      [-98, 162],
      [98, 162],
    ] as const)
      marigold(g, x, y, 10, MELA.marigold);
    g.roundRect(-60, -146, 120, 30, 10).fill(MELA.brass);
    g.moveTo(-36, -128).lineTo(36, -128).stroke({ width: 3, color: MELA.ink });
    g.moveTo(0, -140).lineTo(0, -122).stroke({ width: 3, color: MELA.ink });
    for (const sx of [-1, 1])
      g.moveTo(sx * 36, -128)
        .quadraticCurveTo(sx * 30, -118, sx * 24, -128)
        .fill(MELA.ink);
    this.glow.roundRect(-126, -166, 252, 356, 22).fill({ color: 0xffe08a, alpha: 0.5 });
    this.glow.alpha = 0;
    this.glow.blendMode = 'add';
    this.board.addChild(this.glow, g, this.content);
    this.view.addChild(ropes, this.board);
    this.drawRule(rule);
    if (!motionSettings.reducedMotion) {
      this.board.rotation = -0.02;
      this.swing = gsap.to(this.board, {
        rotation: 0.02,
        duration: 2.6,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inOut',
      });
    }
  }

  private drawRule(rule: WeighRule): void {
    for (const ch of this.content.removeChildren()) ch.destroy({ children: true });
    const rows: { decision: WeighDecision; ticks: number[] }[] = (
      ['approve', 'warn', 'fine'] as const
    )
      .map((d) => ({ decision: d, ticks: ticksFor(rule, d) }))
      .filter((r) => r.ticks.length > 0);
    const gap = 96;
    const y0 = 10 - ((rows.length - 1) * gap) / 2 + 12;
    rows.forEach((row, i) => {
      const y = y0 + i * gap;
      const g = new Graphics();
      miniDial(g, -44, y + 24, 46, row.ticks);
      g.moveTo(14, y).lineTo(30, y).stroke({ width: 3, color: MELA.ink, cap: 'round' });
      g.moveTo(24, y - 6)
        .lineTo(31, y)
        .lineTo(24, y + 6)
        .stroke({ width: 3, color: MELA.ink, cap: 'round', join: 'round' });
      const t = new ChoiceToken('weigh', row.decision, 64);
      t.view.position.set(66, y);
      this.content.addChild(g, t.view);
    });
  }

  /** Turn the board over to show a new rule (with a warm glow). */
  turnTo(rule: WeighRule): void {
    if (motionSettings.reducedMotion) {
      this.drawRule(rule);
      this.glow.alpha = 0.8;
      gsap.to(this.glow, { alpha: 0, duration: 1.6, delay: 0.6 });
      return;
    }
    this.tl?.kill();
    const tl = gsap.timeline();
    this.tl = tl;
    tl.to(this.board.scale, {
      x: 0,
      duration: 0.32,
      ease: 'power2.in',
      onComplete: () => this.drawRule(rule),
    })
      .to(this.board.scale, { x: 1, duration: 0.5, ease: 'back.out(1.8)' })
      .to(this.glow, { alpha: 1, duration: 0.3 }, '<')
      .to(this.glow, { alpha: 0, duration: 1.4, delay: 0.9 });
  }

  /** Brief highlight (practice, new rule). */
  highlight(on: boolean): void {
    gsap.to(this.glow, { alpha: on ? 0.75 : 0, duration: 0.3 });
  }

  destroy(): void {
    this.swing?.kill();
    this.tl?.kill();
    gsap.killTweensOf(this.board);
    gsap.killTweensOf(this.board.scale);
    gsap.killTweensOf(this.glow);
    this.view.destroy({ children: true });
  }
}
