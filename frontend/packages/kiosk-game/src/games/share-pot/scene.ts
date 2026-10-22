/**
 * Share-the-Pot scene: the banyan share circle at golden hour sliding towards sunset as the rounds pass.
 * The guide watches from the edge, a pretend helper stands across the brass pot, and the player's ten
 * coins rest on a red cloth. Every reaction is expressive but never evaluative: no points, no
 * "wrong" sounds, quantities are pictured coins.
 *
 * Nothing here gates timing: the module awaits only `ActiveTrial.present` and level-table delays;
 * scene animations run alongside.
 */
import { gsap } from 'gsap';
import { Container, type Sprite } from 'pixi.js';
import type { ProceduralCharacter } from '../../art/characters/ProceduralCharacter.ts';
import { MELA } from '../../art/palettes.ts';
import type { Character, Point, UiButton } from '../../core/contracts.ts';
import type { PlayedRound } from '../../paradigms/public-goods.ts';
import { createBigCoin, createClothMat, createSelectionRing } from '../hub/kit/art.ts';
import { arcTo, hop, popIn, popOut, squash, still } from '../hub/kit/motion.ts';
import type { GameRuntime } from '../hub/kit/runtime.ts';
import type { GameStage } from '../hub/kit/stage.ts';
import { centerOf } from '../hub/kit/targets.ts';
import { BrassPot, createGiftBasket, createPalmSpot, createPouch, createToneFace } from './art.ts';
import type { SharePotGeometry } from './geometry.ts';

type ToneCode = 'warm' | 'neutral' | 'firm';

interface CoinSlot {
  readonly holder: Container;
  readonly coin: Container;
  readonly ring: Container;
  readonly home: Point;
}

export class SharePotScene {
  readonly guide: Character | null;
  readonly partner: Character;
  private readonly guideRig: ProceduralCharacter | null;
  private readonly partnerRig: ProceduralCharacter | null;
  private readonly pot: BrassPot;
  private readonly potGlow: Sprite;
  private readonly mat: Container;
  private readonly pouch: Container;
  private readonly palm: Container;
  private readonly palmRing: Container;
  private readonly coins: CoinSlot[] = [];
  private readonly confirm: UiButton;
  private readonly tones = new Map<ToneCode, Container>();
  private readonly flyLayer = new Container();
  private selected = 0;
  private destroyed = false;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private roundsDone = 0;
  private readonly endowment: number;

  constructor(
    private readonly stage: GameStage,
    private readonly geo: SharePotGeometry,
    options: { readonly endowment: number; readonly partnerVariant: number },
  ) {
    this.endowment = options.endowment;
    const { u } = stage;
    // World: pot on the chabutra, warm light pool, the helper behind it, the guide at the edge.
    const pool = stage.lightPool(geo.potSize * 1.6, geo.potSize * 0.42);
    pool.position.set(geo.pot.x, geo.pot.y + geo.potSize * 0.02);
    stage.propLayer.addChild(pool);
    this.potGlow = stage.glowSprite(geo.potSize * 1.1, 0xffc861, 0.0);
    this.potGlow.position.set(geo.pot.x, geo.pot.y - geo.potSize * 0.5);
    this.pot = new BrassPot(geo.potSize);
    this.pot.view.position.set(geo.pot.x, geo.pot.y);
    this.pot.view.zIndex = geo.pot.y;
    stage.actorLayer.addChild(this.pot.view);
    stage.worldFx.addChild(this.potGlow);
    this.partner = stage.character(
      {
        id: 'share_pot.partner',
        role: 'partner',
        variant: options.partnerVariant,
        facing: 'left',
        scale: geo.partnerScale,
        view: 'three_quarter',
      } as Parameters<GameStage['character']>[0],
      { x: stage.width + 260 * u, y: geo.partner.y },
    );
    this.partnerRig = stage.rig(this.partner);
    this.partner.view.zIndex = geo.partner.y - 1;
    this.guide = stage.character(
      {
        id: 'share_pot.guide',
        role: 'guide',
        facing: 'right',
        scale: geo.guideScale,
      },
      { x: -240 * u, y: geo.guide.y },
    );
    this.guideRig = stage.rig(this.guide);
    this.guide.setExpression('calm');

    // Screen space: cloth mat, palm spot, coins, pouch and confirm tick.
    const m = geo.mat;
    this.mat = createClothMat(m.width, m.height, MELA.kumkum);
    this.mat.position.set(m.x + m.width / 2, m.y + m.height / 2);
    this.mat.alpha = 0;
    stage.ui.addChild(this.mat);
    const s0 = geo.slots[0];
    const palmSize = s0 ? s0.width : 80;
    this.palm = createPalmSpot(palmSize);
    this.palmRing = createSelectionRing(palmSize * 0.62);
    this.palmRing.visible = false;
    if (s0) {
      const c = centerOf(s0);
      this.palm.position.set(c.x, c.y);
      this.palmRing.position.set(c.x, c.y);
    }
    this.palm.alpha = 0;
    stage.ui.addChild(this.palm, this.palmRing);
    for (let k = 1; k < geo.slots.length; k++) {
      const r = geo.slots[k];
      if (!r) continue;
      const home = centerOf(r);
      const holder = new Container();
      holder.position.set(home.x, home.y);
      const coin = createBigCoin(geo.coinR);
      const ring = createSelectionRing(geo.coinR * 1.45);
      ring.visible = false;
      holder.addChild(ring, coin);
      holder.visible = false;
      stage.ui.addChild(holder);
      this.coins.push({ holder, coin, ring, home });
    }
    this.pouch = createPouch(palmSize * 1.15);
    this.pouch.position.set(geo.pouch.x, geo.pouch.y + palmSize * 0.45);
    this.pouch.alpha = 0;
    stage.ui.addChild(this.pouch);
    this.confirm = stage.art.createButton({
      id: 'share_pot.confirm',
      iconId: 'tick',
      audioKey: 'share_pot.replay',
      variant: 'confirm',
      sizeMm: geo.confirm.width / stage.pxPerMm,
    });
    const cc = centerOf(geo.confirm);
    this.confirm.view.position.set(cc.x, cc.y);
    this.confirm.view.visible = false;
    stage.ui.addChild(this.confirm.view);
    stage.ui.addChild(this.flyLayer);
    this.flyLayer.zIndex = 800;
    stage.fireflies(
      { x: 0, y: stage.height * 0.25, width: stage.width, height: stage.height * 0.4 },
      14,
    );
  }

  /** Opening shot: canopy and string lights, then a glide down to the circle as the cast arrives. */
  async intro(rt: GameRuntime): Promise<void> {
    const { stage, geo } = this;
    rt.ctx.audio.setAmbience('market_day', { fadeMs: 1500 });
    rt.ctx.audio.playMusic('hub', { fadeMs: 1500 });
    stage.cameraTo({ x: stage.width / 2, y: stage.height * 0.36, zoom: 1.22 }, 0);
    void stage.cameraTo(geo.focus, 3.2, 'power2.inOut');
    stage.stream(
      'petals',
      { x: stage.width * 0.5, y: -stage.height * 0.05 },
      26,
      3500,
      stage.worldFx,
    );
    if (this.guideRig) void this.guideRig.walkTo(geo.guide.x);
    else this.guide?.view.position.set(geo.guide.x, geo.guide.y);
    await rt.sleep(400);
    if (this.partnerRig) void this.partnerRig.walkTo(geo.partner.x);
    else this.partner.view.position.set(geo.partner.x, geo.partner.y);
    gsap.to(this.potGlow, { alpha: 0.55, duration: 1.2, yoyo: true, repeat: 1 });
    await rt.sleep(1600);
    this.guide?.setExpression('happy');
    void this.guideRig?.play('namaste');
    void this.partnerRig?.play('namaste');
    gsap.to(this.mat, { alpha: 1, duration: 0.6 });
    gsap.to(this.palm, { alpha: 1, duration: 0.6 });
    gsap.to(this.pouch, { alpha: 1, duration: 0.6 });
    popIn(this.pouch, 0.1, 0.6);
    await rt.sleep(900);
    this.partner.setExpression('happy');
  }

  /** The real rounds start (the light begins its slow slide towards sunset). */
  beginRounds(): void {
    void this.stage.backdrop?.setTimeOfDay('golden_hour', { durationMs: 600 });
  }

  /** Deal: ten coins hop out of the pouch onto the cloth; the helper's hidden coins settle in hand. */
  deal(partnerType: string): void {
    this.selected = 0;
    this.palmRing.visible = false;
    this.confirm.view.visible = false;
    for (const t of this.tones.values()) t.destroy({ children: true });
    this.tones.clear();
    const from = { x: this.pouch.x, y: this.pouch.y - this.geo.coinR * 2 };
    this.coins.forEach((c, i) => {
      still(c.holder);
      c.ring.visible = false;
      c.holder.visible = true;
      c.holder.alpha = 1;
      c.holder.position.set(from.x, from.y);
      c.holder.scale.set(0.6);
      void arcTo(c.holder, c.home.x, c.home.y, {
        durationS: 0.42,
        delayS: i * 0.022,
        lift: this.geo.coinR * 3,
      });
      gsap.to(c.holder.scale, {
        x: 1,
        y: 1,
        duration: 0.42,
        delay: i * 0.022,
        ease: 'back.out(2)',
      });
    });
    squash(this.pouch, 0.12);
    this.pot.setFill(0);
    this.partner.setExpression(partnerType === 'free_rider' ? 'thinking' : 'calm');
    void this.partnerRig?.play('idle');
  }

  /** The choice opens: a shimmer runs across the coins; the palm spot breathes. */
  openChoice(): void {
    this.confirm.view.visible = true;
    this.confirm.setEnabled(false);
    this.coins.forEach((c, i) => {
      gsap.fromTo(
        c.coin,
        { y: 0 },
        { y: -this.geo.coinR * 0.25, duration: 0.18, delay: i * 0.03, yoyo: true, repeat: 1 },
      );
    });
    squash(this.palm, 0.08);
  }

  /** Coins 1..k lift with petal rings; the rest settle. */
  select(k: number): void {
    const prev = this.selected;
    this.selected = k;
    this.palmRing.visible = k === 0;
    if (k === 0) squash(this.palm, 0.15);
    this.coins.forEach((c, i) => {
      const on = i < k;
      c.ring.visible = on;
      gsap.to(c.holder, {
        y: c.home.y - (on ? this.geo.coinR * 0.55 : 0),
        duration: 0.22,
        ease: 'back.out(2)',
      });
    });
    const tapped = this.coins[k - 1];
    if (tapped) squash(tapped.coin, 0.2);
    if (prev !== k) this.stage.rt.sfx(k === 0 ? 'tap_soft' : 'coin_drop', { volume: 0.35 });
    this.confirm.setEnabled(true);
    this.confirm.pulse();
  }

  hideHint(): void {
    this.stage.hideHint();
  }

  /** Practice: the hand hint lands mid-row (between coins, so it suggests no amount), then the tick. */
  practiceHint(): void {
    const a = this.geo.slots[5];
    const b = this.geo.slots[6];
    if (a && b) {
      const p = { x: (centerOf(a).x + centerOf(b).x) / 2, y: centerOf(a).y };
      this.stage.showHint('tap', p);
    }
    void this.guideRig?.pointAt(this.stage.toScreen(this.geo.pot));
  }

  /** Nudge (the only prompt): the guide gestures at the pot and a shimmer wave runs over all coins. */
  nudge(): void {
    void this.guideRig?.play('beckon');
    this.guide?.setExpression('happy');
    this.coins.forEach((c, i) => {
      gsap.fromTo(
        c.coin.scale,
        { x: 1, y: 1 },
        { x: 1.12, y: 1.12, duration: 0.16, delay: i * 0.05, yoyo: true, repeat: 1 },
      );
    });
    gsap.fromTo(this.potGlow, { alpha: 0.2 }, { alpha: 0.6, duration: 0.5, yoyo: true, repeat: 1 });
  }

  /** Reveal: both piles go in, the pot doubles with a shimmer, and the pot is split equally. */
  async reveal(played: PlayedRound, responded: boolean, durationMs: number): Promise<void> {
    const { stage, geo } = this;
    const d = Math.max(0.6, durationMs / 1000);
    const potTop = stage.toScreen({ x: geo.pot.x, y: geo.pot.y - geo.potSize * 0.92 });
    this.confirm.setEnabled(false);
    squash(this.confirm.view, 0.12);
    // Player's coins arc into the pot.
    const k = responded ? played.contribution.contributed_tokens : 0;
    for (let i = 0; i < this.coins.length; i++) {
      const c = this.coins[i];
      if (!c) continue;
      c.ring.visible = false;
      if (i < k) {
        void arcTo(c.holder, potTop.x + ((i % 3) - 1) * geo.coinR * 0.4, potTop.y, {
          durationS: d * 0.32,
          delayS: i * 0.025,
          lift: stage.height * 0.12,
        }).then(() => {
          c.holder.visible = false;
        });
        gsap.to(c.holder.scale, { x: 0.45, y: 0.45, duration: d * 0.32, delay: i * 0.025 });
      } else {
        gsap.to(c.holder, { alpha: 0.55, duration: 0.25 });
      }
    }
    if (k > 0) this.stage.rt.sfx('coin_drop', { volume: 0.7 });
    // The helper acts by script.
    const pa = played.partnerAction;
    const rig = this.partnerRig;
    const partnerCoins = pa.tokens ?? 0;
    if (pa.partner_type === 'free_rider') {
      this.partner.setExpression('happy');
      rig?.setExpression('pleased');
      void rig?.play('fold_arms');
      this.later(() => void rig?.stopGesture(), d * 1000 + 400);
    } else {
      void rig?.play('hand_over');
      this.partner.setExpression('happy');
    }
    const hand = rig ? rig.handPosition('l') : stage.toScreen(geo.partner);
    for (let i = 0; i < partnerCoins; i++) {
      const coin = createBigCoin(geo.coinR * 0.7);
      coin.position.set(hand.x, hand.y);
      this.flyLayer.addChild(coin);
      void arcTo(coin, potTop.x + ((i % 3) - 1) * geo.coinR * 0.3, potTop.y, {
        durationS: d * 0.3,
        delayS: 0.12 + i * 0.03,
        lift: stage.height * 0.06,
      }).then(() => coin.destroy());
    }
    if (pa.is_error) {
      // Scripted accident: the helper's coins tumble from the hand and roll on the ground.
      const spill = Math.max(4, Math.round(this.endowment * 0.7));
      for (let i = 0; i < spill; i++) {
        const coin = createBigCoin(geo.coinR * 0.62);
        coin.position.set(hand.x, hand.y);
        this.flyLayer.addChild(coin);
        const gx = hand.x - stage.width * (0.02 + (0.09 * ((i * 37) % 10)) / 10);
        const gy = stage.toScreen(geo.pot).y + geo.potSize * 0.05 + ((i * 53) % 7) * 4 * stage.u;
        void arcTo(coin, gx, gy, {
          durationS: 0.5,
          delayS: 0.15 + i * 0.03,
          lift: 30 * stage.u,
        }).then(() => {
          squash(coin, 0.25);
          gsap.to(coin, {
            alpha: 0,
            delay: d * 0.8,
            duration: 0.4,
            onComplete: () => coin.destroy(),
          });
        });
      }
      this.later(() => {
        stage.burst('dust', { x: hand.x - stage.width * 0.05, y: stage.toScreen(geo.pot).y }, 16);
        this.stage.rt.sfx('coin_drop', { volume: 0.5 });
        this.partner.setExpression('surprised');
        void rig?.play('shrug');
      }, 450);
      this.later(() => {
        void rig?.play('namaste');
        this.partner.setExpression('calm');
      }, 1300);
    }
    // The pot fills, glows, doubles.
    const totalIn = k + partnerCoins;
    this.later(() => {
      this.pot.setFill(totalIn / (2 * this.endowment));
      squash(this.pot.view, 0.08);
      if (totalIn > 0) {
        gsap.fromTo(
          this.potGlow,
          { alpha: 0.2 },
          { alpha: 0.9, duration: d * 0.25, yoyo: true, repeat: 1 },
        );
        stage.burst('sparkle', potTop, 16 + totalIn);
        this.stage.rt.sfx('jar_fill', { volume: 0.6 });
        this.pot.setFill(Math.min(1, (2 * totalIn) / (2 * this.endowment)));
      }
    }, d * 380);
    // Split: equal shares fly to the player's pouch and to the helper.
    const back = played.settlement.returnEach;
    this.later(() => {
      const pouchTop = { x: this.pouch.x, y: this.pouch.y - geo.coinR * 2 };
      const partnerHand = rig ? rig.handPosition('l') : stage.toScreen(geo.partner);
      const shown = Math.min(back, 14);
      for (let i = 0; i < shown; i++) {
        for (const [target, side] of [
          [pouchTop, 0],
          [partnerHand, 1],
        ] as const) {
          const coin = createBigCoin(geo.coinR * 0.55);
          coin.position.set(potTop.x, potTop.y);
          this.flyLayer.addChild(coin);
          void arcTo(coin, target.x, target.y, {
            durationS: d * 0.32,
            delayS: i * 0.03 + side * 0.015,
            lift: stage.height * 0.1,
          }).then(() => {
            coin.destroy();
            if (side === 0) squash(this.pouch, 0.06);
          });
        }
      }
      if (back > 0) {
        this.stage.rt.sfx('chime', { volume: 0.4 });
        this.pot.setFill(0);
      }
    }, d * 640);
    this.roundsDone += 1;
    // The light slides from golden hour towards sunset over the rounds.
    const tv = 2 + Math.min(0.75, this.roundsDone * 0.08);
    void (
      this.stage.backdrop as { setTimeValue?: (v: number, ms?: number) => Promise<void> } | null
    )?.setTimeValue?.(tv, 1600);
  }

  /** Scripted unfair loss: a shared gift appears; the helper snatches all of it. */
  unfairGrab(tokens: number): void {
    const { stage, geo } = this;
    for (const c of this.coins) c.holder.visible = false;
    this.confirm.view.visible = false;
    this.palmRing.visible = false;
    const potTop = stage.toScreen({ x: geo.pot.x, y: geo.pot.y - geo.potSize * 0.4 });
    const gift = createGiftBasket(geo.potSize * 0.9, tokens);
    gift.position.set(potTop.x - geo.potSize * 0.9, potTop.y + geo.potSize * 0.4);
    this.flyLayer.addChild(gift);
    popIn(gift, 0, 0.5);
    stage.burst('sparkle', { x: gift.x, y: gift.y - geo.potSize * 0.4 }, 14);
    this.guide?.setExpression('happy');
    this.later(() => {
      void this.partnerRig?.play('receive');
      this.partnerRig?.setExpression('delighted');
      const hand = this.partnerRig
        ? this.partnerRig.handPosition('l')
        : stage.toScreen(geo.partner);
      void arcTo(gift, hand.x, hand.y + geo.potSize * 0.1, {
        durationS: 0.6,
        lift: stage.height * 0.08,
      }).then(() => {
        void popOut(gift, 0.25).then(() => gift.destroy({ children: true }));
        this.partnerRig?.setExpression('pleased');
        this.guide?.setExpression('surprised');
      });
      this.stage.rt.sfx('whoosh', { volume: 0.5 });
    }, 550);
  }

  /** Fade the coin cloth away (before the tone probe and the probe segment). */
  hideRoundUi(): void {
    for (const v of [this.mat, this.palm, this.pouch, this.palmRing, this.confirm.view]) {
      gsap.to(v, {
        alpha: 0,
        duration: 0.35,
        onComplete: () => {
          v.visible = false;
        },
      });
    }
    for (const c of this.coins) c.holder.visible = false;
  }

  /** The three tone faces rise in front of the player. */
  showTones(): void {
    const codes: ToneCode[] = ['warm', 'neutral', 'firm'];
    codes.forEach((code, i) => {
      const r = this.geo.tones[i];
      if (!r) return;
      const face = createToneFace(code, r.width);
      const c = centerOf(r);
      face.position.set(c.x, c.y);
      this.stage.ui.addChild(face);
      this.tones.set(code, face);
      popIn(face, i * 0.06, 0.5);
    });
  }

  selectTone(code: ToneCode): void {
    for (const [k, v] of this.tones) {
      if (k === code) {
        hop(v, this.geo.tones[0].width * 0.12);
        const ring = createSelectionRing(this.geo.tones[0].width * 0.56);
        v.addChild(ring);
      } else gsap.to(v, { alpha: 0.35, duration: 0.25 });
    }
    this.stage.rt.sfx('tap', { volume: 0.4 });
  }

  /** The helper reacts to the player's face (expressive only; nothing changes in the game). */
  async toneReaction(code: ToneCode | null): Promise<void> {
    const rig = this.partnerRig;
    if (code === 'warm') {
      this.partner.setExpression('happy');
      void rig?.play('namaste');
    } else if (code === 'neutral') {
      this.partner.setExpression('calm');
      void rig?.play('nod');
    } else if (code === 'firm') {
      this.partner.setExpression('surprised');
      void rig?.play('shrug');
    } else {
      this.partner.setExpression('calm');
    }
    await new Promise<void>((r) => this.later(r, 900));
    for (const v of this.tones.values()) void popOut(v, 0.25);
  }

  /** Closing: thanks all round, petals, and the camera pulls back into the glowing evening. */
  async outro(): Promise<void> {
    const { stage } = this;
    this.mat.visible = false;
    this.palm.visible = false;
    this.pouch.visible = false;
    this.confirm.view.visible = false;
    for (const c of this.coins) c.holder.visible = false;
    this.guide?.setExpression('happy');
    this.partner.setExpression('happy');
    void this.guideRig?.play('celebrate');
    void this.partnerRig?.play('namaste');
    stage.burst('petals', { x: stage.width * 0.5, y: stage.height * 0.35 }, 40);
    stage.rt.sfx('chime', { volume: 0.5 });
    await stage.cameraTo({ x: stage.width / 2, y: stage.height * 0.5, zoom: 1 }, 1.4, 'power2.out');
  }

  destroy(): void {
    gsap.killTweensOf(this.potGlow);
    for (const c of this.coins) {
      gsap.killTweensOf(c.holder);
      gsap.killTweensOf(c.holder.scale);
      gsap.killTweensOf(c.coin);
      gsap.killTweensOf(c.coin.scale);
    }
    for (const t of this.timers.splice(0)) clearTimeout(t);
    this.destroyed = true;
    this.confirm.destroy();
  }

  /** Run `fn` after `ms` unless the scene was destroyed meanwhile. */
  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      if (!this.destroyed) fn();
    }, ms);
    this.timers.push(t);
  }
}
