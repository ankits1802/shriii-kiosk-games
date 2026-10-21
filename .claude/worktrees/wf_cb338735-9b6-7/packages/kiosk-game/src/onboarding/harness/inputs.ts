/**
 * Harness input services:
 * - {@link PointerInput}: real pointer events on a canvas, hit-testing registered target bounds (gallery
 *   previews; the engine's InputService is the production implementation).
 * - {@link ScriptedInput}: programmatic taps/holds chosen by a script (unit tests, headless bots).
 */
import type {
  Clock,
  HoldResult,
  InputService,
  PhysicalMetrics,
  RawTap,
  Rect,
  SayOrTouchPrompt,
  SayOrTouchResult,
  TapResult,
  TargetHandle,
  TargetSpec,
  Unsubscribe,
} from '../../core/contracts.ts';

interface Target {
  spec: TargetSpec;
  bounds: Rect;
  enabled: boolean;
}

interface TapWaiter {
  ids: readonly string[];
  anchorMs: number;
  resolve: (r: TapResult) => void;
}

interface HoldWaiter {
  id: string;
  requiredMs: number;
  resolve: (r: HoldResult) => void;
}

abstract class BaseInput implements InputService {
  readonly metrics: PhysicalMetrics;
  protected readonly targets = new Map<string, Target>();
  protected readonly tapWaiters = new Set<TapWaiter>();
  protected readonly holdWaiters = new Set<HoldWaiter>();
  private readonly listeners = new Set<(t: RawTap) => void>();
  protected enabled = true;
  private lastTouch = 0;

  constructor(
    protected readonly clock: Clock,
    metrics: PhysicalMetrics,
  ) {
    this.metrics = metrics;
  }

  get lastInteractionMs(): number {
    return this.lastTouch;
  }

  registerTarget(spec: TargetSpec): TargetHandle {
    const t: Target = { spec, bounds: spec.bounds, enabled: spec.enabled ?? true };
    this.targets.set(spec.id, t);
    return {
      id: spec.id,
      setBounds: (b) => {
        t.bounds = b;
      },
      setEnabled: (e) => {
        t.enabled = e;
      },
      remove: () => {
        if (this.targets.get(spec.id) === t) this.targets.delete(spec.id);
      },
    };
  }

  /** Registered target ids (tests). */
  get targetIds(): string[] {
    return [...this.targets.keys()];
  }

  onRawTap(listener: (tap: RawTap) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForTap(
    targetIds: readonly string[],
    options: {
      readonly anchorMs: number;
      readonly windowMs: number | null;
      readonly signal?: AbortSignal;
    },
  ): Promise<TapResult> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const w: TapWaiter = {
        ids: targetIds,
        anchorMs: options.anchorMs,
        resolve: (r) => {
          this.tapWaiters.delete(w);
          if (timer) clearTimeout(timer);
          resolve(r);
        },
      };
      if (options.signal?.aborted) {
        resolve({ kind: 'aborted' });
        return;
      }
      this.tapWaiters.add(w);
      if (options.windowMs !== null)
        timer = setTimeout(() => w.resolve({ kind: 'timeout' }), options.windowMs);
      options.signal?.addEventListener('abort', () => w.resolve({ kind: 'aborted' }), {
        once: true,
      });
      this.onWaiterAdded();
    });
  }

  waitForHold(
    targetId: string,
    options: {
      readonly requiredMs: number;
      readonly windowMs: number | null;
      readonly signal?: AbortSignal;
    },
  ): Promise<HoldResult> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const w: HoldWaiter = {
        id: targetId,
        requiredMs: options.requiredMs,
        resolve: (r) => {
          this.holdWaiters.delete(w);
          if (timer) clearTimeout(timer);
          resolve(r);
        },
      };
      this.holdWaiters.add(w);
      if (options.windowMs !== null)
        timer = setTimeout(() => w.resolve({ kind: 'timeout' }), options.windowMs);
      options.signal?.addEventListener('abort', () => w.resolve({ kind: 'aborted' }), {
        once: true,
      });
      this.onWaiterAdded();
    });
  }

  async sayOrTouch<C extends string>(prompt: SayOrTouchPrompt<C>): Promise<SayOrTouchResult<C>> {
    const ids = prompt.options.map((o) => `${prompt.promptId}.${o.code}`);
    const anchor = this.clock.now();
    const r = await this.waitForTap(ids, {
      anchorMs: anchor,
      windowMs: prompt.windowMs,
      ...(prompt.signal ? { signal: prompt.signal } : {}),
    });
    if (r.kind !== 'tap') {
      return {
        kind: r.kind === 'timeout' ? 'timeout' : 'aborted',
        value: null,
        inputMode: 'timeout',
        latencyMs: null,
        bargeIn: false,
        responseMs: null,
        revisions: [],
        tapCount: 0,
        touchXyNorm: null,
        asrLabel: null,
        asrConfidence: null,
      };
    }
    const code = (prompt.options.find((o) => `${prompt.promptId}.${o.code}` === r.tap.targetId)
      ?.code ?? null) as C | null;
    return {
      kind: 'response',
      value: code,
      inputMode: 'touch',
      latencyMs: r.latencyMs,
      bargeIn: false,
      responseMs: r.tap.tMs,
      revisions: [],
      tapCount: 1,
      touchXyNorm: r.tap.xyNorm,
      asrLabel: null,
      asrConfidence: null,
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  protected onWaiterAdded(): void {}

  /** Deliver a tap on a target id (or a point) to listeners and waiters. */
  protected deliverTap(
    targetId: string | null,
    xyNorm: readonly [number, number],
    tMs: number,
    pointerType: RawTap['pointerType'] = 'touch',
  ): void {
    if (!this.enabled) return;
    this.lastTouch = tMs;
    const tap: RawTap = { targetId, xyNorm, tMs, pointerType, activePoints: 1, filtered: 'none' };
    for (const l of this.listeners) l(tap);
    if (!targetId) return;
    for (const w of [...this.tapWaiters]) {
      if (w.ids.includes(targetId)) w.resolve({ kind: 'tap', tap, latencyMs: tMs - w.anchorMs });
    }
  }

  protected deliverHold(targetId: string, startMs: number, holdMs: number): void {
    for (const w of [...this.holdWaiters]) {
      if (w.id === targetId)
        w.resolve({ kind: 'hold', targetId, startMs, holdMs, completed: holdMs >= w.requiredMs });
    }
  }

  protected hit(x: number, y: number): string | null {
    let found: string | null = null;
    for (const [id, t] of this.targets) {
      if (!t.enabled) continue;
      const b = t.bounds;
      if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) found = id;
    }
    return found;
  }
}

/** Pointer-driven input on a canvas (dev previews). */
export class PointerInput extends BaseInput {
  private readonly down = new Map<
    number,
    { id: string | null; t: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  private readonly onDown = (e: PointerEvent): void => {
    const p = this.toStage(e);
    const id = this.hit(p.x, p.y);
    const t = this.clock.now();
    this.deliverTap(
      id,
      [p.x / this.stageSize().w, p.y / this.stageSize().h],
      t,
      e.pointerType === 'mouse' ? 'mouse' : e.pointerType === 'pen' ? 'pen' : 'touch',
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (id) {
      const w = [...this.holdWaiters].find((h) => h.id === id);
      if (w) timer = setTimeout(() => this.deliverHold(id, t, w.requiredMs), w.requiredMs);
    }
    this.down.set(e.pointerId, { id, t, timer });
  };
  private readonly onUp = (e: PointerEvent): void => {
    const d = this.down.get(e.pointerId);
    this.down.delete(e.pointerId);
    if (!d?.id) return;
    if (d.timer) clearTimeout(d.timer);
    this.deliverHold(d.id, d.t, this.clock.now() - d.t);
  };

  private autoPending = false;

  constructor(
    clock: Clock,
    metrics: PhysicalMetrics,
    private readonly canvas: HTMLCanvasElement,
    private readonly stageSize: () => { w: number; h: number },
    private autoplay: TapScript | null = null,
  ) {
    super(clock, metrics);
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  }

  /** Auto-play waits with a script (gallery: reach a state for screenshots); null hands over to the user. */
  setAutoplay(script: TapScript | null): void {
    this.autoplay = script;
  }

  protected override onWaiterAdded(): void {
    if (!this.autoplay || this.autoPending) return;
    this.autoPending = true;
    setTimeout(() => {
      this.autoPending = false;
      const script = this.autoplay;
      if (!script) return;
      for (const h of [...this.holdWaiters])
        this.deliverHold(h.id, this.clock.now(), h.requiredMs + 10);
      const waiting = [...this.tapWaiters].flatMap((w) => [...w.ids]);
      if (waiting.length === 0) return;
      const id = script(waiting);
      if (id) this.deliverTap(id, [0.5, 0.5], this.clock.now());
    }, 400);
  }

  private toStage(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const s = this.stageSize();
    return { x: ((e.clientX - r.left) / r.width) * s.w, y: ((e.clientY - r.top) / r.height) * s.h };
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
  }
}

/** Script that chooses which target to tap among the waited ids (return null to keep waiting). */
export type TapScript = (waitingFor: readonly string[]) => string | null;

/** Programmatic input for tests: taps chosen by a script, holds always completed (configurable). */
export class ScriptedInput extends BaseInput {
  private pending = false;
  holdOutcome: (targetId: string, requiredMs: number) => number = (_id, req) => req + 10;

  constructor(
    clock: Clock,
    metrics: PhysicalMetrics,
    private script: TapScript,
  ) {
    super(clock, metrics);
  }

  setScript(script: TapScript): void {
    this.script = script;
  }

  protected override onWaiterAdded(): void {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      for (const h of [...this.holdWaiters])
        this.deliverHold(h.id, this.clock.now(), this.holdOutcome(h.id, h.requiredMs));
      const waiting = [...this.tapWaiters].flatMap((w) => [...w.ids]);
      if (waiting.length === 0) return;
      const id = this.script(waiting);
      if (id) this.deliverTap(id, [0.5, 0.5], this.clock.now() + 1);
    }, 0);
  }
}
