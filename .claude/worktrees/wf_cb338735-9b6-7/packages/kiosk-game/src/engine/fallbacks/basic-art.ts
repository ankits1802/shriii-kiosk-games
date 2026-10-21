/**
 * Minimal Pixi {@link ArtKit} used when the full art kit (src/art) is not injected: flat shapes in
 * the colour-blind-safe palette, no text and no numerals (ENG-11). It exists so the engine and the
 * generic fallback module render something sensible in isolation; production uses the art kit.
 */
import { Container, Graphics } from 'pixi.js';
import type {
  ArtKit,
  Backdrop,
  ButtonSpec,
  Character,
  CharacterSpec,
  Layout,
  Palette,
  ParticleEmitter,
  ParticleSpec,
  SceneId,
  TimeOfDay,
  TransitionKind,
  UiButton,
} from '../../core/contracts.ts';

export const BASIC_PALETTE: Palette = {
  sky: 0xf6c56b,
  sun: 0xffd166,
  earth: 0xb8643c,
  foliage: 0x2a9d8f,
  accentA: 0x0072b2,
  accentB: 0xe69f00,
  accentC: 0xcc79a7,
  ink: 0x1d1d1b,
  paper: 0xfff8ec,
  confirm: 0x009e73,
  cancel: 0xd55e00,
};

const SKY: Readonly<Record<TimeOfDay, number>> = {
  morning: 0xfde2a7,
  midday: 0xf6c56b,
  golden_hour: 0xf0a35e,
  dusk: 0x8a5a83,
};

function iconGlyph(g: Graphics, iconId: string, r: number, color: number): void {
  switch (iconId) {
    case 'tick':
    case 'confirm':
      g.moveTo(-r * 0.5, 0)
        .lineTo(-r * 0.1, r * 0.4)
        .lineTo(r * 0.55, -r * 0.4)
        .stroke({ width: r * 0.18, color });
      break;
    case 'cross':
    case 'cancel':
      g.moveTo(-r * 0.4, -r * 0.4)
        .lineTo(r * 0.4, r * 0.4)
        .moveTo(r * 0.4, -r * 0.4)
        .lineTo(-r * 0.4, r * 0.4)
        .stroke({ width: r * 0.18, color });
      break;
    default:
      // A hand-like blob: palm and four fingers.
      g.roundRect(-r * 0.35, -r * 0.1, r * 0.7, r * 0.6, r * 0.2).fill(color);
      for (let i = 0; i < 4; i += 1)
        g.roundRect(-r * 0.35 + i * r * 0.18, -r * 0.5, r * 0.14, r * 0.5, r * 0.07).fill(color);
  }
}

export class BasicArtKit implements ArtKit {
  readonly palette = BASIC_PALETTE;
  private readonly layout: Layout;
  private readonly overlay: Container;

  constructor(layout: Layout, overlay: Container) {
    this.layout = layout;
    this.overlay = overlay;
  }

  createBackdrop(sceneId: SceneId, timeOfDay: TimeOfDay): Backdrop {
    const view = new Container();
    const g = new Graphics();
    const draw = (tod: TimeOfDay): void => {
      g.clear();
      g.rect(0, 0, this.layout.width, this.layout.height * 0.65).fill(SKY[tod]);
      g.rect(0, this.layout.height * 0.65, this.layout.width, this.layout.height * 0.35).fill(
        BASIC_PALETTE.earth,
      );
    };
    draw(timeOfDay);
    view.addChild(g);
    return {
      view,
      sceneId,
      setTimeOfDay: async (tod) => draw(tod),
      setParallax: (offset) => {
        g.x = offset * 8;
      },
      destroy: () => view.destroy({ children: true }),
    };
  }

  createCharacter(spec: CharacterSpec): Character {
    const view = new Container();
    const body = new Graphics();
    const r = 40 * (spec.scale ?? 1);
    body.circle(0, -r * 2.2, r * 0.7).fill(0x8d5524);
    body.roundRect(-r * 0.8, -r * 1.5, r * 1.6, r * 2, r * 0.4).fill(BASIC_PALETTE.accentA);
    view.addChild(body);
    return {
      view,
      spec,
      setExpression: () => undefined,
      speak: async (playback) => {
        await playback.ended;
      },
      play: async () => undefined,
      lookAt: () => undefined,
      destroy: () => view.destroy({ children: true }),
    };
  }

  createButton(spec: ButtonSpec): UiButton {
    const view = new Container();
    const g = new Graphics();
    const size = (spec.sizeMm ?? 24) * this.layout.metrics.pxPerMm;
    const fill =
      spec.variant === 'confirm'
        ? BASIC_PALETTE.confirm
        : spec.variant === 'cancel'
          ? BASIC_PALETTE.cancel
          : BASIC_PALETTE.accentA;
    g.circle(0, 0, size / 2)
      .fill(fill)
      .stroke({ width: size * 0.06, color: BASIC_PALETTE.paper });
    iconGlyph(g, spec.iconId, size / 2, BASIC_PALETTE.paper);
    view.addChild(g);
    let pulseTimer: ReturnType<typeof setInterval> | null = null;
    return {
      view,
      targetId: spec.id,
      setEnabled: (enabled) => {
        view.alpha = enabled ? 1 : 0.4;
      },
      pulse: () => {
        if (pulseTimer) return;
        let up = true;
        // 1 Hz pulse (well under the 3 Hz flashing limit, KSK-05).
        pulseTimer = setInterval(() => {
          view.scale.set(up ? 1.06 : 1);
          up = !up;
        }, 500);
      },
      destroy: () => {
        if (pulseTimer) clearInterval(pulseTimer);
        view.destroy({ children: true });
      },
    };
  }

  createIconButton(
    spec: Omit<ButtonSpec, 'variant'> & { readonly variant?: ButtonSpec['variant'] },
  ): UiButton {
    return this.createButton({ ...spec, variant: spec.variant ?? 'secondary' });
  }

  createIcon(iconId: string, sizeMm: number): Container {
    const g = new Graphics();
    iconGlyph(g, iconId, (sizeMm * this.layout.metrics.pxPerMm) / 2, BASIC_PALETTE.ink);
    const c = new Container();
    c.addChild(g);
    return c;
  }

  createParticles(_spec: ParticleSpec): ParticleEmitter {
    const view = new Container();
    return { view, burst: () => undefined, stop: () => undefined, destroy: () => view.destroy() };
  }

  async transition(
    _kind: TransitionKind,
    options: { readonly durationMs?: number; readonly midpoint?: () => void | Promise<void> } = {},
  ): Promise<void> {
    const veil = new Graphics()
      .rect(0, 0, this.layout.width, this.layout.height)
      .fill(BASIC_PALETTE.ink);
    veil.alpha = 0;
    this.overlay.addChild(veil);
    const half = (options.durationMs ?? 400) / 2;
    const fade = (from: number, to: number): Promise<void> =>
      new Promise((resolve) => {
        const start = performance.now();
        const step = (): void => {
          const k = Math.min(1, (performance.now() - start) / half);
          veil.alpha = from + (to - from) * k;
          if (k < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    await fade(0, 1);
    await options.midpoint?.();
    await fade(1, 0);
    veil.destroy();
  }
}
