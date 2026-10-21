import { describe, expect, it, vi } from 'vitest';
import { GatedLogger, LoggerGate, warnOnLateEvents } from '../gated-logger.ts';
import { MemoryOutbox } from '../outbox/memory-outbox.ts';
import { testLogger } from './helpers.ts';

describe('GatedLogger (no events after module_end)', () => {
  it('forwards while open, drops (logger and children) once closed', async () => {
    const outbox = new MemoryOutbox({ kioskId: 'kiosk-test' });
    const logger = testLogger(outbox);
    const dropped: string[] = [];
    const gate = new LoggerGate('dont_tap', (type, label) => dropped.push(`${label}:${type}`));
    const gated = new GatedLogger(logger, gate, () => 123);
    const child = gated.child({ scorable: false });
    const ok = gated.log('idle', { duration_ms: 1, state: 'play', after_response_window: true });
    expect(ok.valid).toBe(true);
    expect(ok.seq).toBeGreaterThanOrEqual(0);
    gate.close();
    expect(gate.closed).toBe(true);
    const late = gated.log('idle', { duration_ms: 2, state: 'play', after_response_window: true });
    const lateChild = child.log('idle', {
      duration_ms: 3,
      state: 'play',
      after_response_window: true,
    });
    expect(late).toEqual({ eventId: '', seq: -1, tMonoMs: 123, valid: false });
    expect(lateChild.valid).toBe(false);
    expect(gate.dropped).toBe(2);
    expect(dropped).toEqual(['dont_tap:idle', 'dont_tap:idle']);
    await gated.flush();
    const rows = (await outbox.sessionEvents(logger.sessionId)) as { event_type: string }[];
    expect(rows.filter((r) => r.event_type === 'idle')).toHaveLength(1);
    // The un-gated logger keeps working (the host logs module_end through it).
    expect(
      logger.log('idle', { duration_ms: 4, state: 'play', after_response_window: true }).valid,
    ).toBe(true);
  });

  it('dev reporter warns once per module and event type', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const report = warnOnLateEvents();
    report('idle', 'tower');
    report('idle', 'tower');
    report('response', 'tower');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
