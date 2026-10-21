import { checkEventInvariants, type EventEnvelope, validateEvent } from '@shriii/contracts';
import minimalSession from '@shriii/contracts/fixtures/sessions/minimal-session.json' with {
  type: 'json',
};
import { render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  abortReasonOf,
  KioskGame,
  type SayOrTouchResult,
  TOUCH_SPACING_MIN_MM,
  TOUCH_TARGET_MIN_MM,
  toResponsePayload,
} from '../src/index.ts';

const responseTemplate = (minimalSession as unknown as EventEnvelope[]).find(
  (e) => e.event_type === 'response',
);
if (!responseTemplate) throw new Error('fixture missing response event');

function withPayload(payload: ReturnType<typeof toResponsePayload>): EventEnvelope {
  return { ...responseTemplate, payload } as EventEnvelope;
}

const base: SayOrTouchResult<'serve' | 'withhold'> = {
  kind: 'response',
  value: 'serve',
  inputMode: 'touch',
  latencyMs: 412.6,
  bargeIn: false,
  responseMs: 184629.3,
  revisions: [],
  tapCount: 1,
  touchXyNorm: [0.42, 0.71],
  asrLabel: null,
  asrConfidence: null,
};

describe('toResponsePayload', () => {
  it('produces a schema-valid response payload that satisfies the invariants', () => {
    const payload = toResponsePayload(base, {
      stimulusId: 'stall.item.spoiled_mango',
      correctness: false,
      latencyAnchor: 'visual_onset',
    });
    const event = withPayload(payload);
    expect(validateEvent(event).ok).toBe(true);
    expect(checkEventInvariants(event)).toEqual([]);
  });

  it('maps timeouts to input_mode timeout with null latency and value', () => {
    const payload = toResponsePayload(
      {
        ...base,
        kind: 'timeout',
        value: null,
        latencyMs: null,
        responseMs: null,
        tapCount: 0,
        touchXyNorm: null,
      },
      { stimulusId: null, correctness: true, latencyAnchor: 'audio_end' },
    );
    expect(payload.input_mode).toBe('timeout');
    expect(payload.latency_ms).toBeNull();
    expect(payload.response_value).toBeNull();
    expect(payload.correctness).toBeNull();
    expect(checkEventInvariants(withPayload(payload))).toEqual([]);
  });

  it('refuses aborted prompts', () => {
    expect(() =>
      toResponsePayload(
        { ...base, kind: 'aborted' },
        { stimulusId: null, correctness: null, latencyAnchor: 'go_signal' },
      ),
    ).toThrow();
  });

  it('keeps any signed latency valid and consistent with barge_in (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -2000, max: 10000, noNaN: true }),
        fc.boolean(),
        (latency, voiced) => {
          const payload = toResponsePayload(
            {
              ...base,
              latencyMs: latency,
              bargeIn: latency < 0,
              inputMode: voiced ? 'voice_then_touch_confirm' : 'touch',
              asrLabel: voiced ? 'serve' : null,
              asrConfidence: voiced ? 0.9 : null,
            },
            {
              stimulusId: 'stall.item.spoiled_mango',
              correctness: null,
              latencyAnchor: 'audio_end',
            },
          );
          const event = withPayload(payload);
          return validateEvent(event).ok && checkEventInvariants(event).length === 0;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('abortReasonOf', () => {
  it('returns null for live signals and the typed reason otherwise', () => {
    const live = new AbortController();
    expect(abortReasonOf(live.signal)).toBeNull();
    const walk = new AbortController();
    walk.abort({ kind: 'walkaway' });
    expect(abortReasonOf(walk.signal)).toEqual({ kind: 'walkaway' });
    const odd = new AbortController();
    odd.abort(new Error('boom'));
    expect(abortReasonOf(odd.signal)).toEqual({ kind: 'crash' });
  });
});

describe('constants and root component', () => {
  it('exposes the plan touch-target geometry', () => {
    expect(TOUCH_TARGET_MIN_MM).toBe(20);
    expect(TOUCH_SPACING_MIN_MM).toBe(8);
  });

  it('renders the full-screen root with no text', () => {
    render(<KioskGame mode="pilot" siteMode="supervised" />);
    const root = screen.getByTestId('kiosk-game-root');
    expect(root.dataset.mode).toBe('pilot');
    expect(root.textContent).toBe('');
    expect(screen.getByTestId('kiosk-stage-host')).toBeTruthy();
  });
});
