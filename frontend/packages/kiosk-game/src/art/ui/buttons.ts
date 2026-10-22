/**
 * Tactile icon buttons, picture tiles, ripples and the animated hand-pointer hint.
 *
 * - Every variant is encoded by icon + shape + colour (never colour alone, KSK-06): confirm = teal
 *   circle with a tick, cancel = orange rounded square with a cross, replay = marigold circle with a
 *   circular arrow, help = indigo speech bubble, exit = maroon octagon with an open hand.
 * - Size is physical: >= 20 mm at the configured px/mm (default 30 mm).
 * - Press feedback is visual only (sink, squash, ripple, springy release); input logic stays in the
 *   InputService, which receives the target id and stage bounds.
 * - Attention pulse is at most 1.25 Hz (< 3 Hz flash limit, KSK-05).
 */
import { gsap } from 'gsap';
import { Container, type FederatedPointerEvent, Graphics } from 'pixi.js';
import {
  type ButtonSpec,
  type PhysicalMetrics,
  TOUCH_TARGET_MIN_MM,
  type UiButton,
} from '../../core/contracts.ts';
import { darken, desaturate, lighten } from '../color.ts';
import { openArc, rgrad, softShadow, vgrad } from '../draw.ts';
import { KIOSK_PALETTE, MELA } from '../palettes.ts';
import { drawIcon } from './icons.ts';

export type ButtonShape = 'circle' | 'rounded' | 'octagon' | 'bubble';

/** Visual token for a button variant. */
export interface ButtonToken {
  readonly shape: ButtonShape;
  readonly face: number;
  readonly iconColor: number;
  readonly defaultIcon: string;
}

export const BUTTON_TOKENS: Readonly<Record<ButtonSpec['variant'], ButtonToken>> = {
  primary: { shape: 'rounded', face: MELA.saffron, iconColor: MELA.ink, defaultIcon: 'play' },
  secondary: { shape: 'rounded', face: MELA.cream, iconColor: MELA.ink, defaultIcon: 'play' },
  confirm: {
    shape: 'circle',
    face: KIOSK_PALETTE.confirm,
    iconColor: MELA.cream,
    defaultIcon: 'tick',
  },
  cancel: {
    shape: 'rounded',
    face: KIOSK_PALETTE.cancel,
    iconColor: MELA.cream,
    defaultIcon: 'cross',
  },
  replay: { shape: 'circle', face: MELA.marigold, iconColor: MELA.ink, defaultIcon: 'replay' },
  help: { shape: 'bubble', face: MELA.indigo, iconColor: MELA.cream, defaultIcon: 'help' },
  exit: { shape: 'octagon', face: 0x8e2f4a, iconColor: MELA.cream, defaultIcon: 'hand' },
};

/** Default edge for primary choices (comfortably above the 20 mm floor). */
export const DEFAULT_BUTTON_MM = 30;

function shapePath(g: Graphics, shape: ButtonShape, r: number, inset = 0): Graphics {
  const rr = r - inset;
  switch (shape) {
    case 'circle':
      return g.circle(0, 0, rr);
    case 'rounded':
      return g.roundRect(-rr, -rr, rr * 2, rr * 2, rr * 0.36);
    case 'octagon': {
      const pts: number[] = [];
      for (let i = 0; i < 8; i++) {
        const a = Math.PI / 8 + (i * Math.PI) / 4;
        pts.push(Math.cos(a) * rr * 1.05, Math.sin(a) * rr * 1.05);
      }
      return g.poly(pts);
    }
    case 'bubble':
      return g.roundRect(-rr, -rr * 0.92, rr * 2, rr * 1.84, rr * 0.6);
  }
}

/** Options for {@link IconButton}. */
export interface IconButtonOptions {
  readonly spec: ButtonSpec;
  readonly metrics: PhysicalMetrics;
  readonly reducedMotion?: boolean;
  /** Override the face colour (e.g. a tinted primary) — still keep icon + shape distinct. */
  readonly face?: number;
}

/** A tactile, icon-only button. */
export class IconButton implements UiButton {
  readonly view = new Container();
  readonly targetId: string;
  readonly sizePx: number;
  private readonly body = new Container();
  private readonly shadow = new Graphics();
  private readonly base = new Graphics();
  private readonly faceG = new Graphics();
  private readonly gloss = new Graphics();
  private readonly ring = new Graphics();
  private readonly icon: Container;
  private readonly ripples = new Container();
  private enabled = true;
  private selected = false;
  private pulseTl: gsap.core.Timeline | null = null;
  private readonly token: ButtonToken;
  private readonly reducedMotion: boolean;
  private readonly faceColor: number;

  constructor(opts: IconButtonOptions) {
    const { spec, metrics } = opts;
    this.targetId = spec.id;
    this.token = BUTTON_TOKENS[spec.variant];
    this.reducedMotion = opts.reducedMotion ?? false;
    const mm = Math.max(TOUCH_TARGET_MIN_MM, spec.sizeMm ?? DEFAULT_BUTTON_MM);
    this.sizePx = Math.round(mm * metrics.pxPerMm);
    this.faceColor = opts.face ?? this.token.face;
    const r = this.sizePx / 2;
    this.view.label = `button:${spec.id}`;
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.hitArea = { contains: (x: number, y: number) => x * x + y * y <= r * r * 1.15 };

    softShadow(this.shadow, 0, r * 0.9, r * 0.95, r * 0.22, MELA.ink, 0.5);
    shapePath(this.base, this.token.shape, r).fill(darken(this.faceColor, 0.38));
    this.base.y = r * 0.1;
    this.drawFace();
    this.icon = drawIcon(
      spec.iconId || this.token.defaultIcon,
      this.sizePx * 0.62,
      this.token.iconColor,
    );
    // Icon outline for contrast on any face colour.
    const outline = drawIcon(
      spec.iconId || this.token.defaultIcon,
      this.sizePx * 0.62,
      this.token.iconColor === MELA.ink ? MELA.cream : darken(this.faceColor, 0.55),
    );
    outline.position.set(0, this.sizePx * 0.025);
    outline.alpha = 0.55;
    const iconHolder = new Container();
    iconHolder.addChild(outline, this.icon);
    this.body.addChild(this.faceG, this.gloss, iconHolder, this.ring);
    this.view.addChild(this.shadow, this.base, this.body, this.ripples);

    this.view.on('pointerdown', (e: FederatedPointerEvent) => this.onDown(e));
    this.view.on('pointerup', () => this.onUp());
    this.view.on('pointerupoutside', () => this.onUp());
  }

  private drawFace(): void {
    const r = this.sizePx / 2;
    const c = this.enabled ? this.faceColor : desaturate(this.faceColor, 0.75);
    this.faceG.clear();
    shapePath(this.faceG, this.token.shape, r).fill(
      vgrad([
        [0, lighten(c, 0.22)],
        [0.55, c],
        [1, darken(c, 0.16)],
      ]),
    );
    shapePath(this.faceG, this.token.shape, r).stroke({
      width: Math.max(2, r * 0.06),
      color: lighten(c, 0.45),
      alpha: 0.7,
      alignment: 1,
    });
    this.gloss.clear();
    this.gloss.ellipse(-r * 0.12, -r * 0.5, r * 0.6, r * 0.26).fill(
      rgrad([
        [0, '#ffffff88'],
        [1, '#ffffff00'],
      ]),
    );
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.view.eventMode = enabled ? 'static' : 'none';
    this.view.alpha = enabled ? 1 : 0.5;
    this.drawFace();
    if (!enabled) this.stopPulse();
  }

  /** Selection ring (thick ring + scale): shape cue, not colour alone. */
  setSelected(selected: boolean): void {
    this.selected = selected;
    const r = this.sizePx / 2;
    this.ring.clear();
    if (selected) {
      shapePath(this.ring, this.token.shape, r + r * 0.16).stroke({
        width: r * 0.12,
        color: MELA.cream,
      });
      shapePath(this.ring, this.token.shape, r + r * 0.16).stroke({
        width: r * 0.05,
        color: MELA.ink,
        alpha: 0.6,
        alignment: 1,
      });
    }
    gsap.to(this.body.scale, {
      x: selected ? 1.06 : 1,
      y: selected ? 1.06 : 1,
      duration: 0.2,
      ease: 'back.out(2)',
    });
  }

  get isSelected(): boolean {
    return this.selected;
  }

  pulse(): void {
    this.stopPulse();
    // A screen can ask for a pulse in the same tick it tears the button down (voice cue racing a
    // hand-off): a destroyed button has nothing to animate.
    if (this.body.destroyed) return;
    if (this.reducedMotion) {
      this.setSelected(this.selected);
      return;
    }
    const r = this.sizePx / 2;
    const halo = new Graphics();
    shapePath(halo, this.token.shape, r).stroke({ width: r * 0.1, color: MELA.cream });
    this.ripples.addChild(halo);
    // 0.8 s period = 1.25 Hz, far below the 3 Hz flashing limit.
    this.pulseTl = gsap.timeline({ repeat: 3, onComplete: () => halo.destroy() });
    this.pulseTl
      .fromTo(
        this.body.scale,
        { x: 1, y: 1 },
        { x: 1.07, y: 1.07, duration: 0.4, ease: 'sine.inOut', yoyo: true, repeat: 1 },
        0,
      )
      .fromTo(halo.scale, { x: 1, y: 1 }, { x: 1.35, y: 1.35, duration: 0.8, ease: 'sine.out' }, 0)
      .fromTo(halo, { alpha: 0.85 }, { alpha: 0, duration: 0.8, ease: 'sine.out' }, 0);
  }

  private stopPulse(): void {
    this.pulseTl?.kill();
    this.pulseTl = null;
    if (!this.body.destroyed) this.body.scale.set(this.selected ? 1.06 : 1);
  }

  /** Programmatic press feedback (e.g. when a voice answer commits this option). */
  press(): void {
    this.onDown(null);
    setTimeout(() => this.onUp(), 120);
  }

  private onDown(e: FederatedPointerEvent | null): void {
    if (!this.enabled) return;
    const r = this.sizePx / 2;
    gsap.killTweensOf(this.body);
    gsap.to(this.body, { y: r * 0.08, duration: 0.06, ease: 'power2.out' });
    gsap.to(this.body.scale, { x: 0.93, y: 0.9, duration: 0.07, ease: 'power2.out' });
    gsap.to(this.shadow.scale, { x: 0.86, y: 0.86, duration: 0.07 });
    let x = 0;
    let y = 0;
    if (e) {
      const p = this.view.toLocal(e.global);
      x = p.x;
      y = p.y;
    }
    ripple(this.ripples, x, y, r * 1.5, MELA.cream, this.reducedMotion);
  }

  private onUp(): void {
    gsap.to(this.body, { y: 0, duration: 0.45, ease: 'elastic.out(1.1, 0.4)' });
    gsap.to(this.body.scale, {
      x: this.selected ? 1.06 : 1,
      y: this.selected ? 1.06 : 1,
      duration: 0.5,
      ease: 'elastic.out(1.2, 0.35)',
    });
    gsap.to(this.shadow.scale, { x: 1, y: 1, duration: 0.3 });
  }

  destroy(): void {
    this.stopPulse();
    gsap.killTweensOf(this.body);
    gsap.killTweensOf(this.body.scale);
    gsap.killTweensOf(this.shadow.scale);
    this.view.destroy({ children: true });
  }
}

/** Expanding soft ring at (x, y) inside `layer`. */
export function ripple(
  layer: Container,
  x: number,
  y: number,
  radius: number,
  color: number,
  reducedMotion = false,
): void {
  const g = new Graphics();
  g.circle(0, 0, radius).stroke({ width: radius * 0.12, color, alpha: 0.9 });
  g.circle(0, 0, radius * 0.9).fill({ color, alpha: 0.18 });
  g.position.set(x, y);
  g.scale.set(0.2);
  layer.addChild(g);
  gsap.to(g.scale, { x: 1, y: 1, duration: reducedMotion ? 0.2 : 0.45, ease: 'power2.out' });
  gsap.to(g, {
    alpha: 0,
    duration: reducedMotion ? 0.2 : 0.45,
    ease: 'power1.in',
    onComplete: () => g.destroy(),
  });
}

/** Options for a picture tile (a card with a pictogram used for choices). */
export interface PictureTileOptions {
  readonly id: string;
  readonly pictogram: Container;
  readonly sizePx: number;
  readonly accent?: number;
  readonly reducedMotion?: boolean;
}

/** A large cream picture card. Selection shows a thick ring and a tick badge (shape cues). */
export class PictureTile implements UiButton {
  readonly view = new Container();
  readonly targetId: string;
  readonly sizePx: number;
  private readonly card = new Container();
  private readonly ring = new Graphics();
  private readonly badge = new Container();
  private readonly ripples = new Container();
  private enabled = true;
  private selected = false;
  private readonly reducedMotion: boolean;
  private pulseTl: gsap.core.Timeline | null = null;

  constructor(opts: PictureTileOptions) {
    this.targetId = opts.id;
    this.sizePx = opts.sizePx;
    this.reducedMotion = opts.reducedMotion ?? false;
    const s = opts.sizePx;
    const accent = opts.accent ?? MELA.saffron;
    this.view.label = `tile:${opts.id}`;
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    const sh = new Graphics();
    softShadow(sh, 0, s * 0.5, s * 0.5, s * 0.08, MELA.ink, 0.45);
    const g = new Graphics();
    g.roundRect(-s / 2, -s / 2 + s * 0.04, s, s, s * 0.16).fill(darken(accent, 0.35));
    g.roundRect(-s / 2, -s / 2, s, s, s * 0.16).fill(
      vgrad([
        [0, 0xfffaf0],
        [1, MELA.parchment],
      ]),
    );
    g.roundRect(-s / 2 + s * 0.04, -s / 2 + s * 0.04, s * 0.92, s * 0.92, s * 0.13).stroke({
      width: s * 0.025,
      color: accent,
      alpha: 0.85,
    });
    // Corner motifs.
    for (const [cx, cy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      g.circle(cx * s * 0.38, cy * s * 0.38, s * 0.018).fill(accent);
    }
    this.card.addChild(g, opts.pictogram, this.ring);
    const bg = new Graphics();
    bg.circle(0, 0, s * 0.13)
      .fill(KIOSK_PALETTE.confirm)
      .circle(0, 0, s * 0.13)
      .stroke({ width: s * 0.02, color: MELA.cream });
    const tick = drawIcon('tick', s * 0.2, MELA.cream);
    this.badge.addChild(bg, tick);
    this.badge.position.set(s * 0.4, -s * 0.4);
    this.badge.visible = false;
    this.view.addChild(sh, this.card, this.badge, this.ripples);
    this.view.on('pointerdown', (e: FederatedPointerEvent) => {
      if (!this.enabled) return;
      gsap.to(this.card.scale, { x: 0.95, y: 0.95, duration: 0.07 });
      const p = this.view.toLocal(e.global);
      ripple(this.ripples, p.x, p.y, s * 0.5, MELA.saffron, this.reducedMotion);
    });
    const up = (): void => {
      gsap.to(this.card.scale, {
        x: this.selected ? 1.05 : 1,
        y: this.selected ? 1.05 : 1,
        duration: 0.5,
        ease: 'elastic.out(1.2, 0.4)',
      });
    };
    this.view.on('pointerup', up);
    this.view.on('pointerupoutside', up);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.view.eventMode = enabled ? 'static' : 'none';
    this.view.alpha = enabled ? 1 : 0.5;
  }

  setSelected(selected: boolean): void {
    this.selected = selected;
    const s = this.sizePx;
    this.ring.clear();
    if (selected) {
      this.ring
        .roundRect(-s / 2 - s * 0.05, -s / 2 - s * 0.05, s * 1.1, s * 1.1, s * 0.2)
        .stroke({ width: s * 0.05, color: KIOSK_PALETTE.confirm });
    }
    this.badge.visible = selected;
    if (selected)
      gsap.fromTo(
        this.badge.scale,
        { x: 0, y: 0 },
        { x: 1, y: 1, duration: 0.35, ease: 'back.out(2.5)' },
      );
    gsap.to(this.card.scale, {
      x: selected ? 1.05 : 1,
      y: selected ? 1.05 : 1,
      duration: 0.25,
      ease: 'back.out(2)',
    });
  }

  get isSelected(): boolean {
    return this.selected;
  }

  pulse(): void {
    this.pulseTl?.kill();
    if (this.reducedMotion) return;
    this.pulseTl = gsap.timeline({ repeat: 2 });
    this.pulseTl.to(this.card.scale, {
      x: 1.05,
      y: 1.05,
      duration: 0.4,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: 1,
    });
  }

  destroy(): void {
    this.pulseTl?.kill();
    gsap.killTweensOf(this.card.scale);
    gsap.killTweensOf(this.badge.scale);
    this.view.destroy({ children: true });
  }
}

/** Cartoon hand with an extended index finger (pointer hint). Origin = fingertip. */
export function drawPointerHand(size: number): Container {
  const c = new Container();
  const g = new Graphics();
  const skin = 0xf3c9a0;
  const edge = 0x6a3a2a;
  const s = size;
  // Sleeve cuff.
  g.roundRect(-s * 0.2, s * 0.78, s * 0.5, s * 0.28, s * 0.08)
    .fill(MELA.saffron)
    .stroke({ width: s * 0.03, color: edge });
  // Palm and folded fingers.
  g.roundRect(-s * 0.22, s * 0.32, s * 0.5, s * 0.52, s * 0.18)
    .fill(skin)
    .stroke({ width: s * 0.035, color: edge });
  for (let k = 0; k < 3; k++)
    g.roundRect(s * 0.04 + k * s * 0.0, s * 0.36 + k * s * 0.13, s * 0.3, s * 0.13, s * 0.06)
      .fill(skin)
      .stroke({ width: s * 0.03, color: edge });
  // Thumb.
  g.roundRect(-s * 0.34, s * 0.42, s * 0.2, s * 0.13, s * 0.06)
    .fill(skin)
    .stroke({ width: s * 0.03, color: edge });
  // Index finger.
  g.roundRect(-s * 0.09, 0, s * 0.16, s * 0.46, s * 0.08)
    .fill(skin)
    .stroke({ width: s * 0.035, color: edge });
  g.ellipse(-s * 0.01, s * 0.06, s * 0.04, s * 0.025).fill({ color: 0xffffff, alpha: 0.6 });
  c.addChild(g);
  c.pivot.set(0, 0);
  return c;
}

/** Hint gesture kinds. */
export type HintKind = 'tap' | 'hold' | 'say_or_touch';

/**
 * Animated hand-pointer hint: glides to `target`, then taps (tap), presses while a ring fills (hold),
 * or taps with sound waves (say-or-touch). Loops until `stop()`.
 */
export class HandHint {
  readonly view = new Container();
  private readonly hand: Container;
  private readonly fx = new Container();
  private tl: gsap.core.Timeline | null = null;

  constructor(
    private readonly size: number,
    private readonly reducedMotion = false,
  ) {
    this.hand = drawPointerHand(size);
    this.view.addChild(this.fx, this.hand);
    this.view.eventMode = 'none';
    this.view.alpha = 0;
  }

  /** Start the hint at `target` (stage coordinates in the parent's space). */
  show(kind: HintKind, target: { x: number; y: number }, holdMs = 1200): void {
    this.stop();
    const s = this.size;
    this.view.alpha = 1;
    const start = { x: target.x + s * 1.4, y: target.y + s * 1.6 };
    this.hand.position.set(start.x, start.y);
    this.hand.rotation = -0.3;
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });
    if (this.reducedMotion) {
      this.hand.position.set(target.x, target.y + s * 0.15);
      tl.to(this.hand, { alpha: 0.6, duration: 0.6, yoyo: true, repeat: 1 });
      this.tl = tl;
      return;
    }
    tl.set(this.hand, { x: start.x, y: start.y, alpha: 0, rotation: -0.3 })
      .to(this.hand, { alpha: 1, duration: 0.2 })
      .to(
        this.hand,
        {
          x: target.x,
          y: target.y + s * 0.1,
          rotation: -0.12,
          duration: 0.7,
          ease: 'power2.inOut',
        },
        '<',
      );
    if (kind === 'tap' || kind === 'say_or_touch') {
      tl.to(this.hand.scale, { x: 0.86, y: 0.86, duration: 0.12, ease: 'power2.in' })
        .call(() => this.tapFx(target, kind === 'say_or_touch'))
        .to(this.hand.scale, { x: 1, y: 1, duration: 0.25, ease: 'back.out(2)' })
        .to(this.hand.scale, { x: 0.86, y: 0.86, duration: 0.12, ease: 'power2.in' }, '+=0.25')
        .call(() => this.tapFx(target, kind === 'say_or_touch'))
        .to(this.hand.scale, { x: 1, y: 1, duration: 0.25, ease: 'back.out(2)' });
    } else {
      const ring = new Graphics();
      this.fx.addChild(ring);
      const prog = { p: 0 };
      tl.to(this.hand.scale, { x: 0.86, y: 0.86, duration: 0.12 })
        .to(prog, {
          p: 1,
          duration: holdMs / 1000,
          ease: 'none',
          onUpdate: () => {
            ring.clear();
            openArc(
              ring,
              target.x,
              target.y,
              s * 0.75,
              -Math.PI / 2,
              -Math.PI / 2 + Math.PI * 2 * prog.p,
            ).stroke({ width: s * 0.12, color: MELA.marigold, cap: 'round' });
          },
        })
        .call(() => this.tapFx(target, false))
        .to(this.hand.scale, { x: 1, y: 1, duration: 0.25, ease: 'back.out(2)' })
        .call(() => ring.clear());
    }
    tl.to(this.hand, { alpha: 0, duration: 0.25 }, '+=0.3');
    this.tl = tl;
  }

  private tapFx(target: { x: number; y: number }, voice: boolean): void {
    ripple(this.fx, target.x, target.y, this.size * 0.7, MELA.cream, this.reducedMotion);
    if (voice) {
      for (let k = 1; k <= 3; k++) {
        const arc = new Graphics();
        openArc(arc, 0, 0, this.size * 0.3 * k, -0.7, 0.7).stroke({
          width: this.size * 0.06,
          color: MELA.cream,
          cap: 'round',
        });
        arc.position.set(target.x - this.size * 1.2, target.y - this.size * 0.9);
        arc.rotation = Math.PI;
        arc.alpha = 0;
        this.fx.addChild(arc);
        gsap.to(arc, {
          alpha: 1,
          duration: 0.15,
          delay: k * 0.08,
          yoyo: true,
          repeat: 1,
          onComplete: () => arc.destroy(),
        });
      }
    }
  }

  stop(): void {
    this.tl?.kill();
    this.tl = null;
    for (const c of this.fx.removeChildren()) c.destroy();
    this.view.alpha = 0;
  }

  destroy(): void {
    this.stop();
    this.view.destroy({ children: true });
  }
}
