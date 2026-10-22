/**
 * Cross-module probe segment (MG-10: "cross-module probe trials support the style traits, >= 4
 * comparable segments"). Every Pathway B module ends with the same four probe situations so the style
 * indicators (`persistence_of_style.cross_segment_style_r`, `.lag1_autocorr`) compare like with like:
 *
 * The sweets seller sets out two baskets: an open one with a few laddoos (code `safe`) and a basket
 * under a cloth that may hold many or none (code `risky`). The player taps one (and may change their
 * mind; every selection is a revision), then the tick. No outcome is shown, so situations stay
 * comparable and nothing reads as a score.
 *
 * Situations (visible laddoos, side of the covered basket) come from the module config
 * (`constraints.probe_safe_counts`, `constraints.probe_risky_sides`) and are identical in every
 * module; the response window is `levels.Lx.timing.probe_window_ms`.
 *
 * Events follow the scoring conventions: trial type `probe`, block `probe`, `task.probe_group_id`
 * `<module>.probe`, params `repeat_group_id = probe_situation_<k>`, response `safe` | `risky`.
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../../art/color.ts';
import { softShadow, vgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import type { Character, CharacterSpec, Point, Rect, UiButton } from '../../../core/contracts.ts';
import { createCoveredBasket, createLaddooPile, createSelectionRing } from './art.ts';
import type { BotHand } from './bot.ts';
import { runChoice } from './choice.ts';
import { hop, popIn, popOut, squash } from './motion.ts';
import { type GameRuntime, MicroGameConfigError } from './runtime.ts';
import type { GameStage } from './stage.ts';
import { centerOf, squareAt, type TargetBoard } from './targets.ts';
import type { TrialRecorder } from './trials.ts';

export type ProbeCode = 'safe' | 'risky';

export interface ProbeSituation {
  readonly repeatGroupId: string;
  readonly safeCount: number;
  readonly riskySide: 'left' | 'right';
}

/** Read the probe situations from the module config (fail closed). */
export function probeSituations(rt: GameRuntime): ProbeSituation[] {
  const counts = rt.constraintNumbers('probe_safe_counts');
  const sides = rt.constraintStrings('probe_risky_sides');
  const n = rt.block('probe').trials;
  if (counts.length < n || sides.length < n) {
    throw new MicroGameConfigError(
      rt.moduleId,
      `probe_safe_counts/probe_risky_sides must list ${n} situations`,
    );
  }
  return Array.from({ length: n }, (_, k) => {
    const side = sides[k];
    if (side !== 'left' && side !== 'right') {
      throw new MicroGameConfigError(rt.moduleId, `probe_risky_sides[${k}] must be left|right`);
    }
    return {
      repeatGroupId: `probe_situation_${k}`,
      safeCount: Math.max(1, Math.round(counts[k] ?? 1)),
      riskySide: side,
    };
  });
}

/** Stage geometry of the probe interlude (pure; shared by scene, targets and bot). */
export interface ProbeGeometry {
  readonly left: Rect;
  readonly right: Rect;
  readonly confirm: Rect;
  readonly basketWidth: number;
  readonly mat: Rect;
  readonly vendorAt: Point;
}

export function probeGeometry(layout: {
  readonly width: number;
  readonly height: number;
  readonly orientation: 'landscape' | 'portrait';
  readonly metrics: { readonly pxPerMm: number };
}): ProbeGeometry {
  const mm = layout.metrics.pxPerMm;
  const portrait = layout.orientation === 'portrait';
  const W = layout.width;
  const H = layout.height;
  const tile = Math.max(46 * mm, Math.min(W, H) * (portrait ? 0.3 : 0.24));
  const gap = Math.max(16 * mm, tile * 0.32);
  const cy = portrait ? H * 0.66 : H * 0.62;
  const cx = W / 2;
  const left = squareAt({ x: cx - gap / 2 - tile / 2, y: cy }, tile);
  const right = squareAt({ x: cx + gap / 2 + tile / 2, y: cy }, tile);
  const btn = Math.max(26 * mm, tile * 0.38);
  const confirm = portrait
    ? squareAt({ x: cx, y: cy + tile / 2 + btn * 0.9 }, btn)
    : squareAt({ x: right.x + right.width + gap * 0.6 + btn / 2, y: cy + tile * 0.18 }, btn);
  const matW = tile * 2 + gap + tile * 0.7;
  const tableTop = cy + tile * 0.22;
  return {
    left,
    right,
    confirm,
    basketWidth: tile * 0.82,
    mat: { x: cx - matW / 2, y: tableTop, width: matW, height: tile * 0.95 },
    vendorAt: { x: cx, y: tableTop + tile * 0.75 },
  };
}

/** Cloth-draped wooden chowki (low table) filling `r`: top surface, skirt with border, legs. */
function drawChowki(r: Rect): Graphics {
  const g = new Graphics();
  const topH = r.height * 0.22;
  const legH = r.height * 0.18;
  softShadow(g, r.x + r.width / 2, r.y + r.height, r.width * 0.55, r.height * 0.08, MELA.ink, 0.45);
  for (const fx of [0.06, 0.94]) {
    g.roundRect(
      r.x + r.width * fx - r.width * 0.02,
      r.y + r.height - legH,
      r.width * 0.04,
      legH,
      4,
    ).fill(darken(MELA.wood, 0.2));
  }
  g.roundRect(r.x, r.y, r.width, topH, topH * 0.3).fill(
    vgrad([
      [0, lighten(MELA.wood, 0.25)],
      [1, MELA.wood],
    ]),
  );
  for (let i = 1; i < 6; i++) {
    g.moveTo(r.x + r.width * 0.02, r.y + (topH * i) / 6)
      .lineTo(r.x + r.width * 0.98, r.y + (topH * i) / 6 + (i % 2 ? 2 : -2))
      .stroke({ width: 1, color: darken(MELA.wood, 0.35), alpha: 0.35 });
  }
  const skirtY = r.y + topH * 0.8;
  const skirtH = r.height - topH * 0.8 - legH * 0.7;
  g.moveTo(r.x - r.width * 0.01, skirtY)
    .lineTo(r.x + r.width * 1.01, skirtY)
    .lineTo(r.x + r.width * 0.99, skirtY + skirtH)
    .quadraticCurveTo(
      r.x + r.width / 2,
      skirtY + skirtH * 1.12,
      r.x + r.width * 0.01,
      skirtY + skirtH,
    )
    .closePath()
    .fill(
      vgrad([
        [0, lighten(MELA.kumkum, 0.1)],
        [1, darken(MELA.kumkum, 0.25)],
      ]),
    );
  g.moveTo(r.x, skirtY + skirtH * 0.18)
    .lineTo(r.x + r.width, skirtY + skirtH * 0.18)
    .stroke({ width: skirtH * 0.08, color: MELA.brass });
  const step = r.width / 18;
  for (let x = r.x + step / 2; x < r.x + r.width; x += step) {
    g.circle(x, skirtY + skirtH * 0.55, skirtH * 0.06).fill(MELA.marigold);
    g.moveTo(x, skirtY + skirtH * 0.95)
      .lineTo(x + step * 0.25, skirtY + skirtH * 1.06)
      .stroke({ width: 2, color: MELA.brassLight, alpha: 0.8 });
  }
  return g;
}

/** Visual for the probe interlude (null when headless). */
export class ProbeScene {
  private readonly root = new Container();
  private readonly baskets = new Map<ProbeCode, Container>();
  private readonly rings = new Map<ProbeCode, Container>();
  private confirmBtn: UiButton | null = null;
  private vendor: Character | null = null;
  private dimmer: Graphics | null = null;

  constructor(
    private readonly stage: GameStage,
    private readonly geo: ProbeGeometry,
    private readonly moduleId: string,
    private readonly vendorSpec: CharacterSpec = {
      id: 'probe_vendor',
      role: 'vendor',
      variant: 5,
      facing: 'left',
      scale: 1.55,
    },
  ) {
    this.root.label = 'probe';
    this.root.zIndex = 500;
    stage.ui.addChild(this.root);
  }

  /** Bring in the seller and dim the scene behind (once per block). */
  enter(): void {
    const { stage, geo } = this;
    if (!this.dimmer) {
      const d = new Graphics()
        .rect(0, 0, stage.width, stage.height)
        .fill({ color: 0x1c1226, alpha: 0.42 });
      d.alpha = 0;
      this.root.addChildAt(d, 0);
      gsap.to(d, { alpha: 1, duration: 0.5 });
      this.dimmer = d;
      const pool = stage.lightPool(geo.mat.width * 0.75, geo.mat.height * 0.9);
      pool.position.set(geo.mat.x + geo.mat.width / 2, geo.mat.y + geo.mat.height * 0.4);
      this.root.addChild(pool);
      // The seller stands behind a cloth-draped wooden chowki; the table hides his legs.
      const v = stage.art.createCharacter(this.vendorSpec);
      v.view.position.set(geo.vendorAt.x, geo.vendorAt.y);
      const rig = stage.rig(v);
      if (rig) rig.setExpression('pleased');
      else v.setExpression('happy');
      this.root.addChild(v.view);
      this.root.addChild(drawChowki(geo.mat));
      this.vendor = v;
      stage.own(v);
      popIn(v.view, 0, 0.6, v.view.scale.y);
    }
  }

  /** Lay out the two baskets for a situation. */
  show(s: ProbeSituation): void {
    this.clearBaskets();
    const { geo } = this;
    const safeRect = s.riskySide === 'left' ? geo.right : geo.left;
    const riskyRect = s.riskySide === 'left' ? geo.left : geo.right;
    const r = geo.basketWidth * 0.11;
    const safe = new Container();
    const pile = createLaddooPile(s.safeCount, r);
    safe.addChild(pile);
    const risky = createCoveredBasket(geo.basketWidth);
    for (const [code, view, rect] of [
      ['safe', safe, safeRect],
      ['risky', risky, riskyRect],
    ] as const) {
      const c = centerOf(rect);
      const holder = new Container();
      holder.position.set(c.x, this.geo.mat.y + this.geo.mat.height * 0.12);
      holder.addChild(view);
      const ring = createSelectionRing(rect.width * 0.5);
      ring.position.set(0, -rect.height * 0.28);
      ring.visible = false;
      holder.addChild(ring);
      this.root.addChild(holder);
      this.baskets.set(code, holder);
      this.rings.set(code, ring);
      popIn(holder, code === 'safe' ? 0 : 0.08, 0.5);
    }
    if (!this.confirmBtn) {
      const b = this.stage.art.createButton({
        id: `${this.moduleId}.probe_confirm`,
        iconId: 'tick',
        audioKey: `${this.moduleId}.replay`,
        variant: 'confirm',
        sizeMm: this.geo.confirm.width / this.stage.pxPerMm,
      });
      const c = centerOf(this.geo.confirm);
      b.view.position.set(c.x, c.y);
      this.root.addChild(b.view);
      this.confirmBtn = b;
    }
    this.confirmBtn.setEnabled(false);
  }

  select(code: ProbeCode): void {
    for (const [k, ring] of this.rings) ring.visible = k === code;
    const b = this.baskets.get(code);
    if (b) hop(b, this.geo.basketWidth * 0.12);
    this.confirmBtn?.setEnabled(true);
    this.confirmBtn?.pulse();
  }

  /** Commit animation: the seller wraps the chosen basket away (no outcome shown). */
  async commit(code: ProbeCode | null): Promise<void> {
    if (this.confirmBtn) squash(this.confirmBtn.view, 0.15);
    const rig = this.vendor ? this.stage.rig(this.vendor) : null;
    if (rig) void rig.play('nod');
    const chosen = code ? this.baskets.get(code) : null;
    await Promise.all(
      [...this.baskets.entries()].map(([k, b]) =>
        k === code && chosen
          ? new Promise<void>((resolve) =>
              gsap.to(b, {
                y: b.y - this.geo.basketWidth * 0.25,
                alpha: 0,
                duration: 0.35,
                onComplete: resolve,
              }),
            )
          : popOut(b, 0.22),
      ),
    );
  }

  private clearBaskets(): void {
    for (const b of this.baskets.values()) {
      gsap.killTweensOf(b);
      gsap.killTweensOf(b.scale);
      b.destroy({ children: true });
    }
    this.baskets.clear();
    this.rings.clear();
  }

  /** Remove the interlude. */
  async exit(): Promise<void> {
    this.clearBaskets();
    this.confirmBtn?.destroy();
    this.confirmBtn = null;
    if (this.dimmer)
      await new Promise<void>((r) =>
        gsap.to(this.dimmer, { alpha: 0, duration: 0.35, onComplete: r }),
      );
    this.destroy();
  }

  destroy(): void {
    this.clearBaskets();
    this.vendor?.destroy();
    this.vendor = null;
    this.confirmBtn?.destroy();
    this.confirmBtn = null;
    if (!this.root.destroyed) this.root.destroy({ children: true });
  }
}

/** Bot persona for probes: probability of the covered basket and of changing its mind. */
export interface ProbeBotPolicy {
  readonly riskyBias: number;
  readonly reviseRate: number;
  readonly medianMs: number;
}

/**
 * Run the probe block: `probe` trials with select-then-confirm, exact window from the level table.
 * Returns the number of completed probe trials.
 */
export async function runProbeBlock(
  rt: GameRuntime,
  rec: TrialRecorder,
  board: TargetBoard,
  options: {
    readonly scene: ProbeScene | null;
    readonly bot: BotHand | null;
    readonly botPolicy?: ProbeBotPolicy;
    readonly geometry: ProbeGeometry;
  },
): Promise<number> {
  const situations = probeSituations(rt);
  const windowMs = rt.timing('probe_window_ms');
  const moduleId = rt.moduleId;
  const leftId = `${moduleId}.probe_left`;
  const rightId = `${moduleId}.probe_right`;
  const confirmId = `${moduleId}.probe_confirm`;
  const geo = options.geometry;
  const audio = `${moduleId}.replay`;
  const botRand = rt.ctx.rng.stream('bot.probe');
  const policy = options.botPolicy ?? { riskyBias: 0.45, reviseRate: 0.2, medianMs: 1400 };
  options.scene?.enter();
  let done = 0;
  rt.phase('probe');
  for (const s of situations) {
    rt.check();
    const codeFor = (side: 'left' | 'right'): 'safe' | 'risky' =>
      side === s.riskySide ? 'risky' : 'safe';
    const trial = rec.begin({
      blockId: 'probe',
      phase: 'main',
      conditionId: 'probe',
      trialType: 'probe',
      stimulusId: `${moduleId}.probe.${s.repeatGroupId}`,
      responseWindowMs: windowMs,
      expectedResponse: null,
      scorable: true,
      probeGroupId: `${moduleId}.probe`,
      params: {
        repeat_group_id: s.repeatGroupId,
        safe_count: s.safeCount,
        risky_side: s.riskySide,
      },
    });
    try {
      board.set(leftId, geo.left, audio, { enabled: false });
      board.set(rightId, geo.right, audio, { enabled: false });
      board.set(confirmId, geo.confirm, audio, { enabled: false });
      const presented = await trial.present(
        () => {
          options.scene?.show(s);
          board.enable(leftId, true);
          board.enable(rightId, true);
          board.enable(confirmId, true);
        },
        { version: 'probe.1', durationMs: null },
      );
      rt.phase('probe.choice', trial.index);
      if (options.bot) {
        const first = botRand.bool(policy.riskyBias) ? 'risky' : 'safe';
        const firstId = (first === 'risky') === (s.riskySide === 'left') ? leftId : rightId;
        const t1 = Math.min(
          windowMs * 0.6,
          Math.max(250, policy.medianMs * (0.6 + botRand.next() * 0.8)),
        );
        const plan: Promise<void>[] = [options.bot.tapTarget(firstId, t1, () => botRand.next())];
        let tLast = t1;
        if (botRand.bool(policy.reviseRate)) {
          const otherId = firstId === leftId ? rightId : leftId;
          tLast = t1 + 350 + botRand.next() * 500;
          plan.push(options.bot.tapTarget(otherId, tLast, () => botRand.next()));
        }
        plan.push(
          options.bot.tapTarget(confirmId, tLast + 300 + botRand.next() * 400, () =>
            botRand.next(),
          ),
        );
        for (const p of plan) void p.catch(() => undefined);
      }
      const outcome = await runChoice(rt, {
        options: new Map([
          [leftId, codeFor('left')],
          [rightId, codeFor('right')],
        ]),
        confirmId,
        anchorMs: presented.presentedOnsetMs,
        windowMs,
        onSelect: (code) => options.scene?.select(code as ProbeCode),
      });
      board.enableAll([leftId, rightId, confirmId], false);
      trial.respond({
        stimulusId: trial.spec.stimulusId,
        value: outcome.value,
        correctness: null,
        latencyMs: outcome.latencyMs,
        anchor: 'visual_onset',
        tapCount: outcome.tapCount,
        revisions: outcome.revisions,
        xy: outcome.xy,
      });
      if (options.scene) await options.scene.commit((outcome.value as ProbeCode | null) ?? null);
      trial.end(
        outcome.kind === 'timeout' ? 'timeout' : 'not_applicable',
        null,
        outcome.kind === 'timeout' ? 0 : 1,
      );
      done += 1;
      await rt.sleep(250);
    } catch (err) {
      trial.abort();
      throw err;
    }
  }
  board.remove(leftId);
  board.remove(rightId);
  board.remove(confirmId);
  if (options.scene) await options.scene.exit();
  return done;
}
