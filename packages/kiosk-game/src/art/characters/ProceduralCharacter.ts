/**
 * Layered vector character rig.
 *
 * Rig: shadow -> figure (lean/bounce) -> lower garment + feet -> upper group (breathing) -> torso, drape,
 * neck, head (tilt/nod: hair, face, features, headwear, glasses) and two jointed arms (shoulder + elbow),
 * plus an expression-symbol layer and an optional glowing lantern (the guide).
 *
 * Life: breathing, blinking, idle head tilt and gaze, lip-sync while a voice clip plays, gestures (wave,
 * nod, point, walk in/out, celebrate, shrug) and expression states that tween smoothly. Expressions are
 * readable without colour: brow shape, eye lids, mouth shape, posture (hands on hips, crossed arms, fist)
 * and symbols (sweat drop, anger mark, steam, sparkle, thought bubble, sigh puff).
 */
import { gsap } from 'gsap';
import { Container, Graphics, Sprite, type Ticker } from 'pixi.js';
import { OutlineFilter } from 'pixi-filters';
import type {
  Character,
  CharacterAnimation,
  CharacterSpec,
  Expression,
  Point,
  VoicePlayback,
} from '../../core/contracts.ts';
import { drawLantern } from '../backdrop/props.ts';
import { clamp, darken, lighten, mixColor } from '../color.ts';
import { openArc, rgrad, softShadow, vgrad } from '../draw.ts';
import { FX_RADIUS, fxTexture } from '../fx/textures.ts';
import type { Lighting } from '../lighting.ts';
import { MELA } from '../palettes.ts';
import type { QualityProfile } from '../quality.ts';
import { ArtRandom, hashString } from '../rand.ts';
import type { TextureCache } from '../textures.ts';
import { type Appearance, appearanceFor } from './appearance.ts';
import {
  type ArmPose,
  EXPRESSIONS,
  type ExpressionParams,
  type ExpressionSymbol,
  type ExtendedExpression,
  intensify,
  lerpParams,
  toneExpression,
} from './expressions.ts';

export interface CharacterDeps {
  readonly ticker: Ticker;
  readonly lighting: Lighting;
  readonly quality: QualityProfile;
  readonly cache: TextureCache;
}

interface ArmState {
  u: number;
  f: number;
}

interface Arm {
  readonly root: Container;
  readonly upper: Graphics;
  readonly fore: Container;
  readonly foreG: Graphics;
  readonly side: -1 | 1;
}

const U_LEN = 50;
const F_LEN = 46;

/** Arm angles (upper, fore) for left (viewer-left, side -1) and right arms per pose. */
const ARM_POSES: Readonly<Record<ArmPose, { l: ArmState; r: ArmState }>> = {
  relaxed: { l: { u: 0.17, f: -0.24 }, r: { u: -0.17, f: 0.24 } },
  hips: { l: { u: 0.75, f: -2.05 }, r: { u: -0.75, f: 2.05 } },
  crossed: { l: { u: -0.18, f: -1.38 }, r: { u: 0.22, f: 1.3 } },
  chin: { l: { u: -0.18, f: -1.38 }, r: { u: 0.3, f: 2.55 } },
  open: { l: { u: 0.62, f: 0.35 }, r: { u: -0.62, f: -0.35 } },
  fist: { l: { u: 0.75, f: -2.05 }, r: { u: -1.05, f: -1.75 } },
};

export class ProceduralCharacter implements Character {
  readonly view = new Container();
  readonly spec: CharacterSpec;
  readonly appearance: Appearance;

  private readonly deps: CharacterDeps;
  private readonly rnd: ArtRandom;
  private readonly shadow = new Graphics();
  private readonly figure = new Container();
  private readonly lowerG = new Graphics();
  private readonly upperGroup = new Container();
  private readonly torsoG = new Graphics();
  private readonly drapeG = new Graphics();
  private readonly head = new Container();
  private readonly hairBackG = new Graphics();
  private readonly faceG = new Graphics();
  private readonly featuresG = new Graphics();
  private readonly hairFrontG = new Graphics();
  private readonly glassesG = new Graphics();
  private readonly symbols = new Container();
  private readonly armL: Arm;
  private readonly armR: Arm;
  private lanternGlow: Sprite | null = null;
  private lanternHolder: Container | null = null;

  // Geometry.
  private readonly H0: number;
  private readonly sw: number;
  private readonly ww: number;
  private readonly hw: number;
  private readonly hipY: number;
  private readonly waistY: number;
  private readonly shoulderY: number;
  private readonly neckTop: number;
  private readonly headCY: number;

  // State.
  private expression: ExtendedExpression = 'neutral';
  private intensity = 1;
  private params: ExpressionParams = EXPRESSIONS.neutral.params;
  private symbol: ExpressionSymbol = 'none';
  private fidget: 'none' | 'foot_tap' | 'bounce' | 'shake' = 'none';
  private readonly arms = { l: { ...ARM_POSES.relaxed.l }, r: { ...ARM_POSES.relaxed.r } };
  private readonly motion = { bodyY: 0, bodyRot: 0, headRot: 0, nod: 0, x: 0, squash: 0 };
  private blink = 0;
  private nextBlink = 1.5;
  private talk = 0;
  private talking = false;
  private gazeOverride: { x: number; y: number } | null = null;
  private animating = false;
  private elapsed = 0;
  private destroyed = false;
  private symbolTime = 0;
  private featureSig = '';
  private readonly onTick = (t: Ticker): void => this.update(Math.min(0.1, t.deltaMS / 1000));
  private exprTween: gsap.core.Tween | null = null;
  private unsubLight: (() => void) | null = null;

  constructor(spec: CharacterSpec, deps: CharacterDeps) {
    this.spec = spec;
    this.deps = deps;
    this.appearance = appearanceFor(spec.role, spec.variant ?? 0);
    this.rnd = new ArtRandom(hashString(spec.id));
    const a = this.appearance;
    this.H0 = 330 * a.height;
    this.sw = 37 * a.build;
    this.ww = (a.feminine ? 27 : 30) * a.build;
    this.hw = (a.feminine ? 35 : 31) * a.build;
    this.hipY = -0.46 * this.H0;
    this.waistY = -0.51 * this.H0;
    this.shoulderY = -0.64 * this.H0 + a.age * 3;
    this.neckTop = -0.675 * this.H0 + a.age * 3;
    this.headCY = this.neckTop - 40;

    this.view.label = `character:${spec.id}`;
    this.view.eventMode = 'none';
    this.armL = this.makeArm(-1);
    this.armR = this.makeArm(1);

    this.view.addChild(this.shadow, this.figure);
    this.upperGroup.pivot.set(0, this.waistY);
    this.upperGroup.position.set(0, this.waistY);
    this.head.pivot.set(0, this.neckTop);
    this.head.position.set(0, this.neckTop);
    this.head.addChild(this.hairBackG, this.faceG, this.featuresG, this.hairFrontG, this.glassesG);
    this.upperGroup.addChild(this.torsoG, this.drapeG, this.head, this.armL.root, this.armR.root);
    this.figure.addChild(this.lowerG, this.upperGroup, this.symbols);
    // Crisp illustrated silhouette (medium/high tiers): reads clearly against the busy fair.
    if (deps.quality.softShadows) {
      this.figure.filters = [
        new OutlineFilter({
          thickness: 2.4 * (spec.scale ?? 1),
          color: 0x3a2018,
          alpha: 0.7,
          quality: 0.25,
        }),
      ];
    }

    this.drawBody();
    this.drawHead();
    if (a.lantern) this.attachLantern();

    const facing = spec.facing ?? 'right';
    const sc = spec.scale ?? 1;
    this.view.scale.set(facing === 'left' ? -sc : sc, sc);

    if (spec.toneLevel !== undefined) this.setTone(spec.toneLevel);
    else this.applyExpression(spec.role === 'guide' ? 'calm' : 'neutral', 0);

    this.unsubLight = deps.lighting.subscribe((p) => {
      this.figure.tint = mixColor(p.lightTint, 0xffffff, 0.4);
      this.drawShadow(p.shadowDir, p.shadowLength, p.shadowAlpha, p.shadow);
    });
    deps.ticker.add(this.onTick);
    this.elapsed = this.rnd.range(0, 10);
  }

  /** Current expression. */
  get currentExpression(): ExtendedExpression {
    return this.expression;
  }

  /** Current symbol (for tests and the gallery). */
  get currentSymbol(): ExpressionSymbol {
    return this.symbol;
  }

  setExpression(expression: Expression | ExtendedExpression): void {
    this.applyExpression(expression, 0.28);
  }

  /** Customer tone (0 calm .. 4 hostile): a stimulus property for The Stall. */
  setTone(level: 0 | 1 | 2 | 3 | 4): void {
    const t = toneExpression(level);
    this.intensity = Math.max(1, t.intensity);
    this.applyExpression(t.expression, 0.35);
  }

  /** Anger/rudeness level 0..3 (0 calm, 1 impatient, 2 annoyed, 3 angry). */
  setAngerLevel(level: 0 | 1 | 2 | 3): void {
    this.setTone(level === 3 ? 4 : level);
  }

  /** Exaggeration of the current negative expression (1..3). */
  setIntensity(intensity: 1 | 2 | 3): void {
    this.intensity = intensity;
    this.applyExpression(this.expression, 0.25);
  }

  async speak(playback: VoicePlayback): Promise<void> {
    this.talking = true;
    try {
      await playback.ended;
    } finally {
      this.talking = false;
    }
  }

  /** Lip-sync for a fixed duration (used when no playback object exists, e.g. gallery previews). */
  async speakFor(ms: number): Promise<void> {
    this.talking = true;
    await new Promise((r) => setTimeout(r, ms));
    this.talking = false;
  }

  play(animation: CharacterAnimation): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    gsap.killTweensOf(this.motion);
    gsap.killTweensOf(this.arms.l);
    gsap.killTweensOf(this.arms.r);
    this.animating = animation !== 'idle';
    const tl = gsap.timeline({ paused: true });
    const back = ARM_POSES[EXPRESSIONS[this.expression].arms];
    const dir = this.view.scale.x < 0 ? -1 : 1;
    switch (animation) {
      case 'idle':
        tl.to(this.arms.l, { ...back.l, duration: 0.3 }).to(
          this.arms.r,
          { ...back.r, duration: 0.3 },
          0,
        );
        break;
      case 'wave':
        tl.to(this.arms.r, { u: -2.55, f: -0.35, duration: 0.32, ease: 'back.out(1.6)' });
        for (let i = 0; i < 3; i++)
          tl.to(this.arms.r, { f: 0.35, duration: 0.18, ease: 'sine.inOut' }).to(this.arms.r, {
            f: -0.45,
            duration: 0.18,
            ease: 'sine.inOut',
          });
        tl.to(this.motion, { headRot: 0.08, duration: 0.3 }, 0);
        tl.to(this.arms.r, { ...back.r, duration: 0.35, ease: 'sine.inOut' }).to(
          this.motion,
          { headRot: 0, duration: 0.35 },
          '<',
        );
        break;
      case 'nod':
        tl.to(this.motion, { nod: 0.16, duration: 0.16, ease: 'sine.inOut' })
          .to(this.motion, { nod: -0.04, duration: 0.18, ease: 'sine.inOut' })
          .to(this.motion, { nod: 0.14, duration: 0.16, ease: 'sine.inOut' })
          .to(this.motion, { nod: 0, duration: 0.22, ease: 'sine.out' });
        break;
      case 'point':
        tl.to(this.arms.r, { u: -1.5, f: -0.08, duration: 0.3, ease: 'back.out(1.4)' })
          .to(this.motion, { bodyRot: 0.03, headRot: 0.06, duration: 0.3 }, 0)
          .to(this.arms.r, { u: -1.42, duration: 0.25, yoyo: true, repeat: 3, ease: 'sine.inOut' })
          .to(this.arms.r, { ...back.r, duration: 0.35 })
          .to(this.motion, { bodyRot: 0, headRot: 0, duration: 0.35 }, '<');
        break;
      case 'walk_in':
      case 'walk_out': {
        const span = 520;
        const from = animation === 'walk_in' ? -dir * span : 0;
        const to = animation === 'walk_in' ? 0 : dir * span;
        this.motion.x = from;
        if (animation === 'walk_in') this.view.alpha = 1;
        const steps = 6;
        const dur = 1.25;
        tl.fromTo(
          this.motion,
          { x: from },
          { x: to, duration: dur, ease: animation === 'walk_in' ? 'power1.out' : 'power1.in' },
        );
        for (let i = 0; i < steps; i++) {
          tl.to(
            this.motion,
            {
              bodyY: -7,
              bodyRot: 0.03 * (i % 2 ? 1 : -1),
              duration: dur / steps / 2,
              ease: 'sine.out',
            },
            (i * dur) / steps,
          ).to(
            this.motion,
            { bodyY: 0, duration: dur / steps / 2, ease: 'sine.in' },
            (i * dur) / steps + dur / steps / 2,
          );
          tl.to(
            this.arms.l,
            { u: 0.14 + (i % 2 ? 0.25 : -0.15), duration: dur / steps },
            (i * dur) / steps,
          );
          tl.to(
            this.arms.r,
            { u: -0.14 + (i % 2 ? 0.15 : -0.25), duration: dur / steps },
            (i * dur) / steps,
          );
        }
        tl.to(this.motion, { bodyRot: 0, duration: 0.15 });
        tl.to(this.arms.l, { ...back.l, duration: 0.2 }, '<').to(
          this.arms.r,
          { ...back.r, duration: 0.2 },
          '<',
        );
        if (animation === 'walk_out') tl.to(this.view, { alpha: 0, duration: 0.25 }, dur - 0.25);
        break;
      }
      case 'celebrate':
        tl.to(this.arms.l, { u: 2.5, f: 0.2, duration: 0.25, ease: 'back.out(1.8)' })
          .to(this.arms.r, { u: -2.5, f: -0.2, duration: 0.25, ease: 'back.out(1.8)' }, 0)
          .to(this.motion, { bodyY: -22, squash: -0.04, duration: 0.22, ease: 'power2.out' }, 0.05)
          .to(this.motion, { bodyY: 0, squash: 0.05, duration: 0.2, ease: 'power2.in' })
          .to(this.motion, { bodyY: -16, squash: -0.03, duration: 0.2, ease: 'power2.out' })
          .to(this.motion, { bodyY: 0, squash: 0, duration: 0.22, ease: 'bounce.out' })
          .to(this.arms.l, { ...back.l, duration: 0.35 })
          .to(this.arms.r, { ...back.r, duration: 0.35 }, '<');
        this.flashSymbol('sparkle', 1.6);
        break;
      case 'shrug':
        tl.to(this.arms.l, { u: 0.55, f: -1.2, duration: 0.25 })
          .to(this.arms.r, { u: -0.55, f: 1.2, duration: 0.25 }, 0)
          .to(this.motion, { headRot: -0.12, bodyY: -4, duration: 0.25 }, 0)
          .to({}, { duration: 0.5 })
          .to(this.arms.l, { ...back.l, duration: 0.3 })
          .to(this.arms.r, { ...back.r, duration: 0.3 }, '<')
          .to(this.motion, { headRot: 0, bodyY: 0, duration: 0.3 }, '<');
        break;
    }
    return new Promise((resolve) => {
      tl.eventCallback('onComplete', () => {
        this.animating = false;
        resolve();
      });
      tl.eventCallback('onInterrupt', () => {
        this.animating = false;
        resolve();
      });
      tl.play();
    });
  }

  /** Point the arm towards a stage point (guide pointing at a button) and hold until {@link play}('idle'). */
  pointAt(point: Point): Promise<void> {
    const local = this.view.toLocal(point);
    const sx = this.armR.root.x;
    const sy = this.shoulderY + 4;
    const ang = Math.atan2(local.x - sx, local.y - sy);
    const u = clamp(-ang, -2.8, 0.4);
    this.animating = true;
    this.lookAt(point);
    return new Promise((resolve) => {
      gsap.to(this.arms.r, {
        u,
        f: -0.05,
        duration: 0.35,
        ease: 'back.out(1.4)',
        onComplete: () => resolve(),
        onInterrupt: () => resolve(),
      });
    });
  }

  lookAt(point: Point): void {
    const local = this.head.toLocal(point);
    const dx = local.x;
    const dy = local.y - this.headCY;
    this.gazeOverride = { x: clamp(dx / 260, -1, 1), y: clamp(dy / 260, -1, 1) };
  }

  /** Release a lookAt (eyes return to the expression's gaze). */
  clearLook(): void {
    this.gazeOverride = null;
  }

  /** Guide entrance: walk in, then wave. */
  async entrance(): Promise<void> {
    await this.play('walk_in');
    await this.play('wave');
  }

  /** Guide exit: wave, then walk out. */
  async exit(): Promise<void> {
    await this.play('wave');
    await this.play('walk_out');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.deps.ticker.remove(this.onTick);
    this.unsubLight?.();
    this.exprTween?.kill();
    gsap.killTweensOf(this.motion);
    gsap.killTweensOf(this.arms.l);
    gsap.killTweensOf(this.arms.r);
    gsap.killTweensOf(this.view);
    if (!this.view.destroyed) {
      this.view.removeFromParent();
      this.view.destroy({ children: true });
    }
  }

  /* ============================================================================================ */

  private applyExpression(e: Expression | ExtendedExpression, durationS: number): void {
    const def = EXPRESSIONS[e];
    this.expression = e;
    const target =
      e === 'angry' || e === 'annoyed' || e === 'impatient'
        ? intensify(def.params, this.intensity)
        : def.params;
    this.symbol = def.symbol;
    if ((e === 'annoyed' || e === 'impatient') && this.intensity >= 3) this.symbol = 'steam';
    this.fidget = def.fidget;
    this.exprTween?.kill();
    const from = this.params;
    if (durationS <= 0) {
      this.params = target;
    } else {
      const s = { t: 0 };
      this.exprTween = gsap.to(s, {
        t: 1,
        duration: durationS,
        ease: 'sine.out',
        onUpdate: () => {
          this.params = lerpParams(from, target, s.t);
        },
      });
    }
    if (!this.animating) {
      const pose = ARM_POSES[def.arms];
      gsap.to(this.arms.l, {
        ...pose.l,
        duration: Math.max(0.01, durationS * 1.2),
        ease: 'sine.inOut',
      });
      gsap.to(this.arms.r, {
        ...pose.r,
        duration: Math.max(0.01, durationS * 1.2),
        ease: 'sine.inOut',
      });
    }
    this.buildSymbols();
  }

  private flashSymbol(sym: ExpressionSymbol, seconds: number): void {
    const prev = this.symbol;
    this.symbol = sym;
    this.buildSymbols();
    setTimeout(() => {
      if (this.destroyed) return;
      this.symbol = prev === sym ? EXPRESSIONS[this.expression].symbol : prev;
      this.buildSymbols();
    }, seconds * 1000);
  }

  private update(dt: number): void {
    if (this.destroyed) return;
    this.elapsed += dt;
    const t = this.elapsed;
    const ms = this.deps.quality.motionScale;
    const p = this.params;

    // Breathing and idle sway.
    const breath = Math.sin(t * 1.7);
    this.upperGroup.scale.y = 1 + 0.012 * breath * ms - this.motion.squash;
    this.upperGroup.scale.x = 1 + this.motion.squash * 0.6;
    let fidgetY = 0;
    let fidgetRot = 0;
    if (this.fidget === 'foot_tap') fidgetY = Math.max(0, Math.sin(t * 7)) * -1.5 * ms;
    if (this.fidget === 'bounce') fidgetY = -Math.abs(Math.sin(t * 3.2)) * 3 * ms;
    if (this.fidget === 'shake') fidgetRot = Math.sin(t * 13) * 0.012 * this.intensity * ms;
    this.figure.y = this.motion.bodyY + fidgetY;
    this.figure.x = this.motion.x;
    this.figure.rotation = this.motion.bodyRot + p.lean + fidgetRot;
    this.head.rotation = p.tilt + this.motion.headRot + Math.sin(t * 0.6) * 0.025 * ms;
    this.head.y = this.neckTop + this.motion.nod * 26 + breath * 0.6 * ms;
    this.head.skew.x = this.motion.nod * 0.1;

    // Blink every 2-6 s (120 ms close/open).
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      this.blink += dt / 0.06;
      if (this.blink >= 2) {
        this.blink = 0;
        this.nextBlink = this.rnd.range(2.2, 5.8);
      }
    }
    const blinkAmt = this.blink <= 0 ? 0 : this.blink < 1 ? this.blink : 2 - this.blink;

    // Lip sync: syllable-like mouth motion at ~7-9 Hz with natural irregularity.
    if (this.talking) {
      const syl = 0.5 + 0.5 * Math.sin(t * 17.3) * Math.sin(t * 5.1 + 1.3);
      this.talk += (clamp(syl * 0.85, 0, 0.75) - this.talk) * Math.min(1, dt * 18);
    } else {
      this.talk += (0 - this.talk) * Math.min(1, dt * 12);
    }

    // Arms.
    this.applyArm(this.armL, this.arms.l);
    this.applyArm(this.armR, this.arms.r);
    if (this.lanternHolder && this.lanternGlow) {
      const lp = this.armL.foreG.toGlobal({ x: 0, y: F_LEN + 6 });
      const local = this.figure.toLocal(lp);
      this.lanternHolder.position.set(local.x, local.y);
      this.lanternHolder.rotation = -this.figure.rotation * 0.5 + Math.sin(t * 1.3) * 0.05 * ms;
      const lights = this.deps.lighting.palette.lights;
      this.lanternGlow.alpha = 0.35 + 0.55 * lights + 0.06 * Math.sin(t * 6.3) * Math.sin(t * 2.9);
    }

    // Rebuild the face only when something visible changed (most idle frames are skipped).
    const gz = this.gazeOverride ?? { x: p.gazeX, y: p.gazeY };
    const sig = `${p.browAngle.toFixed(3)}|${p.browLift.toFixed(2)}|${p.browAsym.toFixed(2)}|${p.eyeOpen.toFixed(3)}|${p.eyeSmile.toFixed(3)}|${p.pupil.toFixed(2)}|${p.smile.toFixed(3)}|${p.mouthOpen.toFixed(3)}|${p.mouthWidth.toFixed(3)}|${p.teeth.toFixed(2)}|${p.blush.toFixed(2)}|${p.flush.toFixed(2)}|${blinkAmt.toFixed(2)}|${this.talk.toFixed(2)}|${gz.x.toFixed(2)}|${gz.y.toFixed(2)}`;
    if (sig !== this.featureSig) {
      this.featureSig = sig;
      this.drawFeatures(p, blinkAmt, this.talk);
    }
    this.updateSymbols(dt);
  }

  private applyArm(arm: Arm, s: ArmState): void {
    const sideSign = arm.side;
    arm.root.rotation = s.u * (sideSign === -1 ? 1 : 1);
    arm.fore.rotation = s.f;
  }

  /* -------------------------------- drawing ------------------------------------------------- */

  private makeArm(side: -1 | 1): Arm {
    const root = new Container();
    root.position.set(side * (this.sw - 3), this.shoulderY + 4);
    const upper = new Graphics();
    const fore = new Container();
    fore.position.set(0, U_LEN);
    const foreG = new Graphics();
    fore.addChild(foreG);
    root.addChild(upper, fore);
    return { root, upper, fore, foreG, side };
  }

  private drawShadow(dir: number, length: number, alpha: number, color: number): void {
    const g = this.shadow;
    g.clear();
    const w = this.hw * 1.5;
    softShadow(g, 0, 0, w, 10, color, Math.min(0.5, alpha * 1.4));
    const len = 1 + length * 0.8;
    g.ellipse(dir * w * length * 0.5, 0, w * len, 7).fill({
      color,
      alpha: Math.min(0.25, alpha * 0.6),
    });
  }

  private drawBody(): void {
    const a = this.appearance;
    const { sw, ww, hw, hipY, waistY, shoulderY, neckTop } = this;
    const g = this.lowerG;
    g.clear();
    const skin = a.skin;
    const skinShade = darken(skin, 0.18);

    // Feet and chappals.
    for (const fx of [-13, 13]) {
      g.ellipse(fx * a.build, -3, 12, 5).fill(darken(MELA.wood, 0.25));
      g.ellipse(fx * a.build, -6, 9, 5).fill(skin);
      g.moveTo(fx * a.build - 6, -6)
        .quadraticCurveTo(fx * a.build, -11, fx * a.build + 6, -6)
        .stroke({ width: 2.4, color: darken(MELA.wood, 0.1) });
    }

    const lc = a.lowerColor;
    const lb = a.lowerBorder;
    const ankle = -10;
    switch (a.lower) {
      case 'sari':
      case 'lehenga': {
        g.moveTo(-ww, waistY)
          .bezierCurveTo(-hw * 1.05, hipY, -hw * 1.2, -60, -hw * 1.32, ankle)
          .quadraticCurveTo(0, ankle + 6, hw * 1.32, ankle)
          .bezierCurveTo(hw * 1.2, -60, hw * 1.05, hipY, ww, waistY)
          .closePath()
          .fill(
            vgrad([
              [0, lighten(lc, 0.08)],
              [1, darken(lc, 0.18)],
            ]),
          );
        // Front pleats.
        for (let k = -3; k <= 3; k++) {
          g.moveTo(k * 2.5, hipY + 10)
            .quadraticCurveTo(k * 5, -70, k * 7.5, ankle + 2)
            .stroke({ width: 1.6, color: darken(lc, 0.28), alpha: 0.7 });
        }
        // Border band with motif dots.
        g.moveTo(-hw * 1.3, ankle - 2)
          .quadraticCurveTo(0, ankle + 4, hw * 1.3, ankle - 2)
          .lineTo(hw * 1.24, ankle - 16)
          .quadraticCurveTo(0, ankle - 10, -hw * 1.24, ankle - 16)
          .closePath()
          .fill(lb);
        for (let k = -5; k <= 5; k++)
          g.circle(k * hw * 0.22, ankle - 8, 1.8).fill(lighten(lb, 0.5));
        break;
      }
      case 'nauvari': {
        for (const sx of [-1, 1]) {
          g.moveTo(0, hipY + 6)
            .lineTo(sx * hw * 1.05, waistY + 4)
            .quadraticCurveTo(sx * hw * 1.25, -80, sx * hw * 0.85, -40)
            .lineTo(sx * hw * 0.2, -40)
            .closePath()
            .fill(
              vgrad([
                [0, lc],
                [1, darken(lc, 0.2)],
              ]),
            );
          g.moveTo(sx * hw * 0.85, -40)
            .lineTo(sx * hw * 0.2, -40)
            .stroke({ width: 6, color: lb });
          // Calves.
          g.roundRect(sx * 13 * a.build - 6, -42, 12, 36, 5).fill(skin);
        }
        g.moveTo(-hw * 0.9, waistY + 10)
          .lineTo(hw * 0.5, -60)
          .stroke({ width: 5, color: lb, alpha: 0.9 });
        break;
      }
      case 'mekhela': {
        g.moveTo(-ww, waistY)
          .lineTo(-hw * 1.1, ankle)
          .lineTo(hw * 1.1, ankle)
          .lineTo(ww, waistY)
          .closePath()
          .fill(
            vgrad([
              [0, lc],
              [1, darken(lc, 0.15)],
            ]),
          );
        g.rect(-hw * 1.08, ankle - 30, hw * 2.16, 16).fill(lb);
        for (let k = -4; k <= 4; k++) {
          const x = k * hw * 0.24;
          g.poly([x - 4, ankle - 22, x, ankle - 28, x + 4, ankle - 22, x, ankle - 16]).fill(
            lighten(lb, 0.55),
          );
        }
        g.rect(-hw * 1.1, ankle - 8, hw * 2.2, 5).fill(lb);
        break;
      }
      case 'dhoti': {
        for (const sx of [-1, 1])
          g.roundRect(sx * 13 * a.build - 6.5, -60, 13, 56, 6).fill(skinShade);
        g.moveTo(-ww, waistY)
          .bezierCurveTo(-hw * 1.15, hipY, -hw * 1.2, -80, -hw * 1.05, -52)
          .lineTo(-4, -64)
          .lineTo(4, -64)
          .lineTo(hw * 1.05, -52)
          .bezierCurveTo(hw * 1.2, -80, hw * 1.15, hipY, ww, waistY)
          .closePath()
          .fill(
            vgrad([
              [0, lc],
              [1, darken(lc, 0.12)],
            ]),
          );
        for (let k = -2; k <= 2; k++)
          g.moveTo(k * 3, hipY + 4)
            .quadraticCurveTo(k * 2, -90, k * 1.5, -64)
            .stroke({ width: 1.5, color: darken(lc, 0.25) });
        g.moveTo(-hw * 1.05, -52)
          .lineTo(-4, -64)
          .stroke({ width: 3, color: lb });
        g.moveTo(hw * 1.05, -52)
          .lineTo(4, -64)
          .stroke({ width: 3, color: lb });
        break;
      }
      case 'mundu': {
        g.moveTo(-ww, waistY)
          .lineTo(-hw * 1.08, ankle)
          .lineTo(hw * 1.08, ankle)
          .lineTo(ww, waistY)
          .closePath()
          .fill(
            vgrad([
              [0, lc],
              [1, darken(lc, 0.12)],
            ]),
          );
        g.rect(-hw * 1.08, ankle - 12, hw * 2.16, 7).fill(lb);
        g.moveTo(hw * 0.35, waistY + 2)
          .lineTo(hw * 0.45, ankle)
          .stroke({ width: 5, color: lb });
        break;
      }
      case 'salwar': {
        for (const sx of [-1, 1]) {
          g.moveTo(sx * 2, hipY)
            .quadraticCurveTo(sx * hw * 1.35, -70, sx * hw * 0.65, -12)
            .lineTo(sx * hw * 0.2, -12)
            .quadraticCurveTo(sx * 6, -60, sx * 2, hipY)
            .fill(
              vgrad([
                [0, lc],
                [1, darken(lc, 0.15)],
              ]),
            );
          g.roundRect(sx * hw * 0.42 - 9, -16, 18, 7, 3).fill(lb);
        }
        break;
      }
      case 'pants': {
        for (const sx of [-1, 1]) {
          g.moveTo(sx * 1, waistY + 6)
            .lineTo(sx * hw, waistY + 6)
            .lineTo(sx * (hw * 0.62), -8)
            .lineTo(sx * 4, -8)
            .closePath()
            .fill(
              vgrad([
                [0, lc],
                [1, darken(lc, 0.2)],
              ]),
            );
          g.moveTo(sx * hw * 0.55, hipY)
            .lineTo(sx * hw * 0.45, -12)
            .stroke({ width: 1.2, color: lighten(lc, 0.2), alpha: 0.5 });
        }
        break;
      }
    }

    // Torso + top garment.
    const t = this.torsoG;
    t.clear();
    const uc = a.upperColor;
    const trim = a.upperTrim;
    const top = shoulderY;
    const neckW = 9;
    let hemY = waistY + 4;
    let hemHalf = ww * 1.04;
    if (a.upper === 'kurta') {
      hemY = hipY + 46;
      hemHalf = hw * 1.18;
    } else if (a.upper === 'kurta_long' || a.upper === 'kameez') {
      hemY = -72;
      hemHalf = hw * (a.upper === 'kameez' ? 1.38 : 1.25);
    } else if (a.upper === 'shirt' || a.upper === 'vest_shirt') {
      hemY = hipY + 14;
      hemHalf = hw * 1.06;
    }
    // Neck.
    t.roundRect(-neckW, neckTop - 6, neckW * 2, shoulderY - neckTop + 14, 6).fill(skinShade);
    t.moveTo(-sw - 1, top + 12)
      .bezierCurveTo(-sw - 2, top - 1, -sw + 5, top - 7, -sw + 15, top - 7)
      .lineTo(-neckW - 3, top - 8)
      .quadraticCurveTo(0, top + (a.upper === 'blouse' ? 12 : 4), neckW + 3, top - 8)
      .lineTo(sw - 15, top - 7)
      .bezierCurveTo(sw - 5, top - 7, sw + 2, top - 1, sw + 1, top + 12)
      .bezierCurveTo(sw * 0.96, waistY - 30, ww * 1.02, waistY - 10, hemHalf * 0.98, hemY)
      .quadraticCurveTo(0, hemY + 4, -hemHalf * 0.98, hemY)
      .bezierCurveTo(-ww * 1.02, waistY - 10, -sw * 0.96, waistY - 30, -sw - 1, top + 12)
      .closePath()
      .fill(
        vgrad([
          [0, lighten(uc, 0.1)],
          [1, darken(uc, 0.18)],
        ]),
      );
    // Side shading for volume.
    t.moveTo(sw * 0.55, top)
      .quadraticCurveTo(sw * 0.9, waistY - 20, hemHalf * 0.9, hemY)
      .lineTo(hemHalf * 0.98, hemY)
      .bezierCurveTo(ww, waistY - 10, sw, waistY - 30, sw, top + 6)
      .closePath()
      .fill({
        color: 0x000000,
        alpha: 0.1,
      });
    // Neckline trim.
    t.moveTo(-neckW - 3, top - 7)
      .quadraticCurveTo(0, top + (a.upper === 'blouse' ? 12 : 4), neckW + 3, top - 7)
      .stroke({ width: 3, color: trim });
    if (a.upper === 'blouse' && a.drape !== 'pallu' && a.drape !== 'chador') {
      // Midriff band (covered by the pallu/chador when present).
      t.rect(-ww * 0.95, waistY - 14, ww * 1.9, 10).fill(skinShade);
      t.moveTo(-ww * 0.95, waistY - 14)
        .lineTo(ww * 0.95, waistY - 14)
        .stroke({ width: 2.5, color: trim });
    }
    if (a.upper === 'kurta' || a.upper === 'kurta_long' || a.upper === 'kameez') {
      t.moveTo(0, top + 2)
        .lineTo(0, top + 40)
        .stroke({ width: 2, color: darken(uc, 0.25) });
      for (let k = 0; k < 4; k++) t.circle(0, top + 10 + k * 9, 1.8).fill(trim);
      t.moveTo(-hemHalf * 0.98, hemY)
        .quadraticCurveTo(0, hemY + 4, hemHalf * 0.98, hemY)
        .stroke({ width: 4, color: trim });
      if (a.upper === 'kameez') {
        for (let k = -3; k <= 3; k++) t.circle(k * 5, top + 6 + Math.abs(k) * 1.5, 1.8).fill(trim);
      }
    }
    if (a.upper === 'shirt' || a.upper === 'vest_shirt') {
      t.poly([-neckW - 3, top - 7, -2, top + 8, -neckW - 10, top + 2]).fill(lighten(uc, 0.2));
      t.poly([neckW + 3, top - 7, 2, top + 8, neckW + 10, top + 2]).fill(lighten(uc, 0.2));
      t.moveTo(0, top + 6)
        .lineTo(0, hemY)
        .stroke({ width: 1.5, color: darken(uc, 0.2) });
      for (let k = 0; k < 5; k++) t.circle(2.5, top + 14 + k * 14, 1.6).fill(darken(uc, 0.3));
      if (a.upper === 'vest_shirt') {
        for (const sx of [-1, 1]) {
          t.moveTo(sx * 3, top + 6)
            .lineTo(sx * (sw - 6), top + 2)
            .bezierCurveTo(
              sx * sw * 0.96,
              waistY - 20,
              sx * ww,
              waistY,
              sx * hemHalf * 0.95,
              hemY - 2,
            )
            .lineTo(sx * 6, hemY + 2)
            .closePath()
            .fill(trim);
        }
      }
    }

    // Drape.
    const d = this.drapeG;
    d.clear();
    const dc = a.drapeColor;
    switch (a.drape) {
      case 'pallu':
        d.moveTo(-ww * 1.05, waistY + 18)
          .lineTo(-ww * 0.2, waistY + 24)
          .lineTo(sw * 0.9, top + 2)
          .lineTo(sw * 0.25, top - 6)
          .closePath()
          .fill(
            vgrad([
              [0, lighten(dc, 0.1)],
              [1, darken(dc, 0.12)],
            ]),
          );
        d.moveTo(-ww * 0.2, waistY + 24)
          .lineTo(sw * 0.9, top + 2)
          .stroke({ width: 6, color: a.lowerBorder });
        for (let k = 1; k < 4; k++)
          d.moveTo(-ww + k * 8, waistY + 18)
            .lineTo(sw * 0.3 + k * 9, top - 2)
            .stroke({ width: 1.2, color: darken(dc, 0.3), alpha: 0.5 });
        break;
      case 'chador':
        d.moveTo(ww * 1.05, waistY + 10)
          .lineTo(ww * 0.25, waistY + 16)
          .lineTo(-sw * 0.9, top + 2)
          .lineTo(-sw * 0.2, top - 6)
          .closePath()
          .fill(dc);
        d.moveTo(ww * 0.25, waistY + 16)
          .lineTo(-sw * 0.9, top + 2)
          .stroke({ width: 7, color: a.lowerBorder });
        for (let k = 0; k < 5; k++) {
          const tt = (k + 0.5) / 5;
          const x = ww * 0.25 + (-sw * 0.9 - ww * 0.25) * tt;
          const y = waistY + 16 + (top + 2 - waistY - 16) * tt;
          d.poly([x - 3, y + 6, x, y + 1, x + 3, y + 6]).fill(lighten(a.lowerBorder, 0.4));
        }
        break;
      case 'dupatta':
        d.moveTo(-sw + 2, top + 2)
          .quadraticCurveTo(0, top + 46, sw - 2, top + 2)
          .lineTo(sw + 2, top + 14)
          .quadraticCurveTo(0, top + 60, -sw - 2, top + 14)
          .closePath()
          .fill(dc);
        for (const sx of [-1, 1])
          d.roundRect(sx * (sw + 2) - 7, top + 6, 14, -top + hipY - 6, 6).fill(darken(dc, 0.12));
        d.moveTo(-sw - 2, top + 14)
          .quadraticCurveTo(0, top + 60, sw + 2, top + 14)
          .stroke({ width: 2.5, color: lighten(dc, 0.35) });
        break;
      case 'gamcha': {
        d.roundRect(-sw * 0.65, top - 4, 18, 70, 6).fill(dc);
        for (let k = 0; k < 7; k++)
          d.moveTo(-sw * 0.65, top + 6 + k * 9)
            .lineTo(-sw * 0.65 + 18, top + 6 + k * 9)
            .stroke({ width: 1.5, color: lighten(dc, 0.5), alpha: 0.8 });
        for (let k = 0; k < 2; k++)
          d.moveTo(-sw * 0.65 + 6 + k * 6, top - 4)
            .lineTo(-sw * 0.65 + 6 + k * 6, top + 66)
            .stroke({ width: 1.5, color: lighten(dc, 0.5), alpha: 0.8 });
        break;
      }
      case 'shawl':
        d.moveTo(-sw - 6, top + 22)
          .quadraticCurveTo(-sw, top - 8, 0, top - 2)
          .quadraticCurveTo(sw, top - 8, sw + 6, top + 22)
          .lineTo(sw * 0.55, top + 48)
          .quadraticCurveTo(0, top + 30, -sw * 0.55, top + 48)
          .closePath()
          .fill(
            vgrad([
              [0, lighten(dc, 0.1)],
              [1, darken(dc, 0.15)],
            ]),
          );
        for (let k = -6; k <= 6; k++)
          d.moveTo(k * 5, top + 34 + Math.abs(k) * 1.6)
            .lineTo(k * 5, top + 40 + Math.abs(k) * 1.6)
            .stroke({ width: 1.4, color: lighten(dc, 0.4) });
        break;
      case 'none':
        break;
    }

    this.drawArm(this.armL);
    this.drawArm(this.armR);
  }

  private drawArm(arm: Arm): void {
    const a = this.appearance;
    const sleeveFull = a.upper !== 'blouse' && a.upper !== 'vest_shirt';
    const sleeve = a.upper === 'vest_shirt' ? a.upperColor : a.upperColor;
    const skin = a.skin;
    const w = 13 * a.build;
    const u = arm.upper;
    u.clear();
    u.roundRect(-w / 2, -4, w, U_LEN + 8, w / 2).fill(skin);
    const sleeveLen = sleeveFull
      ? U_LEN + 4
      : a.upper === 'vest_shirt'
        ? U_LEN * 0.55
        : U_LEN * 0.42;
    u.roundRect(-w / 2 - 1.5, -6, w + 3, sleeveLen + 6, w / 2).fill(darken(sleeve, 0.05));
    u.moveTo(-w / 2 - 1.5, sleeveLen - 1)
      .lineTo(w / 2 + 1.5, sleeveLen - 1)
      .stroke({ width: 2.5, color: a.upperTrim });
    const f = arm.foreG;
    f.clear();
    const fw = w * 0.92;
    f.roundRect(-fw / 2, -4, fw, F_LEN + 4, fw / 2).fill(skin);
    if (sleeveFull) {
      f.roundRect(-fw / 2 - 1.5, -6, fw + 3, F_LEN - 4, fw / 2).fill(darken(sleeve, 0.08));
      f.moveTo(-fw / 2 - 1.5, F_LEN - 10)
        .lineTo(fw / 2 + 1.5, F_LEN - 10)
        .stroke({ width: 2.5, color: a.upperTrim });
    }
    if (a.bangles) {
      for (let k = 0; k < 3; k++)
        f.moveTo(-fw / 2 - 1, F_LEN - 10 + k * 3.2)
          .lineTo(fw / 2 + 1, F_LEN - 10 + k * 3.2)
          .stroke({ width: 2.2, color: k === 1 ? MELA.vermilion : MELA.brass });
    }
    // Hand with thumb.
    f.circle(0, F_LEN + 6, 8.5 * a.build).fill(skin);
    f.ellipse(-arm.side * 6, F_LEN + 2, 3.5, 5).fill(skin);
    f.circle(0, F_LEN + 6, 8.5 * a.build).stroke({
      width: 1,
      color: darken(skin, 0.25),
      alpha: 0.5,
    });
  }

  private drawHead(): void {
    const a = this.appearance;
    const cy = this.headCY;
    const skin = a.skin;
    const hb = this.hairBackG;
    const hf = this.hairFrontG;
    hb.clear();
    hf.clear();
    const hair = a.hair;
    const hairDark = darken(hair, 0.2);

    // Back hair.
    switch (a.hairStyle) {
      case 'bun':
        hb.circle(0, cy - 4, 43).fill(hairDark);
        hb.circle(0, cy - 46, 19).fill(hair);
        hb.circle(-5, cy - 50, 7).fill({ color: lighten(hair, 0.25), alpha: 0.5 });
        break;
      case 'braid':
        hb.circle(0, cy - 4, 43).fill(hairDark);
        for (let k = 0; k < 9; k++)
          hb.ellipse(30 + k * 1.2, cy + 26 + k * 13, 8 - k * 0.3, 8).fill(k % 2 ? hair : hairDark);
        hb.circle(41, cy + 26 + 9 * 13, 4).fill(MELA.vermilion);
        break;
      case 'long_open':
        hb.roundRect(-46, cy - 40, 92, 110, 40).fill(hairDark);
        break;
      case 'bob':
        hb.roundRect(-47, cy - 44, 94, 84, 38).fill(hairDark);
        break;
      default:
        break;
    }
    if (a.headwear === 'pallu_head') {
      hb.moveTo(-50, cy + 40)
        .quadraticCurveTo(-56, cy - 50, 0, cy - 56)
        .quadraticCurveTo(56, cy - 50, 50, cy + 40)
        .lineTo(60, cy + 80)
        .lineTo(-60, cy + 80)
        .closePath()
        .fill(darken(a.headwearColor, 0.12));
    }

    // Face, ears.
    const f = this.faceG;
    f.clear();
    for (const sx of [-1, 1]) {
      f.ellipse(sx * 39, cy + 4, 8, 11).fill(darken(skin, 0.06));
      f.ellipse(sx * 39, cy + 4, 4, 6).fill(darken(skin, 0.2));
      if (a.earrings) {
        f.circle(sx * 39, cy + 18, 3.2).fill(MELA.brass);
        if (a.feminine) f.circle(sx * 39, cy + 24, 2.2).fill(MELA.brassLight);
      }
    }
    f.ellipse(0, cy - 2, 39, 44).fill(skin);
    f.ellipse(0, cy + 14, 33, 32).fill(skin);
    // Soft forehead light and jaw shade.
    f.ellipse(-8, cy - 22, 20, 12).fill({ color: 0xffffff, alpha: 0.08 });
    f.ellipse(0, cy + 44, 22, 6).fill({ color: darken(skin, 0.3), alpha: 0.18 });

    // Front hair / headwear.
    const parting = a.feminine;
    switch (a.hairStyle) {
      case 'bun':
      case 'braid':
      case 'long_open':
      case 'bob':
      case 'short':
        hf.moveTo(-41, cy + (a.hairStyle === 'bob' ? 18 : 2))
          .bezierCurveTo(-46, cy - 40, -20, cy - 52, 0, cy - 50)
          .bezierCurveTo(20, cy - 52, 46, cy - 40, 41, cy + (a.hairStyle === 'bob' ? 18 : 2))
          .quadraticCurveTo(38, cy - 18, parting ? 24 : 30, cy - 26)
          .quadraticCurveTo(parting ? 10 : 6, cy - 34, parting ? 0 : -18, cy - (parting ? 36 : 30))
          .quadraticCurveTo(parting ? -10 : -30, cy - 34, -26, cy - 26)
          .quadraticCurveTo(-38, cy - 18, -41, cy + (a.hairStyle === 'bob' ? 18 : 2))
          .closePath()
          .fill(hair);
        hf.moveTo(-26, cy - 40)
          .quadraticCurveTo(-10, cy - 50, 6, cy - 48)
          .stroke({ width: 3, color: lighten(hair, 0.3), alpha: 0.4 });
        if (parting && a.bindi)
          hf.moveTo(0, cy - 36)
            .lineTo(0, cy - 48)
            .stroke({ width: 2, color: MELA.vermilion, alpha: 0.85 });
        break;
      case 'bald_sides':
        for (const sx of [-1, 1]) {
          hf.moveTo(sx * 41, cy + 2)
            .quadraticCurveTo(sx * 46, cy - 24, sx * 30, cy - 34)
            .quadraticCurveTo(sx * 36, cy - 14, sx * 36, cy + 4)
            .closePath()
            .fill(hair);
        }
        break;
      default:
        break;
    }
    const hw = a.headwearColor;
    switch (a.headwear) {
      case 'pagri':
        hf.moveTo(-44, cy - 14)
          .bezierCurveTo(-52, cy - 62, 52, cy - 62, 44, cy - 14)
          .quadraticCurveTo(0, cy - 30, -44, cy - 14)
          .fill(
            vgrad([
              [0, lighten(hw, 0.15)],
              [1, darken(hw, 0.12)],
            ]),
          );
        for (let k = 0; k < 4; k++)
          hf.moveTo(-42 + k * 4, cy - 18 - k * 9)
            .quadraticCurveTo(0, cy - 40 - k * 9, 42 - k * 4, cy - 18 - k * 9)
            .stroke({ width: 2.2, color: darken(hw, 0.25), alpha: 0.7 });
        hf.moveTo(-30, cy - 30)
          .quadraticCurveTo(0, cy - 66, 30, cy - 44)
          .stroke({ width: 5, color: lighten(hw, 0.25), alpha: 0.6 });
        hf.ellipse(46, cy - 10, 7, 16).fill(darken(hw, 0.1));
        break;
      case 'turban':
        hf.moveTo(-43, cy - 10)
          .bezierCurveTo(-48, cy - 50, -20, cy - 70, 0, cy - 72)
          .bezierCurveTo(20, cy - 70, 48, cy - 50, 43, cy - 10)
          .quadraticCurveTo(0, cy - 26, -43, cy - 10)
          .fill(
            vgrad([
              [0, lighten(hw, 0.12)],
              [1, darken(hw, 0.15)],
            ]),
          );
        hf.moveTo(-38, cy - 16)
          .quadraticCurveTo(-6, cy - 40, 10, cy - 70)
          .stroke({ width: 2.5, color: darken(hw, 0.3), alpha: 0.7 });
        hf.moveTo(38, cy - 16)
          .quadraticCurveTo(6, cy - 40, -10, cy - 70)
          .stroke({ width: 2.5, color: darken(hw, 0.3), alpha: 0.7 });
        break;
      case 'cap':
        hf.moveTo(-40, cy - 18)
          .bezierCurveTo(-44, cy - 62, 44, cy - 62, 40, cy - 18)
          .closePath()
          .fill(hw);
        hf.ellipse(0, cy - 18, 46, 9).fill(darken(hw, 0.2));
        hf.circle(0, cy - 56, 3).fill(darken(hw, 0.25));
        break;
      case 'topi':
        hf.moveTo(-36, cy - 26)
          .lineTo(-30, cy - 48)
          .quadraticCurveTo(0, cy - 56, 30, cy - 48)
          .lineTo(36, cy - 26)
          .quadraticCurveTo(0, cy - 34, -36, cy - 26)
          .fill(hw);
        hf.moveTo(-30, cy - 34)
          .quadraticCurveTo(0, cy - 42, 30, cy - 34)
          .stroke({ width: 1.5, color: darken(hw, 0.15) });
        break;
      case 'gajra':
        for (let k = 0; k < 9; k++) {
          const ang = Math.PI + (k / 8) * Math.PI;
          hf.circle(Math.cos(ang) * 21, cy - 46 + Math.sin(ang) * 13 + 6, 4).fill(hw);
          hf.circle(Math.cos(ang) * 21, cy - 46 + Math.sin(ang) * 13 + 6, 1.4).fill(0xf2e8a0);
        }
        break;
      case 'pallu_head':
        hf.moveTo(-46, cy + 30)
          .quadraticCurveTo(-50, cy - 46, 0, cy - 52)
          .quadraticCurveTo(50, cy - 46, 46, cy + 30)
          .quadraticCurveTo(38, cy - 30, 0, cy - 34)
          .quadraticCurveTo(-38, cy - 30, -46, cy + 30)
          .fill(hw);
        hf.moveTo(-40, cy - 30)
          .quadraticCurveTo(0, cy - 44, 40, cy - 30)
          .stroke({ width: 3, color: a.upperTrim });
        break;
      default:
        break;
    }

    // Glasses.
    const gl = this.glassesG;
    gl.clear();
    if (a.glasses) {
      for (const sx of [-1, 1]) {
        gl.circle(sx * 15, cy + 1, 11.5).stroke({ width: 2.2, color: 0x3a2a24 });
        gl.moveTo(sx * 15 - 6, cy - 6)
          .lineTo(sx * 15 - 2, cy - 8)
          .stroke({ width: 1.6, color: 0xffffff, alpha: 0.6 });
      }
      gl.moveTo(-4, cy)
        .quadraticCurveTo(0, cy - 3, 4, cy)
        .stroke({ width: 2, color: 0x3a2a24 });
      gl.moveTo(-26, cy - 1)
        .lineTo(-38, cy - 2)
        .stroke({ width: 2, color: 0x3a2a24 });
      gl.moveTo(26, cy - 1)
        .lineTo(38, cy - 2)
        .stroke({ width: 2, color: 0x3a2a24 });
    }
  }

  /** Eyes, brows, nose, mouth, cheeks, facial hair; redrawn every frame from parameters (cheap). */
  private drawFeatures(p: ExpressionParams, blink: number, talk: number): void {
    const a = this.appearance;
    const g = this.featuresG;
    g.clear();
    const cy = this.headCY;
    const skin = a.skin;
    const ink = 0x2a1a14;
    const browCol = a.hair === 0xd8d4d0 ? 0x9a928c : darken(a.hair, 0.1);
    const gaze = this.gazeOverride ?? { x: p.gazeX, y: p.gazeY };

    // Flush (anger) and blush (warmth): colour is an extra cue only.
    if (p.flush > 0.01)
      g.ellipse(0, cy - 8, 32, 26).fill({ color: 0xd83a2a, alpha: p.flush * 0.22 });
    if (p.blush > 0.01)
      for (const sx of [-1, 1])
        g.ellipse(sx * 24, cy + 14, 8, 5).fill({ color: 0xf06a6a, alpha: p.blush * 0.42 });

    // Stress lines on the forehead (shape cue for anger, readable without colour).
    if (p.browAngle > 0.25) {
      const n = p.browAngle > 0.45 ? 3 : 2;
      for (let k = 0; k < n; k++)
        g.moveTo(-6 + k * 6 - 3, cy - 30 - k)
          .lineTo(-6 + k * 6 + 3, cy - 33 - k)
          .stroke({ width: 1.6, color: darken(skin, 0.35), alpha: 0.8 });
    }

    // Beard sits under the mouth.
    if (a.facialHair === 'beard') {
      g.moveTo(-36, cy + 4)
        .quadraticCurveTo(-36, cy + 52, 0, cy + 58)
        .quadraticCurveTo(36, cy + 52, 36, cy + 4)
        .quadraticCurveTo(30, cy + 30, 0, cy + 32)
        .quadraticCurveTo(-30, cy + 30, -36, cy + 4)
        .fill(a.hair);
    } else if (a.facialHair === 'stubble') {
      g.ellipse(0, cy + 30, 26, 16).fill({ color: darken(skin, 0.3), alpha: 0.18 });
    }

    // Eyes.
    const open = p.eyeOpen * (1 - blink);
    for (const sx of [-1, 1] as const) {
      const ex = sx * 15;
      const ey = cy + 1;
      const ry = 9.5 * Math.max(1, p.eyeOpen);
      if (open < 0.12) {
        // Closed: happy closed eyes curve up (∩), blinks are flat lines.
        const up = p.eyeSmile > 0.5 ? -4 : 1;
        g.moveTo(ex - 8, ey + 1)
          .quadraticCurveTo(ex, ey + up, ex + 8, ey + 1)
          .stroke({ width: 2.8, color: ink, cap: 'round' });
        continue;
      }
      g.ellipse(ex, ey, 8.2, ry).fill(0xffffff);
      const ix = ex + gaze.x * 3;
      const iy = ey + gaze.y * 3;
      g.circle(ix, iy, 6.6).fill(0x4a2c1a);
      g.circle(ix, iy, 6.6).stroke({ width: 1, color: 0x2a160c });
      g.circle(ix, iy, 3.3 * p.pupil).fill(0x0e0806);
      g.circle(ix - 2.2, iy - 2.6, 2.1).fill(0xffffff);
      g.circle(ix + 2, iy + 2, 0.9).fill(0xffffff);
      // Upper lid (skin) cut by openness and slanted by the brow angle (angry inner corners down).
      const lidBase = ey - ry + (1 - Math.min(open, 1)) * ry * 1.7;
      const slope = sx * -p.browAngle * 0.75;
      const lidAt = (x: number): number => lidBase + slope * (x - ex);
      g.poly([
        ex - 12,
        ey - ry - 6,
        ex + 12,
        ey - ry - 6,
        ex + 12,
        lidAt(ex + 12),
        ex - 12,
        lidAt(ex - 12),
      ]).fill(skin);
      // Lash line along the lid (follows the eye top when fully open).
      if (open >= 0.98 && Math.abs(p.browAngle) < 0.05) {
        openArc(g, ex, ey, 8.6, Math.PI * 1.08, Math.PI * 1.92).stroke({
          width: 2.6,
          color: ink,
          cap: 'round',
        });
      } else {
        g.moveTo(ex - 8.5, lidAt(ex - 8.5))
          .lineTo(ex + 8.5, lidAt(ex + 8.5))
          .stroke({ width: 2.6, color: ink, cap: 'round' });
      }
      if (a.feminine)
        g.moveTo(ex + sx * 8, lidAt(ex + sx * 8))
          .lineTo(ex + sx * 11, lidAt(ex + sx * 8) - 3)
          .stroke({ width: 1.8, color: ink, cap: 'round' });
      // Smiling eyes: cheeks push the lower lid up.
      if (p.eyeSmile > 0.02) g.ellipse(ex, ey + ry * (1.75 - p.eyeSmile * 0.85), 11, 8).fill(skin);
      // Elder crow's feet.
      if (a.age > 0.6)
        g.moveTo(ex + sx * 11, ey + 2)
          .lineTo(ex + sx * 15, ey + 4)
          .stroke({ width: 1.2, color: darken(skin, 0.3), alpha: 0.7 });
    }

    // Brows.
    for (const sx of [-1, 1] as const) {
      const ex = sx * 15;
      const lift = p.browLift + (sx === 1 ? p.browAsym : -p.browAsym * 0.3);
      const by = cy - 15 - lift;
      const inner = ex - sx * 9;
      const outer = ex + sx * 10;
      g.moveTo(outer, by + 1)
        .quadraticCurveTo(ex, by - 4, inner, by + p.browAngle * 14 - (p.browAngle < 0 ? 0 : 0))
        .stroke({ width: 4.6, color: browCol, cap: 'round' });
    }

    // Nose.
    g.moveTo(-3.5, cy + 15)
      .quadraticCurveTo(0, cy + 19, 3.5, cy + 15)
      .stroke({ width: 2, color: darken(skin, 0.3), cap: 'round' });
    g.moveTo(0, cy + 4)
      .quadraticCurveTo(-2, cy + 10, -1.5, cy + 13)
      .stroke({ width: 1.4, color: darken(skin, 0.18), alpha: 0.7 });
    if (a.noseRing) g.circle(-5, cy + 17, 3).stroke({ width: 1.4, color: MELA.brass });
    if (a.bindi) g.circle(0, cy - 21, 2.8).fill(MELA.kumkum);
    if (a.tilak) {
      g.moveTo(0, cy - 34)
        .lineTo(0, cy - 20)
        .stroke({ width: 3, color: MELA.saffron });
      g.circle(0, cy - 19, 2).fill(MELA.kumkum);
    }

    // Mouth.
    const my = cy + 27;
    const mw = 11 * p.mouthWidth;
    const o = clamp(p.mouthOpen + talk * (1 - p.mouthOpen * 0.5), 0, 1);
    const s = p.smile;
    const lip = 0x8a3a32;
    if (o > 0.06) {
      const depth = 4 + o * 13;
      g.moveTo(-mw, my - s * 1.5)
        .quadraticCurveTo(0, my - 2 - s * 2 + (s < 0 ? 3 : 0), mw, my - s * 1.5)
        .quadraticCurveTo(0, my + depth + s * 4, -mw, my - s * 1.5)
        .fill(0x5a1a1c);
      if (p.teeth > 0.3)
        g.moveTo(-mw * 0.8, my - s * 1.2)
          .quadraticCurveTo(0, my + 1, mw * 0.8, my - s * 1.2)
          .lineTo(mw * 0.7, my + 2)
          .quadraticCurveTo(0, my + 4, -mw * 0.7, my + 2)
          .closePath()
          .fill(0xfaf6f0);
      g.ellipse(0, my + depth * 0.7, mw * 0.45, depth * 0.22).fill(0xd9746a);
      g.moveTo(-mw, my - s * 1.5)
        .quadraticCurveTo(0, my + depth + s * 4, mw, my - s * 1.5)
        .stroke({ width: 1.6, color: lip });
    } else {
      g.moveTo(-mw, my - s * 2)
        .quadraticCurveTo(0, my + s * 7, mw, my - s * 2)
        .stroke({ width: 2.8, color: lip, cap: 'round' });
      if (s > 0.6)
        for (const sx of [-1, 1])
          g.moveTo(sx * (mw + 1), my - s * 2 - 1)
            .lineTo(sx * (mw + 3), my - s * 2 - 3)
            .stroke({ width: 1.6, color: lip, cap: 'round' });
    }
    if (a.age > 0.6)
      for (const sx of [-1, 1])
        g.moveTo(sx * (mw + 6), my - 8)
          .quadraticCurveTo(sx * (mw + 9), my - 2, sx * (mw + 6), my + 4)
          .stroke({ width: 1.3, color: darken(skin, 0.28), alpha: 0.7 });
    if (a.facialHair === 'moustache' || a.facialHair === 'beard') {
      g.moveTo(-15, my - 3)
        .quadraticCurveTo(-8, my - 11, 0, my - 7)
        .quadraticCurveTo(8, my - 11, 15, my - 3)
        .quadraticCurveTo(8, my - 5, 0, my - 4)
        .quadraticCurveTo(-8, my - 5, -15, my - 3)
        .fill(a.hair === 0xd8d4d0 ? 0xc8c2bc : darken(a.hair, 0.05));
    }
  }

  /* -------------------------------- symbols -------------------------------------------------- */

  private buildSymbols(): void {
    for (const c of this.symbols.removeChildren()) c.destroy({ children: true });
    this.symbolTime = 0;
    const cy = this.headCY;
    const sym = this.symbol;
    if (sym === 'none') return;
    const add = (g: Graphics, x: number, y: number, label: string): void => {
      g.position.set(x, y);
      g.label = label;
      this.symbols.addChild(g);
    };
    switch (sym) {
      case 'sweat': {
        const g = new Graphics();
        g.moveTo(0, -10)
          .quadraticCurveTo(9, 4, 0, 9)
          .quadraticCurveTo(-9, 4, 0, -10)
          .fill(0xdff3ff)
          .stroke({ width: 2, color: 0x2a4a6a });
        add(g, 46, cy - 26, 'sweat');
        break;
      }
      case 'vein': {
        const count = this.intensity >= 3 ? 2 : 1;
        for (let i = 0; i < count; i++) {
          const g = new Graphics();
          for (let q = 0; q < 4; q++) {
            const ang = (q / 4) * Math.PI * 2 + Math.PI / 4;
            const cx = Math.cos(ang) * 6;
            const cyy = Math.sin(ang) * 6;
            g.moveTo(cx + Math.cos(ang + 1.2) * 6, cyy + Math.sin(ang + 1.2) * 6)
              .quadraticCurveTo(
                cx * 0.2,
                cyy * 0.2,
                cx + Math.cos(ang - 1.2) * 6,
                cyy + Math.sin(ang - 1.2) * 6,
              )
              .stroke({ width: 6, color: 0x2a0a0a })
              .moveTo(cx + Math.cos(ang + 1.2) * 6, cyy + Math.sin(ang + 1.2) * 6)
              .quadraticCurveTo(
                cx * 0.2,
                cyy * 0.2,
                cx + Math.cos(ang - 1.2) * 6,
                cyy + Math.sin(ang - 1.2) * 6,
              )
              .stroke({ width: 3, color: 0xe0402a });
          }
          add(g, i === 0 ? 30 : -34, cy - 46 + i * 6, 'vein');
        }
        break;
      }
      case 'steam': {
        for (let i = 0; i < (this.intensity >= 3 ? 4 : 2); i++) {
          const g = new Graphics();
          g.circle(0, 0, 9)
            .circle(8, -4, 7)
            .circle(-7, -3, 6)
            .fill({ color: 0xffffff, alpha: 0.95 })
            .stroke({ width: 2, color: 0x6a5a5a });
          add(g, (i % 2 === 0 ? 1 : -1) * (40 + (i >> 1) * 8), cy - 46, `steam${i}`);
        }
        const v = new Graphics();
        for (let q = 0; q < 4; q++) {
          const ang = (q / 4) * Math.PI * 2 + Math.PI / 4;
          v.moveTo(Math.cos(ang) * 10, Math.sin(ang) * 10)
            .lineTo(Math.cos(ang) * 4, Math.sin(ang) * 4)
            .stroke({ width: 5, color: 0x2a0a0a })
            .moveTo(Math.cos(ang) * 10, Math.sin(ang) * 10)
            .lineTo(Math.cos(ang) * 4, Math.sin(ang) * 4)
            .stroke({ width: 2.5, color: 0xe0402a });
        }
        add(v, 30, cy - 44, 'vein');
        break;
      }
      case 'sparkle': {
        for (let i = 0; i < 3; i++) {
          const g = new Graphics();
          g.poly([0, -9, 2.2, -2.2, 9, 0, 2.2, 2.2, 0, 9, -2.2, 2.2, -9, 0, -2.2, -2.2])
            .fill(0xfff2b0)
            .stroke({ width: 1.2, color: 0xb8862a });
          add(g, [-66, 64, 58][i] ?? 0, cy + ([-34, -52, 18][i] ?? 0), `sparkle${i}`);
        }
        break;
      }
      case 'thought': {
        const g = new Graphics();
        g.circle(0, 0, 4)
          .circle(10, -12, 6)
          .circle(24, -28, 9)
          .fill({ color: 0xffffff, alpha: 0.95 })
          .stroke({ width: 2, color: 0x5a4a4a });
        add(g, 40, cy - 40, 'thought');
        break;
      }
      case 'sigh': {
        const g = new Graphics();
        g.circle(0, 0, 6)
          .circle(9, -2, 5)
          .circle(16, 1, 4)
          .fill({ color: 0xffffff, alpha: 0.9 })
          .stroke({ width: 1.6, color: 0x6a5a5a });
        add(g, -30, cy + 26, 'sigh');
        break;
      }
    }
  }

  private updateSymbols(dt: number): void {
    if (this.symbols.children.length === 0) return;
    this.symbolTime += dt;
    const t = this.symbolTime;
    const ms = Math.max(0.3, this.deps.quality.motionScale);
    const cy = this.headCY;
    for (const c of this.symbols.children) {
      const label = c.label;
      if (label === 'sweat') {
        c.y = cy - 26 + ((t * 10) % 14) * ms;
        c.alpha = 1 - ((t * 10) % 14) / 20;
      } else if (label === 'vein') {
        // Throb at ~1.6 Hz (well under the 3 Hz limit).
        c.scale.set(1 + 0.12 * Math.max(0, Math.sin(t * Math.PI * 2 * 1.6)) * ms);
      } else if (label.startsWith('steam')) {
        const i = Number(label.slice(5));
        const phase = (t * 0.9 + i * 0.37) % 1;
        c.y = cy - 46 - phase * 40 * ms;
        c.alpha = 1 - phase;
        c.scale.set(0.6 + phase * 0.8);
      } else if (label.startsWith('sparkle')) {
        const i = Number(label.slice(7));
        c.alpha = 0.5 + 0.5 * Math.sin(t * 2.4 + i * 2);
        c.rotation = t * 0.8;
      } else if (label === 'thought') {
        c.y = cy - 40 + Math.sin(t * 1.5) * 3 * ms;
      } else if (label === 'sigh') {
        const phase = (t * 0.5) % 1;
        c.x = -30 - phase * 30 * ms;
        c.alpha = 1 - phase;
      }
    }
  }

  /* -------------------------------- lantern (guide) ------------------------------------------ */

  private attachLantern(): void {
    const holder = new Container();
    const lan = drawLantern(1.25, MELA.marigold);
    holder.addChild(lan.view);
    const glow = new Sprite(fxTexture(this.deps.cache, 'glow'));
    glow.anchor.set(0.5);
    glow.blendMode = 'add';
    glow.tint = 0xffb04a;
    const l = lan.lights[0];
    glow.position.set(l?.x ?? 0, l?.y ?? 30);
    glow.scale.set(((l?.r ?? 50) * 2.4) / FX_RADIUS.glow);
    holder.addChild(glow);
    this.lanternGlow = glow;
    this.lanternHolder = holder;
    this.figure.addChild(holder);
    // Hold the lantern with a slightly bent arm.
    this.arms.l.u = 0.35;
    this.arms.l.f = -0.9;
  }
}

/** Build glow-friendly radial gradient (exported for the gallery swatches). */
export const characterSwatch = (c: number): ReturnType<typeof rgrad> =>
  rgrad([
    [0, lighten(c, 0.4)],
    [1, c],
  ]);
