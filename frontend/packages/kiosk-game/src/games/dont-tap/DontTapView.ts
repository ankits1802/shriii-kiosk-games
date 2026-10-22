/**
 * Don't-Tap scene: the firefly fruit-toss booth at dusk. A carved wooden arch with a striped awning,
 * brass toss-rings on pegs, firefly jars glowing on the shelves, marigold garlands and two lanterns;
 * a stone pedestal under a lantern spotlight where each fruit appears; a customer with a woven basket
 * to catch served fruit; a compost crate for fruit left alone. The pressure block brings a crowd, a
 * ring of diyas that burns down over each response window (Meta-T style timer), drums and deeper dusk.
 *
 * Measurement integrity: `showFruit` makes the stimulus visible synchronously (the frame-committed
 * onset); response animations start only after the response and finish inside the ISI; the camera is
 * at rest during trials; nothing ever covers the pedestal.
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Ticker } from 'pixi.js';
import { MelaArtKit } from '../../art/ArtKit.ts';
import { lighten } from '../../art/color.ts';
import { glowDisc, marigold, rgba, rgrad, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import { createBasket } from '../../art/props/containers.ts';
import type { HandHint } from '../../art/ui/buttons.ts';
import type { Character, ModuleContext } from '../../core/contracts.ts';
import type { GngKind } from '../../paradigms/go-nogo.ts';
import { drawBooth } from './booth.ts';
import type { DontTapViewSurface } from './DontTapModule.ts';
import { drawFruit, type FruitArt, type FruitKind } from './fruit.ts';
import { type DontTapGeometry, dontTapGeometry } from './geometry.ts';
import { markStimulus } from './kit/devtools.ts';
import type { KitView } from './kit/micro-game.ts';
import type { ProbeChoice, ProbeSituation } from './kit/probe.ts';
import { FairStage } from './kit/scene/FairStage.ts';
import { arcTo, contactShadow, popRing, squash, warmGlow } from './kit/scene/fx.ts';
import type { GamePhase } from './kit/types.ts';

export { FRUIT_KINDS, type FruitKind } from './fruit.ts';

/** Time values on the continuous day curve (0 morning .. 3 dusk). */
const DUSK = 2.05;
const DEEP_DUSK = 2.62;

export class DontTapView implements KitView, DontTapViewSurface {
  private readonly ctx: ModuleContext;
  private readonly stage: FairStage;
  private readonly g: DontTapGeometry;
  private readonly u: number;
  private readonly booth = new Container();
  private readonly pedestal = new Container();
  private readonly spot = new Graphics();
  private readonly fruitLayer = new Container();
  private readonly ringLayer = new Container();
  private readonly crowdLayer = new Container();
  private readonly flames: Container[] = [];
  private readonly lanternGlows: Container[] = [];
  private fruit: FruitArt | null = null;
  private fruitSpoiled = false;
  private fruitKind: FruitKind = 'mango';
  private customer: Character | null = null;
  private basket: Container | null = null;
  private crate: Container | null = null;
  private crowd: Character[] = [];
  private hint: HandHint | null = null;
  private ringTween: gsap.core.Tween | null = null;
  private jars: readonly { readonly x: number; readonly y: number; readonly r: number }[] = [];
  private jarFlies: Container | null = null;
  private t = 0;
  private readonly onTick = (tk: Ticker): void => this.tick(Math.min(0.05, tk.deltaMS / 1000));
  private readonly baker = (key: string, build: () => Container): Container =>
    this.stage.bake(key, build);

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.g = dontTapGeometry(ctx.layout);
    this.u = Math.min(ctx.layout.width, ctx.layout.height) / 1080;
    this.stage = new FairStage(ctx, {
      scene: 'market_square',
      timeOfDay: 'dusk',
      music: 'hub',
      ambience: 'market_day',
      guide: { at: () => this.g.guide, scale: this.g.characterScale, facing: 'right' },
      emblem: (size) => this.emblem(size),
      focus: () => this.g.fruit,
      fireflies: 30,
      godRays: false,
    });
    void (
      this.stage.backdrop as { setTimeValue?: (t: number, ms: number) => Promise<void> }
    ).setTimeValue?.(DUSK, 0);
    const dbg = new URLSearchParams(globalThis.location?.search ?? '').get('dbg') ?? '';
    if (!dbg.includes('nobooth')) this.buildBooth();
    this.buildPedestal();
    this.buildCrate();
    this.buildCustomer();
    this.buildTimerRing();
    this.stage.ui.addChild(this.fruitLayer, this.ringLayer);
    this.stage.world.addChild(this.crowdLayer);
    const art = ctx.art;
    if (art instanceof MelaArtKit) {
      this.hint = art.createHandHint(24);
      this.stage.ui.addChild(this.hint.view);
    }
    ctx.app.ticker.add(this.onTick);
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Set building                                                                                    */
  /* ---------------------------------------------------------------------------------------------- */

  private buildBooth(): void {
    const art = drawBooth(this.g, this.u);
    this.booth.addChild(
      this.stage.bake('booth', () => art.view),
      art.glowLayer,
    );
    this.lanternGlows.push(...art.glows);
    this.jars = art.jars;
    const flies = new Container();
    for (const jar of this.jars) {
      for (let k = 0; k < 6; k += 1) {
        const d = new Graphics()
          .circle(0, 0, jar.r * 0.22)
          .fill({ color: 0xfff07a, alpha: 0.45 })
          .circle(0, 0, jar.r * 0.08)
          .fill({ color: 0xfffbe0, alpha: 1 });
        d.blendMode = 'add';
        flies.addChild(d);
      }
    }
    this.jarFlies = flies;
    this.booth.addChild(flies);
    this.stage.set.addChild(this.booth);
  }

  private buildPedestal(): void {
    const { fruit, fruitRadius: r } = this.g;
    const u = this.u;
    const top = fruit.y + r * 0.95;
    const p = new Graphics();
    // Stone column on a stepped base.
    p.roundRect(fruit.x - r * 0.62, top + r * 0.1, r * 1.24, r * 0.95, r * 0.12).fill(
      vgrad([
        [0, 0xd9c7a6],
        [1, 0x9c8766],
      ]),
    );
    p.roundRect(fruit.x - r * 0.85, top + r * 0.98, r * 1.7, r * 0.22, r * 0.08).fill(0x8b765a);
    // Brass dish.
    p.ellipse(fruit.x, top + r * 0.08, r * 1.12, r * 0.24).fill(
      rgrad(
        [
          [0, MELA.brassLight],
          [0.8, MELA.brass],
          [1, 0x8a5c16],
        ],
        { x: 0.42, y: 0.3 },
        0.8,
      ),
    );
    p.ellipse(fruit.x, top + r * 0.02, r * 0.92, r * 0.15).fill(lighten(MELA.brass, 0.2));
    // Marigold ring around the dish (the touch zone cue).
    for (let i = 0; i < 18; i += 1) {
      const a = (i / 18) * Math.PI * 2;
      marigold(
        p,
        fruit.x + Math.cos(a) * r * 1.2,
        top + r * 0.12 + Math.sin(a) * r * 0.28,
        7 * u,
        i % 2 ? MELA.marigold : MELA.saffron,
      );
    }
    this.pedestal.addChild(this.stage.bake('pedestal', () => p));
    // Lantern spotlight cone onto the pedestal (additive, soft).
    this.spot
      .poly([
        fruit.x - r * 0.4,
        0,
        fruit.x + r * 0.4,
        0,
        fruit.x + r * 1.6,
        top + r * 0.2,
        fruit.x - r * 1.6,
        top + r * 0.2,
      ])
      .fill(
        vgrad([
          [0, rgba(0xffe2a0, 0.0)],
          [0.55, rgba(0xffe2a0, 0.08)],
          [1, rgba(0xffe2a0, 0.2)],
        ]),
      );
    this.spot.blendMode = 'add';
    const pool = new Graphics();
    glowDisc(pool, fruit.x, top, r * 1.8, 0xffd27a, 0.55);
    pool.blendMode = 'add';
    this.pedestal.addChild(pool, this.spot);
    this.stage.set.addChild(this.pedestal);
  }

  private buildCrate(): void {
    const { crate } = this.g;
    const u = this.u;
    const c = new Container();
    const g = new Graphics();
    c.addChild(Object.assign(contactShadow(90 * u, 16 * u), { y: 4 * u }));
    g.roundRect(-90 * u, -70 * u, 180 * u, 70 * u, 8 * u).fill(
      vgrad([
        [0, lighten(MELA.wood, 0.2)],
        [1, MELA.woodDark],
      ]),
    );
    for (const yy of [-52, -28])
      g.rect(-90 * u, yy * u, 180 * u, 5 * u).fill({ color: MELA.woodDark, alpha: 0.6 });
    g.rect(-6 * u, -70 * u, 12 * u, 70 * u).fill({ color: MELA.woodDark, alpha: 0.5 });
    c.addChild(g);
    c.position.set(crate.x, crate.y);
    this.crate = c;
    this.stage.set.addChild(c);
  }

  private buildCustomer(): void {
    const { customer, basket: bp } = this.g;
    const u = this.u;
    const ch = this.ctx.art.createCharacter({
      id: 'dont_tap.customer',
      role: 'customer',
      variant: 3,
      facing: 'left',
      scale: this.g.characterScale,
    });
    ch.view.position.set(customer.x, customer.y);
    ch.view.zIndex = customer.y;
    ch.setExpression('happy');
    this.stage.actors.addChild(ch.view);
    this.customer = ch;
    // A low wooden stool with the woven basket that catches served fruit.
    const stool = new Container();
    const sg = new Graphics();
    const legH = Math.max(40 * u, (customer.y - bp.y) * 0.62);
    stool.addChild(
      Object.assign(contactShadow(80 * u, 14 * u), { x: bp.x, y: bp.y + 30 * u + legH }),
      sg,
    );
    sg.roundRect(bp.x - 70 * u, bp.y + 26 * u, 140 * u, 14 * u, 5 * u).fill(
      lighten(MELA.wood, 0.2),
    );
    for (const dx of [-56, 56]) {
      sg.roundRect(bp.x + dx * u - 5 * u, bp.y + 38 * u, 10 * u, legH, 3 * u).fill(MELA.woodDark);
    }
    this.stage.actors.addChild(stool);
    stool.zIndex = customer.y - 2;
    const basket = createBasket({ contents: 'mango', count: 3, width: 150 * u, seed: 7 });
    basket.position.set(bp.x, bp.y + 30 * u);
    this.stage.actors.addChild(basket);
    basket.zIndex = customer.y - 1;
    this.basket = basket;
  }

  private buildTimerRing(): void {
    const { fruit, fruitRadius: r } = this.g;
    const u = this.u;
    const n = 12;
    for (let i = 0; i < n; i += 1) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const x = fruit.x + Math.cos(a) * r * 1.75;
      const y = fruit.y + Math.sin(a) * r * 1.55;
      const holder = new Graphics();
      holder
        .moveTo(x - 16 * u, y + 2 * u)
        .quadraticCurveTo(x, y + 14 * u, x + 16 * u, y + 2 * u)
        .lineTo(x + 20 * u, y)
        .closePath()
        .fill(MELA.terracotta);
      const flame = new Container();
      const tongue = new Graphics()
        .moveTo(0, 0)
        .bezierCurveTo(-7 * u, -6 * u, -5 * u, -16 * u, 0, -26 * u)
        .bezierCurveTo(5 * u, -16 * u, 7 * u, -6 * u, 0, 0)
        .fill(0xffc24a)
        .moveTo(0, -2 * u)
        .bezierCurveTo(-3 * u, -6 * u, -2 * u, -11 * u, 0, -15 * u)
        .bezierCurveTo(2 * u, -11 * u, 3 * u, -6 * u, 0, -2 * u)
        .fill(0xfff4c2);
      const glow = new Graphics();
      glowDisc(glow, 0, -8 * u, 26 * u, 0xffa347, 0.7);
      glow.blendMode = 'add';
      flame.addChild(glow, tongue);
      flame.position.set(x, y + 2 * u);
      this.flames.push(flame);
      this.ringLayer.addChild(holder, flame);
    }
    this.ringLayer.visible = false;
  }

  private emblem(size: number): Container {
    const c = new Container();
    const art = drawFruit('mango', false, size * 0.34);
    c.addChild(art.view);
    const f = new Graphics();
    glowDisc(f, size * 0.32, -size * 0.3, size * 0.16, 0xfff07a, 0.9);
    f.circle(size * 0.32, -size * 0.3, size * 0.035).fill(0xfffbd0);
    c.addChild(f);
    return c;
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* KitView                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  intro(): Promise<void> {
    return this.stage.intro(async () => {
      if (this.stage.reducedMotion) return;
      const top = this.pedestal.y;
      this.pedestal.y = top + this.g.fruitRadius * 2.4;
      this.pedestal.alpha = 0;
      await new Promise<void>((resolve) => {
        gsap.to(this.pedestal, {
          y: top,
          alpha: 1,
          duration: 0.9,
          delay: 0.9,
          ease: 'back.out(1.4)',
          onComplete: resolve,
          onInterrupt: resolve,
        });
      });
      this.stage.guidePoint(this.g.fruit);
    });
  }

  async outro(): Promise<void> {
    this.customer?.setExpression('happy');
    void this.customer?.play('wave');
    await this.stage.outro();
  }

  phase(_p: GamePhase): void {}

  guideSpeak(ms: number): void {
    this.stage.guideSpeak(ms);
  }

  enterProbes(): Promise<void> {
    this.hideFruit();
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

  showFruit(kind: GngKind, fruit: FruitKind, _pressure: boolean): void {
    this.clearFruit();
    const art = drawFruit(fruit, kind === 'nogo', this.g.fruitRadius, this.baker);
    art.view.position.set(this.g.fruit.x, this.g.fruit.y);
    this.fruitLayer.addChild(art.view);
    this.fruit = art;
    this.fruitSpoiled = kind === 'nogo';
    this.fruitKind = fruit;
    markStimulus(kind);
    // Visible at full size on the onset frame; a tiny settle bounce follows.
    if (!this.stage.reducedMotion) {
      art.view.scale.set(1.06, 0.94);
      gsap.to(art.view.scale, { x: 1, y: 1, duration: 0.18, ease: 'back.out(3)' });
    }
    this.ctx.audio.playSfx('tap_soft', { volume: 0.25 });
  }

  hideFruit(): void {
    markStimulus(null);
    const f = this.fruit;
    if (!f) return;
    if (f.view.destroyed) {
      // The view was torn down (module end) while the offset timer was pending.
      this.fruit = null;
      return;
    }
    // Offset: the fruit drops back into the pedestal (quick, never lingering past the stimulus).
    if (this.stage.reducedMotion) {
      this.clearFruit();
      return;
    }
    this.fruit = null;
    gsap.killTweensOf(f.view.scale);
    gsap.to(f.view, {
      alpha: 0,
      y: f.view.y + this.g.fruitRadius * 0.35,
      duration: 0.12,
      ease: 'power1.in',
      onComplete: () => destroyArt(f),
    });
  }

  private clearFruit(): void {
    if (!this.fruit) return;
    destroyArt(this.fruit);
    this.fruit = null;
  }

  async serve(kind: GngKind): Promise<void> {
    const src = this.fruit;
    const u = this.u;
    const { fruit, fruitRadius: r, basket } = this.g;
    this.ctx.audio.playSfx('pop', { volume: 0.55 });
    popRing(this.fruitLayer, fruit, r * 1.25, MELA.marigold, this.stage.reducedMotion);
    // A flying copy (the stimulus itself keeps its exact offset timing).
    const fly = drawFruit(this.fruitKind, this.fruitSpoiled, r * 0.62, this.baker);
    fly.view.position.set(fruit.x, fruit.y);
    this.stage.worldFx.addChild(fly.view);
    if (src) src.view.visible = false;
    await arcTo(
      fly.view,
      { x: basket.x, y: basket.y + 10 * u },
      { height: r * 1.6, durationS: 0.36, spin: 0.8, scaleTo: 0.55 },
      this.stage.reducedMotion,
    );
    destroyArt(fly);
    if (this.basket) void squash(this.basket, 0.14, this.stage.reducedMotion);
    if (kind === 'go') {
      this.ctx.audio.playSfx('coin_drop', { volume: 0.35 });
      warmGlow(this.stage.worldFx, this.stage.fx, basket, 90 * u);
      (this.customer as { react?: (e: string, s?: number) => void } | null)?.react?.(
        'delighted',
        0.6,
      );
    } else {
      (this.customer as { react?: (e: string, s?: number) => void } | null)?.react?.(
        'thinking',
        0.7,
      );
    }
  }

  async letGo(kind: GngKind): Promise<void> {
    const f = this.fruit;
    if (kind === 'nogo' && f) {
      // Flies drift off; the spoiled fruit slides gently to the compost crate.
      void this.toCrate(f);
      return;
    }
    if (f) void this.toCrate(f);
  }

  private async toCrate(f: FruitArt): Promise<void> {
    if (this.fruit === f) this.fruit = null;
    if (f.view.destroyed) return;
    gsap.killTweensOf(f.view);
    gsap.killTweensOf(f.view.scale);
    const { crate } = this.g;
    await arcTo(
      f.view,
      { x: crate.x, y: crate.y - 50 * this.u },
      { height: this.g.fruitRadius * 0.8, durationS: 0.34, spin: -1.2, scaleTo: 0.5 },
      this.stage.reducedMotion,
    );
    destroyArt(f);
    if (this.crate) void squash(this.crate, 0.08, this.stage.reducedMotion);
  }

  timerRing(durationMs: number): void {
    this.ringTween?.kill();
    for (const f of this.flames) {
      f.alpha = 1;
      f.scale.set(1);
    }
    const state = { k: 0 };
    const n = this.flames.length;
    this.ringTween = gsap.to(state, {
      k: 1,
      duration: durationMs / 1000,
      ease: 'none',
      onUpdate: () => {
        const lit = n * (1 - state.k);
        this.flames.forEach((f, i) => {
          const a = Math.min(1, Math.max(0, lit - i));
          f.alpha = 0.15 + 0.85 * a;
          f.scale.set(0.6 + 0.4 * a);
        });
      },
    });
  }

  async pressureOn(): Promise<void> {
    this.ringLayer.visible = true;
    this.ringLayer.alpha = 0;
    gsap.to(this.ringLayer, { alpha: 1, duration: 0.8 });
    // The crowd presses in: foreground villagers (upper bodies, feet below the frame) flank the
    // booth, leaving the pedestal and the basket clear.
    const L = this.ctx.layout;
    const spots = this.g.portrait ? [0.3, 0.47] : [0.2, 0.31, 0.69, 0.8];
    spots.forEach((f, i) => {
      const x = L.width * f;
      const ch = this.ctx.art.createCharacter({
        id: `dont_tap.crowd.${i}`,
        role: 'customer',
        variant: 10 + i,
        facing: x < L.width / 2 ? 'right' : 'left',
        scale: this.g.characterScale * 1.45,
      });
      const y = L.height * (this.g.portrait ? 1.1 : 1.18);
      ch.view.position.set(x, y + L.height * 0.25);
      (ch as Character & { setExpression(e: string): void }).setExpression(
        i % 2 ? 'impatient' : 'thinking',
      );
      this.crowdLayer.addChild(ch.view);
      this.crowd.push(ch);
      gsap.to(ch.view, {
        y,
        duration: this.stage.reducedMotion ? 0 : 0.9,
        delay: i * 0.12,
        ease: 'power2.out',
      });
    });
    await this.stage.mood({
      time: DEEP_DUSK,
      tension: 0.8,
      music: 'pressure',
      ambience: 'market_busy',
      durationMs: 1400,
    });
    for (const glow of this.lanternGlows) gsap.to(glow, { alpha: 1.25, duration: 1 });
  }

  async pressureOff(): Promise<void> {
    this.ringTween?.kill();
    gsap.to(this.ringLayer, {
      alpha: 0,
      duration: 0.6,
      onComplete: () => {
        this.ringLayer.visible = false;
      },
    });
    for (const c of this.crowd) {
      gsap.to(c.view, {
        y: c.view.y + this.ctx.layout.height * 0.3,
        duration: this.stage.reducedMotion ? 0 : 0.8,
        ease: 'power2.in',
      });
    }
    await this.stage.mood({
      time: DUSK,
      tension: 0.15,
      music: 'hub',
      ambience: 'market_day',
      durationMs: 1200,
    });
  }

  practiceHint(show: boolean): void {
    if (!this.hint) return;
    if (show) this.hint.show('tap', { x: this.g.fruit.x, y: this.g.fruit.y });
    else this.hint.stop();
  }

  /* ---------------------------------------------------------------------------------------------- */

  private tick(dt: number): void {
    this.t += dt;
    const f = this.fruit;
    if (f) {
      const r = this.g.fruitRadius;
      f.flies.forEach((fly, i) => {
        const a = this.t * (2.2 + i * 0.5) + i * 2.1;
        fly.position.set(
          Math.cos(a) * r * (1.15 + 0.12 * i),
          -r * 0.35 + Math.sin(a * 1.3) * r * 0.55,
        );
        fly.rotation = Math.sin(a * 3) * 0.4;
      });
      if (f.stink) f.stink.alpha = 0.5 + 0.35 * Math.sin(this.t * 2.6);
      if (f.sparkle) {
        const k = 0.5 + 0.5 * Math.sin(this.t * 3.2);
        f.sparkle.alpha = 0.35 + 0.65 * k;
        f.sparkle.scale.set(0.7 + 0.4 * k);
        f.sparkle.rotation += dt * 0.8;
      }
    }
    for (const [i, glow] of this.lanternGlows.entries()) {
      if (!gsap.isTweening(glow)) glow.alpha = 0.86 + 0.12 * Math.sin(this.t * 1.3 + i * 1.9);
    }
    const d = this.jarFlies;
    if (d) {
      let n = 0;
      for (const [j, jar] of this.jars.entries()) {
        for (let k = 0; k < 6; k += 1) {
          const dot = d.children[n++];
          if (!dot) continue;
          const a = this.t * (0.6 + k * 0.17) + k * 1.7 + j;
          dot.position.set(
            jar.x + Math.sin(a * 1.3) * jar.r * 0.5,
            jar.y + Math.cos(a) * jar.r * 0.75,
          );
          dot.alpha = 0.45 + 0.45 * (0.5 + 0.5 * Math.sin(this.t * 1.6 + k * 2.3));
        }
      }
    }
  }

  destroy(): void {
    this.ctx.app.ticker.remove(this.onTick);
    this.ringTween?.kill();
    this.hint?.stop();
    for (const c of this.crowd) c.destroy();
    this.customer?.destroy();
    this.stage.destroy();
    this.fruit = null;
  }
}

/** Kill tweens on a fruit's display objects, then destroy it (safe to call twice). */
function destroyArt(f: FruitArt): void {
  if (f.view.destroyed) return;
  gsap.killTweensOf(f.view);
  gsap.killTweensOf(f.view.scale);
  gsap.killTweensOf(f.view.position);
  f.view.destroy({ children: true });
}
