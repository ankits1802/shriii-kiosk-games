/**
 * Unified input layer (ENG-06, KSK-05). Touch is primary and always sufficient; a closed-vocabulary
 * voice adapter plugs in through {@link SpeechInput}.
 *
 * - Every pointer-down is recorded and logged as `input.raw_tap` (never debounced): on-target,
 *   off-target, premature (before the latency anchor), extra (after the response), during the ISI,
 *   multi-touch interference and filtered palm contacts.
 * - Pointer times come from `PointerEvent.timeStamp` mapped to the session clock minus the per-SKU
 *   touch offset; latencies are signed against the caller's anchor.
 * - Targets must be >= 20 mm with >= 8 mm spacing at the configured density (dev builds throw).
 * - Timed response windows suspend walkaway counting (KSK-04: inactivity counts only after the
 *   trial's response window).
 */
import type { InputMode, InputRawTapPayload } from '@shriii/contracts';
import type {
  Clock,
  EventLogger,
  HoldResult,
  InputService,
  PhysicalMetrics,
  RawTap,
  Rect,
  SayOrTouchPrompt,
  SayOrTouchResult,
  SpeechInput,
  TapResult,
  TargetHandle,
  TargetSpec,
  Unsubscribe,
  VoicePlayback,
  VoiceService,
} from '../core/contracts.ts';
import { rectContains, rectGap, rectHit } from './metrics.ts';

/** Target id convention for SayOrTouch options: `<promptId>.<code>`; confirm tick: `<promptId>.confirm`. */
export function sayOrTouchTargetId(promptId: string, code: string): string {
  return `${promptId}.${code}`;
}

/** Thrown (dev) when a target violates the 20 mm / 8 mm rule. */
export class TargetSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetSizeError';
  }
}

/** A normalised pointer sample (from a DOM PointerEvent or injected by tests/bots). */
export interface PointerSample {
  readonly kind: 'down' | 'up' | 'cancel';
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  /** DOMHighResTimeStamp (performance timeline). */
  readonly timeStamp: number;
  readonly pointerType: 'touch' | 'pen' | 'mouse';
  /** Contact geometry in CSS px (0 when unknown). */
  readonly width?: number;
  readonly height?: number;
}

/** Minimal element surface (lets tests use a plain object). */
export interface InputSurface {
  addEventListener(
    type: string,
    listener: (e: Event) => void,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

export interface DomInputServiceOptions {
  readonly clock: Clock;
  readonly metrics: PhysicalMetrics;
  /** Element receiving pointer events (null: inject samples via {@link DomInputService.inject}). */
  readonly element?: InputSurface | null;
  /** Stage size in stage px (pointer coordinates are scaled from the element rect). */
  readonly stageSize?: () => { readonly width: number; readonly height: number };
  /** Safe area for `touch_xy_norm` (default: whole stage). */
  readonly safeArea?: () => Rect;
  /** Throw on undersized/crowded targets (dev builds). */
  readonly strictTargets?: boolean;
  /** Contacts wider than this (mm) are treated as palm/ghost touches (default 30 mm). */
  readonly palmContactMm?: number;
  /** Regions where multi-touch is legitimate (co-play zones). */
  readonly coplayZones?: () => readonly Rect[];
  readonly speech?: SpeechInput | null;
  readonly voice?: VoiceService | null;
  readonly logger?: EventLogger | null;
}

interface Target {
  spec: TargetSpec;
  bounds: Rect;
  enabled: boolean;
  order: number;
}

interface Waiter {
  /** Session time from which latency is measured; null until known (audio_end prompts). */
  anchorMs: number | null;
  readonly targetIds: ReadonlySet<string>;
  /** Return true when the tap was consumed (resolves or advances the waiter). */
  onTap(tap: RawTap): boolean;
  onUp?(pointerId: number, tMs: number): void;
  onDown?(pointerId: number, tap: RawTap): void;
}

type TrialPhase = 'idle' | 'isi' | 'post_response';

/** The engine's {@link InputService}. */
export class DomInputService implements InputService {
  readonly metrics: PhysicalMetrics;
  private clock: Clock;
  private readonly element: InputSurface | null;
  private readonly opts: DomInputServiceOptions;
  private readonly targets = new Map<string, Target>();
  private readonly rawListeners = new Set<(tap: RawTap) => void>();
  private readonly activityListeners = new Set<(tMs: number) => void>();
  private readonly windowListeners = new Set<(open: boolean) => void>();
  private readonly active = new Map<number, { x: number; y: number }>();
  private readonly waiters = new Set<Waiter>();
  private logger: EventLogger | null;
  private voice: VoiceService | null;
  private speech: SpeechInput | null;
  private enabled = true;
  private order = 0;
  private phase: TrialPhase = 'idle';
  private lastAnchorMs: number | null = null;
  private openWindows = 0;
  private last = Number.NEGATIVE_INFINITY;
  private readonly domHandler = (e: Event): void => this.onDomEvent(e);

  constructor(options: DomInputServiceOptions) {
    this.opts = options;
    this.clock = options.clock;
    this.metrics = options.metrics;
    this.element = options.element ?? null;
    this.logger = options.logger ?? null;
    this.voice = options.voice ?? null;
    this.speech = options.speech ?? null;
    if (this.element) {
      for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
        this.element.addEventListener(type, this.domHandler, { passive: false });
      }
    }
  }

  /** Detach DOM listeners and cancel pending waits. */
  dispose(): void {
    if (this.element) {
      for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
        this.element.removeEventListener(type, this.domHandler);
      }
    }
    this.waiters.clear();
    this.targets.clear();
  }

  /** Logger used for `input.raw_tap` / `input.hold` / prompt window events (module-scoped while a module runs). */
  setLogger(logger: EventLogger | null): void {
    this.logger = logger;
  }

  /** Follow the current session's clock (pointer times are mapped onto it). */
  setClock(clock: Clock): void {
    this.clock = clock;
  }

  setVoice(voice: VoiceService | null): void {
    this.voice = voice;
  }

  setSpeech(speech: SpeechInput | null): void {
    this.speech = speech;
  }

  /** Every pointer-down (walkaway activity). */
  onActivity(listener: (tMs: number) => void): Unsubscribe {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  /** Timed response windows opening/closing (walkaway suspension). */
  onWindowChange(listener: (open: boolean) => void): Unsubscribe {
    this.windowListeners.add(listener);
    return () => this.windowListeners.delete(listener);
  }

  /** Mark the inter-stimulus interval (taps are classified `during_isi`). */
  markIsi(): void {
    this.phase = 'isi';
  }

  /** Clear trial phase (taps outside any wait are on/off target). */
  markIdle(): void {
    this.phase = 'idle';
    this.lastAnchorMs = null;
  }

  get lastInteractionMs(): number {
    return this.last;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  registerTarget(spec: TargetSpec): TargetHandle {
    this.validateTarget(spec.id, spec.bounds);
    const target: Target = {
      spec,
      bounds: spec.bounds,
      enabled: spec.enabled ?? true,
      order: this.order++,
    };
    this.targets.set(spec.id, target);
    return {
      id: spec.id,
      setBounds: (bounds) => {
        this.validateTarget(spec.id, bounds);
        target.bounds = bounds;
      },
      setEnabled: (enabled) => {
        target.enabled = enabled;
      },
      remove: () => {
        if (this.targets.get(spec.id) === target) this.targets.delete(spec.id);
      },
    };
  }

  private validateTarget(id: string, bounds: Rect): void {
    const problems: string[] = [];
    const min = this.metrics.minTargetPx;
    if (bounds.width < min || bounds.height < min) {
      problems.push(
        `target ${id} is ${Math.round(bounds.width)}x${Math.round(bounds.height)} px; minimum ${min} px (20 mm)`,
      );
    }
    for (const other of this.targets.values()) {
      if (other.spec.id === id || !other.enabled) continue;
      if (rectContains(other.bounds, bounds) || rectContains(bounds, other.bounds)) continue;
      const gap = rectGap(bounds, other.bounds);
      if (gap < this.metrics.minSpacingPx) {
        problems.push(
          `target ${id} is ${Math.round(gap)} px from ${other.spec.id}; minimum ${this.metrics.minSpacingPx} px (8 mm)`,
        );
      }
    }
    if (problems.length === 0) return;
    if (this.opts.strictTargets) throw new TargetSizeError(problems.join('; '));
    console.warn(`[input] ${problems.join('; ')}`);
  }

  onRawTap(listener: (tap: RawTap) => void): Unsubscribe {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  /** Feed a pointer sample (DOM handler, tests and headless bots). */
  inject(sample: PointerSample): void {
    const { x, y } = this.toStage(sample.clientX, sample.clientY);
    const tMs = this.clock.fromPointerTime(sample.timeStamp);
    if (sample.kind === 'down') {
      this.active.set(sample.pointerId, { x, y });
      this.handleDown(sample, x, y, tMs);
    } else {
      this.active.delete(sample.pointerId);
      for (const w of [...this.waiters]) w.onUp?.(sample.pointerId, tMs);
    }
  }

  private onDomEvent(e: Event): void {
    const pe = e as PointerEvent;
    const kind = e.type === 'pointerdown' ? 'down' : e.type === 'pointerup' ? 'up' : 'cancel';
    if (kind === 'down') e.preventDefault();
    const pointerType =
      pe.pointerType === 'pen' || pe.pointerType === 'mouse' ? pe.pointerType : 'touch';
    this.inject({
      kind,
      pointerId: pe.pointerId ?? 0,
      clientX: pe.clientX,
      clientY: pe.clientY,
      timeStamp: e.timeStamp,
      pointerType,
      width: pe.width ?? 0,
      height: pe.height ?? 0,
    });
  }

  private toStage(clientX: number, clientY: number): { x: number; y: number } {
    if (!this.element) return { x: clientX, y: clientY };
    const rect = this.element.getBoundingClientRect();
    const size = this.opts.stageSize?.() ?? { width: rect.width, height: rect.height };
    const sx = rect.width > 0 ? size.width / rect.width : 1;
    const sy = rect.height > 0 ? size.height / rect.height : 1;
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
  }

  private hitTest(x: number, y: number): Target | null {
    let best: Target | null = null;
    for (const t of this.targets.values()) {
      if (!t.enabled || t.spec.enabled === false) continue;
      if (!rectHit(t.bounds, x, y)) continue;
      if (!best || t.order > best.order) best = t;
    }
    return best;
  }

  private normalise(x: number, y: number): [number, number] {
    const size = this.opts.stageSize?.();
    const sa = this.opts.safeArea?.() ?? {
      x: 0,
      y: 0,
      width: size?.width ?? 1,
      height: size?.height ?? 1,
    };
    const clamp = (v: number): number => Math.min(1, Math.max(0, v));
    const nx = sa.width > 0 ? clamp((x - sa.x) / sa.width) : 0;
    const ny = sa.height > 0 ? clamp((y - sa.y) / sa.height) : 0;
    return [Math.round(nx * 10000) / 10000, Math.round(ny * 10000) / 10000];
  }

  private handleDown(sample: PointerSample, x: number, y: number, tMs: number): void {
    this.last = Math.max(this.last, tMs);
    for (const l of this.activityListeners) l(tMs);
    const target = this.hitTest(x, y);
    const contactMm = Math.max(sample.width ?? 0, sample.height ?? 0) / this.metrics.pxPerMm;
    const palm = sample.pointerType === 'touch' && contactMm > (this.opts.palmContactMm ?? 30);
    const zones = this.opts.coplayZones?.() ?? [];
    const multi = this.active.size >= 2 && !zones.some((z) => rectHit(z, x, y));
    const tap: RawTap = {
      targetId: target?.spec.id ?? null,
      xyNorm: this.normalise(x, y),
      tMs,
      pointerType: sample.pointerType,
      activePoints: this.active.size,
      filtered: palm ? 'palm' : multi ? 'multi_touch_interference' : 'none',
    };
    // Classify against the current wait (before resolving it).
    const waiter = [...this.waiters].at(-1) ?? null;
    let classification: InputRawTapPayload['classification'];
    let anchorOffset: number | null = null;
    if (tap.filtered === 'palm') classification = 'filtered_palm';
    else if (tap.filtered === 'multi_touch_interference')
      classification = 'multi_touch_interference';
    else if (waiter) {
      if (waiter.anchorMs !== null && tMs < waiter.anchorMs) classification = 'premature';
      else
        classification =
          tap.targetId && waiter.targetIds.has(tap.targetId) ? 'on_target' : 'off_target';
    } else if (this.phase === 'post_response') classification = 'extra';
    else if (this.phase === 'isi') classification = 'during_isi';
    else classification = tap.targetId ? 'on_target' : 'off_target';
    const anchor = waiter
      ? waiter.anchorMs
      : this.phase === 'post_response'
        ? this.lastAnchorMs
        : null;
    if (anchor !== null) anchorOffset = Math.round((tMs - anchor) * 1000) / 1000;

    this.logger?.log('input.raw_tap', {
      target_id: tap.targetId,
      touch_xy_norm: [tap.xyNorm[0], tap.xyNorm[1]],
      pointer_t_ms: Math.round(tMs * 1000) / 1000,
      anchor_offset_ms: anchorOffset,
      pointer_type: tap.pointerType,
      active_points: tap.activePoints,
      classification,
    });
    for (const l of this.rawListeners) l(tap);
    if (!this.enabled || tap.filtered !== 'none') return;
    for (const w of [...this.waiters].reverse()) {
      w.onDown?.(sample.pointerId, tap);
      if (w.onTap(tap)) break;
    }
  }

  private windowOpened(timed: boolean): () => void {
    if (!timed) return () => undefined;
    this.openWindows += 1;
    if (this.openWindows === 1) for (const l of this.windowListeners) l(true);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.openWindows -= 1;
      if (this.openWindows === 0) for (const l of this.windowListeners) l(false);
    };
  }

  private resolvedAt(anchorMs: number | null): void {
    this.phase = 'post_response';
    this.lastAnchorMs = anchorMs;
  }

  waitForTap(
    targetIds: readonly string[],
    options: {
      readonly anchorMs: number;
      readonly windowMs: number | null;
      readonly signal?: AbortSignal;
    },
  ): Promise<TapResult> {
    return new Promise<TapResult>((resolve) => {
      const ac = new AbortController();
      const closeWindow = this.windowOpened(options.windowMs !== null);
      let done = false;
      const finish = (r: TapResult): void => {
        if (done) return;
        done = true;
        this.waiters.delete(waiter);
        ac.abort();
        closeWindow();
        options.signal?.removeEventListener('abort', onAbort);
        if (r.kind !== 'aborted') this.resolvedAt(options.anchorMs);
        resolve(r);
      };
      const waiter: Waiter = {
        anchorMs: options.anchorMs,
        targetIds: new Set(targetIds),
        onTap: (tap) => {
          if (tap.tMs < options.anchorMs) return false; // premature: recorded, does not resolve
          if (!tap.targetId || !waiter.targetIds.has(tap.targetId)) return false;
          finish({
            kind: 'tap',
            tap,
            latencyMs: Math.round((tap.tMs - options.anchorMs) * 1000) / 1000,
          });
          return true;
        },
      };
      const onAbort = (): void => finish({ kind: 'aborted' });
      if (options.signal?.aborted) {
        closeWindow();
        resolve({ kind: 'aborted' });
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
      this.phase = 'idle';
      if (options.windowMs !== null) {
        const remaining = options.anchorMs + options.windowMs - this.clock.now();
        this.clock.delay(remaining, ac.signal).then(
          () => finish({ kind: 'timeout' }),
          () => undefined,
        );
      }
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
    return new Promise<HoldResult>((resolve) => {
      const ac = new AbortController();
      const startAnchor = this.clock.now();
      const closeWindow = this.windowOpened(options.windowMs !== null);
      let done = false;
      let holding: { pointerId: number; startMs: number } | null = null;
      const finish = (r: HoldResult): void => {
        if (done) return;
        done = true;
        this.waiters.delete(waiter);
        ac.abort();
        closeWindow();
        options.signal?.removeEventListener('abort', onAbort);
        if (r.kind === 'hold') {
          this.logger?.log('input.hold', {
            target_id: r.targetId,
            hold_ms: Math.round(r.holdMs * 1000) / 1000,
            required_hold_ms: options.requiredMs,
            completed: r.completed,
          });
        }
        if (r.kind !== 'aborted') this.resolvedAt(startAnchor);
        resolve(r);
      };
      const endHold = (tMs: number): void => {
        if (!holding) return;
        const holdMs = Math.max(0, tMs - holding.startMs);
        finish({
          kind: 'hold',
          targetId,
          startMs: holding.startMs,
          holdMs,
          completed: holdMs >= options.requiredMs,
        });
      };
      const waiter: Waiter = {
        anchorMs: startAnchor,
        targetIds: new Set([targetId]),
        onTap: (tap) => tap.targetId === targetId,
        onDown: (pointerId, tap) => {
          if (holding || tap.targetId !== targetId) return;
          holding = { pointerId, startMs: tap.tMs };
          ac.abort(); // the response window only bounds the start of the hold
        },
        onUp: (pointerId, tMs) => {
          if (holding && holding.pointerId === pointerId) endHold(tMs);
        },
      };
      const onAbort = (): void => finish({ kind: 'aborted' });
      if (options.signal?.aborted) {
        closeWindow();
        resolve({ kind: 'aborted' });
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
      this.phase = 'idle';
      if (options.windowMs !== null) {
        this.clock.delay(options.windowMs, ac.signal).then(
          () => {
            if (!holding) finish({ kind: 'timeout' });
          },
          () => undefined,
        );
      }
    });
  }

  async sayOrTouch<C extends string>(prompt: SayOrTouchPrompt<C>): Promise<SayOrTouchResult<C>> {
    const codes = prompt.options.map((o) => o.code);
    if (codes.length < 1) throw new RangeError('sayOrTouch: at least one option required');
    const voiceCodes = (prompt.voiceCodes ?? []).filter((c) => codes.includes(c));
    const asrEnabled =
      !prompt.privateReport &&
      voiceCodes.length > 0 &&
      (this.speech?.isAvailable(prompt.promptId) ?? false);
    const optionIds = new Map(
      codes.map((c) => [sayOrTouchTargetId(prompt.promptId, c), c] as const),
    );
    const confirmId = sayOrTouchTargetId(prompt.promptId, 'confirm');
    this.logger?.log('prompt_window_open', {
      prompt_id: prompt.promptId,
      vocabulary: codes as unknown as [string, ...string[]],
      asr_enabled: asrEnabled,
      window_ms: prompt.windowMs,
    });

    const spoken = prompt.promptLine !== undefined && this.voice !== null;
    const audioAnchored = prompt.latencyAnchor === 'audio_end' && spoken;
    let playback: VoicePlayback | null = null;
    if (spoken && prompt.promptLine !== undefined && this.voice) {
      playback = this.voice.play(prompt.promptLine, prompt.signal ? { signal: prompt.signal } : {});
    }
    const startMs = this.clock.now();
    const anchor: { ms: number | null } = { ms: audioAnchored ? null : startMs };

    const result = await new Promise<SayOrTouchResult<C>>((resolve) => {
      const ac = new AbortController();
      let closeWindow: () => void = () => undefined;
      let done = false;
      let selection: {
        code: C;
        mode: InputMode;
        tap: RawTap | null;
        asr: { label: C; confidence: number | null } | null;
      } | null = null;
      const revisions: { value: C; tMs: number }[] = [];
      let tapCount = 0;

      const finish = (r: SayOrTouchResult<C>): void => {
        if (done) return;
        done = true;
        this.waiters.delete(waiter);
        ac.abort();
        closeWindow();
        prompt.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const commit = (
        code: C,
        mode: InputMode,
        responseMs: number,
        tap: RawTap | null,
        asr: { label: C; confidence: number | null } | null,
      ): void => {
        const build = (anchorMs: number): SayOrTouchResult<C> => {
          const latencyMs = Math.round((responseMs - anchorMs) * 1000) / 1000;
          return {
            kind: 'response',
            value: code,
            inputMode: mode,
            latencyMs,
            bargeIn: latencyMs < 0,
            responseMs,
            revisions,
            tapCount,
            touchXyNorm: tap ? tap.xyNorm : null,
            asrLabel: asr ? asr.label : null,
            asrConfidence: asr ? asr.confidence : null,
          };
        };
        if (anchor.ms !== null) {
          finish(build(anchor.ms));
          return;
        }
        // Barge-in before the spoken prompt ended: the anchor is the prompt's natural end.
        done = true;
        this.waiters.delete(waiter);
        ac.abort();
        closeWindow();
        prompt.signal?.removeEventListener('abort', onAbort);
        const end = playback
          ? playback.ended.then((r) => r.endMs)
          : Promise.resolve(this.clock.now());
        void end.then((endMs) => resolve(build(endMs)));
      };
      const startWindow = (): void => {
        closeWindow = this.windowOpened(prompt.windowMs !== null);
        if (prompt.windowMs !== null && anchor.ms !== null) {
          const remaining = anchor.ms + prompt.windowMs - this.clock.now();
          this.clock.delay(remaining, ac.signal).then(
            () =>
              finish({
                kind: 'timeout',
                value: null,
                inputMode: 'timeout',
                latencyMs: null,
                bargeIn: false,
                responseMs: null,
                revisions,
                tapCount,
                touchXyNorm: null,
                asrLabel: null,
                asrConfidence: null,
              }),
            () => undefined,
          );
        }
      };
      const waiter: Waiter = {
        anchorMs: anchor.ms,
        targetIds: new Set([...optionIds.keys(), confirmId]),
        onTap: (tap) => {
          if (!tap.targetId) return false;
          const code = optionIds.get(tap.targetId);
          if (code !== undefined) {
            tapCount += 1;
            if (prompt.allowRevisions || prompt.requireConfirm)
              revisions.push({ value: code, tMs: tap.tMs });
            if (!prompt.requireConfirm) {
              commit(code, 'touch', tap.tMs, tap, null);
            } else {
              selection = { code, mode: 'touch', tap, asr: null };
            }
            return true;
          }
          if (tap.targetId === confirmId && selection) {
            tapCount += 1;
            const s = selection;
            commit(
              s.code,
              s.mode === 'voice' ? 'voice_then_touch_confirm' : 'touch',
              tap.tMs,
              s.tap ?? tap,
              s.asr,
            );
            return true;
          }
          return false;
        },
      };
      const onAbort = (): void =>
        finish({
          kind: 'aborted',
          value: null,
          inputMode: 'none',
          latencyMs: null,
          bargeIn: false,
          responseMs: null,
          revisions,
          tapCount,
          touchXyNorm: null,
          asrLabel: null,
          asrConfidence: null,
        });
      if (prompt.signal?.aborted) {
        onAbort();
        return;
      }
      prompt.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
      this.phase = 'idle';

      if (anchor.ms === null && playback) {
        void playback.ended.then((r) => {
          if (done) return;
          anchor.ms = r.endMs;
          waiter.anchorMs = r.endMs;
          startWindow();
        });
      } else {
        startWindow();
      }

      if (asrEnabled && this.speech) {
        void this.speech.listen(prompt.promptId, voiceCodes, ac.signal).then((r) => {
          if (done || r.label === null) return;
          const label = r.label as C;
          if (!voiceCodes.includes(label)) return;
          this.logger?.log('asr_result', {
            prompt_id: prompt.promptId,
            asr_label: label,
            asr_confidence: r.confidence,
            accepted: true,
          });
          if (prompt.requireConfirm) {
            selection = {
              code: label,
              mode: 'voice',
              tap: null,
              asr: { label, confidence: r.confidence },
            };
            revisions.push({ value: label, tMs: this.clock.now() });
          } else {
            commit(label, 'voice', this.clock.now(), null, { label, confidence: r.confidence });
          }
        });
      }
    });

    this.logger?.log('prompt_window_close', {
      prompt_id: prompt.promptId,
      reason:
        result.kind === 'response'
          ? 'response'
          : result.kind === 'timeout'
            ? 'timeout'
            : 'cancelled',
    });
    if (result.kind !== 'aborted') this.resolvedAt(anchor.ms);
    return result;
  }

  /** Anchor (session ms) of the innermost active wait, or null when no wait is active. */
  currentAnchorMs(): number | null {
    return [...this.waiters].at(-1)?.anchorMs ?? null;
  }
}
