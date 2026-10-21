import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGameContent } from '../../engine/content.ts';
import { WalkawayMonitor, type WalkawayStage, walkawayConfigFromPlan } from '../walkaway.ts';

const config = walkawayConfigFromPlan(loadGameContent().plan);

function setup() {
  const log: string[] = [];
  const monitor = new WalkawayMonitor(
    config,
    {
      onPrompt: (stage: WalkawayStage, idle) =>
        log.push(`prompt:${stage}@${Math.round(idle / 1000)}`),
      onResume: (stage: WalkawayStage, idle) =>
        log.push(`resume:${stage}@${Math.round(idle / 1000)}`),
      onAbandon: (idle) => log.push(`abandon@${Math.round(idle / 1000)}`),
    },
    () => Date.now(),
  );
  return { log, monitor };
}

describe('walkaway (KSK-04)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses the plan timers: 8 s, 20 s, 45 s, abandon 10 s later', () => {
    expect(config).toMatchObject({
      repromptMs: 8000,
      stillThereMs: 20000,
      countdownMs: 45000,
      abandonAfterCountdownMs: 10000,
    });
  });

  it('escalates re-prompt -> still there -> countdown -> abandon', () => {
    const { log, monitor } = setup();
    monitor.start('public');
    vi.advanceTimersByTime(7999);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(['prompt:reprompt@8']);
    expect(monitor.stage).toBe('reprompt');
    vi.advanceTimersByTime(12_000);
    expect(log.at(-1)).toBe('prompt:still_there@20');
    vi.advanceTimersByTime(25_000);
    expect(log.at(-1)).toBe('prompt:countdown@45');
    vi.advanceTimersByTime(9_999);
    expect(log).not.toContain('abandon@55');
    vi.advanceTimersByTime(1);
    expect(log.at(-1)).toBe('abandon@55');
  });

  it('a touch resets the idle timer and logs a resume when a prompt was showing', () => {
    const { log, monitor } = setup();
    monitor.start('public');
    vi.advanceTimersByTime(5000);
    monitor.activity();
    vi.advanceTimersByTime(7000);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(14_000); // 21 s since the touch
    expect(log).toEqual(['prompt:reprompt@8', 'prompt:still_there@20']);
    monitor.activity();
    expect(log.at(-1)).toBe('resume:still_there@21');
    expect(monitor.stage).toBeNull();
    vi.advanceTimersByTime(7999);
    expect(log).toHaveLength(3);
  });

  it('does not count idle time inside a timed response window', () => {
    const { log, monitor } = setup();
    monitor.start('public');
    vi.advanceTimersByTime(4000);
    monitor.windowOpen();
    vi.advanceTimersByTime(120_000);
    expect(log).toEqual([]);
    monitor.windowClose();
    vi.advanceTimersByTime(8000);
    expect(log).toEqual(['prompt:reprompt@8']);
  });

  it('is disabled in think-aloud mode and stops cleanly', () => {
    const { log, monitor } = setup();
    monitor.start('think_aloud');
    vi.advanceTimersByTime(200_000);
    expect(log).toEqual([]);
    monitor.start('public');
    monitor.stop();
    vi.advanceTimersByTime(200_000);
    expect(log).toEqual([]);
  });

  it('can be driven to any stage by the devtools', () => {
    const { log, monitor } = setup();
    monitor.start('public');
    monitor.simulate('countdown');
    expect(monitor.stage).toBe('countdown');
    vi.advanceTimersByTime(10_000);
    expect(log.at(-1)?.startsWith('abandon')).toBe(true);
  });
});
