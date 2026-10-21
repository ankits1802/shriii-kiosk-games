/**
 * Art direction kit ("Mela at golden hour"): procedural painterly-vector backdrops, characters, icon
 * buttons, particles and cinematic transitions, plus the <ArtGallery/> dev gallery.
 */
export { type ArtKitOptions, createArtKit, MelaArtKit } from './ArtKit.ts';
export { type BackdropDeps, MelaBackdrop } from './backdrop/MelaBackdrop.ts';
export { SCENE_RECIPES } from './backdrop/scenes.ts';
export {
  type Appearance,
  appearanceFor,
  CHILD_VARIANT,
  GUIDE_APPEARANCE,
  VILLAGERS,
} from './characters/appearance.ts';
export {
  EXPRESSIONS,
  type ExpressionSymbol,
  type ExtendedExpression,
  toneExpression,
} from './characters/expressions.ts';
export { type CharacterDeps, ProceduralCharacter } from './characters/ProceduralCharacter.ts';
export { contrastRatio, deltaE, mixColor, simulateColorBlind } from './color.ts';
export { PooledEmitter } from './fx/particles.ts';
export { addBloom, FilmGrain } from './fx/post.ts';
export { glowBloom, lightSweep, runTransition } from './fx/transitions.ts';
export { ArtGallery, type ArtGalleryProps } from './gallery/ArtGallery.tsx';
export {
  arrangeChoices,
  createViewportLayout,
  DEFAULT_PX_PER_MM,
  mmToPx,
  physicalMetrics,
  safeAreaFor,
  stageBoundsOf,
  staticLayout,
  unitScale,
} from './layout.ts';
export { Lighting } from './lighting.ts';
export { killTweensDeep, motionSettings } from './motion.ts';
export {
  KIOSK_PALETTE,
  MELA,
  type ScenePalette,
  scenePaletteAt,
  TIME_PALETTES,
} from './palettes.ts';
export {
  type ArtQuality,
  DEFAULT_QUALITY,
  parseQualityTier,
  type QualityProfile,
  type QualityTier,
  qualityProfile,
} from './quality.ts';
export { TextureCache } from './textures.ts';
export { BUTTON_TOKENS, HandHint, type HintKind, IconButton, PictureTile } from './ui/buttons.ts';
export { drawIcon, ICONS, iconIds } from './ui/icons.ts';
