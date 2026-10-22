/**
 * Card Sort scene: inside the fortune-teller's tent at golden hour. Velvet curtains frame a round
 * table with an embroidered cloth; four key cards rest on brass trays; a brass diya burns between
 * curls of incense. The teller (an elder with a turban) draws each card with a flourish, and reacts
 * to every sort: a pleased nod with sparkles for a match, a gentle thoughtful tilt for a miss.
 *
 * Measurement integrity: `showCard` puts the card in place, fully visible, synchronously (the
 * frame-committed onset); nothing animates over the piles while a response is possible; feedback runs
 * inside the configured feedback interval; the camera is at rest during trials.
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Ticker } from 'pixi.js';
import { MelaArtKit } from '../../art/ArtKit.ts';
import { glowDisc, rgrad, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import type { HandHint } from '../../art/ui/buttons.ts';
import type { Character, ModuleContext } from '../../core/contracts.ts';
import type { Pile } from '../../paradigms/card-sort.ts';
import { PILES } from '../../paradigms/card-sort.ts';
import { markStimulus } from '../dont-tap/kit/devtools.ts';
import type { KitView } from '../dont-tap/kit/micro-game.ts';
import type { ProbeChoice, ProbeSituation } from '../dont-tap/kit/probe.ts';
import { FairStage } from '../dont-tap/kit/scene/FairStage.ts';
import { arcTo, contactShadow, popRing, squash, warmGlow } from '../dont-tap/kit/scene/fx.ts';
import type { GamePhase } from '../dont-tap/kit/types.ts';
import type { CardFace, CardSortViewSurface } from './CardSortModule.ts';
import { drawCardBack, drawCardFace } from './cards.ts';
import { type CardSortGeometry, cardSortGeometry, pileRect } from './geometry.ts';

type Rig = Character & {
  play(a: string): Promise<void>;
  react?(e: string, s?: number): void;
  setExpression(e: string): void;
};

export class CardSortView implements KitView, CardSortViewSurface {
  private readonly ctx: ModuleContext;
  private readonly stage: FairStage;
  private readonly g: CardSortGeometry;
  private readonly u: number;
  private readonly table = new Container();
  private readonly keyLayer = new Container();
  private readonly pileStacks: Container[] = [];
  private readonly cardLayer = new Container();
  private readonly smoke = new Container();
  private card: Container | null = null;
  private teller: Rig | null = null;
  private hintHand: HandHint | null = null;
  private flame: Graphics | null = null;
  private t = 0;
  private readonly onTick = (tk: Ticker): void => this.tick(Math.min(0.05, tk.deltaMS / 1000));
  private readonly bake = (key: string, build: () => Container): Container =>
    this.stage.bake(key, build);

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.g = cardSortGeometry(ctx.layout);
    this.u = Math.min(ctx.layout.width, ctx.layout.height) / 1080;
    this.stage = new FairStage(ctx, {
      scene: 'card_tent',
      timeOfDay: 'golden_hour',
      music: 'hub',
      ambience: 'quiet',
      guide: { at: () => this.g.guide, scale: this.g.characterScale, facing: 'right' },
      emblem: (size) => this.emblem(size),
      focus: () => this.g.card,
      fireflies: 14,
      godRays: true,
      rayColor: 0xffd9a0,
    });
    this.buildTeller();
    this.buildTable();
    this.stage.ui.addChild(this.keyLayer, this.cardLayer);
    const art = ctx.art;
    if (art instanceof MelaArtKit) {
      this.hintHand = art.createHandHint(24);
      this.stage.ui.addChild(this.hintHand.view);
    }
    ctx.app.ticker.add(this.onTick);
  }

  /* ---------------------------------------------------------------------------------------------- */

  private buildTeller(): void {
    const { teller } = this.g;
    const ch = this.ctx.art.createCharacter({
      id: 'card_sort.teller',
      role: 'vendor',
      variant: 6,
      facing: 'left',
      scale: this.g.characterScale * 1.05,
    }) as Rig;
    ch.view.position.set(teller.x, teller.y);
    ch.setExpression('calm');
    this.stage.actors.addChild(ch.view);
    this.teller = ch;
  }

  private buildTable(): void {
    const L = this.ctx.layout;
    const u = this.u;
    const { tableY } = this.g;
    const first = this.g.piles[0];
    const last = this.g.piles[this.g.piles.length - 1];
    if (!first || !last) return;
    const x0 = first.x - this.g.cardW * 0.35;
    const x1 = last.x + last.width + this.g.cardW * 0.35;
    const w = x1 - x0;
    const cx = (x0 + x1) / 2;
    const art = (): Container => {
      const c = new Container();
      const sh = contactShadow(w * 0.55, 34 * u, 0.4);
      sh.position.set(cx, Math.min(L.height * 0.995, tableY + this.g.cardH * 1.35));
      c.addChild(sh);
      const g = new Graphics();
      // Table top (elliptical) with a velvet cloth falling to the floor.
      g.ellipse(cx, tableY, w / 2, w * 0.07).fill(
        vgrad([
          [0, 0x7a1626],
          [1, 0x5c0f1c],
        ]),
      );
      g.moveTo(x0, tableY)
        .lineTo(x0 - w * 0.02, L.height * 1.02)
        .lineTo(x1 + w * 0.02, L.height * 1.02)
        .lineTo(x1, tableY)
        .closePath()
        .fill(
          vgrad([
            [0, 0x6a1322],
            [1, 0x3e0a14],
          ]),
        );
      // Cloth folds and a gold-embroidered border.
      for (let i = 1; i < 12; i += 1) {
        const fx = x0 + (i / 12) * w;
        g.moveTo(fx, tableY + w * 0.05)
          .quadraticCurveTo(fx + w * 0.01, (tableY + L.height) / 2, fx - w * 0.004, L.height)
          .stroke({ width: 3 * u, color: 0x2e0610, alpha: 0.35 });
      }
      const bandY = tableY + w * 0.06;
      g.moveTo(x0, bandY)
        .quadraticCurveTo(cx, bandY + w * 0.05, x1, bandY)
        .stroke({ width: 10 * u, color: MELA.brass });
      for (let i = 0; i <= 20; i += 1) {
        const t = i / 20;
        const bx = x0 + t * w;
        const by = bandY + 4 * w * 0.05 * t * (1 - t) * 0.5 + 18 * u;
        g.moveTo(bx, by - 10 * u)
          .lineTo(bx, by + 6 * u)
          .stroke({ width: 2 * u, color: MELA.marigold });
        g.circle(bx, by + 9 * u, 4 * u).fill(MELA.marigold);
      }
      g.ellipse(cx, tableY, w / 2, w * 0.07).stroke({
        width: 3 * u,
        color: MELA.brass,
        alpha: 0.8,
      });
      // Brass trays under the key cards.
      for (const r of this.g.piles) {
        g.ellipse(r.x + r.width / 2, r.y + r.height * 0.96, r.width * 0.6, r.width * 0.14).fill(
          rgrad(
            [
              [0, MELA.brassLight],
              [0.8, MELA.brass],
              [1, 0x8a5c16],
            ],
            { x: 0.45, y: 0.35 },
            0.8,
          ),
        );
      }
      c.addChild(g);
      return c;
    };
    this.table.addChild(this.bake('table', art));
    // Diya and incense on the table centre (live: the flame flickers).
    const diya = new Container();
    const bowl = new Graphics()
      .moveTo(-26 * u, -6 * u)
      .quadraticCurveTo(0, 16 * u, 26 * u, -6 * u)
      .lineTo(34 * u, -10 * u)
      .closePath()
      .fill(MELA.brass);
    const flame = new Graphics()
      .moveTo(0, 0)
      .bezierCurveTo(-8 * u, -6 * u, -6 * u, -18 * u, 0, -30 * u)
      .bezierCurveTo(6 * u, -18 * u, 8 * u, -6 * u, 0, 0)
      .fill(0xffc24a);
    flame.position.set(30 * u, -12 * u);
    const glow = new Graphics();
    glowDisc(glow, 30 * u, -24 * u, 90 * u, 0xffa347, 0.8);
    glow.blendMode = 'add';
    diya.addChild(glow, bowl, flame);
    diya.position.set(cx - w * 0.36, tableY - 6 * u);
    this.flame = flame;
    this.table.addChild(diya, this.smoke);
    this.smoke.position.set(cx - w * 0.3, tableY - 10 * u);
    // The table stands in front of the teller (actors are depth-sorted; the guide stays in front).
    this.table.zIndex = this.g.teller.y + 100;
    this.stage.actors.addChild(this.table);
  }

  private emblem(size: number): Container {
    const c = new Container();
    const a = drawCardBack(size * 0.42);
    a.rotation = -0.25;
    a.position.set(-size * 0.12, 0);
    const b = drawCardFace(
      { colourPattern: 'yellow_checks', shape: 'star', count: 1 },
      size * 0.42,
    );
    b.rotation = 0.2;
    b.position.set(size * 0.12, 0);
    c.addChild(a, b);
    return c;
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* KitView                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  intro(): Promise<void> {
    return this.stage.intro(async () => {
      void this.teller?.play('namaste');
    });
  }

  async outro(): Promise<void> {
    void this.teller?.play('namaste');
    await this.stage.outro();
  }

  phase(_p: GamePhase): void {}

  guideSpeak(ms: number): void {
    this.stage.guideSpeak(ms);
  }

  enterProbes(): Promise<void> {
    this.clearCard();
    this.keyLayer.visible = false;
    return this.stage.enterProbes();
  }

  showProbe(s: ProbeSituation): void {
    this.stage.showProbe(s);
  }

  probeChosen(choice: ProbeChoice | null): Promise<void> {
    return this.stage.probeChosen(choice);
  }

  async exitProbes(): Promise<void> {
    await this.stage.exitProbes();
    this.keyLayer.visible = true;
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Trial surface                                                                                  */
  /* ---------------------------------------------------------------------------------------------- */

  async dealKeys(keys: readonly CardFace[]): Promise<void> {
    for (const c of this.keyLayer.removeChildren()) c.destroy({ children: true });
    this.pileStacks.length = 0;
    const deck = this.g.card;
    const tasks: Promise<void>[] = [];
    keys.forEach((face, i) => {
      const r = this.g.piles[i];
      if (!r) return;
      const stack = new Container();
      stack.position.set(r.x + r.width / 2, r.y + r.height / 2);
      const keyCard = this.bake(
        `key.${face.colourPattern}.${face.shape}.${face.count}.${Math.round(r.width)}`,
        () => drawCardFace(face, r.width),
      );
      stack.addChild(keyCard);
      this.keyLayer.addChild(stack);
      this.pileStacks.push(stack);
      if (this.stage.reducedMotion) return;
      const target = { x: stack.x, y: stack.y };
      stack.position.set(deck.x, deck.y);
      stack.scale.set(0.3);
      stack.rotation = -0.8;
      tasks.push(
        new Promise<void>((resolve) => {
          gsap.to(stack, {
            x: target.x,
            y: target.y,
            rotation: 0,
            duration: 0.55,
            delay: 1.0 + i * 0.16,
            ease: 'power3.out',
          });
          gsap.to(stack.scale, {
            x: 1,
            y: 1,
            duration: 0.55,
            delay: 1.0 + i * 0.16,
            ease: 'back.out(1.6)',
            onComplete: () => {
              this.ctx.audio.playSfx('card_flip', { volume: 0.5 });
              resolve();
            },
          });
        }),
      );
    });
    await Promise.all(tasks);
  }

  showCard(face: CardFace): void {
    this.clearCard();
    const { card } = this.g;
    const c = new Container();
    const aura = new Graphics();
    glowDisc(aura, 0, 0, this.g.cardW * 1.1, 0xffe2a0, 0.55);
    aura.blendMode = 'add';
    const art = this.bake(
      `card.${face.colourPattern}.${face.shape}.${face.count}.${Math.round(this.g.cardW)}`,
      () => drawCardFace(face, this.g.cardW),
    );
    c.addChild(aura, art);
    c.position.set(card.x, card.y);
    this.cardLayer.addChild(c);
    this.card = c;
    markStimulus(`${face.colourPattern}.${face.shape}.${face.count}`);
    this.ctx.audio.playSfx('card_flip', { volume: 0.6 });
    void this.teller?.play('hand_over');
  }

  private clearCard(): void {
    if (!this.card) return;
    gsap.killTweensOf(this.card);
    gsap.killTweensOf(this.card.scale);
    this.card.destroy({ children: true });
    this.card = null;
  }

  async sortTo(pile: Pile, correct: boolean): Promise<void> {
    const c = this.card;
    if (!c) return;
    this.card = null;
    markStimulus(null);
    const r = pileRect(this.g, pile);
    const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    const aura = c.children[0];
    if (aura) gsap.to(aura, { alpha: 0, duration: 0.15 });
    await arcTo(
      c,
      { x: at.x, y: at.y - r.height * 0.05 },
      { height: r.height * 0.5, durationS: 0.28, spin: 0.15 },
      this.stage.reducedMotion,
    );
    c.rotation = 0;
    const stack = this.pileStacks[PILES.indexOf(pile)];
    if (stack) void squash(stack, 0.08, this.stage.reducedMotion);
    if (correct) {
      warmGlow(this.stage.ui, this.stage.fx, at, r.width * 1.1);
      this.stage.burst('sparkle', { x: at.x, y: at.y - r.height * 0.3 }, 14, this.stage.ui);
      this.teller?.react?.('pleased', 0.6);
      void this.teller?.play('nod');
    } else {
      popRing(this.stage.ui, at, r.width * 0.55, 0xd8c7a0, this.stage.reducedMotion);
      this.teller?.react?.('thinking', 0.7);
      void this.teller?.play('head_shake');
    }
    // The sorted card settles onto the pile, then fades (the key card stays on top for reference).
    gsap.to(c, {
      alpha: 0,
      duration: 0.25,
      delay: 0.25,
      onComplete: () => c.destroy({ children: true }),
    });
  }

  async cardTimeout(): Promise<void> {
    const c = this.card;
    if (!c) return;
    this.card = null;
    markStimulus(null);
    await new Promise<void>((resolve) => {
      gsap.to(c, {
        alpha: 0,
        y: c.y - 30 * this.u,
        duration: 0.3,
        onComplete: resolve,
        onInterrupt: resolve,
      });
    });
    c.destroy({ children: true });
  }

  hint(pile: Pile | null): void {
    if (!this.hintHand) return;
    if (pile === null) {
      this.hintHand.stop();
      return;
    }
    const r = pileRect(this.g, pile);
    this.hintHand.show('tap', { x: r.x + r.width / 2, y: r.y + r.height / 2 });
  }

  /* ---------------------------------------------------------------------------------------------- */

  private tick(dt: number): void {
    this.t += dt;
    if (this.flame) {
      const k = 1 + 0.08 * Math.sin(this.t * 9) + 0.05 * Math.sin(this.t * 13.7);
      this.flame.scale.set(1, k);
    }
    // Incense: slow curls (a few soft puffs rising and fading).
    if (
      this.smoke.children.length < 6 &&
      Math.floor(this.t * 1.6) !== Math.floor((this.t - dt) * 1.6)
    ) {
      const p = new Graphics().circle(0, 0, 10 * this.u).fill({ color: 0xf2ece4, alpha: 0.35 });
      this.smoke.addChild(p);
      gsap.to(p, {
        y: -160 * this.u,
        x: 20 * this.u * Math.sin(this.t),
        alpha: 0,
        duration: 3.2,
        ease: 'sine.out',
        onComplete: () => p.destroy(),
      });
      gsap.to(p.scale, { x: 2.6, y: 2.6, duration: 3.2 });
    }
    // Gentle float of the drawn card (never moves the target piles).
    if (this.card && !gsap.isTweening(this.card))
      this.card.y = this.g.card.y + Math.sin(this.t * 1.8) * 4 * this.u;
  }

  destroy(): void {
    this.ctx.app.ticker.remove(this.onTick);
    this.hintHand?.stop();
    this.teller?.destroy();
    this.stage.destroy();
  }
}
