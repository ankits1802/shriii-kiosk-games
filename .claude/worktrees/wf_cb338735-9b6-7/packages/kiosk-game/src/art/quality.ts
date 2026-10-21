/**
 * Rendering quality tiers (KSK-14 low-spec hardening). Selected in config; the engine may step down at
 * runtime when frame timing degrades. Reduced motion is independent of the tier (a11y choice).
 */

/** `high`: every filter (bloom, godrays, grain); `medium`: baked glows, no godrays/grain; `low`: no filters. */
export type QualityTier = 'high' | 'medium' | 'low';

export interface ArtQuality {
  readonly tier: QualityTier;
  /** Minimise motion: no sway/parallax/camera pans, crossfades instead of wipes, few particles. */
  readonly reducedMotion: boolean;
}

/** Concrete switches derived from a quality setting. */
export interface QualityProfile {
  readonly bloom: boolean;
  readonly godrays: boolean;
  readonly grain: boolean;
  readonly colorGrade: boolean;
  readonly softShadows: boolean;
  /** Multiplier on ambient particle counts. */
  readonly particleScale: number;
  /** Multiplier on idle motion amplitudes (sway, flutter, bob). */
  readonly motionScale: number;
  /** Texture bake resolution multiplier. */
  readonly bakeResolution: number;
  readonly birds: boolean;
  readonly cameraMoves: boolean;
}

export const DEFAULT_QUALITY: ArtQuality = { tier: 'high', reducedMotion: false };

/** Resolve tier + reduced-motion into switches. */
export function qualityProfile(q: ArtQuality): QualityProfile {
  const base: Record<QualityTier, QualityProfile> = {
    high: {
      bloom: true,
      godrays: true,
      grain: true,
      colorGrade: true,
      softShadows: true,
      particleScale: 1,
      motionScale: 1,
      bakeResolution: 1,
      birds: true,
      cameraMoves: true,
    },
    medium: {
      bloom: false,
      godrays: false,
      grain: false,
      colorGrade: true,
      softShadows: true,
      particleScale: 0.6,
      motionScale: 1,
      bakeResolution: 1,
      birds: true,
      cameraMoves: true,
    },
    low: {
      bloom: false,
      godrays: false,
      grain: false,
      colorGrade: false,
      softShadows: false,
      particleScale: 0.3,
      motionScale: 0.6,
      bakeResolution: 0.75,
      birds: false,
      cameraMoves: true,
    },
  };
  const p = base[q.tier];
  if (!q.reducedMotion) return p;
  return {
    ...p,
    particleScale: p.particleScale * 0.25,
    motionScale: 0.15,
    birds: false,
    cameraMoves: false,
  };
}

/** Parse a tier from config/env strings, defaulting to `high`. */
export function parseQualityTier(value: string | undefined | null): QualityTier {
  return value === 'medium' || value === 'low' ? value : 'high';
}
