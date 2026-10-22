/**
 * Visual scaffolding shared by the set-2 micro-game scenes and the carousel hub: a camera-driven
 * world (backdrop, props, actors, world FX) under a screen-space UI layer and overlay, with
 * reduced-motion-aware camera moves, characters from the art kit, particle bursts, fireflies and
 * floating dust, a soft vignette, and the hand hint.
 *
 * Only instantiated when a renderer is attached (see `GameRuntime.visual`); logic never depends on it.
 * Rendering never gates measurement: callers fire camera moves and effects without awaiting them on
 * the timing path, and stimuli are committed through `ActiveTrial.present`.
 */
import { gsap } from 'gsap';
import { Container, Graphics, Sprite, Texture, type Ticker } from 'pixi.js';
import { MelaArtKit } from '../../../art/ArtKit.ts';
import type { RigCharacterSpec } from '../../../art/characters/ProceduralCharacter.ts';
import { ProceduralCharacter } from '../../../art/characters/ProceduralCharacter.ts';
import { rgba, rgrad } from '../../../art/draw.ts';
import { fxTexture } from '../../../art/fx/textures.ts';
import { motionSettings } from '../../../art/motion.ts';
import type { HintKind } from '../../../art/ui/buttons.ts';
import type {
  ArtKit,
  Backdrop,
  Character,
  ModuleContext,
  ParticleKind,
  Point,
  Rect,
  SceneId,
  SfxId,
  SfxOptions,
  TimeOfDay,
} from '../../../core/contracts.ts';
/**
 * What a stage needs from its owner: the shared Pixi app, the module's root container, layout, art
 * kit and an SFX hook. `GameRuntime` satisfies it; the carousel hub provides its own.
 */
export interface StageHost {
  readonly ctx: {
    readonly app: unknown;
    readonly stage: Container;
    readonly layout: ModuleContext['layout'];
    readonly art: ArtKit;
  };
  readonly moduleId: string;
  sfx(id: SfxId, options?: SfxOptions): void;
}

/** Camera framing: world point at screen centre plus zoom. */
export interface CameraShot {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

interface HandHintLike {
  readonly view: Container;
  show(kind: HintKind, target: Point, holdMs?: number): void;
  stop(): void;
  destroy(): void;
}

/** Drifting, softly pulsing fireflies (pulse < 1 Hz, far below the 3 Hz flash limit). */
export class Fireflies {
  readonly view = new Container();
  private readonly flies: {
    s: Sprite;
    x: number;
    y: number;
    phase: number;
    speed: number;
    amp: number;
  }[] = [];
  private t = 0;
  private readonly tick = (tk: Ticker): void => this.update(Math.min(0.05, tk.deltaMS / 1000));

  constructor(
    private readonly ticker: Ticker,
    texture: Sprite['texture'],
    region: Rect,
    count: number,
    size: number,
    seed = 7,
    color = 0xfff3a0,
  ) {
    this.view.eventMode = 'none';
    let r = seed * 9301 + 49297;
    const rand = (): number => {
      r = (r * 9301 + 49297) % 233280;
      return r / 233280;
    };
    for (let i = 0; i < count; i++) {
      const s = new Sprite(texture);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      s.tint = color;
      const k = 0.5 + rand() * 0.8;
      s.scale.set((size * k) / 64);
      const f = {
        s,
        x: region.x + rand() * region.width,
        y: region.y + rand() * region.height,
        phase: rand() * Math.PI * 2,
        speed: 0.25 + rand() * 0.5,
        amp: size * (1.5 + rand() * 3),
      };
      s.position.set(f.x, f.y);
      this.flies.push(f);
      this.view.addChild(s);
    }
    ticker.add(this.tick);
  }

  set intensity(v: number) {
    this.view.alpha = Math.max(0, Math.min(1, v));
  }

  private update(dt: number): void {
    this.t += dt * Math.max(0.15, motionSettings.reducedMotion ? 0.15 : 1);
    for (const f of this.flies) {
      const a = this.t * f.speed + f.phase;
      f.s.x = f.x + Math.sin(a) * f.amp;
      f.s.y = f.y + Math.cos(a * 0.7) * f.amp * 0.6;
      f.s.alpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(a * 2.1));
    }
  }

  destroy(): void {
    this.ticker.remove(this.tick);
    this.view.destroy({ children: true });
  }
}

export class GameStage {
  readonly root = new Container();
  /** World under the camera transform. */
  readonly camera = new Container();
  readonly backLayer = new Container();
  readonly propLayer = new Container();
  readonly actorLayer = new Container();
  readonly frontLayer = new Container();
  readonly worldFx = new Container();
  /** Screen-space layers. */
  readonly ui = new Container();
  readonly uiFx = new Container();
  readonly overlay = new Container();
  readonly art: ArtKit;
  /** The rich art kit when available (lighting, glow, hand hints, picture tiles). */
  readonly mela: MelaArtKit | null;
  readonly width: number;
  readonly height: number;
  readonly portrait: boolean;
  readonly pxPerMm: number;
  /** Scale unit: short edge / 1080. */
  readonly u: number;
  backdrop: Backdrop | null = null;
  private hint: HandHintLike | null = null;
  private readonly owned: { destroy(): void }[] = [];
  private shot: CameraShot;
  private destroyed = false;
  private readonly ticker: Ticker;

  constructor(
    readonly rt: StageHost,
    options: { readonly sceneId: SceneId | null; readonly timeOfDay: TimeOfDay },
  ) {
    const { ctx } = rt;
    this.art = ctx.art;
    this.mela = ctx.art instanceof MelaArtKit ? ctx.art : null;
    this.width = ctx.layout.width;
    this.height = ctx.layout.height;
    this.portrait = ctx.layout.orientation === 'portrait';
    this.pxPerMm = ctx.layout.metrics.pxPerMm;
    this.u = Math.min(this.width, this.height) / 1080;
    this.ticker = (ctx.app as { ticker: Ticker }).ticker;
    this.root.label = `${rt.moduleId}:stage`;
    this.camera.label = 'camera';
    this.camera.addChild(
      this.backLayer,
      this.propLayer,
      this.actorLayer,
      this.frontLayer,
      this.worldFx,
    );
    this.actorLayer.sortableChildren = true;
    this.root.addChild(this.camera, this.ui, this.uiFx, this.overlay);
    this.ui.sortableChildren = true;
    for (const l of [this.worldFx, this.uiFx, this.overlay]) l.eventMode = 'none';
    ctx.stage.addChild(this.root);
    this.shot = { x: this.width / 2, y: this.height / 2, zoom: 1 };
    this.applyShot(this.shot);
    if (options.sceneId) {
      const b = ctx.art.createBackdrop(options.sceneId, options.timeOfDay);
      this.backdrop = b;
      this.backLayer.addChild(b.view);
    }
  }

  /** Physical millimetres to stage px. */
  mm(v: number): number {
    return v * this.pxPerMm;
  }

  /** Whether camera moves and ambient motion are allowed (quality tier and reduced motion). */
  get motion(): boolean {
    return !motionSettings.reducedMotion && (this.mela?.profile.cameraMoves ?? true);
  }

  get currentShot(): CameraShot {
    return this.shot;
  }

  /**
   * Keep the view inside the painted world: with zoom >= 1 the visible window never crosses the
   * backdrop's edges (no bare seams at the sides); zoomed out, the camera stays centred.
   */
  clampShot(s: CameraShot): CameraShot {
    const W = this.width;
    const H = this.height;
    const zoom = s.zoom;
    if (zoom <= 1) return { x: W / 2, y: H / 2, zoom };
    const hx = W / (2 * zoom);
    const hy = H / (2 * zoom);
    return {
      x: Math.min(W - hx, Math.max(hx, s.x)),
      y: Math.min(H - hy, Math.max(hy, s.y)),
      zoom,
    };
  }

  private applyShot(s: CameraShot): void {
    this.camera.pivot.set(s.x, s.y);
    this.camera.position.set(this.width / 2, this.height / 2);
    this.camera.scale.set(s.zoom);
  }

  /** Move the camera (eased); instant under reduced motion. Never await this on a timing path. */
  cameraTo(requested: CameraShot, seconds = 1.6, ease = 'power2.inOut'): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const from = { ...this.shot };
    const shot = this.clampShot(requested);
    this.shot = shot;
    if (!this.motion || seconds <= 0) {
      this.applyShot(shot);
      return Promise.resolve();
    }
    gsap.killTweensOf(from);
    return new Promise((resolve) => {
      gsap.to(from, {
        x: shot.x,
        y: shot.y,
        zoom: shot.zoom,
        duration: seconds,
        ease,
        onUpdate: () => {
          // Mid-move frames (zoom and position eased separately) are clamped too.
          if (!this.destroyed) this.applyShot(this.clampShot(from));
        },
        onComplete: () => resolve(),
        onInterrupt: () => resolve(),
      });
    });
  }

  /** Map a world point to screen space under the current (final) camera shot. */
  toScreen(p: Point): Point {
    const s = this.shot;
    return {
      x: (p.x - s.x) * s.zoom + this.width / 2,
      y: (p.y - s.y) * s.zoom + this.height / 2,
    };
  }

  /** Create a character from the art kit and add it to the actor layer. */
  character(spec: RigCharacterSpec, at: Point, layer: Container = this.actorLayer): Character {
    const c = this.art.createCharacter(spec);
    c.view.position.set(at.x, at.y);
    c.view.zIndex = at.y;
    layer.addChild(c.view);
    this.owned.push(c);
    return c;
  }

  /** The rig character when available (gestures, held items, walking). */
  rig(c: Character): ProceduralCharacter | null {
    return c instanceof ProceduralCharacter ? c : null;
  }

  /** Fire-and-forget particle burst (auto-destroyed). */
  burst(
    kind: ParticleKind,
    at: Point,
    count?: number,
    layer: Container = this.uiFx,
    lifeMs = 3200,
  ): void {
    if (this.destroyed) return;
    const fx = this.art.createParticles({ kind, origin: at, ...(count ? { count } : {}) });
    layer.addChild(fx.view);
    this.owned.push(fx);
    setTimeout(() => fx.destroy(), lifeMs);
  }

  /** Continuous emitter for `durationMs` (auto-destroyed after it fades). */
  stream(
    kind: ParticleKind,
    at: Point,
    count: number,
    durationMs: number,
    layer?: Container,
  ): void {
    if (this.destroyed) return;
    const fx = this.art.createParticles({ kind, origin: at, count, durationMs });
    (layer ?? this.worldFx).addChild(fx.view);
    this.owned.push(fx);
    setTimeout(() => fx.destroy(), durationMs + 3500);
  }

  /** Fireflies drifting over a region (world space by default). */
  fireflies(
    region: Rect,
    count: number,
    layer: Container = this.worldFx,
    color?: number,
  ): Fireflies | null {
    if (!this.mela) return null;
    const scaled = Math.max(
      3,
      Math.round(
        count * (this.mela.profile.particleScale > 0 ? this.mela.profile.particleScale : 0.3),
      ),
    );
    const f = new Fireflies(
      this.ticker,
      fxTexture(this.mela.cache, 'glow'),
      region,
      scaled,
      this.mm(3.2),
      Math.round(region.x + region.y),
      color,
    );
    layer.addChild(f.view);
    this.owned.push(f);
    return f;
  }

  /** Soft radial glow sprite (additive) for lamps, pots and highlights. */
  glowSprite(radius: number, color: number, alpha = 0.8): Sprite {
    const tex = this.mela ? fxTexture(this.mela.cache, 'glow') : null;
    const s = tex ? new Sprite(tex) : new Sprite();
    s.anchor.set(0.5);
    s.blendMode = 'add';
    s.tint = color;
    s.alpha = alpha;
    s.scale.set(radius / 64);
    s.eventMode = 'none';
    return s;
  }

  /**
   * Screen-space vignette that calms the periphery (private corners, focus moments): a clear centre
   * falling off to `color` at the corners. Drawn once into a small canvas texture and stretched over the
   * screen (one sprite, no per-frame gradient cost). Falls back to a live gradient where no 2D canvas
   * exists.
   */
  vignette(strength: number, color = 0x140c1c): Container {
    const W = this.width;
    const H = this.height;
    const cx = 0.5;
    const cy = 0.55;
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const ctx = canvas?.getContext('2d') ?? null;
    let v: Container;
    if (canvas && ctx) {
      const cw = 320;
      const ch = Math.max(1, Math.round((cw * H) / W));
      canvas.width = cw;
      canvas.height = ch;
      const r = Math.hypot(cw, ch) / 2;
      const rgb = `${(color >> 16) & 255}, ${(color >> 8) & 255}, ${color & 255}`;
      const grad = ctx.createRadialGradient(cw * cx, ch * cy, 0, cw * cx, ch * cy, r * 1.05);
      grad.addColorStop(0, `rgba(${rgb}, 0)`);
      grad.addColorStop(0.55, `rgba(${rgb}, 0)`);
      grad.addColorStop(0.8, `rgba(${rgb}, 0.55)`);
      grad.addColorStop(1, `rgba(${rgb}, 1)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cw, ch);
      const tex = Texture.from(canvas);
      const sprite = new Sprite(tex);
      sprite.width = W;
      sprite.height = H;
      this.owned.push({ destroy: () => tex.destroy(true) });
      v = sprite;
    } else {
      const g = new Graphics();
      g.rect(0, 0, W, H).fill(
        rgrad(
          [
            [0, rgba(color, 0)],
            [0.55, rgba(color, 0)],
            [1, rgba(color, 1)],
          ],
          { x: cx, y: cy },
          (Math.hypot(W, H) / 2 / Math.max(W, H)) * 1.05,
        ),
      );
      v = g;
    }
    v.alpha = strength;
    v.eventMode = 'none';
    this.overlay.addChild(v);
    return v;
  }

  /** Warm pool of light on the ground (additive glow sprite, elliptical). */
  lightPool(rx: number, ry: number, color = 0xffd27a, alpha = 0.7): Sprite {
    const s = this.glowSprite(rx, color, alpha);
    s.scale.set(rx / 64, ry / 64);
    return s;
  }

  /** Show the animated hand hint at a screen point. */
  showHint(kind: HintKind, at: Point, holdMs?: number): void {
    if (!this.mela) return;
    if (!this.hint) {
      this.hint = this.mela.createHandHint();
    }
    this.ui.addChild(this.hint.view);
    this.hint.view.zIndex = 9000;
    this.hint.show(kind, at, holdMs);
  }

  hideHint(): void {
    this.hint?.stop();
  }

  /** Golden bloom at a screen point (art-kit overlay). */
  glow(at: Point, radius: number): void {
    void this.mela?.glow(at.x, at.y, radius);
  }

  /** Take ownership of an object destroyed with the stage. */
  own<T extends { destroy(): void }>(o: T): T {
    this.owned.push(o);
    return o;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hint?.destroy();
    for (const o of this.owned.splice(0).reverse()) {
      try {
        o.destroy();
      } catch {
        // already gone
      }
    }
    gsap.killTweensOf(this.camera);
    this.backdrop?.destroy();
    if (!this.root.destroyed) {
      this.root.removeFromParent();
      this.root.destroy({ children: true });
    }
  }
}
