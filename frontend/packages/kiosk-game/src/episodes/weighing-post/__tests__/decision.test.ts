import { describe, expect, it } from 'vitest';
import type { Clock, InputService, RawTap, TapResult } from '../../../core/contracts.ts';
import { runChoice } from '../decision.ts';

/** Manual clock: `delay` resolves when `advance` passes its deadline. */
class ManualClock {
  t = 0;
  private timers: { at: number; resolve: () => void; signal?: AbortSignal }[] = [];
  now(): number {
    return this.t;
  }
  delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry = { at: this.t + ms, resolve, ...(signal ? { signal } : {}) };
      this.timers.push(entry);
      signal?.addEventListener('abort', () => {
        this.timers = this.timers.filter((x) => x !== entry);
        reject(new Error('aborted'));
      });
    });
  }
  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.timers.filter((x) => x.at <= this.t);
    this.timers = this.timers.filter((x) => x.at > this.t);
    for (const d of due) d.resolve();
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Scripted input: `tap(id)` resolves the pending wait when `id` is among the awaited targets. */
class ScriptedInput {
  private pending: { ids: readonly string[]; resolve: (r: TapResult) => void } | null = null;
  constructor(private readonly clock: ManualClock) {}
  waitForTap(
    ids: readonly string[],
    opts: { anchorMs: number; windowMs: number | null; signal?: AbortSignal },
  ): Promise<TapResult> {
    return new Promise((resolve) => {
      this.pending = { ids, resolve };
      opts.signal?.addEventListener('abort', () => resolve({ kind: 'aborted' }));
    });
  }
  async tap(id: string): Promise<boolean> {
    const p = this.pending;
    if (!p?.ids.includes(id)) return false;
    this.pending = null;
    const tap: RawTap = {
      targetId: id,
      xyNorm: [0.5, 0.5],
      tMs: this.clock.now(),
      pointerType: 'touch',
      activePoints: 1,
      filtered: 'none',
    };
    p.resolve({ kind: 'tap', tap, latencyMs: 0 });
    await flush();
    return true;
  }
}

function setup() {
  const clock = new ManualClock();
  const input = new ScriptedInput(clock);
  const inspectStates: boolean[] = [];
  let reweighDone: () => void = () => undefined;
  const ac = new AbortController();
  const promise = runChoice<'approve' | 'fine'>(
    input as unknown as InputService,
    clock as unknown as Clock,
    {
      options: [
        { code: 'approve', targetId: 'o.approve' },
        { code: 'fine', targetId: 'o.fine' },
      ],
      confirmId: 'confirm',
      inspectId: 'inspect',
      goMs: 0,
      anchor: Promise.resolve({ anchorMs: 0, anchor: 'go_signal' }),
      windowMs: 8000,
      signal: ac.signal,
      setInspectEnabled: (e) => inspectStates.push(e),
      onInspect: () =>
        new Promise<void>((r) => {
          reweighDone = r;
        }),
    },
  );
  return { clock, input, inspectStates, promise, finishReweigh: () => reweighDone(), ac };
}

describe('runChoice', () => {
  it('counts revisions, inspections and commits with latency from the anchor', async () => {
    const s = setup();
    await flush();
    await s.clock.advance(500);
    expect(await s.input.tap('inspect')).toBe(true);
    s.finishReweigh();
    await flush();
    await s.clock.advance(500);
    expect(await s.input.tap('o.fine')).toBe(true);
    expect(await s.input.tap('o.approve')).toBe(true);
    await s.clock.advance(250);
    expect(await s.input.tap('confirm')).toBe(true);
    const out = await s.promise;
    expect(out.kind).toBe('response');
    expect(out.value).toBe('approve');
    expect(out.revisions.map((r) => r.value)).toEqual(['fine', 'approve']);
    expect(out.inspections).toBe(1);
    expect(out.latencyMs).toBe(1250);
    expect(s.inspectStates).toEqual([false, true]);
  });

  it('listens to the inspect target again once a re-weigh finishes (second re-weigh)', async () => {
    const s = setup();
    await flush();
    expect(await s.input.tap('inspect')).toBe(true);
    s.finishReweigh();
    await flush();
    // No other tap in between: the live wait must already include the re-enabled inspect target.
    expect(await s.input.tap('inspect')).toBe(true);
    s.finishReweigh();
    await flush();
    expect(await s.input.tap('o.fine')).toBe(true);
    expect(await s.input.tap('confirm')).toBe(true);
    const out = await s.promise;
    expect(out.inspections).toBe(2);
    expect(s.inspectStates).toEqual([false, true, false, true]);
  });

  it('does not re-enable inspect when a re-weigh finishes after the commit', async () => {
    const s = setup();
    await flush();
    expect(await s.input.tap('inspect')).toBe(true);
    // Committing is allowed while the re-weigh is still running.
    expect(await s.input.tap('o.fine')).toBe(true);
    expect(await s.input.tap('confirm')).toBe(true);
    const out = await s.promise;
    expect(out.kind).toBe('response');
    s.finishReweigh();
    await flush();
    expect(s.inspectStates).toEqual([false]);
  });

  it('times out exactly at anchor + window with a null value', async () => {
    const s = setup();
    await flush();
    await s.clock.advance(7999);
    expect(await s.input.tap('o.fine')).toBe(true);
    await s.clock.advance(1);
    const out = await s.promise;
    expect(out.kind).toBe('timeout');
    expect(out.value).toBeNull();
    expect(out.latencyMs).toBeNull();
  });
});
