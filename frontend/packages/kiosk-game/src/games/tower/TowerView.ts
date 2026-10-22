/**
 * Tower scene: the potter's courtyard on a bright morning. A potter works at his wheel beside drying
 * racks of fresh pots; three wooden pegs stand on brick plinths (their height shows how many pots fit);
 * the goal is painted on the potter's easel. Lifting a pot raises it with a soft glow; setting it down
 * gives a satisfying clay "tok" with a little dust; a full peg gently bounces the pot back. When a
 * picture is matched, marigold petals drift down and the potter claps. After a while a woven rest
 * mat with an arrow appears: resting is always fine (no judgement, no numbers).
 *
 * Measurement integrity: `setupBoard` draws the whole problem synchronously (the frame-committed
 * onset); pot moves never hide the goal picture; the camera is at rest during problems.
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Ticker } from 'pixi.js';
import { MelaArtKit } from '../../art/ArtKit.ts';
import { lighten } from '../../art/color.ts';
import { vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import type { HandHint, IconButton } from '../../art/ui/buttons.ts';
import type { Character, ModuleContext, Point } from '../../core/contracts.ts';
import type { PotId, TowerProblem, TowerState } from '../../paradigms/tower.ts';
import { markStimulus } from '../dont-tap/kit/devtools.ts';
import type { KitView } from '../dont-tap/kit/micro-game.ts';
import type { ProbeChoice, ProbeSituation } from '../dont-tap/kit/probe.ts';
import { FairStage, waitMs } from '../dont-tap/kit/scene/FairStage.ts';
import { arcTo, contactShadow, squash, warmGlow } from '../dont-tap/kit/scene/fx.ts';
import type { GamePhase } from '../dont-tap/kit/types.ts';
import { type TowerGeometry, towerGeometry } from './geometry.ts';
import { drawGoalPicture, drawPeg, drawPot } from './pots.ts';
import type { TowerViewSurface } from './TowerModule.ts';

type Rig = Character & { play(a: string): Promise<void>; react?(e: string, s?: number): void };

export class TowerView implements KitView, TowerViewSurface {
  private readonly ctx: ModuleContext;
  private readonly stage: FairStage;
  private readonly g: TowerGeometry;
  private readonly u: number;
  private readonly board = new Container();
  private readonly pegLayer = new Container();
  private readonly potLayer = new Container();
  private readonly goalLayer = new Container();
  private readonly pots = new Map<PotId, Container>();
  private state: TowerState = [];
  private lifted: { pot: Container; peg: number; baseY: number } | null = null;
  private skipButton: IconButton | null = null;
  private mat: Container | null = null;
  private potter: Rig | null = null;
  private wheel: Graphics | null = null;
  private hint: HandHint | null = null;
  private t = 0;
  private readonly onTick = (tk: Ticker): void => this.tick(Math.min(0.05, tk.deltaMS / 1000));
  private readonly bake = (key: string, build: () => Container): Container =>
    this.stage.bake(key, build);

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.g = towerGeometry(ctx.layout);
    this.u = Math.min(ctx.layout.width, ctx.layout.height) / 1080;
    this.stage = new FairStage(ctx, {
      scene: 'tower_courtyard',
      timeOfDay: 'morning',
      music: 'hub',
      ambience: 'market_day',
      guide: { at: () => this.g.guide, scale: this.g.characterScale, facing: 'right' },
      emblem: (size) => this.emblem(size),
      focus: () => ({
        x: (this.g.pegs[1]?.x ?? 0) + (this.g.pegs[1]?.width ?? 0) / 2,
        y: this.g.baseY - this.g.potH * 2,
      }),
      fireflies: 0,
      godRays: true,
      rayColor: 0xfff1c8,
    });
    void (
      this.stage.backdrop as { setTimeValue?: (t: number, ms: number) => Promise<void> }
    ).setTimeValue?.(0.55, 0);
    this.buildPotter();
    this.buildRacks();
    this.board.addChild(this.pegLayer, this.potLayer);
    this.stage.ui.addChild(this.goalLayer, this.board);
    this.buildSkip();
    const art = ctx.art;
    if (art instanceof MelaArtKit) {
      this.hint = art.createHandHint(24);
      this.stage.ui.addChild(this.hint.view);
    }
    ctx.app.ticker.add(this.onTick);
  }

  /* ---------------------------------------------------------------------------------------------- */

  private buildPotter(): void {
    const { potter } = this.g;
    const u = this.u;
    // Potter's wheel (spins) beside him.
    const wheelHolder = new Container();
    const base = new Graphics()
      .roundRect(-70 * u, -40 * u, 140 * u, 40 * u, 10 * u)
      .fill(MELA.woodDark);
    const wheel = new Graphics();
    wheel.ellipse(0, 0, 80 * u, 18 * u).fill(lighten(MELA.wood, 0.2));
    for (let k = 0; k < 6; k += 1) {
      const a = (k / 6) * Math.PI * 2;
      wheel
        .moveTo(0, 0)
        .lineTo(Math.cos(a) * 76 * u, Math.sin(a) * 16 * u)
        .stroke({ width: 3 * u, color: MELA.woodDark });
    }
    wheel.position.set(0, -44 * u);
    const lump = drawPot('pot_red', 60 * u);
    lump.tint = 0xb88a66;
    lump.position.set(0, -50 * u);
    wheelHolder.addChild(contactShadow(90 * u, 16 * u), base, wheel, lump);
    const side = -1;
    wheelHolder.position.set(potter.x + side * 150 * u * this.g.characterScale, potter.y);
    this.wheel = wheel;
    const ch = this.ctx.art.createCharacter({
      id: 'tower.potter',
      role: 'vendor',
      variant: 4,
      facing: this.g.portrait ? 'right' : 'left',
      scale: this.g.characterScale,
    }) as Rig;
    ch.view.position.set(potter.x, potter.y);
    ch.view.zIndex = potter.y;
    wheelHolder.zIndex = potter.y + 1;
    this.stage.actors.addChild(ch.view, wheelHolder);
    this.potter = ch;
  }

  /** Drying racks of fresh pots behind the play area (static, baked). */
  private buildRacks(): void {
    const L = this.ctx.layout;
    const u = this.u;
    const art = (): Container => {
      const c = new Container();
      const y = this.g.portrait ? L.height * 0.6 : L.height * 0.6;
      const xs = this.g.portrait ? [0.62, 0.86] : [0.08, 0.24, 0.62];
      xs.forEach((f, idx) => {
        const x = L.width * f;
        const w = 220 * u;
        const g = new Graphics();
        for (const lx of [-w / 2, w / 2])
          g.rect(x + lx - 4 * u, y - 150 * u, 8 * u, 150 * u).fill(MELA.woodDark);
        for (const sy of [-150, -80])
          g.rect(x - w / 2 - 8 * u, y + sy * u, w + 16 * u, 8 * u).fill(MELA.wood);
        c.addChild(g);
        const kinds: PotId[] = ['pot_red', 'pot_green', 'pot_blue'];
        for (const [row, sy] of [-150, -80].entries()) {
          for (let k = 0; k < 4; k += 1) {
            const p = drawPot(kinds[(k + row + idx) % 3] as PotId, 46 * u);
            p.tint = 0xd9b48e; // unglazed, drying clay
            p.position.set(x - w / 2 + 30 * u + k * 54 * u, y + sy * u);
            c.addChild(p);
          }
        }
      });
      return c;
    };
    this.stage.set.addChild(this.bake('racks', art));
    this.stage.set.addChild(this.bake('rug', () => this.drawRug()));
  }

  /** A striped durrie in perspective under the pegs: anchors the board in the courtyard. */
  private drawRug(): Container {
    const u = this.u;
    const first = this.g.pegs[0];
    const last = this.g.pegs[this.g.pegs.length - 1];
    const c = new Container();
    if (!first || !last) return c;
    const x0 = first.x - 70 * u;
    const x1 = last.x + last.width + 70 * u;
    const yTop = this.g.baseY - 70 * u;
    const yBot = Math.min(this.ctx.layout.height * 0.995, this.g.baseY + 90 * u);
    const inset = 60 * u;
    const g = new Graphics();
    const quad = (k: number): number[] => [
      x0 + inset + k,
      yTop + k * 0.4,
      x1 - inset - k,
      yTop + k * 0.4,
      x1 - k,
      yBot - k * 0.4,
      x0 + k,
      yBot - k * 0.4,
    ];
    g.poly(quad(0)).fill(MELA.indigo);
    g.poly(quad(10 * u)).fill(MELA.kumkum);
    g.poly(quad(26 * u)).fill(MELA.indigo);
    // Woven bands.
    const bands = 7;
    for (let i = 1; i < bands; i += 1) {
      const t = i / bands;
      const y = yTop + 26 * u * 0.4 + t * (yBot - yTop - 52 * u * 0.4);
      const half = (x1 - x0) / 2 - inset * (1 - t) - 26 * u;
      g.rect((x0 + x1) / 2 - half, y - 3 * u, half * 2, 6 * u).fill({
        color: i % 2 ? MELA.marigold : MELA.cream,
        alpha: 0.85,
      });
    }
    // Fringe along the near edge.
    for (let x = x0 + 8 * u; x < x1 - 8 * u; x += 14 * u) {
      g.moveTo(x, yBot)
        .lineTo(x - 2 * u, yBot + 12 * u)
        .stroke({ width: 2 * u, color: MELA.cream, alpha: 0.8 });
    }
    c.addChild(contactShadow((x1 - x0) * 0.52, 26 * u, 0.25), g);
    (c.children[0] as Container).position.set((x0 + x1) / 2, yBot + 6 * u);
    return c;
  }

  private buildSkip(): void {
    const { skip } = this.g;
    const u = this.u;
    const mat = new Container();
    const g = new Graphics();
    g.ellipse(0, skip.height * 0.32, skip.width * 0.78, skip.height * 0.26).fill(
      vgrad([
        [0, 0xe2c27a],
        [1, 0xb8914e],
      ]),
    );
    for (let k = -3; k <= 3; k += 1) {
      g.moveTo(k * skip.width * 0.2, skip.height * 0.12)
        .lineTo(k * skip.width * 0.22, skip.height * 0.52)
        .stroke({
          width: 2 * u,
          color: 0x8a6a34,
          alpha: 0.6,
        });
    }
    mat.addChild(g);
    mat.position.set(skip.x + skip.width / 2, skip.y + skip.height / 2);
    mat.visible = false;
    this.mat = mat;
    const btn = this.ctx.art.createIconButton({
      id: 'tower.skip',
      iconId: 'skip',
      audioKey: 'tower.skip_hint',
      sizeMm: Math.max(26, skip.width / this.ctx.layout.metrics.pxPerMm),
    }) as IconButton;
    btn.view.position.set(skip.x + skip.width / 2, skip.y + skip.height / 2);
    btn.view.visible = false;
    this.skipButton = btn;
    this.stage.ui.addChild(mat, btn.view);
  }

  private emblem(size: number): Container {
    const c = new Container();
    const h = size * 0.24;
    const order: PotId[] = ['pot_blue', 'pot_green', 'pot_red'];
    order.forEach((p, k) => {
      const pot = drawPot(p, h);
      pot.position.set(0, size * 0.32 - k * h);
      c.addChild(pot);
    });
    return c;
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* KitView                                                                                        */
  /* ---------------------------------------------------------------------------------------------- */

  intro(): Promise<void> {
    return this.stage.intro(async () => {
      void this.potter?.play('wave');
    });
  }

  async outro(): Promise<void> {
    void this.potter?.play('namaste');
    await this.stage.outro();
  }

  phase(_p: GamePhase): void {}

  guideSpeak(ms: number): void {
    this.stage.guideSpeak(ms);
  }

  enterProbes(): Promise<void> {
    this.goalLayer.visible = false;
    this.board.visible = false;
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

  setupBoard(problem: TowerProblem): void {
    this.state = problem.start.map((b) => [...b]);
    for (const c of this.pegLayer.removeChildren()) c.destroy({ children: true });
    for (const c of this.potLayer.removeChildren()) c.destroy({ children: true });
    for (const c of this.goalLayer.removeChildren()) c.destroy({ children: true });
    this.pots.clear();
    const { potH } = this.g;
    problem.capacities.forEach((cap, i) => {
      const r = this.g.pegs[i];
      if (!r) return;
      const peg = this.bake(`peg.${cap}.${Math.round(potH)}.${Math.round(r.width)}`, () =>
        drawPeg(cap, potH, r.width * 0.92),
      );
      peg.position.set(r.x + r.width / 2, this.g.baseY);
      this.pegLayer.addChild(peg);
    });
    problem.start.forEach((basket, i) => {
      basket.forEach((id, k) => {
        const pot = this.bake(`pot.${id}.${Math.round(potH)}`, () => drawPot(id, potH));
        pot.position.set(this.pegX(i), this.g.baseY - potH * k);
        this.potLayer.addChild(pot);
        this.pots.set(id, pot);
      });
    });
    const goal = drawGoalPicture(
      problem.goal,
      problem.capacities,
      this.g.goal.width,
      this.g.goal.height,
    );
    goal.position.set(this.g.goal.x, this.g.goal.y);
    this.goalLayer.addChild(goal);
    markStimulus(problem.kind);
  }

  private pegX(i: number): number {
    const r = this.g.pegs[i];
    return r ? r.x + r.width / 2 : 0;
  }

  select(basket: number | null): void {
    if (this.lifted) {
      const l = this.lifted;
      gsap.killTweensOf(l.pot);
      gsap.to(l.pot, { y: l.baseY, duration: 0.14, ease: 'power2.in' });
      this.lifted = null;
    }
    if (basket === null) return;
    const stack = this.state[basket] ?? [];
    const top = stack[stack.length - 1];
    const pot = top ? this.pots.get(top) : undefined;
    if (!pot) return;
    const baseY = this.g.baseY - this.g.potH * (stack.length - 1);
    this.lifted = { pot, peg: basket, baseY };
    gsap.to(pot, {
      y: baseY - this.g.potH * 0.55,
      duration: this.stage.reducedMotion ? 0 : 0.16,
      ease: 'back.out(2)',
    });
    warmGlow(
      this.stage.ui,
      this.stage.fx,
      { x: pot.x, y: baseY - this.g.potH * 0.9 },
      this.g.potH * 0.9,
      0xfff1c8,
    );
  }

  async movePot(_from: number, to: number, pot: PotId, state: TowerState): Promise<void> {
    const view = this.pots.get(pot);
    this.lifted = null;
    this.state = state.map((b) => [...b]);
    if (!view) return;
    gsap.killTweensOf(view);
    const k = (state[to] ?? []).length - 1;
    const dest = { x: this.pegX(to), y: this.g.baseY - this.g.potH * k };
    this.potLayer.addChild(view); // on top while flying
    await arcTo(
      view,
      dest,
      { height: this.g.potH * 1.1, durationS: 0.26 },
      this.stage.reducedMotion,
    );
    void squash(view, 0.12, this.stage.reducedMotion);
    this.stage.burst('dust', { x: dest.x, y: dest.y }, 8, this.stage.ui);
  }

  async reject(from: number, to: number): Promise<void> {
    const stack = this.state[from] ?? [];
    const top = stack[stack.length - 1];
    const view = top ? this.pots.get(top) : undefined;
    this.lifted = null;
    if (!view) return;
    gsap.killTweensOf(view);
    const home = { x: this.pegX(from), y: this.g.baseY - this.g.potH * (stack.length - 1) };
    const destTop = this.g.baseY - this.g.potH * ((this.state[to] ?? []).length + 0.6);
    this.ctx.audio.playSfx('tap_soft', { volume: 0.5 });
    await arcTo(
      view,
      { x: this.pegX(to), y: destTop },
      { height: this.g.potH * 0.6, durationS: 0.2 },
      this.stage.reducedMotion,
    );
    // A gentle wobble: the peg is full, the pot hops back.
    await new Promise<void>((resolve) => {
      gsap.to(view, {
        rotation: 0.12,
        duration: 0.06,
        yoyo: true,
        repeat: 3,
        onComplete: resolve,
        onInterrupt: resolve,
      });
    });
    view.rotation = 0;
    await arcTo(
      view,
      home,
      { height: this.g.potH * 0.6, durationS: 0.22 },
      this.stage.reducedMotion,
    );
  }

  showSkip(show: boolean): void {
    if (!this.skipButton || !this.mat) return;
    if (show && !this.skipButton.view.visible) {
      this.mat.visible = true;
      this.skipButton.view.visible = true;
      this.skipButton.view.alpha = 0;
      gsap.to(this.skipButton.view, { alpha: 1, duration: 0.4 });
      this.skipButton.pulse();
      void this.potter?.play('point');
    } else if (!show) {
      this.mat.visible = false;
      this.skipButton.view.visible = false;
    }
  }

  async solved(): Promise<void> {
    markStimulus(null);
    this.ctx.audio.playSfx('chime', { volume: 0.7 });
    for (const pot of this.pots.values()) {
      warmGlow(
        this.stage.ui,
        this.stage.fx,
        { x: pot.x, y: pot.y - this.g.potH * 0.5 },
        this.g.potH,
        0xffe9a8,
      );
    }
    const mid = this.g.pegs[1];
    this.stage.burst(
      'petals',
      { x: mid ? mid.x + mid.width / 2 : 0, y: this.g.baseY - this.g.potH * 4 },
      24,
      this.stage.ui,
    );
    void this.potter?.play('clap');
    this.potter?.react?.('delighted', 0.8);
    await waitMs(this.ctx, 650);
  }

  async rest(): Promise<void> {
    markStimulus(null);
    this.potter?.react?.('calm', 0.8);
    void this.potter?.play('nod');
    await waitMs(this.ctx, 450);
  }

  async clearBoard(): Promise<void> {
    await new Promise<void>((resolve) => {
      gsap.to([this.potLayer, this.goalLayer], {
        alpha: 0,
        duration: this.stage.reducedMotion ? 0.1 : 0.22,
        onComplete: resolve,
        onInterrupt: resolve,
      });
    });
    this.potLayer.alpha = 1;
    this.goalLayer.alpha = 1;
    for (const c of this.potLayer.removeChildren()) c.destroy({ children: true });
    for (const c of this.goalLayer.removeChildren()) c.destroy({ children: true });
    this.pots.clear();
  }

  practiceHint(target: Point | null): void {
    if (!this.hint) return;
    if (target) this.hint.show('tap', target);
    else this.hint.stop();
  }

  /* ---------------------------------------------------------------------------------------------- */

  private tick(dt: number): void {
    this.t += dt;
    if (this.wheel) this.wheel.skew.x = Math.sin(this.t * 6) * 0.08;
    if (this.lifted && !gsap.isTweening(this.lifted.pot)) {
      this.lifted.pot.y =
        this.lifted.baseY - this.g.potH * 0.55 + Math.sin(this.t * 4) * 3 * this.u;
    }
  }

  destroy(): void {
    this.ctx.app.ticker.remove(this.onTick);
    this.hint?.stop();
    this.skipButton?.destroy();
    this.potter?.destroy();
    this.stage.destroy();
  }
}
