/**
 * The touch player: answers every Road Home prompt from real touches through the input service
 * (latencies on the session clock from the director's anchors, windows exactly as configured,
 * every raw tap logged by the input layer into the trial scope).
 */
import type { InputService, ModuleContext, RawTap } from '../../../core/contracts.ts';
import type { Branch } from '../../../paradigms/reversal.ts';
import type {
  ChoiceAnswer,
  ChoiceRequest,
  EffortAnswer,
  EffortRequest,
  FuelAnswer,
  FuelRequest,
  HoldRecord,
  MapAnswer,
  MapStepRequest,
  RoadHomePlayer,
} from '../types.ts';
import type { RoadHomeView } from './RoadHomeView.ts';

export class HumanPlayer implements RoadHomePlayer {
  private readonly input: InputService;

  constructor(
    private readonly ctx: ModuleContext,
    private readonly view: RoadHomeView,
  ) {
    this.input = ctx.input;
  }

  dispose(): void {}

  async mapStep(req: MapStepRequest): Promise<MapAnswer> {
    const ids = this.view.currentMapIds();
    const r = await this.input.waitForTap([...ids.keys()], {
      anchorMs: req.anchorMs,
      windowMs: req.windowMs,
      signal: req.signal,
    });
    if (r.kind === 'aborted') return { kind: 'aborted' };
    if (r.kind === 'timeout') return { kind: 'timeout' };
    const key = r.tap.targetId ? ids.get(r.tap.targetId) : undefined;
    if (!key) return { kind: 'timeout' };
    this.view.touched(key);
    if (key === 'rest') {
      return {
        kind: 'rest',
        tMs: r.tap.tMs,
        latencyMs: r.tap.tMs - req.walk.onsetMs,
        xy: r.tap.xyNorm,
      };
    }
    return { kind: 'node', node: key.slice('node:'.length), tMs: r.tap.tMs, xy: r.tap.xyNorm };
  }

  private async choice<C extends string>(
    req: ChoiceRequest,
    options: readonly (readonly [string, C])[],
  ): Promise<ChoiceAnswer<C>> {
    const byId = new Map(
      options.map(([key, code]) => [this.view.targetId(key), [key, code] as const]),
    );
    const r = await this.input.waitForTap([...byId.keys()], {
      anchorMs: req.anchorMs,
      windowMs: req.windowMs,
      signal: req.signal,
    });
    if (r.kind === 'aborted') return { kind: 'aborted' };
    if (r.kind === 'timeout') return { kind: 'timeout' };
    const hit = r.tap.targetId ? byId.get(r.tap.targetId) : undefined;
    if (!hit) return { kind: 'timeout' };
    this.view.touched(hit[0]);
    return {
      kind: 'choice',
      value: hit[1],
      tMs: r.tap.tMs,
      latencyMs: r.latencyMs,
      xy: r.tap.xyNorm,
      tapCount: 1,
    };
  }

  fork(req: ChoiceRequest): Promise<ChoiceAnswer<Branch>> {
    return this.choice<Branch>(req, [
      ['branch:left', 'left'],
      ['branch:right', 'right'],
    ]);
  }

  optional(req: ChoiceRequest): Promise<ChoiceAnswer<'take'>> {
    return this.choice<'take'>(req, [['optional', 'take']]);
  }

  probe(req: ChoiceRequest): Promise<ChoiceAnswer<'safe' | 'risky'>> {
    const t = req.trial;
    const safe: Branch = t.kind === 'probe' ? t.safeSide : 'left';
    const risky: Branch = safe === 'left' ? 'right' : 'left';
    return this.choice<'safe' | 'risky'>(req, [
      [`branch:${safe}`, 'safe'],
      [`branch:${risky}`, 'risky'],
    ]);
  }

  async fuel(req: FuelRequest): Promise<FuelAnswer> {
    const pile = this.view.targetId('fuel:pile');
    const trough = this.view.targetId('fuel:trough');
    const confirm = this.view.targetId('fuel:confirm');
    const revisions: { value: string; tMs: number }[] = [];
    let tokens = 0;
    let taps = 0;
    for (;;) {
      const r = await this.input.waitForTap([pile, trough, confirm], {
        anchorMs: req.anchorMs,
        windowMs: req.windowMs,
        signal: req.signal,
      });
      if (r.kind === 'aborted') {
        return {
          kind: 'aborted',
          tokens,
          revisions,
          tMs: null,
          latencyMs: null,
          tapCount: taps,
          xy: null,
        };
      }
      if (r.kind === 'timeout') {
        return {
          kind: 'timeout',
          tokens,
          revisions,
          tMs: null,
          latencyMs: null,
          tapCount: taps,
          xy: null,
        };
      }
      taps += 1;
      const id = r.tap.targetId;
      if (id === confirm) {
        this.view.touched('fuel:confirm');
        return {
          kind: 'confirm',
          tokens,
          revisions,
          tMs: r.tap.tMs,
          latencyMs: r.latencyMs,
          tapCount: taps,
          xy: r.tap.xyNorm,
        };
      }
      const next = id === pile ? Math.min(req.endowment, tokens + 1) : Math.max(0, tokens - 1);
      if (next !== tokens) {
        tokens = next;
        revisions.push({ value: `tokens_${tokens}`, tMs: r.tap.tMs });
        this.view.fuelChanged(tokens);
      }
    }
  }

  async effort(req: EffortRequest): Promise<EffortAnswer> {
    const id = this.view.targetId('effort');
    const holds: HoldRecord[] = [];
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    const stopProgress = (): void => {
      if (progressTimer !== null) clearInterval(progressTimer);
      progressTimer = null;
    };
    const unsub = this.input.onRawTap((tap: RawTap) => {
      if (tap.targetId !== id) return;
      stopProgress();
      const start = tap.tMs;
      progressTimer = setInterval(() => {
        this.view.effortProgress((this.ctx.clock.now() - start) / req.requiredMs);
      }, 33);
    });
    try {
      for (;;) {
        const left =
          req.windowMs === null ? null : req.anchorMs + req.windowMs - this.ctx.clock.now();
        if (left !== null && left <= 0) break;
        const r = await this.input.waitForHold(id, {
          requiredMs: req.requiredMs,
          windowMs: left,
          signal: req.signal,
        });
        stopProgress();
        if (r.kind === 'aborted') return { kind: 'aborted', holds, completed: false };
        if (r.kind === 'timeout') break;
        holds.push({ startMs: r.startMs, holdMs: r.holdMs, completed: r.completed });
        if (r.completed) {
          this.view.effortProgress(1);
          break;
        }
        this.view.effortProgress(null);
      }
    } finally {
      stopProgress();
      unsub();
    }
    const completed = holds.some((h) => h.completed);
    return { kind: holds.length > 0 ? 'held' : 'timeout', holds, completed };
  }
}
