/**
 * Baked particle and glow textures (built once per art kit, shared by every emitter and backdrop).
 * Each is drawn white or in fixed colours so sprites can be tinted.
 */
import { Graphics, Texture } from 'pixi.js';
import { rgrad } from '../draw.ts';
import type { TextureCache } from '../textures.ts';

export type FxTextureId =
  | 'soft_dot'
  | 'glow'
  | 'petal'
  | 'confetti'
  | 'leaf'
  | 'coin'
  | 'smoke'
  | 'sparkle'
  | 'disc'
  | 'ring';

const BUILDERS: Record<FxTextureId, () => Graphics> = {
  soft_dot: () =>
    new Graphics().circle(0, 0, 16).fill(
      rgrad([
        [0, '#ffffffff'],
        [0.4, '#ffffffaa'],
        [1, '#ffffff00'],
      ]),
    ),
  glow: () =>
    new Graphics().circle(0, 0, 64).fill(
      rgrad([
        [0, '#ffffffff'],
        [0.15, '#ffffffcc'],
        [0.45, '#ffffff44'],
        [1, '#ffffff00'],
      ]),
    ),
  petal: () =>
    new Graphics()
      .moveTo(0, -12)
      .bezierCurveTo(9, -8, 8, 6, 0, 12)
      .bezierCurveTo(-8, 6, -9, -8, 0, -12)
      .fill(0xffffff)
      .moveTo(0, -10)
      .lineTo(0, 10)
      .stroke({ width: 1.2, color: 0xdddddd, alpha: 0.8 }),
  confetti: () => new Graphics().rect(-7, -3.5, 14, 7).fill(0xffffff),
  leaf: () =>
    new Graphics()
      .moveTo(0, -14)
      .bezierCurveTo(8, -6, 7, 8, 0, 14)
      .bezierCurveTo(-7, 8, -8, -6, 0, -14)
      .fill(0xffffff)
      .moveTo(0, -12)
      .lineTo(0, 12)
      .stroke({ width: 1.4, color: 0xcccccc }),
  coin: () =>
    new Graphics()
      .circle(0, 0, 14)
      .fill(0xe0a82e)
      .circle(0, 0, 11)
      .fill(0xf5d47a)
      .circle(0, 0, 4)
      .fill(0xc98f1e)
      .ellipse(-4, -5, 3, 2)
      .fill({ color: 0xffffff, alpha: 0.7 }),
  smoke: () =>
    new Graphics().circle(0, 0, 32).fill(
      rgrad([
        [0, '#ffffff99'],
        [0.6, '#ffffff33'],
        [1, '#ffffff00'],
      ]),
    ),
  sparkle: () => {
    const g = new Graphics();
    g.poly([0, -18, 3.5, -3.5, 18, 0, 3.5, 3.5, 0, 18, -3.5, 3.5, -18, 0, -3.5, -3.5]).fill(
      0xffffff,
    );
    g.circle(0, 0, 5).fill(0xffffff);
    return g;
  },
  disc: () => new Graphics().circle(0, 0, 32).fill(0xffffff),
  ring: () => new Graphics().circle(0, 0, 60).stroke({ width: 6, color: 0xffffff }),
};

/** Get (or bake) an FX texture; falls back to Texture.WHITE without a renderer. */
export function fxTexture(cache: TextureCache, id: FxTextureId): Texture {
  return cache.texture(`fx:${id}`, BUILDERS[id], { padding: 2 }) ?? Texture.WHITE;
}

/** Natural radius in px of each FX texture (for scaling sprites to a target size). */
export const FX_RADIUS: Readonly<Record<FxTextureId, number>> = {
  soft_dot: 16,
  glow: 64,
  petal: 12,
  confetti: 7,
  leaf: 14,
  coin: 14,
  smoke: 32,
  sparkle: 18,
  disc: 32,
  ring: 63,
};
