/**
 * Texture cache: complex vector art (stalls, trees, clouds, characters' static parts) is drawn once with
 * Pixi Graphics and baked to a GPU texture, then reused as Sprites. Baking keeps the frame cost of a busy
 * fair to a few hundred textured quads (60 fps target on modest kiosk hardware, KSK-14).
 *
 * Without a renderer (unit tests, headless bots) the built display object itself is returned, so the
 * same scene code runs everywhere.
 */
import {
  BlurFilter,
  type Container,
  Container as PixiContainer,
  Rectangle,
  type Renderer,
  Sprite,
  type Texture,
} from 'pixi.js';

export interface BakeOptions {
  /** Transparent padding around the bounds (px), needed for blur/glow filters. */
  readonly padding?: number;
  /** Texture resolution multiplier (default: renderer resolution x tier bake factor). */
  readonly resolution?: number;
  /** Gaussian softening applied before baking (painterly edges / depth of field). */
  readonly blur?: number;
}

/** Baked-art cache keyed by a stable string (include every parameter that changes the drawing). */
export class TextureCache {
  private readonly textures = new Map<string, { texture: Texture; x: number; y: number }>();

  constructor(
    private readonly renderer: Renderer | null,
    private readonly resolutionScale = 1,
  ) {}

  /** True when baking to GPU textures is possible. */
  get canBake(): boolean {
    return this.renderer !== null;
  }

  /** Number of cached textures (diagnostics/tests). */
  get size(): number {
    return this.textures.size;
  }

  /**
   * Return a display object for `key`: a Sprite of the cached texture (built on first use), positioned
   * so its local origin matches the origin of the drawing `build()` returns.
   */
  bake(key: string, build: () => Container, options: BakeOptions = {}): Container {
    const cached = this.textures.get(key);
    if (cached) return this.spriteOf(cached);
    const drawing = build();
    if (!this.renderer) {
      if (options.blur && options.blur > 0)
        drawing.filters = [new BlurFilter({ strength: options.blur, quality: 3 })];
      return drawing;
    }
    const pad = options.padding ?? (options.blur ? Math.ceil(options.blur * 3) : 2);
    const holder = new PixiContainer();
    holder.addChild(drawing);
    if (options.blur && options.blur > 0) {
      drawing.filters = [new BlurFilter({ strength: options.blur, quality: 4 })];
    }
    const b = drawing.getLocalBounds();
    const frame = new Rectangle(
      Math.floor(b.x - pad),
      Math.floor(b.y - pad),
      Math.ceil(b.width + pad * 2),
      Math.ceil(b.height + pad * 2),
    );
    const resolution = options.resolution ?? (this.renderer.resolution || 1) * this.resolutionScale;
    const texture = this.renderer.generateTexture({
      target: holder,
      frame,
      resolution,
      antialias: true,
    });
    holder.destroy({ children: true });
    const entry = { texture, x: frame.x, y: frame.y };
    this.textures.set(key, entry);
    return this.spriteOf(entry);
  }

  /** Raw cached texture for particle systems (built on first use, origin at the texture centre). */
  texture(key: string, build: () => Container, options: BakeOptions = {}): Texture | null {
    if (!this.renderer) return null;
    if (!this.textures.has(key)) this.bake(key, build, options).destroy();
    return this.textures.get(key)?.texture ?? null;
  }

  /** Drop textures whose key starts with `prefix` (e.g. on layout resize). */
  evict(prefix: string): void {
    for (const [k, v] of this.textures) {
      if (k.startsWith(prefix)) {
        v.texture.destroy(true);
        this.textures.delete(k);
      }
    }
  }

  /** Destroy every cached texture. */
  destroy(): void {
    for (const v of this.textures.values()) v.texture.destroy(true);
    this.textures.clear();
  }

  private spriteOf(entry: { texture: Texture; x: number; y: number }): Container {
    const wrap = new PixiContainer();
    const s = new Sprite(entry.texture);
    s.position.set(entry.x, entry.y);
    wrap.addChild(s);
    return wrap;
  }
}
