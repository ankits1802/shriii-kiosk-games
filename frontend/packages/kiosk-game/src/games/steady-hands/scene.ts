/**
 * Steady Hands scene: the temple courtyard at dusk, a great brass samai lamp at the centre, fireflies
 * over the flagstones, the guide at the edge, and a brass plate with a henna palm for the held block.
 *
 * Timing contract: `light()` is called inside `ActiveTrial.present` (the flame is on screen on the
 * logged frame) and `extinguish()` exactly at the end of the window; the flare on a touch and all
 * ambience are decorative and never delay a trial. Distractors appear in the sky or at the bell,
 * never over the lamp.
 */
import { gsap } from 'gsap';
import type { Container, Sprite } from 'pixi.js';
import type { ProceduralCharacter } from '../../art/characters/ProceduralCharacter.ts';
import { motionSettings } from '../../art/motion.ts';
import type { Character } from '../../core/contracts.ts';
import { arcTo, popIn, squash } from '../hub/kit/motion.ts';
import type { GameRuntime } from '../hub/kit/runtime.ts';
import type { GameStage } from '../hub/kit/stage.ts';
import { centerOf } from '../hub/kit/targets.ts';
import { createBell, createHoldPlate, createSkyLantern, SamaiLamp } from './art.ts';
import type { SteadyHandsGeometry } from './geometry.ts';

export type DistractorKind = 'firework' | 'sky_lantern' | 'bell';

export class SteadyHandsScene {
  readonly guide: Character | null;
  /** Pointer-interactive plate (the hold tracker listens to it). */
  readonly padView: Container;
  private readonly guideRig: ProceduralCharacter | null;
  private readonly lamp: SamaiLamp;
  private readonly lampGlow: Sprite;
  private readonly lampPool: Sprite;
  private readonly padGlow: Sprite;
  private readonly bell: Container;
  private lit = false;
  private distractorCount = 0;
  private flicker: gsap.core.Tween | null = null;

  constructor(
    private readonly stage: GameStage,
    private readonly geo: SteadyHandsGeometry,
  ) {
    const { u } = stage;
    // Lamp at centre (world == screen during trials: the camera rests at zoom 1).
    this.lampPool = stage.lightPool(geo.lampSize * 1.4, geo.lampSize * 0.32, 0xffc46b);
    this.lampPool.position.set(geo.lampBase.x, geo.lampBase.y);
    this.lampPool.alpha = 0.25;
    stage.propLayer.addChild(this.lampPool);
    this.lamp = new SamaiLamp(geo.lampSize * 1.25);
    this.lamp.view.position.set(geo.lampBase.x, geo.lampBase.y);
    stage.actorLayer.addChild(this.lamp.view);
    this.lampGlow = stage.glowSprite(geo.lampSize * 1.25, 0xffb347, 0);
    const wick = this.lamp.wicks[2] ?? { x: 0, y: -geo.lampSize };
    this.lampGlow.position.set(
      geo.lampBase.x + wick.x,
      geo.lampBase.y + wick.y - geo.lampSize * 0.05,
    );
    stage.worldFx.addChild(this.lampGlow);
    // Bell hanging from the courtyard arch (distractor).
    this.bell = createBell(110 * u);
    this.bell.position.set(geo.bell.x, geo.bell.y - 110 * u);
    stage.propLayer.addChild(this.bell);
    // Guide.
    this.guide = stage.character(
      { id: 'steady_hands.guide', role: 'guide', facing: 'right', scale: geo.guideScale },
      { x: -200 * u, y: geo.guide.y },
    );
    this.guideRig = stage.rig(this.guide);
    this.guide.setExpression('calm');
    // Hold plate (screen space, lower third).
    const pc = centerOf(geo.pad);
    this.padGlow = stage.glowSprite(geo.pad.width * 0.75, 0xffd27a, 0);
    this.padGlow.position.set(pc.x, pc.y);
    this.padView = createHoldPlate(geo.pad.width, geo.pad.height);
    this.padView.position.set(pc.x, pc.y);
    this.padView.visible = false;
    this.padView.alpha = 0;
    stage.ui.addChild(this.padGlow, this.padView);
    stage.fireflies(
      { x: 0, y: stage.height * 0.35, width: stage.width, height: stage.height * 0.5 },
      26,
    );
  }

  /** Dusk falls over the courtyard; the guide arrives; the lamp glints. */
  async intro(rt: GameRuntime): Promise<void> {
    const { stage, geo } = this;
    rt.ctx.audio.setAmbience('quiet', { fadeMs: 1500 });
    stage.cameraTo({ x: stage.width / 2, y: stage.height * 0.42, zoom: 1.18 }, 0);
    void stage.backdrop?.setTimeOfDay('dusk', { durationMs: 2500 });
    void stage.cameraTo({ x: stage.width / 2, y: stage.height / 2, zoom: 1 }, 3, 'power2.inOut');
    if (this.guideRig) void this.guideRig.walkTo(geo.guide.x);
    else this.guide?.view.position.set(geo.guide.x, geo.guide.y);
    gsap.fromTo(
      this.lampGlow,
      { alpha: 0 },
      { alpha: 0.5, duration: 0.8, yoyo: true, repeat: 1, delay: 1.2 },
    );
    await rt.sleep(2200);
    this.guide?.setExpression('happy');
    void this.guideRig?.play('namaste');
    await rt.sleep(900);
  }

  /** Show or hide the plate for the condition. */
  setCondition(condition: 'free' | 'held'): void {
    const on = condition === 'held';
    gsap.killTweensOf(this.padView);
    if (on) {
      this.padView.visible = true;
      gsap.to(this.padView, { alpha: 1, duration: 0.4 });
      popIn(this.padView, 0, 0.5);
    } else {
      gsap.to(this.padView, {
        alpha: 0,
        duration: 0.3,
        onComplete: () => {
          this.padView.visible = false;
        },
      });
      gsap.to(this.padGlow, { alpha: 0, duration: 0.3 });
    }
  }

  /** Announced block change: the guide demonstrates (hand on the plate, or hands free). */
  async announce(condition: 'free' | 'held'): Promise<void> {
    const pc = centerOf(this.geo.pad);
    this.guide?.setExpression('happy');
    if (condition === 'held') {
      void this.guideRig?.pointAt(pc);
      this.stage.showHint('hold', pc, 1400);
      gsap.fromTo(
        this.padGlow,
        { alpha: 0.2 },
        { alpha: 0.85, duration: 0.6, yoyo: true, repeat: 3 },
      );
    } else {
      void this.guideRig?.play('wave');
      this.stage.showHint('tap', centerOf(this.geo.lamp));
    }
  }

  endAnnounce(): void {
    this.stage.hideHint();
    void this.guideRig?.play('idle');
    this.guide?.setExpression('calm');
  }

  /** A gentle call to rest the hand on the plate (shape + glow, never a buzzer). */
  padNeedsHand(): void {
    gsap.fromTo(this.padGlow, { alpha: 0.1 }, { alpha: 0.7, duration: 0.4, yoyo: true, repeat: 1 });
    squash(this.padView, 0.05);
  }

  /** Practice hand hint on the flame. */
  hint(): void {
    this.stage.showHint('tap', centerOf(this.geo.lamp));
  }

  hideHint(): void {
    this.stage.hideHint();
  }

  /** The flames bloom (called inside the stimulus frame). */
  light(): void {
    this.lit = true;
    const flames = this.lamp.flames.children;
    for (const f of flames) {
      gsap.killTweensOf(f.scale);
      f.scale.set(motionSettings.reducedMotion ? 1 : 0.55);
      if (!motionSettings.reducedMotion)
        gsap.to(f.scale, { x: 1, y: 1, duration: 0.12, ease: 'back.out(3)' });
    }
    gsap.killTweensOf(this.lampGlow);
    this.lampGlow.alpha = 0.95;
    this.lampPool.alpha = 0.85;
    this.flicker?.kill();
    this.flicker = gsap.to(this.lampGlow.scale, {
      x: this.lampGlow.scale.x * 1.06,
      y: this.lampGlow.scale.y * 1.06,
      duration: 0.18,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
    });
  }

  /** Touch landed: the flame leaps (squash and stretch) and throws sparks. */
  flare(): void {
    if (!this.lit) return;
    for (const f of this.lamp.flames.children) {
      gsap.killTweensOf(f.scale);
      gsap
        .timeline()
        .to(f.scale, { x: 0.8, y: 1.45, duration: 0.08 })
        .to(f.scale, { x: 1, y: 1, duration: 0.35, ease: 'elastic.out(1.2, 0.4)' });
    }
    const wick = this.lamp.wicks[2] ?? { x: 0, y: 0 };
    this.stage.burst(
      'sparkle',
      {
        x: this.geo.lampBase.x + wick.x,
        y: this.geo.lampBase.y + wick.y - this.geo.lampSize * 0.12,
      },
      10,
      this.stage.worldFx,
      1800,
    );
    this.stage.rt.sfx('chime', { volume: 0.35 });
  }

  /** End of the window: the flames shrink away, leaving a wisp of smoke. */
  extinguish(): void {
    this.lit = false;
    this.flicker?.kill();
    this.flicker = null;
    for (const f of this.lamp.flames.children) {
      gsap.killTweensOf(f.scale);
      gsap.to(f.scale, { x: 0.01, y: 0.01, duration: motionSettings.reducedMotion ? 0.05 : 0.14 });
    }
    gsap.to(this.lampGlow, { alpha: 0, duration: 0.18 });
    gsap.to(this.lampPool, { alpha: 0.25, duration: 0.3 });
  }

  /** Festive distractor for `durationMs` (called inside its own stimulus frame). */
  distractor(kind: DistractorKind, durationMs: number): void {
    const { stage, geo } = this;
    const d = durationMs / 1000;
    const side = (this.distractorCount % 2) as 0 | 1;
    this.distractorCount += 1;
    if (kind === 'firework') {
      const p = geo.sky[side];
      const glow = stage.glowSprite(140 * stage.u, side ? 0x8fd3ff : 0xffd27a, 0.95);
      glow.position.set(p.x, p.y);
      stage.worldFx.addChild(glow);
      stage.burst('sparkle', p, 26, stage.worldFx, 1600);
      stage.burst('confetti', p, 10, stage.worldFx, 1600);
      gsap.to(glow, { alpha: 0, duration: d, ease: 'power2.in', onComplete: () => glow.destroy() });
      stage.rt.sfx('pop', { volume: 0.55, pan: side ? 0.6 : -0.6 });
    } else if (kind === 'sky_lantern') {
      const p = geo.sky[side];
      const l = createSkyLantern(70 * stage.u);
      l.position.set(p.x, p.y + stage.height * 0.18);
      const glow = stage.glowSprite(110 * stage.u, 0xffa94d, 0.9);
      l.addChildAt(glow, 0);
      stage.worldFx.addChild(l);
      void arcTo(l, p.x + (side ? -40 : 40) * stage.u, p.y - stage.height * 0.05, {
        durationS: d * 1.6,
        lift: 10,
      });
      gsap.to(l, {
        alpha: 0,
        delay: d,
        duration: 0.5,
        onComplete: () => l.destroy({ children: true }),
      });
      stage.rt.sfx('whoosh', { volume: 0.4, pan: side ? 0.6 : -0.6 });
    } else {
      gsap.killTweensOf(this.bell);
      gsap
        .timeline()
        .to(this.bell, { rotation: 0.35, duration: d * 0.3, ease: 'sine.out' })
        .to(this.bell, { rotation: -0.25, duration: d * 0.4, ease: 'sine.inOut' })
        .to(this.bell, { rotation: 0, duration: 0.5, ease: 'elastic.out(1, 0.4)' });
      const glow = stage.glowSprite(120 * stage.u, 0xfff1a8, 0.8);
      glow.position.set(geo.bell.x, geo.bell.y);
      stage.worldFx.addChild(glow);
      gsap.to(glow, { alpha: 0, duration: d, onComplete: () => glow.destroy() });
      stage.rt.sfx('bell', { volume: 0.6, pan: 0.5 });
    }
  }

  /** Closing: every lamp in the courtyard glows, petals fall, the guide celebrates. */
  async outro(): Promise<void> {
    const { stage } = this;
    this.guide?.setExpression('happy');
    void this.guideRig?.play('celebrate');
    this.light();
    gsap.to(this.lampGlow, { alpha: 1, duration: 0.6 });
    stage.burst('petals', { x: stage.width / 2, y: stage.height * 0.25 }, 40);
    stage.rt.sfx('chime', { volume: 0.5 });
    await stage.cameraTo(
      { x: stage.width / 2, y: stage.height * 0.46, zoom: 1.08 },
      1.4,
      'power2.out',
    );
  }

  destroy(): void {
    this.flicker?.kill();
    gsap.killTweensOf(this.lampGlow);
    gsap.killTweensOf(this.lampGlow.scale);
    gsap.killTweensOf(this.padGlow);
    gsap.killTweensOf(this.padView);
    gsap.killTweensOf(this.bell);
    for (const f of this.lamp.flames.children) gsap.killTweensOf(f.scale);
  }
}
