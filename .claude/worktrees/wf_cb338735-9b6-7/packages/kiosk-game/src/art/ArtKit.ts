/**
 * The Mela art kit: implementation of the contract {@link ArtKit} plus extras used by onboarding, the
 * report and the gallery (picture tiles, hand hints, light sweeps, film grain, camera pans).
 *
 * Deliberately no text or number API (ENG-11).
 */
import { type Application, Container, type Ticker } from 'pixi.js';
import type {
  ArtKit,
  Backdrop,
  ButtonSpec,
  CharacterSpec,
  Layout,
  Palette,
  ParticleEmitter,
  ParticleSpec,
  SceneId,
  TimeOfDay,
  TransitionKind,
} from '../core/contracts.ts';
import { MelaBackdrop } from './backdrop/MelaBackdrop.ts';
import { ProceduralCharacter } from './characters/ProceduralCharacter.ts';
import { PooledEmitter } from './fx/particles.ts';
import { FilmGrain } from './fx/post.ts';
import { glowBloom, lightSweep, runTransition, type TransitionHost } from './fx/transitions.ts';
import { unitScale } from './layout.ts';
import { Lighting } from './lighting.ts';
import { motionSettings } from './motion.ts';
import { KIOSK_PALETTE, MELA } from './palettes.ts';
import {
  type ArtQuality,
  DEFAULT_QUALITY,
  type QualityProfile,
  qualityProfile,
} from './quality.ts';
import { TextureCache } from './textures.ts';
import { HandHint, IconButton, PictureTile } from './ui/buttons.ts';
import { drawIcon } from './ui/icons.ts';

export interface ArtKitOptions {
  readonly app: Application;
  readonly layout: Layout;
  readonly quality?: ArtQuality;
  /** Ticker driving ambient animation (default: the app ticker). */
  readonly ticker?: Ticker;
  /** Show film grain over everything (high tier only; default true). */
  readonly grain?: boolean;
}

/** Art kit with extras beyond the contract. */
export class MelaArtKit implements ArtKit {
  readonly palette: Palette = KIOSK_PALETTE;
  readonly lighting = new Lighting();
  readonly cache: TextureCache;
  readonly profile: QualityProfile;
  readonly quality: ArtQuality;
  /** Top-most layer for transitions and hints (kept above module content). */
  readonly overlay = new Container();
  private readonly app: Application;
  private readonly ticker: Ticker;
  private layout: Layout;
  private grain: FilmGrain | null = null;
  private readonly backdrops = new Set<MelaBackdrop>();
  private readonly unsubLayout: () => void;

  constructor(opts: ArtKitOptions) {
    this.app = opts.app;
    this.layout = opts.layout;
    this.quality = opts.quality ?? DEFAULT_QUALITY;
    this.profile = qualityProfile(this.quality);
    this.ticker = opts.ticker ?? opts.app.ticker;
    this.cache = new TextureCache(opts.app.renderer ?? null, this.profile.bakeResolution);
    motionSettings.reducedMotion = this.quality.reducedMotion;
    this.overlay.label = 'art-overlay';
    this.overlay.zIndex = 10_000;
    opts.app.stage.addChild(this.overlay);
    if ((opts.grain ?? true) && this.profile.grain) {
      this.grain = new FilmGrain(this.layout.width, this.layout.height, this.ticker, 0.045);
      this.overlay.addChild(this.grain.view);
    }
    this.unsubLayout = this.layout.onChange((l) => {
      this.layout = l;
      this.grain?.resize(l.width, l.height);
      for (const b of this.backdrops) b.resize(l.width, l.height);
    });
  }

  /** Scale unit (short edge / 1080). */
  get unit(): number {
    return unitScale(this.layout);
  }

  get currentLayout(): Layout {
    return this.layout;
  }

  createBackdrop(sceneId: SceneId, timeOfDay: TimeOfDay): MelaBackdrop & Backdrop {
    const b = new MelaBackdrop(sceneId, timeOfDay, this.layout.width, this.layout.height, {
      cache: this.cache,
      quality: this.profile,
      lighting: this.lighting,
      ticker: this.ticker,
    });
    this.backdrops.add(b);
    const destroy = b.destroy.bind(b);
    b.destroy = () => {
      this.backdrops.delete(b);
      destroy();
    };
    return b;
  }

  createCharacter(spec: CharacterSpec): ProceduralCharacter {
    return new ProceduralCharacter(
      { ...spec, scale: (spec.scale ?? 1) * this.unit },
      { ticker: this.ticker, lighting: this.lighting, quality: this.profile, cache: this.cache },
    );
  }

  createButton(spec: ButtonSpec): IconButton {
    return new IconButton({
      spec,
      metrics: this.layout.metrics,
      reducedMotion: this.quality.reducedMotion,
    });
  }

  createIconButton(
    spec: Omit<ButtonSpec, 'variant'> & { readonly variant?: ButtonSpec['variant'] },
  ): IconButton {
    const variant: ButtonSpec['variant'] =
      spec.variant ??
      (spec.iconId === 'replay'
        ? 'replay'
        : spec.iconId === 'help'
          ? 'help'
          : spec.iconId === 'hand' || spec.iconId === 'exit'
            ? 'exit'
            : 'confirm');
    const face =
      spec.variant === undefined && spec.iconId === 'globe' ? MELA.peacockDeep : undefined;
    return new IconButton({
      spec: { ...spec, variant, sizeMm: spec.sizeMm ?? 22 },
      metrics: this.layout.metrics,
      reducedMotion: this.quality.reducedMotion,
      ...(face !== undefined ? { face } : {}),
    });
  }

  createIcon(iconId: string, sizeMm: number): Container {
    const c = new Container();
    c.addChild(drawIcon(iconId, sizeMm * this.layout.metrics.pxPerMm, MELA.ink));
    return c;
  }

  /** Picture tile for pictorial choices (bands, language faces, survey). */
  createPictureTile(
    id: string,
    pictogram: Container,
    sizeMm: number,
    accent?: number,
  ): PictureTile {
    return new PictureTile({
      id,
      pictogram,
      sizePx: Math.round(sizeMm * this.layout.metrics.pxPerMm),
      ...(accent !== undefined ? { accent } : {}),
      reducedMotion: this.quality.reducedMotion,
    });
  }

  /** Animated hand-pointer hint (practice, first-time prompts). */
  createHandHint(sizeMm = 26): HandHint {
    return new HandHint(sizeMm * this.layout.metrics.pxPerMm, this.quality.reducedMotion);
  }

  createParticles(spec: ParticleSpec): ParticleEmitter {
    return new PooledEmitter(spec, this.cache, this.ticker, this.profile, this.unit);
  }

  transition(
    kind: TransitionKind,
    options?: { readonly durationMs?: number; readonly midpoint?: () => void | Promise<void> },
  ): Promise<void> {
    this.raiseOverlay();
    return runTransition(this.host(), kind, options);
  }

  /** Cinematic diagonal light sweep. */
  lightSweep(durationMs?: number): Promise<void> {
    this.raiseOverlay();
    return lightSweep(this.host(), durationMs);
  }

  /** Golden glow bloom at a point. */
  glow(x: number, y: number, radius: number): Promise<void> {
    this.raiseOverlay();
    return glowBloom(this.host(), x, y, radius);
  }

  /** Keep the overlay above everything added to the stage after it. */
  raiseOverlay(): void {
    if (this.overlay.parent) this.overlay.parent.addChild(this.overlay);
  }

  destroy(): void {
    this.unsubLayout();
    for (const b of [...this.backdrops]) b.destroy();
    this.grain?.destroy();
    this.overlay.destroy({ children: true });
    this.cache.destroy();
  }

  private host(): TransitionHost {
    return {
      overlay: this.overlay,
      width: () => this.layout.width,
      height: () => this.layout.height,
      reducedMotion: this.quality.reducedMotion,
    };
  }
}

/** Create the art kit for an application. */
export function createArtKit(opts: ArtKitOptions): MelaArtKit {
  return new MelaArtKit(opts);
}
