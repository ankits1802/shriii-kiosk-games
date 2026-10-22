/**
 * Shared staging for onboarding, survey and opt-in screens: backdrop + guide + a UI layer, spoken lines
 * with lip-sync, targets registered with the input service at their exact stage bounds, hand hints,
 * and a content area that adapts to landscape and portrait. Screens stay short and declarative.
 */
import { Container, Graphics } from 'pixi.js';
import { killTweensDeep } from '../art/motion.ts';
import type { HintKind } from '../art/ui/buttons.ts';
import type {
  ButtonSpec,
  EventLogger,
  LineId,
  Point,
  Rect,
  SceneId,
  TapResult,
  TargetHandle,
  TimeOfDay,
  VoicePlaybackResult,
} from '../core/contracts.ts';
import type {
  HandHintLike,
  OnboardingConfig,
  OnboardingServices,
  RichBackdrop,
  RichCharacter,
  SizedButton,
} from './types.ts';

/** Stage-pixel bounds of a sized button (centre +- half the physical edge, world scale applied). */
export function boundsOfButton(btn: SizedButton): Rect {
  const p = btn.view.toGlobal({ x: 0, y: 0 });
  const s = btn.sizePx * Math.abs(btn.view.worldTransform.a || 1);
  return { x: p.x - s / 2, y: p.y - s / 2, width: s, height: s };
}

interface Registered {
  readonly button: SizedButton;
  readonly handle: TargetHandle;
}

/**
 * Thrown by {@link ScreenKit.ensureActive} after the session signal aborted or the kit was destroyed.
 * It is an expected abort, not a failure: `isAbort` makes `isAbortError()` (core/contracts) recognise
 * it, so the session controller treats it as a normal abort and never as a crash.
 */
export class ScreenAbortedError extends Error {
  readonly isAbort = true as const;
  constructor() {
    super('screen aborted');
    this.name = 'ScreenAbortedError';
  }
}

export class ScreenKit {
  readonly root = new Container();
  readonly world = new Container();
  readonly ui = new Container();
  readonly logger: EventLogger;
  backdrop: RichBackdrop | null = null;
  guide: RichCharacter | null = null;
  private readonly registered = new Map<string, Registered>();
  private readonly owned: RichCharacter[] = [];
  private hint: HandHintLike | null = null;
  private destroyed = false;

  constructor(
    readonly services: OnboardingServices,
    readonly config: OnboardingConfig,
  ) {
    this.root.label = 'onboarding';
    this.root.addChild(this.world, this.ui);
    services.stage.addChild(this.root);
    // Onboarding events are session-level and never scorable (ONB-05/ENG-07).
    this.logger = services.logger.child({ task: null, condition: null, scorable: false });
  }

  get width(): number {
    return this.services.layout.width;
  }

  get height(): number {
    return this.services.layout.height;
  }

  get portrait(): boolean {
    return this.services.layout.orientation === 'portrait';
  }

  /** Physical mm to stage px. */
  mm(mm: number): number {
    return mm * this.services.layout.metrics.pxPerMm;
  }

  /** Position of the globe (language) button: bottom-left in landscape, bottom-right in portrait. */
  globePos(): { x: number; y: number } {
    return {
      x: this.portrait ? this.width - this.mm(20) : this.mm(20),
      y: this.height - this.mm(20),
    };
  }

  /** Where interactive content goes (lower two-thirds, right of the guide in landscape). */
  contentRect(): Rect {
    const sa = this.services.layout.safeArea;
    if (this.portrait)
      return {
        x: sa.x,
        y: Math.max(sa.y, this.height * 0.42),
        width: sa.width,
        height: sa.y + sa.height - Math.max(sa.y, this.height * 0.42),
      };
    const left = this.width * 0.3;
    // Keep clear of the persistent hand (exit) control in the top-right corner (ONB-06, 22 mm + gap).
    const exitClear = this.mm(32);
    return {
      x: left,
      y: sa.y,
      width: Math.max(1, sa.x + sa.width - left - exitClear),
      height: sa.height,
    };
  }

  /**
   * Soft focus panel behind the interactive content: a warm, translucent dusk-coloured glow that calms
   * the busy fair behind pictures and buttons (legibility, KSK-06 contrast).
   */
  focusPanel(rect: Rect = this.contentRect()): Container {
    const c = new Container();
    const g = new Graphics();
    const pad = this.mm(10);
    g.roundRect(
      rect.x - pad,
      rect.y - pad,
      rect.width + pad * 2,
      rect.height + pad * 2,
      this.mm(18),
    ).fill({ color: 0x2b1b30, alpha: 0.28 });
    g.roundRect(
      rect.x - pad * 0.4,
      rect.y - pad * 0.4,
      rect.width + pad * 0.8,
      rect.height + pad * 0.8,
      this.mm(14),
    ).fill({ color: 0x2b1b30, alpha: 0.12 });
    g.roundRect(
      rect.x - pad * 0.4,
      rect.y - pad * 0.4,
      rect.width + pad * 0.8,
      rect.height + pad * 0.8,
      this.mm(14),
    ).stroke({ width: this.mm(0.8), color: 0xffe2a8, alpha: 0.35 });
    c.addChild(g);
    c.eventMode = 'none';
    this.ui.addChildAt(c, 0);
    return c;
  }

  /** Ensure the backdrop for a scene/time (re-uses the current one when unchanged). */
  setScene(sceneId: SceneId, tod: TimeOfDay): RichBackdrop {
    if (this.backdrop && this.backdrop.sceneId === sceneId) {
      void this.backdrop.setTimeOfDay(tod, { durationMs: 1800 });
      return this.backdrop;
    }
    this.backdrop?.destroy();
    this.backdrop = this.services.art.createBackdrop(sceneId, tod);
    this.world.addChildAt(this.backdrop.view, 0);
    return this.backdrop;
  }

  /** Place the guide (elder market host with her lantern) for the current orientation. */
  ensureGuide(): RichCharacter {
    if (this.guide) return this.guide;
    const scale = this.portrait ? 1.25 : 1.95;
    const g = this.services.art.createCharacter({
      id: 'guide',
      role: 'guide',
      facing: 'right',
      scale,
    });
    // Landscape: standing at the left edge; portrait: grounded at the bottom-left corner.
    g.view.position.set(
      this.portrait ? this.width * 0.16 : this.width * 0.14,
      this.portrait ? this.height * 0.995 : this.height * 1.02,
    );
    g.setExpression('calm');
    this.world.addChild(g.view);
    this.guide = g;
    return g;
  }

  /** Speak a line through the voice service with guide lip-sync; resolves when it ends. */
  async say(
    lineId: LineId,
    options: { readonly replay?: boolean } = {},
  ): Promise<VoicePlaybackResult> {
    const pb = this.services.voice.play(lineId, {
      ...(this.services.signal ? { signal: this.services.signal } : {}),
      ...(options.replay ? { replay: true } : {}),
    });
    if (this.guide) void this.guide.speak(pb);
    return pb.ended;
  }

  /** Speak several lines gaplessly. */
  async saySequence(lineIds: readonly LineId[]): Promise<VoicePlaybackResult> {
    const pb = this.services.voice.playSequence(
      lineIds,
      this.services.signal ? { signal: this.services.signal } : {},
    );
    if (this.guide) void this.guide.speak(pb);
    return pb.ended;
  }

  /** Create an icon button at (x, y) in the UI layer and register it as a tap target. */
  button(spec: ButtonSpec, x: number, y: number): SizedButton {
    const b = this.services.art.createButton(spec);
    b.view.position.set(x, y);
    this.ui.addChild(b.view);
    this.registerTarget(b, spec.audioKey);
    return b;
  }

  /** Round icon button (replay, globe, help). */
  iconButton(
    spec: Omit<ButtonSpec, 'variant'> & { readonly variant?: ButtonSpec['variant'] },
    x: number,
    y: number,
  ): SizedButton {
    const b = this.services.art.createIconButton(spec);
    b.view.position.set(x, y);
    this.ui.addChild(b.view);
    this.registerTarget(b, spec.audioKey);
    return b;
  }

  /** Picture tile at (x, y). */
  tile(
    id: string,
    pictogram: Container,
    sizeMm: number,
    x: number,
    y: number,
    audioKey: LineId,
    accent?: number,
  ): SizedButton {
    const t = this.services.art.createPictureTile(id, pictogram, sizeMm, accent);
    t.view.position.set(x, y);
    this.ui.addChild(t.view);
    this.registerTarget(t, audioKey);
    return t;
  }

  /** Register (or refresh) a button as an input target at its current stage bounds. */
  registerTarget(b: SizedButton, audioKey: LineId, kind: 'tap' | 'hold' = 'tap'): void {
    this.registered.get(b.targetId)?.handle.remove();
    const handle = this.services.input.registerTarget({
      id: b.targetId,
      bounds: boundsOfButton(b),
      audioKey,
      kind,
    });
    this.registered.set(b.targetId, { button: b, handle });
  }

  /** Refresh every target's bounds (after an animation moved things). */
  refreshTargets(): void {
    for (const r of this.registered.values()) r.handle.setBounds(boundsOfButton(r.button));
  }

  /** Remove a target and destroy its button. */
  removeButton(b: SizedButton): void {
    const r = this.registered.get(b.targetId);
    r?.handle.remove();
    this.registered.delete(b.targetId);
    b.destroy();
  }

  /** True once the session signal aborted (walkaway, withdrawal, wipe) or the kit was destroyed. */
  get aborted(): boolean {
    return this.destroyed || this.services.signal?.aborted === true;
  }

  /**
   * Throw a `ScreenAbortedError` when the screen was aborted or torn down. Flows call this after every
   * await so nothing is logged or drawn for a session that has already been wiped.
   */
  ensureActive(): void {
    if (this.aborted) throw new ScreenAbortedError();
  }

  /** Wait for a tap on any of `buttons` (untimed unless `windowMs`); `cancel` aborts just this wait. */
  waitTap(
    buttons: readonly SizedButton[],
    windowMs: number | null = null,
    cancel?: AbortSignal,
  ): Promise<TapResult> {
    const signals = [this.services.signal, cancel].filter((s): s is AbortSignal => s !== undefined);
    const signal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals);
    return this.services.input.waitForTap(
      buttons.map((b) => b.targetId),
      { anchorMs: this.services.clock.now(), windowMs, ...(signal ? { signal } : {}) },
    );
  }

  /**
   * Race a tap on `buttons` against `other`; the losing tap wait is aborted so no stale waiter remains.
   * Resolves with the tap result, or `null` when `other` settled first.
   */
  async tapOr(buttons: readonly SizedButton[], other: Promise<unknown>): Promise<TapResult | null> {
    const ac = new AbortController();
    const tap = this.waitTap(buttons, null, ac.signal);
    const winner = await Promise.race([tap, other.then(() => null)]);
    ac.abort();
    return winner;
  }

  /** Show the hand-pointer hint at a button. */
  showHint(kind: HintKind, at: Point, holdMs?: number): void {
    if (!this.hint) {
      this.hint = this.services.art.createHandHint();
      this.ui.addChild(this.hint.view);
    } else {
      this.ui.addChild(this.hint.view);
    }
    this.hint.show(kind, at, holdMs);
  }

  hideHint(): void {
    this.hint?.stop();
  }

  /** Pause scaled by the config pacing (0 in tests). */
  pause(ms: number): Promise<void> {
    const scaled = ms * this.config.pacing;
    if (scaled <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const id = setTimeout(resolve, scaled);
      this.services.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(id);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Take ownership of characters shown inside tiles (destroyed with the UI). */
  adopt(characters: readonly RichCharacter[]): void {
    this.owned.push(...characters);
  }

  /** Remove all UI (targets unregistered, buttons destroyed, hint stopped). */
  clearUi(): void {
    killTweensDeep(this.ui);
    for (const c of this.owned.splice(0)) c.destroy();
    for (const r of this.registered.values()) {
      r.handle.remove();
      r.button.destroy();
    }
    this.registered.clear();
    this.hideHint();
    for (const c of this.ui.removeChildren())
      if (!c.destroyed && c !== this.hint?.view) c.destroy({ children: true });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearUi();
    killTweensDeep(this.root);
    this.hint?.destroy();
    this.guide?.destroy();
    this.backdrop?.destroy();
    this.root.destroy({ children: true });
  }
}
