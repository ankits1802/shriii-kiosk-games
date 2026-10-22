/**
 * Shared rendering context for the Road Home view: ticker, one {@link Lighting} for the whole frame,
 * the quality profile (tier + reduced motion), the baked-texture cache and physical sizing. It reuses
 * the session's {@link MelaArtKit} when the engine supplies one (shared light and cache) and builds an
 * equivalent private context otherwise, so the episode looks the same in every host.
 */
import { Container, Sprite, type Texture, type Ticker } from 'pixi.js';
import { MelaArtKit } from '../../../art/ArtKit.ts';
import { ProceduralCharacter, type RigCharacterSpec } from '../../../art/characters/index.ts';
import { PooledEmitter } from '../../../art/fx/particles.ts';
import { fxTexture } from '../../../art/fx/textures.ts';
import { Lighting } from '../../../art/lighting.ts';
import { motionSettings } from '../../../art/motion.ts';
import { DEFAULT_QUALITY, type QualityProfile, qualityProfile } from '../../../art/quality.ts';
import { TextureCache } from '../../../art/textures.ts';
import type { ModuleContext, ParticleKind, Point } from '../../../core/contracts.ts';

export class EpisodeArt {
  readonly ticker: Ticker;
  readonly lighting: Lighting;
  readonly profile: QualityProfile;
  readonly cache: TextureCache;
  readonly reducedMotion: boolean;
  readonly kit: MelaArtKit | null;
  private readonly ownsCache: boolean;
  private width: number;
  private height: number;

  constructor(private readonly ctx: ModuleContext) {
    this.ticker = ctx.app.ticker;
    this.width = ctx.layout.width;
    this.height = ctx.layout.height;
    if (ctx.art instanceof MelaArtKit) {
      this.kit = ctx.art;
      this.lighting = ctx.art.lighting;
      this.profile = ctx.art.profile;
      this.cache = ctx.art.cache;
      this.reducedMotion = ctx.art.quality.reducedMotion;
      this.ownsCache = false;
    } else {
      this.kit = null;
      const q = DEFAULT_QUALITY;
      this.lighting = new Lighting();
      this.profile = qualityProfile(q);
      this.cache = new TextureCache(ctx.app.renderer ?? null, this.profile.bakeResolution);
      this.reducedMotion = q.reducedMotion || motionSettings.reducedMotion;
      this.ownsCache = true;
    }
  }

  get w(): number {
    return this.width;
  }

  get h(): number {
    return this.height;
  }

  /** Short edge / 1080: keeps proportions in both orientations. */
  get unit(): number {
    return Math.min(this.width, this.height) / 1080;
  }

  get portrait(): boolean {
    return this.height > this.width;
  }

  get pxPerMm(): number {
    return this.ctx.layout.metrics.pxPerMm;
  }

  /** Stage pixels for a physical size (touch targets are >= 20 mm, KSK-05). */
  mm(mm: number): number {
    return mm * this.pxPerMm;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** An articulated character sharing the episode light. `scale` multiplies the unit scale. */
  character(spec: RigCharacterSpec): ProceduralCharacter {
    return new ProceduralCharacter(
      { ...spec, scale: (spec.scale ?? 1) * this.unit },
      { ticker: this.ticker, lighting: this.lighting, quality: this.profile, cache: this.cache },
    );
  }

  /** An additive soft glow sprite (radius in px, tinted). */
  glow(radius: number, tint: number, alpha = 1): Sprite {
    const s = new Sprite(this.glowTexture());
    s.anchor.set(0.5);
    s.blendMode = 'add';
    s.tint = tint;
    s.alpha = alpha;
    s.scale.set(radius / 64);
    return s;
  }

  /** A soft dot sprite (radius in px, tinted, normal blend). */
  dot(radius: number, tint: number, alpha = 1): Sprite {
    const s = new Sprite(fxTexture(this.cache, 'soft_dot'));
    s.anchor.set(0.5);
    s.tint = tint;
    s.alpha = alpha;
    s.scale.set(radius / 16);
    return s;
  }

  /** A one-shot particle burst added to `parent` (auto-destroys after `lifeMs`). */
  burst(
    parent: Container,
    kind: ParticleKind,
    origin: Point,
    count?: number,
    lifeMs = 3500,
    tint?: number,
  ): void {
    const e = new PooledEmitter(
      { kind, origin, ...(count !== undefined ? { count } : {}) },
      this.cache,
      this.ticker,
      this.profile,
      this.unit,
    );
    if (tint !== undefined) e.view.tint = tint;
    parent.addChild(e.view);
    // The emitter goes with its parent (a set piece may be released before the burst ends).
    const end = (): void => e.destroy();
    parent.once('destroyed', end);
    setTimeout(() => {
      parent.off('destroyed', end);
      e.destroy();
    }, lifeMs);
  }

  glowTexture(): Texture {
    return fxTexture(this.cache, 'glow');
  }

  /** Bake a drawing into a cached sprite (falls back to the drawing itself without a renderer). */
  bake(key: string, build: () => Container, blur = 0): Container {
    return this.cache.bake(key, build, blur > 0 ? { blur } : {});
  }

  /** Motion amplitude multiplier (sway, bob); near zero under reduced motion. */
  get motion(): number {
    return this.profile.motionScale;
  }

  destroy(): void {
    if (this.ownsCache) this.cache.destroy();
  }
}

/** A container that never intercepts pointer events (all input goes through the input service). */
export function passive(label: string): Container {
  const c = new Container();
  c.label = label;
  c.eventMode = 'none';
  return c;
}

/** True for display objects that keep their own light at night (glows, characters, lit props). */
function isLit(c: Container): boolean {
  return (
    (c as Sprite).blendMode === 'add' ||
    (c.label ?? '').startsWith('character:') ||
    c.label === 'lit'
  );
}

/**
 * Move a set piece's unlit art into a `body` child (index 0) that takes the scene light as a tint,
 * leaving glows, characters (lit by the shared Lighting) and lit props above it untinted.
 */
export function splitLit(view: Container): Container {
  const body = new Container();
  body.label = 'body';
  const kids = [...view.children];
  view.addChildAt(body, 0);
  for (const c of kids) if (!isLit(c)) body.addChild(c);
  return body;
}
