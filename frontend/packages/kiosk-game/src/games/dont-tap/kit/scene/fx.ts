/**
 * Ambient and feedback effects shared by the set-1 micro-game scenes: fireflies, drifting motes and
 * petals, god-ray shafts, a soft vignette, pop rings and squash-and-stretch. All effects are
 * decorative: they never cover a stimulus, never flash faster than 3 Hz (KSK-05) and collapse to
 * static or no-op versions under reduced motion. No text, no numerals.
 */
import { gsap } from 'gsap';
import { Container, Graphics, Sprite, type Texture, type Ticker } from 'pixi.js';
import { rgba, rgrad, vgrad } from '../../../../art/draw.ts';
import { FX_RADIUS, fxTexture } from '../../../../art/fx/textures.ts';
import { ArtRandom } from '../../../../art/rand.ts';
import type { TextureCache } from '../../../../art/textures.ts';
import type { Point } from '../../../../core/contracts.ts';

/** Minimum blink period of anything that pulses (<= 3 Hz rule, with a wide margin). */
const MIN_PULSE_PERIOD_S = 1.4;

/** Optional texture source (the Mela art kit cache); without it effects draw live graphics. */
export interface FxDeps {
  readonly cache: TextureCache | null;
  readonly ticker: Ticker;
  readonly reducedMotion: boolean;
  /** Multiplier on particle counts (quality tier). */
  readonly particleScale: number;
}

function glowTexture(deps: FxDeps): Texture | null {
  return deps.cache ? fxTexture(deps.cache, 'glow') : null;
}

function glowSprite(deps: FxDeps, radius: number, color: number): Container {
  const tex = glowTexture(deps);
  if (tex) {
    const s = new Sprite(tex);
    s.anchor.set(0.5);
    s.scale.set(radius / FX_RADIUS.glow);
    s.tint = color;
    s.blendMode = 'add';
    return s;
  }
  const g = new Graphics().circle(0, 0, radius).fill(
    rgrad([
      [0, rgba(color, 0.9)],
      [0.3, rgba(color, 0.35)],
      [1, rgba(color, 0)],
    ]),
  );
  g.blendMode = 'add';
  return g;
}

/* ------------------------------------------------------------------------------------------------ */

interface Firefly {
  readonly view: Container;
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  period: number;
  base: number;
}

/** Wandering, softly breathing fireflies inside a rectangle. */
export class Fireflies {
  readonly view = new Container();
  private readonly flies: Firefly[] = [];
  private readonly rnd: ArtRandom;
  private t = 0;
  private bounds: { x: number; y: number; w: number; h: number };
  private intensity = 1;
  private readonly onTick = (tk: Ticker): void => this.update(Math.min(0.05, tk.deltaMS / 1000));

  constructor(
    private readonly deps: FxDeps,
    bounds: { x: number; y: number; w: number; h: number },
    count: number,
    unit: number,
    seed = 'fireflies',
  ) {
    this.bounds = bounds;
    this.rnd = new ArtRandom(seed);
    this.view.eventMode = 'none';
    const n = Math.round(count * deps.particleScale * (deps.reducedMotion ? 0.5 : 1));
    for (let i = 0; i < n; i += 1) {
      const core = new Container();
      const halo = glowSprite(deps, (16 + this.rnd.range(0, 10)) * unit, 0xffe27a);
      const dot = glowSprite(deps, 4.5 * unit, 0xfffbe0);
      core.addChild(halo, dot);
      const f: Firefly = {
        view: core,
        x: bounds.x + this.rnd.range(0, bounds.w),
        y: bounds.y + this.rnd.range(0, bounds.h),
        vx: this.rnd.range(-18, 18) * unit,
        vy: this.rnd.range(-12, 12) * unit,
        phase: this.rnd.range(0, Math.PI * 2),
        period: this.rnd.range(MIN_PULSE_PERIOD_S, 3.6),
        base: this.rnd.range(0.35, 0.9),
      };
      core.position.set(f.x, f.y);
      this.flies.push(f);
      this.view.addChild(core);
    }
    deps.ticker.add(this.onTick);
    this.update(0);
  }

  /** Fade the swarm (0 hidden .. 1 full); smooth, never a flash. */
  setIntensity(v: number, durationS = 1.2): void {
    if (this.deps.reducedMotion || durationS <= 0) {
      this.intensity = v;
      return;
    }
    gsap.to(this, { intensity: v, duration: durationS, ease: 'sine.inOut' });
  }

  resize(bounds: { x: number; y: number; w: number; h: number }): void {
    this.bounds = bounds;
  }

  private update(dt: number): void {
    this.t += dt;
    const b = this.bounds;
    for (const f of this.flies) {
      if (!this.deps.reducedMotion) {
        f.vx += Math.sin(this.t * 0.7 + f.phase) * 6 * dt;
        f.vy += Math.cos(this.t * 0.9 + f.phase * 1.3) * 5 * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (f.x < b.x || f.x > b.x + b.w) f.vx *= -1;
        if (f.y < b.y || f.y > b.y + b.h) f.vy *= -1;
        f.x = Math.min(b.x + b.w, Math.max(b.x, f.x));
        f.y = Math.min(b.y + b.h, Math.max(b.y, f.y));
      }
      const pulse = 0.5 + 0.5 * Math.sin((this.t / f.period) * Math.PI * 2 + f.phase);
      f.view.alpha =
        this.intensity * (this.deps.reducedMotion ? f.base : f.base * (0.25 + 0.75 * pulse));
      f.view.position.set(f.x, f.y);
    }
  }

  destroy(): void {
    this.deps.ticker.remove(this.onTick);
    gsap.killTweensOf(this);
    this.view.destroy({ children: true });
  }
}

/* ------------------------------------------------------------------------------------------------ */

/** Soft diagonal light shafts (golden hour); sway slowly, additive, low alpha. */
export class GodRays {
  readonly view = new Container();
  private t = 0;
  private strength = 1;
  private readonly shafts: { g: Graphics; phase: number; base: number }[] = [];
  private readonly onTick = (tk: Ticker): void => this.update(Math.min(0.05, tk.deltaMS / 1000));

  constructor(
    private readonly deps: FxDeps,
    width: number,
    height: number,
    color: number,
    seed = 'rays',
  ) {
    const rnd = new ArtRandom(seed);
    this.view.eventMode = 'none';
    for (let i = 0; i < 5; i += 1) {
      const g = new Graphics();
      const x = width * (0.1 + i * 0.2 + rnd.range(-0.05, 0.05));
      const w = width * rnd.range(0.05, 0.11);
      const slant = width * 0.22;
      // Soft shaft: nested widths (feathered edges) fading out toward the ground; no hard glass edges.
      const fade = vgrad([
        [0, rgba(color, 0.5)],
        [0.55, rgba(color, 0.22)],
        [1, rgba(color, 0)],
      ]);
      for (const k of [1, 0.72, 0.48, 0.26]) {
        const cx = x + w / 2;
        const hw = (w * k) / 2;
        g.poly([
          cx - hw,
          -10,
          cx + hw,
          -10,
          cx + hw * 1.4 - slant,
          height * 0.95,
          cx - hw * 1.4 - slant,
          height * 0.95,
        ]).fill(fade);
      }
      g.blendMode = 'add';
      const base = rnd.range(0.035, 0.075);
      g.alpha = base;
      this.shafts.push({ g, phase: rnd.range(0, Math.PI * 2), base });
      this.view.addChild(g);
    }
    if (!deps.reducedMotion) deps.ticker.add(this.onTick);
  }

  setStrength(k: number, durationS = 1.5): void {
    for (const s of this.shafts) {
      gsap.to(s.g, { alpha: s.base * k, duration: this.deps.reducedMotion ? 0 : durationS });
    }
    this.strength = k;
  }

  private update(dt: number): void {
    this.t += dt;
    for (const s of this.shafts) {
      if (gsap.isTweening(s.g)) continue;
      s.g.alpha = s.base * this.strength * (0.75 + 0.25 * Math.sin(this.t * 0.35 + s.phase));
    }
  }

  destroy(): void {
    this.deps.ticker.remove(this.onTick);
    for (const s of this.shafts) gsap.killTweensOf(s.g);
    this.view.destroy({ children: true });
  }
}

/* ------------------------------------------------------------------------------------------------ */

/** Screen vignette: transparent over the play area, softly darker only toward the corners. */
export function vignette(
  width: number,
  height: number,
  strength = 0.35,
  color = 0x120a1e,
): Graphics {
  const g = new Graphics();
  g.rect(0, 0, width, height).fill(
    rgrad(
      [
        [0, rgba(color, 0)],
        [0.72, rgba(color, 0)],
        [0.9, rgba(color, strength * 0.55)],
        [1, rgba(color, strength)],
      ],
      { x: 0.5, y: 0.5 },
      0.71,
    ),
  );
  g.eventMode = 'none';
  return g;
}

/** Expanding ring at a point (tap acknowledgement); ~0.45 s, then removed. */
export function popRing(
  parent: Container,
  at: Point,
  radius: number,
  color: number,
  reducedMotion: boolean,
): void {
  const g = new Graphics()
    .circle(0, 0, radius)
    .stroke({ width: Math.max(3, radius * 0.08), color, alpha: 0.9 });
  g.position.set(at.x, at.y);
  g.eventMode = 'none';
  parent.addChild(g);
  if (reducedMotion) {
    gsap.to(g, { alpha: 0, duration: 0.3, onComplete: () => g.destroy() });
    return;
  }
  g.scale.set(0.45);
  gsap.to(g.scale, { x: 1.35, y: 1.35, duration: 0.45, ease: 'power2.out' });
  gsap.to(g, { alpha: 0, duration: 0.45, ease: 'power1.in', onComplete: () => g.destroy() });
}

/** Warm additive glow flash under an object (soft bloom, ~0.6 s; never strobes). */
export function warmGlow(
  parent: Container,
  deps: FxDeps,
  at: Point,
  radius: number,
  color = 0xffd27a,
): void {
  const s = glowSprite(deps, radius, color);
  s.position.set(at.x, at.y);
  s.alpha = 0;
  parent.addChild(s);
  gsap.to(s, {
    alpha: 0.85,
    duration: 0.16,
    ease: 'sine.out',
    onComplete: () => {
      gsap.to(s, { alpha: 0, duration: 0.5, ease: 'sine.in', onComplete: () => s.destroy() });
    },
  });
}

/** Squash-and-stretch on a container (impact). Resolves when settled. */
export function squash(target: Container, amount = 0.18, reducedMotion = false): Promise<void> {
  if (reducedMotion || target.destroyed) return Promise.resolve();
  const sx = target.scale.x;
  const sy = target.scale.y;
  return new Promise((resolve) => {
    gsap
      .timeline({ onComplete: () => resolve(), onInterrupt: () => resolve() })
      .to(target.scale, {
        x: sx * (1 + amount),
        y: sy * (1 - amount),
        duration: 0.07,
        ease: 'power2.out',
      })
      .to(target.scale, { x: sx * (1 - amount * 0.45), y: sy * (1 + amount * 0.5), duration: 0.09 })
      .to(target.scale, { x: sx, y: sy, duration: 0.32, ease: 'elastic.out(1.1, 0.45)' });
  });
}

/** Ballistic arc tween of a display object from its position to `to` (resolves on landing). */
export function arcTo(
  target: Container,
  to: Point,
  options: {
    readonly height: number;
    readonly durationS: number;
    readonly spin?: number;
    readonly scaleTo?: number;
  },
  reducedMotion = false,
): Promise<void> {
  if (target.destroyed) return Promise.resolve();
  const from = { x: target.x, y: target.y };
  const s0 = target.scale.x;
  const d = reducedMotion ? Math.min(0.2, options.durationS) : options.durationS;
  return new Promise((resolve) => {
    const st = { k: 0 };
    gsap.to(st, {
      k: 1,
      duration: d,
      ease: 'none',
      onUpdate: () => {
        if (target.destroyed) return;
        const k = st.k;
        target.x = from.x + (to.x - from.x) * k;
        target.y = from.y + (to.y - from.y) * k - options.height * 4 * k * (1 - k);
        target.rotation = (options.spin ?? 0) * k;
        const sc = s0 + ((options.scaleTo ?? s0) - s0) * k;
        target.scale.set(sc);
      },
      onComplete: () => resolve(),
      onInterrupt: () => resolve(),
    });
  });
}

/** Soft drop shadow ellipse (stacked translucent ellipses). */
export function contactShadow(rx: number, ry: number, alpha = 0.32): Graphics {
  const g = new Graphics();
  for (let i = 5; i >= 1; i -= 1) {
    const k = i / 5;
    g.ellipse(0, 0, rx * (0.6 + 0.4 * k), ry * (0.6 + 0.4 * k)).fill({
      color: 0x1a0d08,
      alpha: (alpha / 5) * 1.3,
    });
  }
  return g;
}
