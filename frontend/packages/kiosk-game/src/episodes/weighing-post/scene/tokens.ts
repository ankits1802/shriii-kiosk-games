/**
 * Diegetic choice tokens: carved stamps for the weighing decisions (circle / triangle / square, each
 * with its own picture, so colour is never the only cue), neutral parchment roundels for dilemmas,
 * wooden die tiles for luck reports, and round controls (confirm seal, re-weigh, replay).
 *
 * Tokens are purely visual: touch goes through the engine's input layer (targets with the same rects).
 * Entrances never hide a token: it is fully opaque from its first frame and only settles in scale.
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import { darken, desaturate, lighten } from '../../../art/color.ts';
import { glowDisc, rgrad, softShadow, vgrad } from '../../../art/draw.ts';
import { motionSettings } from '../../../art/motion.ts';
import { MELA } from '../../../art/palettes.ts';
import { drawIcon } from '../../../art/ui/icons.ts';
import { drawInspectIcon, drawPictogram, type PictogramData } from './pictograms.ts';
import type { ChoiceKind } from './types.ts';

type Shape = 'circle' | 'triangle' | 'square' | 'roundel' | 'tile';

interface TokenStyle {
  readonly shape: Shape;
  readonly face: number;
}

const WEIGH_STYLE: Readonly<Record<string, TokenStyle>> = {
  approve: { shape: 'circle', face: 0x2f7d4a },
  warn: { shape: 'triangle', face: 0xd99a1e },
  fine: { shape: 'square', face: 0x8e2b32 },
};

function styleFor(kind: ChoiceKind, code: string): TokenStyle {
  if (kind === 'weigh') return WEIGH_STYLE[code] ?? { shape: 'roundel', face: MELA.parchment };
  if (kind === 'luck') return { shape: 'tile', face: 0x9c6b3e };
  return { shape: 'roundel', face: MELA.parchment };
}

function shapePath(g: Graphics, shape: Shape, r: number): Graphics {
  switch (shape) {
    case 'circle':
    case 'roundel':
      return g.circle(0, 0, r);
    case 'triangle': {
      // Rounded triangle (apex up), optically centred.
      const k = r * 1.12;
      const pts: readonly (readonly [number, number])[] = [
        [0, -k],
        [k * 0.95, k * 0.62],
        [-k * 0.95, k * 0.62],
      ];
      const at = (i: number): readonly [number, number] => pts[i % 3] ?? [0, 0];
      const rr = r * 0.22;
      g.moveTo((at(0)[0] + at(1)[0]) / 2, (at(0)[1] + at(1)[1]) / 2);
      for (let i = 1; i <= 3; i++) {
        const p = at(i);
        const q = at(i + 1);
        g.arcTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, rr);
      }
      return g.closePath();
    }
    case 'square':
      return g.roundRect(-r * 0.9, -r * 0.9, r * 1.8, r * 1.8, r * 0.26);
    case 'tile':
      return g.roundRect(-r * 0.88, -r * 0.88, r * 1.76, r * 1.76, r * 0.3);
    default: {
      const never: never = shape;
      throw new Error(`unknown shape ${String(never)}`);
    }
  }
}

/** A choice token. Origin at its centre. */
export class ChoiceToken {
  readonly view = new Container();
  readonly code: string;
  private readonly body = new Container();
  private readonly glow = new Graphics();
  private readonly shadow = new Graphics();
  private readonly faceG = new Graphics();
  private readonly style: TokenStyle;
  private readonly r: number;
  private enabled = true;
  private selected = false;
  private bob: gsap.core.Tween | null = null;
  private tl: gsap.core.Timeline | null = null;

  constructor(kind: ChoiceKind, code: string, size: number, data: PictogramData = {}) {
    this.code = code;
    this.style = styleFor(kind, code);
    this.r = size / 2;
    this.view.label = `token:${kind}:${code}`;
    this.view.eventMode = 'none';
    const r = this.r;
    softShadow(this.shadow, 0, r * 0.92, r * 0.95, r * 0.2, MELA.ink, 0.5);
    glowDisc(this.glow, 0, 0, r * 1.75, 0xffe08a, 0.85);
    this.glow.alpha = 0;
    this.glow.blendMode = 'add';
    this.drawFace();
    const picScale =
      this.style.shape === 'roundel' ? 1.12 : this.style.shape === 'tile' ? 0.9 : 0.96;
    const pic = drawPictogram(kind, code, size * picScale, data);
    this.body.addChild(this.faceG, pic);
    this.view.addChild(this.glow, this.shadow, this.body);
  }

  private drawFace(): void {
    const r = this.r;
    const g = this.faceG;
    g.clear();
    const face = this.enabled ? this.style.face : desaturate(this.style.face, 0.7);
    // Thick carved base (depth), brass rim, enamel face, gloss.
    shapePath(g, this.style.shape, r).fill(darken(face, 0.45));
    shapePath(g, this.style.shape, r * 0.97).fill(
      vgrad([
        [0, lighten(MELA.brass, 0.25)],
        [1, darken(MELA.brass, 0.3)],
      ]),
    );
    shapePath(g, this.style.shape, r * 0.86).fill(
      rgrad(
        [
          [0, lighten(face, 0.28)],
          [0.7, face],
          [1, darken(face, 0.2)],
        ],
        { x: 0.4, y: 0.3 },
        0.85,
      ),
    );
    if (this.style.shape === 'roundel') {
      // Embroidered border dots on the neutral roundels.
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        g.circle(Math.cos(a) * r * 0.78, Math.sin(a) * r * 0.78, r * 0.035).fill(
          darken(MELA.brass, 0.15),
        );
      }
    }
    if (this.style.shape === 'tile') {
      for (let i = 0; i < 5; i++) {
        const y = -r * 0.7 + i * r * 0.35;
        g.moveTo(-r * 0.72, y)
          .quadraticCurveTo(0, y + r * 0.06, r * 0.72, y)
          .stroke({
            width: 1.2,
            color: darken(face, 0.3),
            alpha: 0.45,
          });
      }
    }
    g.ellipse(-r * 0.15, -r * 0.48, r * 0.5, r * 0.18).fill({ color: 0xffffff, alpha: 0.22 });
  }

  show(delayS = 0): void {
    gsap.killTweensOf(this.body.scale);
    this.view.visible = true;
    this.view.alpha = 1;
    if (motionSettings.reducedMotion || motionSettings.timeScale <= 0) {
      this.body.scale.set(1);
      return;
    }
    this.body.scale.set(0.86, 0.92);
    gsap.to(this.body.scale, { x: 1, y: 1, duration: 0.32, delay: delayS, ease: 'back.out(2.4)' });
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.view.alpha = enabled ? 1 : 0.55;
    this.drawFace();
  }

  setSelected(selected: boolean): void {
    if (this.selected === selected) return;
    this.selected = selected;
    gsap.killTweensOf(this.body);
    gsap.killTweensOf(this.glow);
    this.bob?.kill();
    this.bob = null;
    const reduced = motionSettings.reducedMotion;
    if (selected) {
      gsap.to(this.body, { y: -this.r * 0.22, duration: reduced ? 0 : 0.18, ease: 'power2.out' });
      gsap.to(this.body.scale, {
        x: 1.1,
        y: 1.1,
        duration: reduced ? 0 : 0.2,
        ease: 'back.out(3)',
      });
      gsap.to(this.glow, { alpha: 0.9, duration: 0.2 });
      if (!reduced) {
        this.bob = gsap.to(this.body, {
          y: -this.r * 0.3,
          duration: 0.6,
          yoyo: true,
          repeat: -1,
          ease: 'sine.inOut',
          delay: 0.2,
        });
      }
    } else {
      gsap.to(this.body, { y: 0, duration: reduced ? 0 : 0.16 });
      gsap.to(this.body.scale, { x: 1, y: 1, duration: reduced ? 0 : 0.16 });
      gsap.to(this.glow, { alpha: 0, duration: 0.16 });
    }
  }

  /** Stamp press: squash, thump, recover. */
  press(): void {
    this.bob?.kill();
    this.bob = null;
    gsap.killTweensOf(this.body);
    gsap.killTweensOf(this.body.scale);
    if (motionSettings.reducedMotion) {
      this.body.y = 0;
      this.body.scale.set(1);
      return;
    }
    this.tl?.kill();
    const tl = gsap.timeline();
    this.tl = tl;
    tl.to(this.body, { y: -this.r * 0.42, duration: 0.09, ease: 'power2.out' })
      .to(this.body.scale, { x: 0.94, y: 1.12, duration: 0.09 }, '<')
      .to(this.body, { y: this.r * 0.05, duration: 0.08, ease: 'power3.in' })
      .to(this.body.scale, { x: 1.18, y: 0.8, duration: 0.08 }, '<')
      .to(this.body, { y: 0, duration: 0.22, ease: 'back.out(2)' })
      .to(this.body.scale, { x: 1, y: 1, duration: 0.22, ease: 'elastic.out(1, 0.5)' }, '<');
  }

  hide(delayS = 0): Promise<void> {
    this.bob?.kill();
    this.bob = null;
    return new Promise((resolve) => {
      if (motionSettings.reducedMotion) {
        this.view.visible = false;
        resolve();
        return;
      }
      gsap.to(this.view, {
        alpha: 0,
        duration: 0.22,
        delay: delayS,
        onComplete: () => {
          this.view.visible = false;
          resolve();
        },
      });
      gsap.to(this.body.scale, { x: 0.8, y: 0.8, duration: 0.22, delay: delayS });
    });
  }

  destroy(): void {
    this.bob?.kill();
    this.tl?.kill();
    this.tl = null;
    gsap.killTweensOf(this.view);
    gsap.killTweensOf(this.body);
    gsap.killTweensOf(this.body.scale);
    gsap.killTweensOf(this.glow);
    this.view.destroy({ children: true });
  }
}

export type ControlKind = 'confirm' | 'inspect' | 'replay';

/** Round controls: confirm seal (teal + cream tick), re-weigh (brass + magnifier), replay. */
export class RoundControl {
  readonly view = new Container();
  private readonly body = new Container();
  private readonly ring = new Graphics();
  private pulseTween: gsap.core.Tween | null = null;
  private readonly kind: ControlKind;
  private readonly r: number;
  private enabled = true;

  constructor(kind: ControlKind, size: number) {
    this.kind = kind;
    this.r = size / 2;
    const r = this.r;
    this.view.label = `control:${kind}`;
    this.view.eventMode = 'none';
    const shadow = new Graphics();
    softShadow(shadow, 0, r * 0.9, r * 0.92, r * 0.2, MELA.ink, 0.5);
    const face = new Graphics();
    const col = kind === 'confirm' ? 0x12707a : kind === 'inspect' ? MELA.brass : MELA.peacockDeep;
    face.circle(0, r * 0.08, r).fill(darken(col, 0.45));
    face.circle(0, 0, r).fill(
      rgrad(
        [
          [0, lighten(col, 0.3)],
          [0.75, col],
          [1, darken(col, 0.25)],
        ],
        { x: 0.4, y: 0.3 },
        0.85,
      ),
    );
    face
      .circle(0, 0, r * 0.92)
      .stroke({ width: Math.max(2, r * 0.06), color: lighten(col, 0.45), alpha: 0.7 });
    face.ellipse(-r * 0.15, -r * 0.5, r * 0.55, r * 0.2).fill({ color: 0xffffff, alpha: 0.25 });
    let icon: Container;
    if (kind === 'confirm') {
      icon = new Container();
      const t = new Graphics();
      t.moveTo(-r * 0.4, r * 0.02)
        .lineTo(-r * 0.1, r * 0.32)
        .lineTo(r * 0.45, -r * 0.32)
        .stroke({ width: r * 0.2, color: darken(col, 0.5), cap: 'round', join: 'round' });
      t.moveTo(-r * 0.4, -r * 0.02)
        .lineTo(-r * 0.1, r * 0.28)
        .lineTo(r * 0.45, -r * 0.36)
        .stroke({ width: r * 0.17, color: MELA.cream, cap: 'round', join: 'round' });
      icon.addChild(t);
    } else if (kind === 'inspect') {
      icon = drawInspectIcon(r * 1.6);
    } else {
      icon = drawIcon('replay', r * 1.15, MELA.cream);
    }
    this.ring
      .circle(0, 0, r * 1.12)
      .stroke({ width: Math.max(3, r * 0.09), color: 0xfff2b0, alpha: 0.9 });
    this.ring.alpha = 0;
    this.body.addChild(face, icon);
    this.view.addChild(shadow, this.ring, this.body);
  }

  show(): void {
    this.view.visible = true;
    this.view.alpha = this.enabled ? 1 : 0.5;
    gsap.killTweensOf(this.body.scale);
    if (motionSettings.reducedMotion) {
      this.body.scale.set(1);
    } else {
      this.body.scale.set(0.6);
      gsap.to(this.body.scale, { x: 1, y: 1, duration: 0.3, ease: 'back.out(2.6)' });
    }
    if (this.kind === 'confirm') this.pulse(true);
  }

  hide(): void {
    this.pulse(false);
    this.view.visible = false;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.view.alpha = enabled ? 1 : 0.5;
  }

  /** Attention pulse of the ring (1.25 Hz, well under the 3 Hz flash limit). */
  pulse(on: boolean): void {
    this.pulseTween?.kill();
    this.pulseTween = null;
    gsap.killTweensOf(this.ring.scale);
    this.ring.alpha = 0;
    if (!on || motionSettings.reducedMotion) {
      if (on) this.ring.alpha = 0.7;
      return;
    }
    this.ring.scale.set(0.92);
    this.pulseTween = gsap.to(this.ring, {
      alpha: 0.85,
      duration: 0.4,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
    });
    gsap.to(this.ring.scale, {
      x: 1.12,
      y: 1.12,
      duration: 0.4,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
    });
  }

  press(): void {
    if (motionSettings.reducedMotion) return;
    gsap.fromTo(
      this.body.scale,
      { x: 0.86, y: 0.86 },
      { x: 1, y: 1, duration: 0.3, ease: 'back.out(3)' },
    );
  }

  destroy(): void {
    this.pulseTween?.kill();
    gsap.killTweensOf(this.ring);
    gsap.killTweensOf(this.ring.scale);
    gsap.killTweensOf(this.body.scale);
    gsap.killTweensOf(this.view);
    this.view.destroy({ children: true });
  }
}
