/**
 * Development panel (PLT-01 / KSK-13 dev stand-in). Opened by five taps in the top-left corner within
 * three seconds followed by a PIN. Lets developers jump to any module/episode, set the language and
 * calibration level, inspect the outbox and uploader, force an upload and simulate walkaway.
 * Never mount this in production builds (apps gate it behind `import.meta.env.DEV`).
 */
import type { CalibrationLevel, LanguageTag } from '@shriii/contracts';
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from 'react';
import type { ModuleId } from '../../core/contracts.ts';
import type { OutboxStats } from '../../logging/outbox/types.ts';
import type { UploaderStatus } from '../../logging/uploader.ts';
import type { KioskRuntime } from '../runtime.ts';
import type { KioskSessionView } from '../session-controller.ts';

export interface DevPanelProps {
  readonly runtime: KioskRuntime | null;
  /** PIN required after the corner gesture. */
  readonly pin: string;
  /** Taps needed in the corner (default 5) within `windowMs` (default 3000). */
  readonly taps?: number;
  readonly windowMs?: number;
}

const ALL_MODULES: readonly ModuleId[] = [
  'warmup',
  'dont_tap',
  'card_sort',
  'balloon',
  'tower',
  'share_pot',
  'wait_or_now',
  'steady_hands',
  'four_stalls',
  'private_dice',
  'stall',
  'weighing_post',
  'road_home',
  'coplay',
];

const panel: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  bottom: 0,
  width: 'min(440px, 100vw)',
  overflowY: 'auto',
  background: 'rgba(20,20,20,0.94)',
  color: '#f5f5f5',
  font: '13px/1.4 ui-monospace, Menlo, Consolas, monospace',
  padding: 12,
  zIndex: 1000,
  boxSizing: 'border-box',
};
const btn: CSSProperties = {
  margin: 2,
  padding: '6px 8px',
  background: '#333',
  color: '#fff',
  border: '1px solid #555',
  borderRadius: 4,
  font: 'inherit',
  cursor: 'pointer',
};

export function DevPanel({
  runtime,
  pin,
  taps = 5,
  windowMs = 3000,
}: DevPanelProps): ReactElement | null {
  const [stage, setStage] = useState<'closed' | 'pin' | 'open'>('closed');
  const [entered, setEntered] = useState('');
  const tapTimes = useRef<number[]>([]);
  const [view, setView] = useState<KioskSessionView | null>(null);
  const [stats, setStats] = useState<OutboxStats | null>(null);
  const [upload, setUpload] = useState<UploaderStatus | null>(null);

  useEffect(() => {
    if (!runtime || stage !== 'open') return;
    const unsubView = runtime.controller.subscribe(setView);
    const unsubUp = runtime.uploader.subscribe(setUpload);
    let alive = true;
    const poll = (): void => {
      void runtime.outbox.stats().then((s) => {
        if (alive) setStats(s);
      });
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      unsubView();
      unsubUp();
    };
  }, [runtime, stage]);

  const onCorner = (): void => {
    const now = performance.now();
    tapTimes.current = [...tapTimes.current.filter((t) => now - t < windowMs), now];
    if (tapTimes.current.length >= taps) {
      tapTimes.current = [];
      setEntered('');
      setStage('pin');
    }
  };

  const corner = (
    <div
      data-testid="dev-corner"
      onPointerUp={(e) => {
        e.stopPropagation();
        onCorner();
      }}
      style={{ position: 'absolute', top: 0, left: 0, width: 64, height: 64, zIndex: 999 }}
    />
  );

  if (stage === 'closed') return corner;

  if (stage === 'pin') {
    const press = (d: string): void => {
      const next = entered + d;
      if (next === pin) setStage('open');
      else if (next.length >= pin.length) setEntered('');
      else setEntered(next);
    };
    return (
      <div style={{ ...panel, width: 260 }} data-testid="dev-pin">
        <div>PIN {'•'.repeat(entered.length)}</div>
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginTop: 8 }}
        >
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => (
            <button key={d} type="button" style={{ ...btn, padding: 14 }} onClick={() => press(d)}>
              {d}
            </button>
          ))}
          <button type="button" style={btn} onClick={() => setStage('closed')}>
            close
          </button>
        </div>
      </div>
    );
  }

  const c = runtime?.controller;
  const levels: CalibrationLevel[] = ['L1', 'L2', 'L3'];
  return (
    <div style={panel} data-testid="dev-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <strong>SHRIII dev panel</strong>
        <button type="button" style={btn} onClick={() => setStage('closed')}>
          close
        </button>
      </div>
      <section>
        <h4>Session</h4>
        <div>state: {view?.state}</div>
        <div>session: {view?.sessionId || '-'}</div>
        <div>seed: {view?.seedHex ?? '-'}</div>
        <div>
          arm {view?.arm ?? '-'} · slot {view?.slotForm ?? '-'} · form {view?.formId || '-'}
        </div>
        <div>
          level {view?.calibration?.level ?? '-'} ({view?.calibration?.reason ?? '-'}) · lang{' '}
          {view?.language ?? '-'}
        </div>
        <div>module: {view?.currentModule ?? '-'}</div>
        <div>
          done:{' '}
          {view?.completedModules.map((m) => `${m.moduleId}:${m.endedReason}`).join(', ') || '-'}
        </div>
        <button type="button" style={btn} onClick={() => c?.devQuickStart()}>
          quick start
        </button>
        <button type="button" style={btn} onClick={() => c?.skipCurrentModule()}>
          skip module
        </button>
        <button type="button" style={btn} onClick={() => c?.send({ type: 'EXIT', erase: false })}>
          end (keep)
        </button>
        <button type="button" style={btn} onClick={() => c?.send({ type: 'EXIT', erase: true })}>
          end (delete)
        </button>
      </section>
      <section>
        <h4>Jump to module</h4>
        {ALL_MODULES.map((m) => (
          <button key={m} type="button" style={btn} onClick={() => c?.devJumpToModule(m)}>
            {m}
          </button>
        ))}
      </section>
      <section>
        <h4>Language</h4>
        {(runtime?.device.languages ?? []).map((l: LanguageTag) => (
          <button key={l} type="button" style={btn} onClick={() => c?.devSetLanguage(l)}>
            {l}
          </button>
        ))}
      </section>
      <section>
        <h4>Calibration level</h4>
        {levels.map((l) => (
          <button key={l} type="button" style={btn} onClick={() => c?.devSetCalibration(l)}>
            {l}
          </button>
        ))}
      </section>
      <section>
        <h4>Walkaway</h4>
        {(['reprompt', 'still_there', 'countdown', 'abandon'] as const).map((s) => (
          <button key={s} type="button" style={btn} onClick={() => c?.devSimulateWalkaway(s)}>
            {s}
          </button>
        ))}
        <div>stage: {view?.walkawayStage ?? '-'}</div>
      </section>
      <section>
        <h4>Outbox / uploader</h4>
        {stats && (
          <div>
            pending {stats.pendingEvents} · in flight {stats.inflightEvents} · acked{' '}
            {stats.acknowledgedEvents}
            <br />
            sessions {stats.sessions} (awaiting consent {stats.sessionsAwaitingConsent}) · open
            batches {stats.openBatches}
            <br />
            declined {stats.declinedCount} · last ack{' '}
            {stats.lastAckAt ? new Date(stats.lastAckAt).toLocaleTimeString() : '-'}
          </div>
        )}
        {upload && (
          <div>
            uploader {upload.state} → {upload.endpoint ?? 'no API base (offline)'}
            <br />
            failures {upload.consecutiveFailures} · sent {upload.batchesSent}
            {upload.lastError ? ` · ${upload.lastError}` : ''}
          </div>
        )}
        <button type="button" style={btn} onClick={() => void runtime?.uploader.uploadOnce()}>
          upload now
        </button>
      </section>
    </div>
  );
}
