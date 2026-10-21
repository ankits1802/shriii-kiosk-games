/**
 * Post effects: animated film grain (a tiny baked noise tile jittered every frame; far cheaper than a
 * full-screen noise filter) and an optional bloom filter for glowing hero moments (high tier only).
 */

import { type Container, Texture, type Ticker, TilingSprite } from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters';
import { ArtRandom } from '../rand.ts';

/** Film-grain overlay sized to the stage. */
export class FilmGrain {
  readonly view: TilingSprite;
  private readonly rnd = new ArtRandom('grain');
  private frame = 0;
  private readonly onTick = (): void => {
    // Re-seed the tile offset every other frame (~30 Hz shimmer, low contrast; not a flash).
    this.frame++;
    if (this.frame % 2 === 0) {
      this.view.tilePosition.set(this.rnd.int(0, 255), this.rnd.int(0, 255));
    }
  };

  constructor(
    width: number,
    height: number,
    private readonly ticker: Ticker,
    strength = 0.06,
  ) {
    this.view = new TilingSprite({ texture: FilmGrain.noiseTexture(), width, height });
    this.view.alpha = strength;
    this.view.eventMode = 'none';
    this.view.label = 'film-grain';
    ticker.add(this.onTick);
  }

  resize(width: number, height: number): void {
    this.view.width = width;
    this.view.height = height;
  }

  destroy(): void {
    this.ticker.remove(this.onTick);
    this.view.destroy();
  }

  private static cached: Texture | null = null;

  /** 256x256 luminance noise generated on a canvas (Texture.WHITE without a DOM). */
  static noiseTexture(): Texture {
    if (FilmGrain.cached) return FilmGrain.cached;
    if (typeof document === 'undefined') return Texture.WHITE;
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext('2d');
    if (!ctx) return Texture.WHITE;
    const img = ctx.createImageData(256, 256);
    const r = new ArtRandom('noise');
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.floor(96 + r.next() * 160);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    FilmGrain.cached = Texture.from(c);
    return FilmGrain.cached;
  }
}

/** Attach a soft bloom to a container (hero moments; high tier). Returns a remover. */
export function addBloom(target: Container, strength = 0.6): () => void {
  const f = new AdvancedBloomFilter({
    threshold: 0.55,
    bloomScale: strength,
    brightness: 1,
    blur: 6,
    quality: 4,
  });
  const prev = target.filters;
  target.filters = [...(Array.isArray(prev) ? prev : prev ? [prev] : []), f];
  return () => {
    const cur = target.filters;
    target.filters = (Array.isArray(cur) ? cur : cur ? [cur] : []).filter((x) => x !== f);
    f.destroy();
  };
}
