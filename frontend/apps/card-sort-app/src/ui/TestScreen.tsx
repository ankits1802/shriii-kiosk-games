import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioPlayer } from '../audio/slots.ts';
import { type Card, KEY_CARDS, KEY_INDICES, type KeyIndex } from '../domain/cards.ts';
import { currentCard, type EngineState } from '../domain/engine.ts';
import { CardFace } from './CardFace.tsx';

export interface TestScreenProps {
  readonly engine: EngineState;
  readonly feedbackMs: number;
  readonly audio: AudioPlayer;
  /** Persist and apply the response. */
  readonly onRespond: (
    key: KeyIndex,
    latencyMs: number,
  ) => Promise<{ correct: boolean; finished: boolean }>;
  /** Called after the last feedback has been shown. */
  readonly onFinished: () => void;
  /** Hidden administrator control (long press) to pause/abort. */
  readonly onAdminRequest: () => void;
}

const LONG_PRESS_MS = 1500;

/** Participant-facing sorting screen: pictures only, no text to read. */
export function TestScreen({
  engine,
  feedbackMs,
  audio,
  onRespond,
  onFinished,
  onAdminRequest,
}: TestScreenProps) {
  const [held, setHeld] = useState<Card | null>(null);
  const card = held ?? currentCard(engine);
  const shownAt = useRef(performance.now());
  const [feedback, setFeedback] = useState<'correct' | 'incorrect' | null>(null);
  const [busy, setBusy] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start the latency clock when a new card becomes visible (after feedback has cleared).
  const visibleTrial = held ? -1 : engine.trials.length;
  useEffect(() => {
    if (visibleTrial >= 0) shownAt.current = performance.now();
  }, [visibleTrial]);

  const choose = useCallback(
    async (k: KeyIndex) => {
      if (busy || !card) return;
      setBusy(true);
      const latency = performance.now() - shownAt.current;
      setHeld(card);
      let finished = false;
      try {
        const res = await onRespond(k, latency);
        finished = res.finished;
        setFeedback(res.correct ? 'correct' : 'incorrect');
        audio.tone(res.correct ? 'correct' : 'incorrect');
        await new Promise((r) => setTimeout(r, feedbackMs));
      } finally {
        setFeedback(null);
        setHeld(null);
        setBusy(false);
      }
      if (finished) onFinished();
    },
    [busy, card, onRespond, onFinished, audio, feedbackMs],
  );

  const startPress = () => {
    press.current = setTimeout(onAdminRequest, LONG_PRESS_MS);
  };
  const endPress = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };

  return (
    <div className="test" data-testid="test-screen" data-trial={engine.trials.length + 1}>
      <button
        type="button"
        className="admin-corner"
        aria-label="Administrator (press and hold)"
        onPointerDown={startPress}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="keys">
        {KEY_INDICES.map((k) => (
          <button
            key={k}
            type="button"
            className="key-card"
            data-testid={`key-${k}`}
            aria-label={`Key card ${k + 1}`}
            disabled={busy}
            onClick={() => void choose(k)}
          >
            <CardFace card={KEY_CARDS[k]} />
          </button>
        ))}
      </div>
      <div className="response-area">
        {card && (
          <div className={`response-card ${feedback ? 'dim' : ''}`} data-testid="response-card">
            <CardFace card={card} />
          </div>
        )}
        {feedback && (
          <div
            className={`feedback ${feedback}`}
            data-testid={`feedback-${feedback}`}
            aria-live="polite"
          >
            {feedback === 'correct' ? (
              <svg viewBox="0 0 100 100" role="img" aria-label="correct">
                <circle cx="50" cy="50" r="46" fill="#1b9e4b" />
                <path
                  d="M27 52 L44 68 L74 34"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="10"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 100 100" role="img" aria-label="incorrect">
                <circle cx="50" cy="50" r="46" fill="#d7263d" />
                <path
                  d="M32 32 L68 68 M68 32 L32 68"
                  stroke="#fff"
                  strokeWidth="10"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Participant-facing end screen: a smiley and a "give the tablet back" pictogram. */
export function FinishedScreen({ onAdmin }: { onAdmin: () => void }) {
  return (
    <div className="finished" data-testid="finished-screen">
      <svg viewBox="0 0 120 120" role="img" aria-label="finished" className="smiley">
        <circle cx="60" cy="60" r="56" fill="#f4c20d" stroke="#1d1d1f" strokeWidth="4" />
        <circle cx="42" cy="48" r="7" fill="#1d1d1f" />
        <circle cx="78" cy="48" r="7" fill="#1d1d1f" />
        <path
          d="M34 72 Q60 98 86 72"
          fill="none"
          stroke="#1d1d1f"
          strokeWidth="6"
          strokeLinecap="round"
        />
      </svg>
      <svg viewBox="0 0 160 80" role="img" aria-label="give the tablet back" className="handback">
        <rect
          x="56"
          y="10"
          width="48"
          height="64"
          rx="6"
          fill="#e7e7ec"
          stroke="#1d1d1f"
          strokeWidth="3"
        />
        <path
          d="M14 44 L44 44 M34 32 L46 44 L34 56"
          stroke="#1d1d1f"
          strokeWidth="5"
          fill="none"
          strokeLinecap="round"
        />
        <path d="M116 44 L146 44" stroke="#1d1d1f" strokeWidth="5" strokeLinecap="round" />
      </svg>
      <button type="button" className="btn secondary admin-return" onClick={onAdmin}>
        Administrator
      </button>
    </div>
  );
}
