/**
 * Balloon scene: the balloon-seller's stall at the fair, golden hour. A brass hand-pump stands on the
 * counter with today's balloon knotted to its nozzle; a tall glass jar of sweets waits beside it; the
 * seller (with a huge bobbing bunch of balloons) cheers you on. Pumping pushes the plunger with a puff
 * of air and the balloon swells with a springy squash-and-stretch; collecting ties it off and floats
 * it up to the seller's bunch while sweets tumble into the jar. A pop is a party: a confetti shower,
 * streamers and the seller's laugh. No numbers, no stars, no score.
 *
 * Balloon kinds differ by colour AND pattern (sky blue with stars; rose with stripes). Growth per pump
 * is the same for both kinds, so size never hints at a balloon's own pop point.
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Ticker } from 'pixi.js';
import { MelaArtKit } from '../../art/ArtKit.ts';
import { drawBalloonBunch } from '../../art/backdrop/props.ts';
import { darken, lighten } from '../../art/color.ts';
import { glowDisc, rgrad, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import type { HandHint } from '../../art/ui/buttons.ts';
import type { Character, ModuleContext } from '../../core/contracts.ts';
import type { RiskColour } from '../../paradigms/bart.ts';
import { markStimulus } from '../dont-tap/kit/devtools.ts';
import type { KitView } from '../dont-tap/kit/micro-game.ts';
import type { ProbeChoice, ProbeSituation } from '../dont-tap/kit/probe.ts';
import { FairStage } from '../dont-tap/kit/scene/FairStage.ts';
import { contactShadow, popRing, squash, warmGlow } from '../dont-tap/kit/scene/fx.ts';
import type { GamePhase } from '../dont-tap/kit/types.ts';
import type { BalloonViewSurface } from './BalloonModule.ts';
import { type BalloonGeometry, balloonGeometry } from './geometry.ts';

type Rig = Character & { play(a: string): Promise<void>; react?(e: string, s?: number): void };

const KIND_STYLE: Readonly<
  Record<RiskColour, { readonly color: number; readonly pattern: 'stars' | 'stripes' }>
> = {
  low_risk: { color: 0x3fa7e0, pattern: 'stars' },
  high_risk: { color: 0xe0487a, pattern: 'stripes' },
};

/** Reference maximum for growth (pumps beyond it never happen: the larger kind's max). */
const GROWTH_REF = 32;

/** Balloon art of radius r centred on its body, knot at (0, r * 1.05). */
export function drawBalloon(kind: RiskColour, r: number): Container {
  const c = new Container();
  const st = KIND_STYLE[kind];
  const body = new Graphics();
  const shape = (g: Graphics): Graphics =>
    g
      .moveTo(0, -r)
      .bezierCurveTo(r * 1.1, -r, r * 1.05, r * 0.55, 0, r * 1.02)
      .bezierCurveTo(-r * 1.05, r * 0.55, -r * 1.1, -r, 0, -r)
      .closePath();
  shape(body).fill(
    rgrad(
      [
        [0, lighten(st.color, 0.45)],
        [0.55, st.color],
        [1, darken(st.color, 0.35)],
      ],
      { x: 0.36, y: 0.3 },
      0.78,
    ),
  );
  c.addChild(body);
  const pat = new Graphics();
  if (st.pattern === 'stars') {
    for (const [x, y, s] of [
      [-0.35, -0.3, 0.16],
      [0.3, -0.05, 0.13],
      [-0.1, 0.35, 0.12],
      [0.42, 0.45, 0.09],
      [-0.5, 0.22, 0.08],
    ] as const) {
      const pts: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = (i % 2 === 0 ? s : s * 0.45) * r;
        pts.push(x * r + Math.cos(a) * rr, y * r + Math.sin(a) * rr);
      }
      pat.poly(pts).fill({ color: 0xffffff, alpha: 0.85 });
    }
  } else {
    for (let k = -4; k <= 4; k += 1) {
      pat
        .moveTo(k * r * 0.3 - r * 0.5, -r * 1.2)
        .lineTo(k * r * 0.3 + r * 0.5, r * 1.2)
        .stroke({ width: r * 0.1, color: 0xffffff, alpha: 0.7 });
    }
  }
  const mask = shape(new Graphics()).fill(0xffffff);
  pat.mask = mask;
  c.addChild(pat, mask);
  // Sheen and knot.
  const sheen = new Graphics()
    .ellipse(-r * 0.36, -r * 0.46, r * 0.18, r * 0.3)
    .fill({ color: 0xffffff, alpha: 0.5 });
  sheen.rotation = -0.4;
  const knot = new Graphics()
    .moveTo(-r * 0.09, r * 1.0)
    .lineTo(r * 0.09, r * 1.0)
    .lineTo(r * 0.05, r * 1.12)
    .lineTo(-r * 0.05, r * 1.12)
    .closePath()
    .fill(darken(st.color, 0.3));
  c.addChild(sheen, knot);
  return c;
}

export class BalloonView implements KitView, BalloonViewSurface {
  private readonly ctx: ModuleContext;
  private readonly stage: FairStage;
  private readonly g: BalloonGeometry;
  private readonly u: number;
  private readonly pumpRig = new Container();
  private readonly plunger = new Container();
  private readonly balloonLayer = new Container();
  private readonly jar = new Container();
  private readonly jarFill = new Container();
  private balloon: Container | null = null;
  private balloonR = 0;
  private pumpAnimS = 0.22;
  private banked = 0;
  private seller: Rig | null = null;
  private bunch: Container | null = null;
  private hint: HandHint | null = null;
  private t = 0;
  private readonly onTick = (tk: Ticker): void => this.tick(Math.min(0.05, tk.deltaMS / 1000));
  private readonly bake = (key: string, build: () => Container): Container =>
    this.stage.bake(key, build);

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.g = balloonGeometry(ctx.layout);
    this.u = Math.min(ctx.layout.width, ctx.layout.height) / 1080;
    this.stage = new FairStage(ctx, {
      scene: 'balloon_fair',
      timeOfDay: 'golden_hour',
      music: 'hub',
      ambience: 'market_day',
      guide: { at: () => this.g.guide, scale: this.g.characterScale, facing: 'right' },
      emblem: (size) => {
        const e = drawBalloon('low_risk', size * 0.26);
        e.y = -size * 0.06;
        return e;
      },
      focus: () => ({ x: this.g.knot.x, y: this.g.knot.y - this.g.rMax * 0.6 }),
      fireflies: 10,
      godRays: true,
      rayColor: 0xffd9a0,
    });
    this.buildSeller();
    this.buildCounter();
    this.buildPump();
    this.buildJar();
    this.stage.ui.addChild(this.jar, this.balloonLayer, this.pumpRig);
    const art = ctx.art;
    if (art instanceof MelaArtKit) {
      this.hint = art.createHandHint(24);
      this.stage.ui.addChild(this.hint.view);
    }
    ctx.app.ticker.add(this.onTick);
  }

  /* ---------------------------------------------------------------------------------------------- */

  private buildSeller(): void {
    const { seller } = this.g;
    const u = this.u;
    const bunch = drawBalloonBunch(2.4 * u, 11);
    bunch.position.set(
      seller.x - (this.g.portrait ? 40 : 90) * u,
      seller.y - 260 * u * this.g.characterScale,
    );
    this.bunch = bunch;
    const ch = this.ctx.art.createCharacter({
      id: 'balloon.seller',
      role: 'vendor',
      variant: 2,
      facing: 'left',
      scale: this.g.characterScale,
    }) as Rig;
    ch.view.position.set(seller.x, seller.y);
    ch.view.zIndex = seller.y;
    bunch.zIndex = seller.y - 1;
    this.stage.actors.addChild(bunch, ch.view);
    this.seller = ch;
  }

  /** The stall counter the pump and jar stand on (baked). */
  private buildCounter(): void {
    const L = this.ctx.layout;
    const u = this.u;
    const top = this.g.pump.y + this.g.pump.height * 0.92;
    const x0 = this.g.portrait ? L.width * 0.04 : L.width * 0.22;
    const x1 = this.g.portrait ? L.width * 0.96 : L.width * 0.8;
    const art = (): Container => {
      const c = new Container();
      const sh = contactShadow((x1 - x0) * 0.55, 26 * u, 0.4);
      sh.position.set((x0 + x1) / 2, top + 110 * u);
      c.addChild(sh);
      const g = new Graphics();
      g.roundRect(x0, top, x1 - x0, 22 * u, 6 * u).fill(
        vgrad([
          [0, lighten(MELA.wood, 0.35)],
          [1, MELA.wood],
        ]),
      );
      g.rect(x0 + 10 * u, top + 22 * u, x1 - x0 - 20 * u, 110 * u).fill(
        vgrad([
          [0, lighten(MELA.saffron, 0.05)],
          [1, darken(MELA.saffron, 0.25)],
        ]),
      );
      const stripes = 12;
      for (let i = 0; i < stripes; i += 1) {
        if (i % 2) continue;
        g.rect(
          x0 + 10 * u + (i / stripes) * (x1 - x0 - 20 * u),
          top + 22 * u,
          (x1 - x0 - 20 * u) / stripes,
          110 * u,
        ).fill({
          color: MELA.cream,
          alpha: 0.85,
        });
      }
      g.rect(x0 + 10 * u, top + 22 * u, x1 - x0 - 20 * u, 6 * u).fill(MELA.brass);
      c.addChild(g);
      return c;
    };
    this.stage.set.addChild(this.bake('counter', art));
  }

  private buildPump(): void {
    const { pump, knot } = this.g;
    const u = this.u;
    const cx = pump.x + pump.width / 2;
    const barrelTop = knot.y + 130 * u;
    const barrelBot = pump.y + pump.height * 0.92;
    const base = new Graphics();
    // Foot plate, barrel, nozzle.
    base
      .roundRect(cx - pump.width * 0.42, barrelBot - 16 * u, pump.width * 0.84, 18 * u, 6 * u)
      .fill(MELA.woodDark);
    base.roundRect(cx - 30 * u, barrelTop, 60 * u, barrelBot - barrelTop, 14 * u).fill(
      vgrad([
        [0, MELA.brassLight],
        [0.5, MELA.brass],
        [1, 0x8a5c16],
      ]),
    );
    for (let k = 0; k < 3; k += 1) {
      base
        .rect(cx - 32 * u, barrelTop + 40 * u + k * 46 * u, 64 * u, 6 * u)
        .fill({ color: 0x8a5c16, alpha: 0.7 });
    }
    base.roundRect(cx - 12 * u, knot.y, 24 * u, barrelTop - knot.y, 6 * u).fill(MELA.brass);
    base
      .ellipse(cx - 18 * u, barrelTop + 60 * u, 6 * u, 40 * u)
      .fill({ color: 0xffffff, alpha: 0.35 });
    // Plunger: rod and a fat wooden T-handle (the visual pump button).
    const rod = new Graphics()
      .roundRect(cx + 34 * u, barrelTop - 52 * u, 12 * u, 72 * u, 4 * u)
      .fill(0xc9c2b8);
    const handle = new Graphics()
      .roundRect(
        cx + 40 * u - pump.width * 0.34,
        barrelTop - 74 * u,
        pump.width * 0.68,
        34 * u,
        16 * u,
      )
      .fill(
        vgrad([
          [0, lighten(MELA.vermilion, 0.2)],
          [1, darken(MELA.vermilion, 0.2)],
        ]),
      );
    handle
      .roundRect(cx + 40 * u - pump.width * 0.3, barrelTop - 70 * u, pump.width * 0.6, 8 * u, 4 * u)
      .fill({ color: 0xffffff, alpha: 0.35 });
    this.plunger.addChild(rod, handle);
    const glow = new Graphics();
    glowDisc(glow, cx, barrelTop, pump.width * 0.9, 0xffe2a0, 0.25);
    glow.blendMode = 'add';
    this.pumpRig.addChild(glow, base, this.plunger);
  }

  private buildJar(): void {
    const { jar } = this.g;
    const u = this.u;
    const cx = jar.x + jar.width / 2;
    const bottom = jar.y + jar.height;
    const w = jar.width * 0.8;
    const h = jar.height * 0.82;
    const glass = new Graphics();
    const jarPath = (g: Graphics): Graphics =>
      g
        .moveTo(cx - w * 0.32, bottom - h)
        .lineTo(cx + w * 0.32, bottom - h)
        .bezierCurveTo(
          cx + w * 0.62,
          bottom - h * 0.85,
          cx + w * 0.55,
          bottom - h * 0.05,
          cx + w * 0.4,
          bottom,
        )
        .lineTo(cx - w * 0.4, bottom)
        .bezierCurveTo(
          cx - w * 0.55,
          bottom - h * 0.05,
          cx - w * 0.62,
          bottom - h * 0.85,
          cx - w * 0.32,
          bottom - h,
        )
        .closePath();
    jarPath(glass).fill({ color: 0xd8f0ee, alpha: 0.25 });
    jarPath(glass).stroke({ width: 3 * u, color: 0xf4fffc, alpha: 0.7 });
    const lid = new Graphics()
      .roundRect(cx - w * 0.36, bottom - h - 22 * u, w * 0.72, 26 * u, 8 * u)
      .fill(MELA.kumkum)
      .roundRect(cx - w * 0.36, bottom - h - 22 * u, w * 0.72, 8 * u, 4 * u)
      .fill({ color: 0xffffff, alpha: 0.25 });
    const shine = new Graphics()
      .ellipse(cx - w * 0.3, bottom - h * 0.55, 8 * u, h * 0.28)
      .fill({ color: 0xffffff, alpha: 0.4 });
    const fillMask = jarPath(new Graphics()).fill(0xffffff);
    this.jarFill.mask = fillMask;
    this.jar.addChild(contactShadow(w * 0.5, 12 * u), this.jarFill, fillMask, glass, lid, shine);
    (this.jar.children[0] as Container).position.set(cx, bottom + 2 * u);
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* KitView                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  intro(): Promise<void> {
    return this.stage.intro(async () => {
      void this.seller?.play('wave');
    });
  }

  async outro(): Promise<void> {
    void this.seller?.play('celebrate');
    await this.stage.outro();
  }

  phase(_p: GamePhase): void {}

  guideSpeak(ms: number): void {
    this.stage.guideSpeak(ms);
  }

  enterProbes(): Promise<void> {
    this.pumpRig.visible = false;
    this.balloonLayer.visible = false;
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

  newBalloon(kind: RiskColour, _maxPumps: number, pumpAnimationMs: number): void {
    this.clearBalloon();
    this.pumpAnimS = pumpAnimationMs / 1000;
    const holder = new Container();
    const art = this.bake(`balloon.${kind}.${Math.round(this.g.rMax)}`, () =>
      drawBalloon(kind, this.g.rMax),
    );
    holder.addChild(art);
    holder.position.set(this.g.knot.x, this.g.knot.y);
    art.position.set(0, -this.g.rMax * 1.06);
    this.balloonR = this.g.r0;
    holder.scale.set(this.g.r0 / this.g.rMax);
    this.balloonLayer.addChild(holder);
    this.balloon = holder;
    markStimulus(kind);
  }

  private clearBalloon(): void {
    if (!this.balloon) return;
    gsap.killTweensOf(this.balloon.scale);
    gsap.killTweensOf(this.balloon);
    this.balloon.destroy({ children: true });
    this.balloon = null;
  }

  pump(pumps: number, _maxPumps: number): void {
    const b = this.balloon;
    if (!b) return;
    const { r0, rMax } = this.g;
    this.balloonR = r0 + (rMax - r0) * Math.sqrt(Math.min(1, pumps / GROWTH_REF));
    const s = this.balloonR / rMax;
    const d = this.stage.reducedMotion ? 0 : this.pumpAnimS;
    gsap.killTweensOf(b.scale);
    // Squash-and-stretch swell: overshoot wide, settle round.
    gsap
      .timeline()
      .to(b.scale, { x: s * 1.08, y: s * 0.95, duration: d * 0.45, ease: 'power2.out' })
      .to(b.scale, { x: s, y: s, duration: d * 1.4, ease: 'elastic.out(1.1, 0.4)' });
    gsap.killTweensOf(this.plunger);
    gsap
      .timeline()
      .to(this.plunger, { y: 46 * this.u, duration: d * 0.4, ease: 'power2.in' })
      .to(this.plunger, { y: 0, duration: d * 0.6, ease: 'power2.out' });
    this.stage.burst(
      'smoke',
      { x: this.g.knot.x + 26 * this.u, y: this.g.knot.y + 10 * this.u },
      2,
      this.stage.ui,
    );
  }

  async burst(): Promise<void> {
    const b = this.balloon;
    if (!b) return;
    this.balloon = null;
    markStimulus(null);
    const at = { x: b.x, y: b.y - this.balloonR * 1.06 };
    b.destroy({ children: true });
    popRing(this.stage.ui, at, this.balloonR * 1.1, 0xffffff, this.stage.reducedMotion);
    this.stage.burst('confetti', at, this.stage.reducedMotion ? 16 : 60, this.stage.ui);
    warmGlow(this.stage.ui, this.stage.fx, at, this.balloonR * 1.6, 0xfff1c8);
    this.seller?.react?.('surprised', 0.4);
    void this.seller?.play('celebrate');
  }

  async collect(pumps: number, _maxPumps: number): Promise<void> {
    const b = this.balloon;
    if (!b) return;
    this.balloon = null;
    markStimulus(null);
    // The balloon floats up to the seller's bunch.
    const target = this.bunch
      ? { x: this.bunch.x, y: this.bunch.y - 40 * this.u }
      : { x: b.x, y: -200 };
    gsap.to(b, {
      x: target.x,
      y: target.y,
      duration: this.stage.reducedMotion ? 0.2 : 0.9,
      ease: 'power1.in',
    });
    gsap.to(b.scale, {
      x: b.scale.x * 0.35,
      y: b.scale.y * 0.35,
      duration: this.stage.reducedMotion ? 0.2 : 0.9,
      onComplete: () => b.destroy({ children: true }),
    });
    // Sweets tumble into the jar (pictured; the more pumps, the more sweets).
    this.addSweets(Math.max(1, Math.round(pumps / 2)));
    void this.seller?.play('clap');
    this.seller?.react?.('delighted', 0.6);
  }

  private addSweets(n: number): void {
    const { jar } = this.g;
    const u = this.u;
    const cx = jar.x + jar.width / 2;
    const bottom = jar.y + jar.height;
    const colours = [
      MELA.saffron,
      MELA.rose,
      MELA.mango,
      MELA.marigold,
      MELA.lotus,
      MELA.peacockLight,
    ];
    for (let i = 0; i < n; i += 1) {
      const k = this.banked + i;
      const row = Math.floor(k / 7);
      const col = k % 7;
      const x = cx + (col - 3) * jar.width * 0.1 + (row % 2) * jar.width * 0.05;
      const y = bottom - 16 * u - row * 15 * u;
      if (y < jar.y + jar.height * 0.22) break;
      const s = new Graphics()
        .circle(0, 0, 11 * u)
        .fill(
          rgrad(
            [
              [0, lighten(colours[k % colours.length] as number, 0.4)],
              [1, colours[k % colours.length] as number],
            ],
            { x: 0.35, y: 0.3 },
            0.7,
          ),
        )
        .circle(-3 * u, -4 * u, 3 * u)
        .fill({ color: 0xffffff, alpha: 0.6 });
      s.position.set(x, jar.y - 20 * u);
      this.jarFill.addChild(s);
      gsap.to(s, {
        y,
        duration: this.stage.reducedMotion ? 0.05 : 0.35 + i * 0.03,
        delay: i * 0.03,
        ease: 'bounce.out',
      });
    }
    this.banked += n;
    void squash(this.jar, 0.04, this.stage.reducedMotion);
  }

  practiceHint(stage: 'pump' | 'collect' | null): void {
    if (!this.hint) return;
    if (stage === null) {
      this.hint.stop();
      return;
    }
    const r = stage === 'pump' ? this.g.pump : this.g.jar;
    this.hint.show('tap', {
      x: r.x + r.width / 2,
      y: r.y + r.height * (stage === 'pump' ? 0.3 : 0.5),
    });
  }

  /* ---------------------------------------------------------------------------------------------- */

  private tick(dt: number): void {
    this.t += dt;
    const b = this.balloon;
    if (b && !gsap.isTweening(b)) b.rotation = Math.sin(this.t * 1.3) * 0.04;
    if (this.bunch) this.bunch.rotation = Math.sin(this.t * 0.9) * 0.025;
  }

  destroy(): void {
    this.ctx.app.ticker.remove(this.onTick);
    this.hint?.stop();
    this.seller?.destroy();
    this.stage.destroy();
  }
}
