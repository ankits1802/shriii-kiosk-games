/**
 * Wait-or-Now scene: the halwai's sweet counter in the market square, from golden hour into dusk.
 * Behind the counter, the sweet shop: a striped awning, tiers of laddoos and jalebis, lanterns and a
 * marigold garland; the halwai (sweet-maker) smiles behind his counter. On the counter stand the two
 * brass plates of the offer; the player's wicker basket sits at the corner; the "later" shelf hangs on
 * the wall. Taking a plate NOW tumbles its laddoos into the basket; choosing to WAIT wraps the plate in
 * a leaf parcel tagged with a sun and a moon and puts it on the later shelf. In the effort block the big
 * butter churn stands at the front of the counter: holding its red knob churns the butter (the stick
 * swings, froth rises and marigold beads light around the pot) and the full plate is earned.
 *
 * Measurement integrity: plates are drawn synchronously inside the frame-committed stimulus render, in
 * a layer the camera never moves; choice feedback is short and never blocks the next onset beyond the
 * module's fixed inter-trial wait; nothing shows a number or judges a choice.
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Ticker } from 'pixi.js';
import { MelaArtKit } from '../../art/ArtKit.ts';
import { drawDiya, drawLantern, drawStall } from '../../art/backdrop/props.ts';
import { darken, lighten } from '../../art/color.ts';
import { catenary, glowDisc, marigold, softShadow, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import type { HandHint } from '../../art/ui/buttons.ts';
import type { Character, ModuleContext, Point } from '../../core/contracts.ts';
import type { Side } from '../../paradigms/discounting.ts';
import { markStimulus } from '../dont-tap/kit/devtools.ts';
import type { KitView } from '../dont-tap/kit/micro-game.ts';
import type { ProbeChoice, ProbeSituation } from '../dont-tap/kit/probe.ts';
import { FairStage } from '../dont-tap/kit/scene/FairStage.ts';
import { arcTo, popRing, squash, warmGlow } from '../dont-tap/kit/scene/fx.ts';
import type { GamePhase } from '../dont-tap/kit/types.ts';
import {
  type ChurnArt,
  drawBasket,
  drawChurn,
  drawChurnBadge,
  drawCloche,
  drawParcel,
  drawPile,
  drawPool,
  drawSign,
  drawSunMoonChain,
  drawThali,
  laddooRadius,
  pileHeight,
} from './art.ts';
import { type WaitOrNowGeometry, waitOrNowGeometry } from './geometry.ts';
import type { OfferPicture, PlateSpec, WaitOrNowViewSurface } from './WaitOrNowModule.ts';

type Rig = Character & {
  play(a: string): Promise<void>;
  react?(e: string, s?: number): void;
  pointAt?(p: Point): Promise<void>;
};

/** Backdrop time values (0 morning .. 3 dusk). */
const GOLDEN = 1.72;
const DUSK = 2.7;

/** One plate on the counter (container in the UI layer, at the plate centre). */
interface PlateView {
  readonly view: Container;
  readonly spec: PlateSpec;
  readonly sweets: Graphics[];
  readonly cover: Container | null;
  readonly steam: Graphics[];
  readonly side: Side;
}

export class WaitOrNowView implements KitView, WaitOrNowViewSurface {
  private readonly ctx: ModuleContext;
  private readonly stage: FairStage;
  private readonly g: WaitOrNowGeometry;
  private readonly u: number;
  private readonly plates = new Container();
  private readonly fly = new Container();
  private readonly churnLayer = new Container();
  private readonly shelfItems = new Container();
  private basketContents: Container | null = null;
  private basketView: Container | null = null;
  private halwai: Rig | null = null;
  private current: { left: PlateView; right: PlateView } | null = null;
  private churn: ChurnArt | null = null;
  private churnTl: gsap.core.Timeline | null = null;
  private churnHinted = false;
  private parcels = 0;
  private basketCount = 0;
  private hint: HandHint | null = null;
  private readonly flames: Graphics[] = [];
  private t = 0;
  private readonly onTick = (tk: Ticker): void => this.tick(Math.min(0.05, tk.deltaMS / 1000));

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.g = waitOrNowGeometry(ctx.layout);
    this.u = this.g.u;
    this.stage = new FairStage(ctx, {
      scene: 'market_square',
      timeOfDay: 'golden_hour',
      music: 'hub',
      ambience: 'market_day',
      guide: { at: () => this.g.guide, scale: this.g.characterScale, facing: 'right' },
      emblem: (size) => this.emblem(size),
      focus: () => ({ x: this.g.shop.x, y: this.g.counterTop - 120 * this.u }),
      fireflies: 14,
      godRays: true,
      rayColor: 0xffd49a,
    });
    this.buildShop();
    this.buildHalwai();
    this.buildCounter();
    this.buildShelf();
    this.buildBasket();
    this.stage.ui.addChild(this.churnLayer, this.plates, this.fly);
    if (ctx.art instanceof MelaArtKit) {
      this.hint = ctx.art.createHandHint(24);
      this.stage.ui.addChild(this.hint.view);
    }
    ctx.app.ticker.add(this.onTick);
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Set                                                                                             */
  /* ---------------------------------------------------------------------------------------------- */

  private emblem(size: number): Container {
    const c = new Container();
    const thali = drawThali(size * 0.36);
    thali.y = size * 0.12;
    c.addChild(thali);
    for (const s of drawPile(4, size * 0.36)) {
      s.y += size * 0.12;
      c.addChild(s);
    }
    const chain = drawSunMoonChain(1, size * 0.07);
    chain.view.y = -size * 0.22;
    c.addChild(chain.view);
    return c;
  }

  /** The sweet shop behind the counter (baked): stall, lanterns, garland, warm interior glow. */
  private buildShop(): void {
    const L = this.ctx.layout;
    const u = this.u;
    const { shop, portrait } = this.g;
    const scale = portrait ? 2.6 : 2.35;
    const art = (): Container => {
      const c = new Container();
      const glow = new Graphics();
      glowDisc(glow, shop.x, shop.y - 330 * u, 560 * u, 0xffc777, 0.42);
      glow.blendMode = 'add';
      const stall = drawStall(
        {
          goods: 'sweets',
          stripeA: MELA.kumkum,
          stripeB: MELA.cream,
          cloth: MELA.kumkum,
          seed: 41,
        },
        scale * u,
      );
      stall.view.position.set(shop.x, shop.y);
      c.addChild(glow, stall.view);
      // Side display tiers of sweets (left and right of the stall).
      const tiers = new Graphics();
      for (const sx of portrait ? [] : [-1, 1]) {
        const x = shop.x + sx * 520 * u;
        const base = shop.y - 40 * u;
        for (let t = 0; t < 3; t += 1) {
          const w = (200 - t * 46) * u;
          const y = base - t * 70 * u;
          tiers.roundRect(x - w / 2, y, w, 14 * u, 4 * u).fill(lighten(MELA.wood, 0.2));
          tiers.rect(x - w / 2 + 6 * u, y + 14 * u, 6 * u, 56 * u).fill(MELA.woodDark);
          tiers.rect(x + w / 2 - 12 * u, y + 14 * u, 6 * u, 56 * u).fill(MELA.woodDark);
          const n = 5 - t;
          for (let i = 0; i < n; i += 1) {
            const px = x - w / 2 + 22 * u + (i * (w - 44 * u)) / Math.max(1, n - 1);
            if (t === 1) {
              // Jalebi coils.
              for (let k = 0; k < 3; k += 1) {
                tiers
                  .circle(px, y - 14 * u, (12 - k * 4) * u)
                  .stroke({ width: 4 * u, color: k % 2 ? MELA.saffron : MELA.marigoldDeep });
              }
            } else if (t === 2) {
              // Barfi diamonds with silver leaf.
              tiers
                .poly([
                  px,
                  y - 26 * u,
                  px + 14 * u,
                  y - 12 * u,
                  px,
                  y + 2 * u,
                  px - 14 * u,
                  y - 12 * u,
                ])
                .fill(0xf2e6c4);
              tiers
                .poly([
                  px,
                  y - 22 * u,
                  px + 8 * u,
                  y - 14 * u,
                  px,
                  y - 8 * u,
                  px - 8 * u,
                  y - 14 * u,
                ])
                .fill({ color: 0xffffff, alpha: 0.7 });
            } else {
              tiers.circle(px, y - 14 * u, 14 * u).fill(i % 2 ? 0xf2a43a : 0xe9b356);
              tiers.circle(px - 4 * u, y - 19 * u, 4 * u).fill({ color: 0xffffff, alpha: 0.45 });
            }
          }
        }
      }
      c.addChild(tiers);
      // Marigold garland across the top.
      const garland = new Graphics();
      const pts = catenary(0, L.height * 0.08, L.width, L.height * 0.08, 70 * u, 46);
      for (let i = 0; i < pts.length; i += 1) {
        const p = pts[i] as { x: number; y: number };
        marigold(garland, p.x, p.y, 11 * u, i % 3 === 0 ? MELA.saffron : MELA.marigold);
      }
      for (let i = 2; i < pts.length; i += 6) {
        const p = pts[i] as { x: number; y: number };
        for (let k = 1; k <= 4; k += 1)
          marigold(garland, p.x, p.y + k * 20 * u, 8 * u, k % 2 ? MELA.marigold : MELA.vermilion);
      }
      c.addChild(garland);
      return c;
    };
    this.stage.set.addChild(this.stage.bake('shop', art));
    // Lanterns (live: they sway and glow brighter at dusk).
    const n = portrait ? 3 : 5;
    for (let i = 0; i < n; i += 1) {
      const color = [MELA.vermilion, MELA.saffron, MELA.lotus, MELA.saffron, MELA.vermilion][
        i
      ] as number;
      const lan = drawLantern(1.6 * u, color);
      const x = L.width * ((i + 1) / (n + 1));
      lan.view.position.set(x, L.height * 0.1 + Math.sin((i / (n - 1)) * Math.PI) * 50 * u);
      const glow = new Graphics();
      glowDisc(glow, 0, 46 * u, 70 * u, 0xffb347, 0.5);
      glow.blendMode = 'add';
      lan.view.addChildAt(glow, 0);
      this.stage.set.addChild(lan.view);
      gsap.to(lan.view, {
        rotation: 0.05,
        duration: this.stage.reducedMotion ? 0 : 2.2 + i * 0.3,
        yoyo: true,
        repeat: this.stage.reducedMotion ? 0 : -1,
        ease: 'sine.inOut',
      });
    }
  }

  private buildHalwai(): void {
    const { halwai } = this.g;
    const ch = this.ctx.art.createCharacter({
      id: 'wait_or_now.halwai',
      role: 'vendor',
      variant: 0,
      facing: 'right',
      scale: this.g.characterScale * 1.05,
    }) as Rig;
    ch.view.position.set(halwai.x, halwai.y);
    ch.view.zIndex = halwai.y;
    this.stage.actors.addChild(ch.view);
    this.halwai = ch;
  }

  /** The counter front (in front of the halwai), with carved panels, a mirror-work valance and diyas. */
  private buildCounter(): void {
    const u = this.u;
    const { counterTop: top, counterX0: x0, counterX1: x1 } = this.g;
    const H = this.ctx.layout.height;
    const art = (): Container => {
      const c = new Container();
      const g = new Graphics();
      const bottom = Math.min(H, top + 360 * u);
      softShadow(g, (x0 + x1) / 2, bottom, (x1 - x0) * 0.56, 30 * u, 0x1a0d08, 0.4);
      g.rect(x0 + 12 * u, top + 18 * u, x1 - x0 - 24 * u, bottom - top).fill(
        vgrad([
          [0, MELA.wood],
          [1, darken(MELA.woodDark, 0.2)],
        ]),
      );
      // Carved panels.
      const panels = Math.max(3, Math.round((x1 - x0) / (230 * u)));
      const pw = (x1 - x0 - 24 * u) / panels;
      for (let i = 0; i < panels; i += 1) {
        const px = x0 + 12 * u + i * pw;
        const ph = bottom - top - 90 * u;
        g.roundRect(px + 14 * u, top + 70 * u, pw - 28 * u, ph, 12 * u).fill(
          vgrad([
            [0, i % 2 ? MELA.peacock : MELA.kumkum],
            [1, darken(i % 2 ? MELA.peacockDeep : MELA.kumkum, 0.35)],
          ]),
        );
        g.roundRect(px + 22 * u, top + 78 * u, pw - 44 * u, ph - 16 * u, 9 * u).stroke({
          width: 3 * u,
          color: MELA.brassLight,
          alpha: 0.75,
        });
        // Painted lotus medallion.
        const cx = px + pw / 2;
        const cy = top + 70 * u + ph * 0.42;
        for (let k = 0; k < 8; k += 1) {
          const a = (k / 8) * Math.PI * 2;
          g.ellipse(cx + Math.cos(a) * 20 * u, cy + Math.sin(a) * 20 * u, 14 * u, 8 * u).fill({
            color: MELA.lotus,
            alpha: 0.9,
          });
        }
        g.circle(cx, cy, 13 * u).fill(MELA.marigold);
        g.circle(cx, cy, 5 * u).fill(MELA.saffron);
        // Little paisleys in the corners.
        for (const [dx, dy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const) {
          g.circle(cx + dx * (pw * 0.28), cy + dy * ph * 0.3, 6 * u).fill({
            color: MELA.cream,
            alpha: 0.7,
          });
        }
      }
      // Marigold swags along the valance.
      for (let i = 0; i < panels; i += 1) {
        const ax = x0 + 12 * u + i * pw;
        const pts = catenary(ax + 6 * u, top + 60 * u, ax + pw - 6 * u, top + 60 * u, 34 * u, 14);
        for (let k = 0; k < pts.length; k += 1) {
          const p = pts[k] as { x: number; y: number };
          marigold(g, p.x, p.y, 9 * u, k % 2 ? MELA.marigold : MELA.saffron);
        }
        marigold(g, ax + 6 * u, top + 66 * u, 12 * u, MELA.vermilion);
      }
      // Valance with mirror-work under the top.
      g.rect(x0 + 12 * u, top + 18 * u, x1 - x0 - 24 * u, 38 * u).fill(MELA.peacockDeep);
      for (let x = x0 + 30 * u; x < x1 - 20 * u; x += 34 * u) {
        g.poly([x - 14 * u, top + 56 * u, x, top + 74 * u, x + 14 * u, top + 56 * u]).fill(
          MELA.peacockDeep,
        );
        g.circle(x, top + 37 * u, 6 * u).fill(0xdfe8ea);
        g.circle(x, top + 37 * u, 6 * u).stroke({ width: 2 * u, color: MELA.marigold });
      }
      // Counter top.
      g.roundRect(x0, top - 6 * u, x1 - x0, 26 * u, 8 * u).fill(
        vgrad([
          [0, lighten(MELA.wood, 0.45)],
          [1, lighten(MELA.wood, 0.05)],
        ]),
      );
      g.rect(x0 + 6 * u, top - 4 * u, x1 - x0 - 12 * u, 4 * u).fill({
        color: 0xffffff,
        alpha: 0.2,
      });
      c.addChild(g);
      return c;
    };
    const counter = this.stage.bake('counter', art);
    counter.zIndex = this.g.halwai.y + 50;
    this.stage.actors.addChild(counter);
    // Diyas at both ends (live flames).
    for (const x of [x0 + 40 * u, x1 - 40 * u]) {
      const d = drawDiya(1.5 * u);
      const holder = new Container();
      holder.addChild(d.bowl, d.flame);
      const glow = new Graphics();
      glowDisc(glow, d.light.x, d.light.y, d.light.r * 1.4, d.light.color, 0.55);
      glow.blendMode = 'add';
      holder.addChildAt(glow, 0);
      holder.position.set(x, top);
      holder.zIndex = counter.zIndex + 1;
      this.stage.actors.addChild(holder);
      this.flames.push(d.flame);
    }
  }

  private buildShelf(): void {
    const u = this.u;
    const { shelf } = this.g;
    const art = (): Container => {
      const c = new Container();
      const g = new Graphics();
      softShadow(
        g,
        shelf.x + shelf.width / 2,
        shelf.y + 26 * u,
        shelf.width * 0.5,
        10 * u,
        0x1a0d08,
        0.35,
      );
      g.roundRect(shelf.x, shelf.y, shelf.width, 18 * u, 5 * u).fill(
        vgrad([
          [0, lighten(MELA.wood, 0.35)],
          [1, MELA.wood],
        ]),
      );
      for (const bx of [shelf.x + 18 * u, shelf.x + shelf.width - 30 * u]) {
        g.poly([
          bx,
          shelf.y + 18 * u,
          bx + 12 * u,
          shelf.y + 18 * u,
          bx + 12 * u,
          shelf.y + 60 * u,
        ]).fill(MELA.woodDark);
      }
      // Hanging sun-and-moon charm marks the shelf as "for later".
      const cx = shelf.x + shelf.width / 2;
      g.moveTo(cx, shelf.y + 18 * u)
        .lineTo(cx, shelf.y + 50 * u)
        .stroke({ width: 2 * u, color: MELA.marigoldDeep });
      c.addChild(g);
      const charm = drawSunMoonChain(1, 12 * u);
      charm.view.position.set(cx, shelf.y + 66 * u);
      c.addChild(charm.view);
      return c;
    };
    this.stage.set.addChild(this.stage.bake('shelf', art));
    this.stage.set.addChild(this.shelfItems);
  }

  private buildBasket(): void {
    const b = drawBasket(220 * this.u);
    b.view.position.set(this.g.basket.x, this.g.basket.y);
    b.view.zIndex = this.g.halwai.y + 60;
    this.stage.actors.addChild(b.view);
    this.basketContents = b.contents;
    this.basketView = b.view;
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* KitView                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  intro(): Promise<void> {
    return this.stage.intro(async () => {
      void this.halwai?.play('namaste');
      this.halwai?.react?.('delighted', 1.2);
    });
  }

  async outro(): Promise<void> {
    this.hidePlates();
    this.churnLayer.visible = false;
    void this.halwai?.play('celebrate');
    this.halwai?.react?.('delighted', 1.2);
    if (this.basketView) void squash(this.basketView, 0.06, this.stage.reducedMotion);
    await this.stage.outro();
  }

  phase(_p: GamePhase): void {}

  guideSpeak(ms: number): void {
    this.stage.guideSpeak(ms);
  }

  enterProbes(): Promise<void> {
    this.hidePlates();
    this.churnLayer.visible = false;
    return this.stage.enterProbes();
  }

  showProbe(s: ProbeSituation): void {
    this.stage.showProbe(s);
  }

  probeChosen(choice: ProbeChoice | null): Promise<void> {
    return this.stage.probeChosen(choice);
  }

  exitProbes(): Promise<void> {
    return this.stage.exitProbes();
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Trial surface                                                                                  */
  /* ---------------------------------------------------------------------------------------------- */

  layOut(): void {
    void this.halwai?.play('hand_over');
    this.ctx.audio.playSfx('whoosh', { volume: 0.25 });
  }

  async enterBlock(block: 'delay' | 'effort'): Promise<void> {
    if (block === 'delay') {
      this.churnLayer.visible = false;
      void this.halwai?.play('beckon');
      this.stage.guidePoint({ x: this.ctx.layout.width / 2, y: this.g.leftPlate.y });
      await this.stage.mood({ time: GOLDEN, tension: 0.1, durationMs: 600 });
      this.stage.guideIdle();
      return;
    }
    // Dusk falls; the lanterns win; the churn is carried to the front of the counter.
    this.hidePlates();
    this.ensureChurn();
    const churn = this.churn as ChurnArt;
    this.churnLayer.visible = true;
    churn.view.alpha = 0;
    churn.view.y = this.churnBaseY() + 40 * this.u;
    gsap.to(churn.view, {
      alpha: 0.6,
      y: this.churnBaseY(),
      duration: this.stage.reducedMotion ? 0.2 : 0.8,
      ease: 'back.out(1.4)',
    });
    void this.halwai?.play('hand_over');
    this.halwai?.react?.('pleased', 1);
    this.stage.guidePoint(this.g.churnCentre);
    await this.stage.mood({ time: DUSK, tension: 0.15, fireflies: 1.25, durationMs: 1200 });
    // Demonstration: the hand presses the red knob and the stick swings (nothing is earned here).
    const knob = { x: this.g.churnCentre.x, y: this.churnBaseY() - this.g.churn.height * 0.8 };
    this.hint?.show('hold', knob, 1400);
    this.churnHinted = true;
    const swing = gsap.to(churn.stick, {
      rotation: 0.16,
      duration: 0.32,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: this.stage.reducedMotion ? 0 : 3,
    });
    await new Promise<void>((r) => {
      gsap.delayedCall(this.stage.reducedMotion ? 0.3 : 1.5, r);
    });
    swing.kill();
    churn.stick.rotation = 0;
    this.hint?.stop();
    this.stage.guideIdle();
  }

  showOffer(offer: OfferPicture): void {
    this.hidePlates();
    const left = this.buildPlate(offer.left, 'left');
    const right = this.buildPlate(offer.right, 'right');
    this.plates.addChild(left.view, right.view);
    this.current = { left, right };
    if (this.churn) this.churn.view.alpha = offer.block === 'effort' ? 0.6 : 0;
    // Visible at full size on the commit frame; a tiny settle only (never hides the stimulus).
    if (!this.stage.reducedMotion) {
      for (const p of [left, right]) {
        p.view.scale.set(0.97);
        gsap.to(p.view.scale, { x: 1, y: 1, duration: 0.35, ease: 'back.out(2)' });
      }
    }
    markStimulus(
      `${offer.left.kind}:${offer.left.amount}|${offer.right.kind}:${offer.right.amount}`,
    );
    this.halwai?.react?.('calm', 0.4);
  }

  private buildPlate(spec: PlateSpec, side: Side): PlateView {
    const u = this.u;
    const at = side === 'left' ? this.g.leftPlate : this.g.rightPlate;
    const R = this.g.plateR;
    const view = new Container();
    view.position.set(at.x, at.y);
    const pool = drawPool(R * 1.5, spec.kind === 'wait' ? 0xbfe0ff : 0xffd9a0, 0.34);
    pool.y = R * 0.14;
    view.addChild(pool, drawThali(R));
    const sweets = drawPile(spec.amount, R);
    for (const s of sweets) view.addChild(s);
    const steam: Graphics[] = [];
    let cover: Container | null = null;
    const top = pileHeight(Math.max(spec.amount, 1), R);
    if (spec.kind === 'wait') {
      const h = Math.max(top + 30 * u, R * 0.9);
      cover = drawCloche(R, h);
      cover.y = R * 0.04;
      view.addChild(cover);
      const chain = drawSunMoonChain(spec.delay, 17 * u);
      const signY = -h - 34 * u - chain.height / 2;
      view.addChild(
        drawSign(chain.view.width + 34 * u, chain.height + 18 * u, signY, -h - R * 0.12, u),
      );
      chain.view.y = signY;
      view.addChild(chain.view);
    } else if (spec.kind === 'hard') {
      const badge = drawChurnBadge(70 * u);
      badge.y = -top - 95 * u;
      view.addChild(drawSign(150 * u, 150 * u, badge.y - 20 * u, -top - 12 * u, u), badge);
    } else if (spec.kind === 'now' || spec.kind === 'easy') {
      // Fresh and warm: curling steam above the pile (animated in the ticker).
      for (let i = 0; i < 3; i += 1) {
        const s = new Graphics();
        s.moveTo(0, 0)
          .bezierCurveTo(-12 * u, -20 * u, 12 * u, -40 * u, 0, -60 * u)
          .stroke({ width: 5 * u, color: 0xffffff, alpha: 0.55, cap: 'round' });
        s.position.set((i - 1) * 34 * u, -top + 4 * u);
        s.alpha = 0;
        view.addChild(s);
        steam.push(s);
      }
    }
    return { view, spec, sweets, cover, steam, side };
  }

  private hidePlates(): void {
    const cur = this.current;
    this.current = null;
    markStimulus(null);
    if (!cur) return;
    for (const p of [cur.left, cur.right]) {
      gsap.killTweensOf(p.view);
      gsap.killTweensOf(p.view.scale);
      p.view.destroy({ children: true });
    }
  }

  async chosen(side: Side | null, offer: OfferPicture): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    const rm = this.stage.reducedMotion;
    if (side === null) {
      // Nothing chosen: both plates simply rest (no judgement).
      for (const p of [cur.left, cur.right])
        gsap.to(p.view, { alpha: 0.45, duration: rm ? 0.05 : 0.3 });
      this.halwai?.react?.('thinking', 0.8);
      return;
    }
    const picked = side === 'left' ? cur.left : cur.right;
    const other = side === 'left' ? cur.right : cur.left;
    gsap.to(other.view, { alpha: 0.25, duration: rm ? 0.05 : 0.25 });
    gsap.to(other.view.scale, { x: 0.92, y: 0.92, duration: rm ? 0.05 : 0.25 });
    void squash(picked.view, 0.08, rm);
    popRing(
      this.stage.ui,
      { x: picked.view.x, y: picked.view.y - this.g.plateR * 0.2 },
      this.g.plateR * 0.9,
      0xfff1c8,
      rm,
    );
    this.ctx.audio.playSfx('tap_soft', { volume: 0.5 });
    const kind = picked.spec.kind;
    if (kind === 'now' || kind === 'easy') {
      this.sweetsToBasket(picked);
      void this.halwai?.play('hand_over');
      this.halwai?.react?.('delighted', 0.9);
    } else if (kind === 'wait') {
      this.parcelToShelf(picked);
      void this.halwai?.play('nod');
      this.halwai?.react?.('pleased', 0.9);
    } else {
      // Hard: the plate waits by the churn while the butter is churned.
      this.halwai?.react?.('pleased', 0.9);
      void this.halwai?.play('point');
    }
    void offer;
    await new Promise<void>((r) => {
      gsap.delayedCall(rm ? 0.05 : 0.3, r);
    });
  }

  /** Laddoos arc from the plate into the basket and settle there (pictured, uncounted). */
  private sweetsToBasket(plate: PlateView): void {
    const contents = this.basketContents;
    const basket = this.basketView;
    if (!contents || !basket) return;
    const rm = this.stage.reducedMotion;
    const r = laddooRadius(this.g.plateR);
    plate.sweets.forEach((s, i) => {
      const gp = plate.view.toGlobal(s.position);
      const local = this.fly.toLocal(gp);
      const flyer = new Graphics();
      flyer.context = s.context;
      flyer.position.set(local.x, local.y);
      this.fly.addChild(flyer);
      s.visible = false;
      const k = this.basketCount + i;
      const slot = {
        x: ((k % 7) - 3) * r * 1.2 + (Math.floor(k / 7) % 2) * r * 0.6,
        y: -Math.min(4, Math.floor(k / 7)) * r * 0.55 - r * 0.2,
      };
      const target = { x: basket.x + slot.x * 0.62, y: basket.y - 110 * this.u + slot.y * 0.62 };
      void arcTo(
        flyer,
        target,
        { height: 160 * this.u, durationS: 0.42 + i * 0.035, spin: 0.6, scaleTo: 0.62 },
        rm,
      ).then(() => {
        if (flyer.destroyed) return;
        if (k < 35) {
          const kept = new Graphics();
          kept.context = s.context;
          kept.position.set(slot.x * 0.62, slot.y * 0.62);
          kept.scale.set(0.62);
          contents.addChild(kept);
        }
        flyer.destroy();
        if (i === plate.sweets.length - 1) {
          void squash(basket, 0.06, rm);
          this.stage.burst('sparkle', { x: basket.x, y: basket.y - 120 * this.u }, rm ? 4 : 12);
        }
      });
    });
    this.basketCount += plate.sweets.length;
  }

  /** The covered plate becomes a leaf parcel with a sun-moon tag and hops onto the later shelf. */
  private parcelToShelf(plate: PlateView): void {
    const { shelf } = this.g;
    const rm = this.stage.reducedMotion;
    const s = 58 * this.u;
    const perRow = Math.max(3, Math.floor((shelf.width - 40 * this.u) / (s * 1.05)));
    const k = this.parcels;
    this.parcels += 1;
    const row = Math.floor(k / perRow);
    const col = k % perRow;
    const target = {
      x: shelf.x + 30 * this.u + s / 2 + col * s * 1.05 + (row % 2) * s * 0.5,
      y: shelf.y - s * 0.42 - row * s * 0.7,
    };
    const parcel = drawParcel(s);
    const start = this.fly.toLocal(plate.view.toGlobal({ x: 0, y: -this.g.plateR * 0.3 }));
    parcel.position.set(start.x, start.y);
    parcel.scale.set(1.8);
    parcel.alpha = 0;
    this.fly.addChild(parcel);
    for (const sw of plate.sweets) gsap.to(sw, { alpha: 0, duration: rm ? 0.05 : 0.2 });
    if (plate.cover) gsap.to(plate.cover, { alpha: 0, duration: rm ? 0.05 : 0.2 });
    gsap.to(parcel, { alpha: 1, duration: rm ? 0.05 : 0.18 });
    void arcTo(
      parcel,
      target,
      { height: 220 * this.u, durationS: 0.7, spin: 0, scaleTo: 1 },
      rm,
    ).then(() => {
      if (parcel.destroyed) return;
      // Re-home onto the shelf (world layer; the camera is at rest during trials).
      this.fly.removeChild(parcel);
      this.shelfItems.addChild(parcel);
      void squash(parcel, 0.12, rm);
      this.ctx.audio.playSfx('pot_place', { volume: 0.35 });
    });
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Churn (hold-to-earn)                                                                           */
  /* ---------------------------------------------------------------------------------------------- */

  private churnBaseY(): number {
    const c = this.g.churn;
    return c.y + c.height * 0.9;
  }

  private ensureChurn(): void {
    if (this.churn) return;
    const churn = drawChurn(this.g.churn.height);
    churn.view.position.set(this.g.churnCentre.x, this.churnBaseY());
    this.churnLayer.addChild(churn.view);
    this.churn = churn;
  }

  showChurn(_requiredMs: number): void {
    this.ensureChurn();
    const churn = this.churn as ChurnArt;
    this.churnLayer.visible = true;
    gsap.killTweensOf(churn.view);
    churn.view.alpha = 1;
    churn.view.y = this.churnBaseY();
    for (const b of churn.beads) {
      gsap.killTweensOf(b);
      gsap.killTweensOf(b.scale);
      b.alpha = 0.25;
      b.scale.set(0.8);
    }
    churn.froth.scale.set(0.4);
    void squash(churn.view, 0.06, this.stage.reducedMotion);
    warmGlow(
      this.stage.ui,
      this.stage.fx,
      { x: this.g.churnCentre.x, y: this.g.churnCentre.y },
      this.g.churn.width * 0.7,
      0xffe2a0,
    );
    if (!this.churnHinted && this.hint) {
      this.churnHinted = true;
      const knob = { x: this.g.churnCentre.x, y: this.churnBaseY() - this.g.churn.height * 0.8 };
      this.hint.show('hold', knob, 1400);
    }
    this.requiredMs = _requiredMs;
  }

  private requiredMs = 2500;

  churnStart(): void {
    const churn = this.churn;
    if (!churn) return;
    this.hint?.stop();
    markStimulus('churn');
    const rm = this.stage.reducedMotion;
    const dur = this.requiredMs / 1000;
    this.churnTl?.kill();
    const tl = gsap.timeline();
    // The stick swings back and forth (slow, well under 3 Hz).
    if (!rm) {
      tl.to(
        churn.stick,
        { rotation: 0.16, duration: 0.32, ease: 'sine.inOut', yoyo: true, repeat: -1 },
        0,
      );
    }
    tl.to(churn.froth.scale, { x: 1.25, y: 1.25, duration: dur, ease: 'power1.out' }, 0);
    churn.beads.forEach((b, i) => {
      const at = ((i + 1) / churn.beads.length) * dur;
      tl.to(b, { alpha: 1, duration: rm ? 0.01 : 0.12 }, at - 0.12);
      tl.to(
        b.scale,
        { x: 1.15, y: 1.15, duration: rm ? 0.01 : 0.12, ease: 'back.out(3)' },
        at - 0.12,
      );
      if (i % 3 === 2) tl.call(() => this.ctx.audio.playSfx('tap_soft', { volume: 0.25 }), [], at);
    });
    this.churnTl = tl;
    this.halwai?.react?.('pleased', dur);
  }

  async churnEnd(
    result: { readonly completed: boolean; readonly heldMs: number } | null,
  ): Promise<void> {
    const churn = this.churn;
    this.hint?.stop();
    this.churnTl?.kill();
    this.churnTl = null;
    const rm = this.stage.reducedMotion;
    if (!churn) return;
    gsap.to(churn.stick, { rotation: 0, duration: rm ? 0.05 : 0.4, ease: 'sine.out' });
    const cur = this.current;
    const hardPlate = cur ? (cur.left.spec.kind === 'hard' ? cur.left : cur.right) : null;
    if (result?.completed) {
      for (const b of churn.beads) b.alpha = 1;
      const top = { x: this.g.churnCentre.x, y: this.churnBaseY() - this.g.churn.height * 0.55 };
      this.stage.burst('sparkle', top, rm ? 6 : 26, this.stage.ui);
      warmGlow(this.stage.ui, this.stage.fx, top, this.g.churn.width * 0.8, 0xfff1c8);
      this.ctx.audio.playSfx('chime', { volume: 0.5 });
      void this.halwai?.play('clap');
      this.halwai?.react?.('delighted', 1);
      if (hardPlate) this.sweetsToBasket(hardPlate);
    } else {
      // Let go early or never started: the churn rests, the beads dim, the halwai nods kindly.
      for (const b of churn.beads) gsap.to(b, { alpha: 0.25, duration: rm ? 0.05 : 0.4 });
      gsap.to(churn.froth.scale, { x: 0.4, y: 0.4, duration: rm ? 0.05 : 0.5 });
      void this.halwai?.play('nod');
      this.halwai?.react?.('calm', 0.8);
      if (hardPlate) gsap.to(hardPlate.view, { alpha: 0.3, duration: rm ? 0.05 : 0.4 });
    }
    gsap.to(churn.view, { alpha: 0.6, duration: rm ? 0.05 : 0.5, delay: rm ? 0 : 0.4 });
    await new Promise<void>((r) => {
      gsap.delayedCall(rm ? 0.05 : 0.35, r);
    });
  }

  practiceHint(target: 'plates' | 'churn' | null): void {
    const hint = this.hint;
    if (!hint) return;
    if (target === null) {
      hint.stop();
      return;
    }
    if (target === 'churn') {
      hint.show('hold', this.g.churnCentre, 1400);
      return;
    }
    // Between the two plates, slightly above: the hand taps one then the other.
    hint.show('tap', { x: this.ctx.layout.width / 2, y: this.g.leftPlate.y - this.g.plateR * 0.4 });
  }

  /* ---------------------------------------------------------------------------------------------- */

  private tick(dt: number): void {
    this.t += dt;
    const rm = this.stage.reducedMotion;
    for (let i = 0; i < this.flames.length; i += 1) {
      const f = this.flames[i] as Graphics;
      f.scale.y = rm
        ? 1
        : 1 + Math.sin(this.t * 7 + i * 2) * 0.08 + Math.sin(this.t * 13 + i) * 0.04;
    }
    const cur = this.current;
    if (cur && !rm) {
      for (const p of [cur.left, cur.right]) {
        p.steam.forEach((s, i) => {
          const ph = (this.t * 0.45 + i / 3) % 1;
          s.alpha = Math.sin(ph * Math.PI) * 0.7;
          s.y =
            -pileHeight(Math.max(p.spec.amount, 1), this.g.plateR) + 4 * this.u - ph * 30 * this.u;
          s.x = (i - 1) * 34 * this.u + Math.sin(this.t * 1.3 + i) * 4 * this.u;
        });
      }
    }
  }

  destroy(): void {
    this.ctx.app.ticker.remove(this.onTick);
    this.churnTl?.kill();
    this.hint?.stop();
    this.hidePlates();
    this.halwai?.destroy();
    this.stage.destroy();
  }
}
