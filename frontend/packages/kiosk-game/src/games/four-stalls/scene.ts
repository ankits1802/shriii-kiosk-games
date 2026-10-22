/**
 * Four Stalls scene: a market lane at midday sliding towards golden hour, four fruit stalls (each with
 * its own awning colours AND emblem shape), the guide at the lane's edge, the player's basket in
 * front, villagers who come with the same errand again and again, and a cheeky monkey who sometimes
 * snatches mangoes from the basket (a playful loss, never a "wrong" sound).
 *
 * `open()` runs inside the stimulus frame; payoff animations run for `payoff_ms` and never delay the
 * next trial's timing.
 */
import { gsap } from 'gsap';
import { Container, type Sprite } from 'pixi.js';
import { drawStall } from '../../art/backdrop/props.ts';
import type { ProceduralCharacter } from '../../art/characters/ProceduralCharacter.ts';
import { motionSettings } from '../../art/motion.ts';
import { MELA } from '../../art/palettes.ts';
import { createBasket } from '../../art/props/containers.ts';
import { createGood, createGoodsPile, type GoodsKind } from '../../art/props/goods.ts';
import type { Character, Point } from '../../core/contracts.ts';
import { createSelectionRing } from '../hub/kit/art.ts';
import { arcTo, hop, popIn, popOut, squash } from '../hub/kit/motion.ts';
import type { GameRuntime } from '../hub/kit/runtime.ts';
import type { GameStage } from '../hub/kit/stage.ts';
import { centerOf } from '../hub/kit/targets.ts';
import { createEmblem, createMonkey, createWishBubble, type EmblemShape } from './art.ts';
import type { FourStallsGeometry } from './geometry.ts';
import { STALL_CODES, type StallCode } from './plan.ts';

const STYLES: readonly {
  readonly stripeA: number;
  readonly stripeB: number;
  readonly cloth: number;
  readonly emblem: EmblemShape;
  readonly color: number;
}[] = [
  {
    stripeA: MELA.saffron,
    stripeB: MELA.cream,
    cloth: MELA.kumkum,
    emblem: 'circle',
    color: MELA.vermilion,
  },
  {
    stripeA: MELA.peacock,
    stripeB: MELA.cream,
    cloth: MELA.indigo,
    emblem: 'triangle',
    color: MELA.peacock,
  },
  {
    stripeA: MELA.indigo,
    stripeB: MELA.marigold,
    cloth: MELA.peacockDeep,
    emblem: 'square',
    color: MELA.lapis,
  },
  {
    stripeA: MELA.rose,
    stripeB: MELA.cream,
    cloth: MELA.terracotta,
    emblem: 'star',
    color: MELA.marigoldDeep,
  },
];

export const ERRAND_GOODS: readonly GoodsKind[] = ['mango', 'tomato', 'onion', 'bangles'];

interface StallView {
  readonly root: Container;
  readonly glow: Sprite;
  readonly ring: Container;
  readonly emblem: Container;
  /** Errand wares on the counter (identical at every stall, so the stalls stay interchangeable). */
  readonly wares: Container;
}

export class FourStallsScene {
  readonly guide: Character | null;
  private readonly guideRig: ProceduralCharacter | null;
  private readonly stalls = new Map<StallCode, StallView>();
  private basket: Container;
  private basketCount = 0;
  private villager: Character | null = null;
  private bubble: Container | null = null;
  private readonly fly = new Container();
  private destroyed = false;

  constructor(
    private readonly stage: GameStage,
    private readonly geo: FourStallsGeometry,
  ) {
    const { u } = stage;
    STALL_CODES.forEach((code, i) => {
      const style = STYLES[i] ?? (STYLES[0] as (typeof STYLES)[number]);
      const base = geo.bases[i] as Point;
      const root = new Container();
      root.position.set(base.x, base.y);
      const pool = stage.lightPool(
        150 * u * geo.stallScale,
        34 * u * geo.stallScale,
        0xffd27a,
        0.5,
      );
      const glow = stage.glowSprite(200 * u * geo.stallScale, 0xffd27a, 0);
      glow.position.set(0, -150 * u * geo.stallScale);
      const art = drawStall(
        {
          goods: 'fruit',
          stripeA: style.stripeA,
          stripeB: style.stripeB,
          cloth: style.cloth,
          seed: 40 + i * 7,
        },
        u * geo.stallScale,
      ).view;
      const emblem = createEmblem(style.emblem, style.color, 74 * u * geo.stallScale);
      emblem.position.set(0, -300 * u * geo.stallScale);
      const ring = createSelectionRing(130 * u * geo.stallScale);
      ring.position.set(0, -140 * u * geo.stallScale);
      ring.visible = false;
      const wares = new Container();
      wares.position.set(0, -112 * u * geo.stallScale);
      root.addChild(pool, art, wares, glow, emblem, ring);
      root.zIndex = base.y;
      stage.actorLayer.addChild(root);
      this.stalls.set(code, { root, glow, ring, emblem, wares });
    });
    this.basket = createBasket({ width: geo.basketWidth, contents: 'mango', count: 0 });
    this.basket.position.set(geo.basket.x, geo.basket.y);
    stage.ui.addChild(this.basket);
    stage.ui.addChild(this.fly);
    this.fly.zIndex = 900;
    this.guide = stage.character(
      { id: 'four_stalls.guide', role: 'guide', facing: 'right', scale: geo.guideScale },
      { x: -220 * u, y: geo.guide.y },
      stage.ui,
    );
    this.guideRig = stage.rig(this.guide);
    this.guide.setExpression('calm');
    stage.stream('dust', { x: stage.width * 0.5, y: stage.height * 0.7 }, 18, 4000, stage.worldFx);
  }

  async intro(rt: GameRuntime): Promise<void> {
    const { stage, geo } = this;
    rt.ctx.audio.setAmbience('market_busy', { fadeMs: 1500 });
    rt.ctx.audio.playMusic('hub', { fadeMs: 1500 });
    stage.cameraTo({ x: stage.width * 0.35, y: stage.height * 0.45, zoom: 1.25 }, 0);
    void stage
      .cameraTo({ x: stage.width * 0.65, y: stage.height * 0.45, zoom: 1.25 }, 1.8, 'sine.inOut')
      .then(() =>
        stage.cameraTo({ x: stage.width / 2, y: stage.height / 2, zoom: 1 }, 1.4, 'power2.inOut'),
      );
    if (this.guideRig) void this.guideRig.walkTo(geo.guide.x);
    else this.guide?.view.position.set(geo.guide.x, geo.guide.y);
    STALL_CODES.forEach((code, i) => {
      const s = this.stalls.get(code);
      if (s) {
        gsap.fromTo(
          s.emblem,
          { rotation: -0.4 },
          { rotation: 0, duration: 1.2, delay: 0.3 + i * 0.15, ease: 'elastic.out(1, 0.35)' },
        );
      }
    });
    await rt.sleep(2600);
    this.guide?.setExpression('happy');
    void this.guideRig?.play('wave');
    popIn(this.basket, 0, 0.6);
    await rt.sleep(800);
  }

  /** Before a trial: an errand villager arrives with the same wish as before (or nobody). */
  prepare(errand: { villager: number; goods: GoodsKind } | null): void {
    const { stage, geo } = this;
    for (const s of this.stalls.values()) {
      s.ring.visible = false;
      gsap.killTweensOf(s.glow);
      s.glow.alpha = 0;
    }
    this.showWares(errand?.goods ?? null);
    if (!errand) {
      this.dismissVillager();
      return;
    }
    if (!this.villager || this.villager.spec.variant !== errand.villager) {
      this.dismissVillager();
      const v = stage.character(
        {
          id: `four_stalls.villager.${errand.villager}`,
          role: 'customer',
          variant: errand.villager,
          facing: 'left',
          scale: geo.villagerScale,
          view: 'three_quarter',
        } as Parameters<GameStage['character']>[0],
        { x: stage.width + 200 * stage.u, y: geo.villager.y },
        stage.ui,
      );
      this.villager = v;
      const rig = stage.rig(v);
      if (rig) void rig.walkTo(geo.villager.x);
      else v.view.position.set(geo.villager.x, geo.villager.y);
    }
    this.villager.setExpression('calm');
    this.bubble?.destroy({ children: true });
    const b = createWishBubble(errand.goods, 3, 220 * stage.u);
    // Tail tip just above the villager's head, so the wish clearly belongs to her.
    b.position.set(
      geo.villager.x - 40 * stage.u,
      geo.villager.y - 430 * stage.u * (geo.villagerScale / 1.55),
    );
    stage.ui.addChild(b);
    popIn(b, 0.3, 0.5);
    this.bubble = b;
  }

  /** Stock every counter with the same small heap of the wished-for goods (or clear them). */
  private showWares(goods: GoodsKind | null): void {
    const sc = this.stage.u * this.geo.stallScale;
    let i = 0;
    for (const s of this.stalls.values()) {
      const current = s.wares.children[0]?.label ?? null;
      const wanted = goods ? `pile:${goods}:6` : null;
      if (current !== wanted) {
        for (const c of s.wares.removeChildren()) {
          gsap.killTweensOf(c);
          gsap.killTweensOf(c.scale);
          c.destroy({ children: true });
        }
        if (goods) {
          const pile = createGoodsPile(goods, 6, 1.6 * sc, 11);
          s.wares.addChild(pile);
          if (!motionSettings.reducedMotion) popIn(pile, i * 0.06, 0.4);
        }
      }
      i += 1;
    }
  }

  private dismissVillager(): void {
    const v = this.villager;
    this.villager = null;
    this.bubble?.destroy({ children: true });
    this.bubble = null;
    if (!v) return;
    const rig = this.stage.rig(v);
    if (rig) {
      void rig.walkTo(this.stage.width + 260 * this.stage.u).then(() => (v.view.visible = false));
    } else v.view.visible = false;
  }

  /** Stimulus: the stall lanterns glow, inviting a choice (inside the stimulus frame). */
  open(): void {
    for (const s of this.stalls.values()) {
      gsap.killTweensOf(s.glow);
      s.glow.alpha = 0.55;
    }
  }

  /** The chosen stall bounces and rings; the others dim. */
  choose(code: StallCode): void {
    for (const [k, s] of this.stalls) {
      if (k === code) {
        s.ring.visible = true;
        squash(s.root, 0.06);
        gsap.to(s.glow, { alpha: 0.95, duration: 0.15 });
        hop(s.emblem, 18 * this.stage.u);
      } else gsap.to(s.glow, { alpha: 0, duration: 0.25 });
    }
    this.stage.rt.sfx('tap', { volume: 0.4 });
  }

  /** Nobody chose in time: the lanterns simply dim. */
  close(): void {
    for (const s of this.stalls.values()) gsap.to(s.glow, { alpha: 0, duration: 0.3 });
  }

  /** Own purchase: the vendor's mangoes fly into the basket; on a loss the monkey snatches some. */
  payoff(code: StallCode, gain: number, loss: number, durationMs: number): void {
    const { stage, geo } = this;
    const s = this.stalls.get(code);
    if (!s) return;
    const d = durationMs / 1000;
    const from = { x: s.root.x, y: s.root.y - 140 * stage.u * geo.stallScale };
    const to = { x: geo.basket.x, y: geo.basket.y - geo.basketWidth * 0.35 };
    for (let i = 0; i < gain; i++) {
      const m = createGood('mango', 2.4 * stage.u);
      m.position.set(from.x, from.y);
      this.fly.addChild(m);
      void arcTo(m, to.x + (i - gain / 2) * 14 * stage.u, to.y, {
        durationS: Math.max(0.3, d * 0.55),
        delayS: i * 0.06,
        lift: stage.height * 0.12,
      }).then(() => {
        m.destroy();
        squash(this.basket, 0.06);
      });
    }
    this.stage.rt.sfx('pop', { volume: 0.45 });
    this.later(() => this.setBasket(this.basketCount + gain), d * 600);
    this.guide?.setExpression('happy');
    if (loss > 0) this.later(() => this.monkey(loss, d), d * 650);
  }

  /** The cheeky monkey leaps down, grabs mangoes from the basket and bounds away. */
  private monkey(loss: number, d: number): void {
    const { stage, geo } = this;
    const m = createMonkey(120 * stage.u);
    const side = geo.basket.x > stage.width / 2 ? -1 : 1;
    m.position.set(geo.basket.x + side * stage.width * 0.3, -60 * stage.u);
    this.fly.addChild(m);
    this.guide?.setExpression('surprised');
    this.stage.rt.sfx('whoosh', { volume: 0.45 });
    void arcTo(m, geo.basket.x + side * 40 * stage.u, geo.basket.y - geo.basketWidth * 0.3, {
      durationS: Math.max(0.3, d * 0.45),
      lift: 60 * stage.u,
    }).then(() => {
      if (this.destroyed) return;
      squash(m, 0.2);
      this.setBasket(Math.max(0, this.basketCount - loss));
      for (let i = 0; i < Math.min(loss, 4); i++) {
        const g = createGood('mango', 2 * stage.u);
        g.position.set(-10 * stage.u + i * 8 * stage.u, -90 * stage.u);
        m.addChild(g);
      }
      void arcTo(m, geo.basket.x - side * stage.width * 0.45, -120 * stage.u, {
        durationS: Math.max(0.35, d * 0.6),
        delayS: 0.15,
        lift: 140 * stage.u,
      }).then(() => m.destroy({ children: true }));
      this.guide?.setExpression('happy');
      void this.guideRig?.play('shrug');
    });
  }

  /** Errand: the vendor hands a bundle to the villager, who thanks and waits for the next time. */
  errandDone(code: StallCode | null, durationMs: number): void {
    const { stage } = this;
    const v = this.villager;
    if (!v) return;
    if (code === null) {
      v.setExpression('thinking');
      return;
    }
    const s = this.stalls.get(code);
    if (!s) return;
    const bundle = createGood('rice_sack', 0.9 * stage.u);
    bundle.position.set(s.root.x, s.root.y - 140 * stage.u * this.geo.stallScale);
    this.fly.addChild(bundle);
    const rig = stage.rig(v);
    const hand = rig ? rig.handPosition('l') : { x: v.view.x, y: v.view.y - 200 * stage.u };
    void arcTo(bundle, hand.x, hand.y, {
      durationS: (durationMs / 1000) * 0.6,
      lift: stage.height * 0.1,
    }).then(() => {
      void popOut(bundle, 0.2).then(() => bundle.destroy());
      v.setExpression('happy');
      void rig?.play('namaste');
    });
  }

  private setBasket(count: number): void {
    if (this.destroyed) return;
    this.basketCount = count;
    const shown = Math.min(18, count);
    const next = createBasket({ width: this.geo.basketWidth, contents: 'mango', count: shown });
    next.position.copyFrom(this.basket.position);
    const idx = this.stage.ui.getChildIndex(this.basket);
    this.stage.ui.addChildAt(next, idx);
    this.basket.destroy({ children: true });
    this.basket = next;
  }

  async outro(): Promise<void> {
    const { stage } = this;
    this.dismissVillager();
    this.guide?.setExpression('happy');
    void this.guideRig?.play('celebrate');
    stage.burst('confetti', { x: stage.width / 2, y: stage.height * 0.3 }, 50);
    stage.rt.sfx('chime', { volume: 0.5 });
    void stage.backdrop?.setTimeOfDay('golden_hour', { durationMs: 1500 });
    await stage.cameraTo(
      { x: stage.width / 2, y: stage.height * 0.5, zoom: 1.06 },
      1.4,
      'power2.out',
    );
  }

  /** The light slides from midday towards golden hour as the purchases go by. */
  advanceLight(progress: number): void {
    const tv = 1 + Math.max(0, Math.min(1, progress)) * 0.9;
    void (
      this.stage.backdrop as { setTimeValue?: (v: number, ms?: number) => Promise<void> } | null
    )?.setTimeValue?.(tv, 1500);
  }

  hint(code: StallCode): void {
    const s = this.geo.targets[STALL_CODES.indexOf(code)];
    if (s) this.stage.showHint('tap', centerOf(s));
  }

  hideHint(): void {
    this.stage.hideHint();
  }

  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private later(fn: () => void, ms: number): void {
    this.timers.push(
      setTimeout(() => {
        if (!this.destroyed) fn();
      }, ms),
    );
  }

  destroy(): void {
    this.destroyed = true;
    for (const t of this.timers.splice(0)) clearTimeout(t);
    for (const s of this.stalls.values()) {
      gsap.killTweensOf(s.glow);
      gsap.killTweensOf(s.root.scale);
      gsap.killTweensOf(s.emblem);
    }
  }
}
