/**
 * Pooled sprite particle emitters (confetti, sparkle, dust, petals, smoke, coins, leaves).
 * Sprites are recycled through a {@link Pool}; textures are baked once. Particle counts scale with the
 * quality tier and reduced-motion setting. Celebrations never flash (no strobing; fades are smooth).
 */
import { Container, Sprite, type Ticker } from 'pixi.js';
import type { ParticleEmitter, ParticleKind, ParticleSpec } from '../../core/contracts.ts';
import { MELA } from '../palettes.ts';
import { Pool } from '../pool.ts';
import type { QualityProfile } from '../quality.ts';
import { ArtRandom } from '../rand.ts';
import type { TextureCache } from '../textures.ts';
import { type FxTextureId, fxTexture } from './textures.ts';

interface KindConfig {
  readonly texture: FxTextureId;
  readonly colors: readonly number[];
  readonly count: number;
  readonly speed: readonly [number, number];
  /** Emission cone: centre angle (radians, 0 = right, -PI/2 = up) and spread. */
  readonly angle: number;
  readonly spread: number;
  readonly gravity: number;
  readonly drag: number;
  readonly spin: number;
  readonly life: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly additive: boolean;
  readonly flutter: boolean;
  readonly grow: number;
  /** Peak opacity (default 1). Soft kinds stay translucent so overlapping dots never pile up white. */
  readonly peakAlpha?: number;
}

const KINDS: Readonly<Record<ParticleKind, KindConfig>> = {
  confetti: {
    texture: 'confetti',
    colors: [
      MELA.vermilion,
      MELA.marigold,
      MELA.peacock,
      MELA.rose,
      MELA.saffron,
      MELA.lapis,
      MELA.mango,
    ],
    count: 70,
    speed: [380, 820],
    angle: -Math.PI / 2,
    spread: 1.1,
    gravity: 820,
    drag: 1.6,
    spin: 9,
    life: [1.6, 2.6],
    scale: [0.8, 1.4],
    additive: false,
    flutter: true,
    grow: 0,
  },
  sparkle: {
    texture: 'sparkle',
    colors: [0xfff2b0, 0xffffff, 0xffd27a],
    count: 18,
    speed: [60, 220],
    angle: -Math.PI / 2,
    spread: Math.PI,
    gravity: -20,
    drag: 2.2,
    spin: 2,
    life: [0.6, 1.2],
    scale: [0.4, 1.0],
    additive: true,
    flutter: false,
    grow: -0.6,
  },
  dust: {
    texture: 'soft_dot',
    colors: [0xd6b07e, 0xc29464, 0xe6cda2],
    count: 24,
    speed: [40, 140],
    angle: -Math.PI / 2,
    spread: 1.4,
    gravity: -10,
    drag: 2.5,
    spin: 0,
    life: [0.8, 1.6],
    scale: [0.5, 1.1],
    additive: false,
    flutter: false,
    grow: 0.6,
    peakAlpha: 0.55,
  },
  petals: {
    texture: 'petal',
    colors: [MELA.marigold, MELA.saffron, MELA.rose, MELA.vermilion, MELA.lotus],
    count: 36,
    speed: [180, 420],
    angle: -Math.PI / 2,
    spread: 1.3,
    gravity: 260,
    drag: 2.4,
    spin: 4,
    life: [2.0, 3.2],
    scale: [0.8, 1.4],
    additive: false,
    flutter: true,
    grow: 0,
  },
  smoke: {
    texture: 'smoke',
    colors: [0xf2ece4, 0xd8d0c8],
    count: 10,
    speed: [20, 70],
    angle: -Math.PI / 2,
    spread: 0.6,
    gravity: -40,
    drag: 0.8,
    spin: 0.4,
    life: [1.6, 2.6],
    scale: [0.6, 1.0],
    additive: false,
    flutter: false,
    grow: 1.4,
  },
  coins: {
    texture: 'coin',
    colors: [0xffffff],
    count: 14,
    speed: [260, 520],
    angle: -Math.PI / 2,
    spread: 0.9,
    gravity: 1100,
    drag: 0.6,
    spin: 6,
    life: [1.0, 1.6],
    scale: [0.9, 1.3],
    additive: false,
    flutter: true,
    grow: 0,
  },
  leaves: {
    texture: 'leaf',
    colors: [0x5f8f3a, 0x7aa33c, 0x4f7a3a, 0xa3b84a],
    count: 16,
    speed: [80, 220],
    angle: -Math.PI / 2,
    spread: 1.6,
    gravity: 120,
    drag: 1.8,
    spin: 3,
    life: [2.0, 3.4],
    scale: [0.7, 1.2],
    additive: false,
    flutter: true,
    grow: 0,
  },
};

interface Particle {
  sprite: Sprite;
  vx: number;
  vy: number;
  vr: number;
  life: number;
  age: number;
  baseScale: number;
  phase: number;
}

/** A pooled emitter implementing the contract {@link ParticleEmitter}. */
export class PooledEmitter implements ParticleEmitter {
  readonly view = new Container();
  private readonly cfg: KindConfig;
  private readonly live: Particle[] = [];
  private readonly pool: Pool<Particle>;
  private readonly rnd: ArtRandom;
  private emitting = 0;
  private emitRate = 0;
  private emitAcc = 0;
  private destroyed = false;
  private readonly onTick = (t: Ticker): void => this.update(Math.min(0.05, t.deltaMS / 1000));

  constructor(
    private readonly spec: ParticleSpec,
    private readonly cache: TextureCache,
    private readonly ticker: Ticker,
    private readonly quality: QualityProfile,
    private readonly unit = 1,
  ) {
    this.cfg = KINDS[spec.kind];
    this.rnd = new ArtRandom(`${spec.kind}:${spec.origin.x}:${spec.origin.y}`);
    this.view.label = `particles:${spec.kind}`;
    this.view.eventMode = 'none';
    const tex = fxTexture(cache, this.cfg.texture);
    this.pool = new Pool<Particle>(
      () => {
        const s = new Sprite(tex);
        s.anchor.set(0.5);
        if (this.cfg.additive) s.blendMode = 'add';
        return { sprite: s, vx: 0, vy: 0, vr: 0, life: 1, age: 0, baseScale: 1, phase: 0 };
      },
      (p) => {
        p.sprite.visible = false;
        p.sprite.removeFromParent();
      },
      600,
    );
    ticker.add(this.onTick);
    const n = this.scaled(spec.count ?? this.cfg.count);
    if (spec.durationMs && spec.durationMs > 0) {
      this.emitting = spec.durationMs / 1000;
      this.emitRate = n / this.emitting;
    } else {
      this.burst(spec.count);
    }
  }

  private scaled(n: number): number {
    return Math.max(1, Math.round(n * this.quality.particleScale));
  }

  burst(count?: number): void {
    if (this.destroyed) return;
    const n = this.scaled(count ?? this.cfg.count);
    for (let i = 0; i < n; i++) this.spawn();
  }

  stop(): void {
    this.emitting = 0;
  }

  /** Number of live particles (tests/diagnostics). */
  get liveCount(): number {
    return this.live.length;
  }

  private spawn(): void {
    const p = this.pool.acquire();
    if (!p) return;
    const c = this.cfg;
    const r = this.rnd;
    const a = c.angle + r.range(-c.spread, c.spread);
    const sp = r.range(c.speed[0], c.speed[1]) * this.unit;
    p.vx = Math.cos(a) * sp;
    p.vy = Math.sin(a) * sp;
    p.vr = r.range(-c.spin, c.spin);
    p.life = r.range(c.life[0], c.life[1]);
    p.age = 0;
    p.baseScale = r.range(c.scale[0], c.scale[1]) * this.unit;
    p.phase = r.range(0, Math.PI * 2);
    const s = p.sprite;
    s.tint = r.pick(c.colors);
    s.position.set(
      this.spec.origin.x + r.range(-6, 6) * this.unit,
      this.spec.origin.y + r.range(-6, 6) * this.unit,
    );
    s.rotation = r.range(0, Math.PI * 2);
    s.scale.set(p.baseScale);
    s.alpha = c.peakAlpha ?? 1;
    s.visible = true;
    this.view.addChild(s);
    this.live.push(p);
  }

  private update(dt: number): void {
    if (this.destroyed) return;
    if (this.emitting > 0) {
      this.emitting -= dt;
      this.emitAcc += this.emitRate * dt;
      while (this.emitAcc >= 1) {
        this.emitAcc -= 1;
        this.spawn();
      }
    }
    const c = this.cfg;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      if (!p) continue;
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        this.live.splice(i, 1);
        this.pool.release(p);
        continue;
      }
      const damp = Math.exp(-c.drag * dt);
      p.vx *= damp;
      p.vy = p.vy * damp + c.gravity * this.unit * dt;
      const s = p.sprite;
      s.x += p.vx * dt + (c.flutter ? Math.sin(p.age * 6 + p.phase) * 30 * this.unit * dt : 0);
      s.y += p.vy * dt;
      s.rotation += p.vr * dt;
      const sc = p.baseScale * (1 + c.grow * k);
      if (c.flutter) s.scale.set(sc * Math.abs(Math.cos(p.age * 5 + p.phase)) * 0.8 + sc * 0.2, sc);
      else s.scale.set(sc);
      s.alpha = (c.peakAlpha ?? 1) * (k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ticker.remove(this.onTick);
    for (const p of this.live.splice(0)) p.sprite.destroy();
    this.pool.drain((p) => p.sprite.destroy());
    this.view.destroy({ children: true });
    void this.cache;
  }
}
