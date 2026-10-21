/**
 * Icon-only fallback screens for the session states the onboarding/report agents own (attract,
 * language, consent, bands, report, survey, opt-in, farewell). They are deliberately plain: real
 * screens plug in through `KioskRuntimeView`'s `screens` prop. Every target is >= 20 mm (sized in
 * mm via the layout's px-per-mm) and there is no text or numeral anywhere.
 */
import type { LanguageTag, SessionState } from '@shriii/contracts';
import {
  type ComponentType,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useState,
} from 'react';
import type {
  KioskSessionView,
  SessionController,
  SessionControllerEvent,
} from '../session-controller.ts';
import { Icon, type IconName } from './Icon.tsx';

/** Props every session screen receives. */
export interface KioskScreenProps {
  readonly view: KioskSessionView;
  readonly controller: SessionController;
  /** Send an event (also unlocks audio on the first touch). */
  readonly send: (event: SessionControllerEvent) => void;
  /** Stage px per mm (size targets in mm). */
  readonly pxPerMm: number;
}

export type ScreenMap = Partial<Record<SessionState, ComponentType<KioskScreenProps>>>;

const COLORS = {
  confirm: '#009e73',
  cancel: '#d55e00',
  accent: '#0072b2',
  paper: '#fff8ec',
  ink: '#1d1d1b',
};
const LANGUAGE_COLORS = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00'];

const centre: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-end',
  paddingBottom: '12vh',
  gap: '6vh',
};

function Row({ children }: { readonly children: ReactNode }): ReactElement {
  return <div style={{ display: 'flex', gap: '6vw', alignItems: 'center' }}>{children}</div>;
}

function BigButton(props: {
  readonly icon: IconName;
  readonly color: string;
  readonly onTap: () => void;
  readonly pxPerMm: number;
  readonly sizeMm?: number;
  readonly id: string;
}): ReactElement {
  const px = Math.round((props.sizeMm ?? 34) * props.pxPerMm);
  return (
    <button
      type="button"
      data-target={props.id}
      onPointerUp={props.onTap}
      style={{
        width: px,
        height: px,
        borderRadius: '50%',
        border: `${Math.round(px * 0.05)}px solid ${COLORS.paper}`,
        background: props.color,
        color: COLORS.paper,
        display: 'grid',
        placeItems: 'center',
        cursor: 'pointer',
        boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        touchAction: 'none',
        padding: 0,
      }}
    >
      <Icon name={props.icon} size={px * 0.6} />
    </button>
  );
}

function Attract({ send }: KioskScreenProps): ReactElement {
  return (
    <div
      style={{ ...centre, justifyContent: 'center', cursor: 'pointer' }}
      onPointerUp={() => send({ type: 'TOUCH_START' })}
      data-target="attract.touch"
    >
      <div style={{ color: COLORS.paper, animation: 'shriii-pulse 2s ease-in-out infinite' }}>
        <Icon name="hand" size={220} />
      </div>
    </div>
  );
}

function LanguageSelect({ view, send, pxPerMm }: KioskScreenProps): ReactElement {
  return (
    <div style={centre}>
      <Row>
        {view.languageFaceOrder.map((lang: LanguageTag, i) => (
          <BigButton
            key={lang}
            id={`language.${lang}`}
            icon="face_happy"
            color={LANGUAGE_COLORS[i % LANGUAGE_COLORS.length] ?? COLORS.accent}
            pxPerMm={pxPerMm}
            onTap={() => send({ type: 'LANGUAGE_SELECTED', language: lang, taps: 1 })}
          />
        ))}
      </Row>
    </div>
  );
}

function Consent({ send, pxPerMm }: KioskScreenProps): ReactElement {
  const [archive, setArchive] = useState(false);
  return (
    <div style={centre}>
      <BigButton
        id="consent.archive"
        icon={archive ? 'box_checked' : 'box'}
        color={COLORS.accent}
        sizeMm={24}
        pxPerMm={pxPerMm}
        onTap={() => setArchive((a) => !a)}
      />
      <Row>
        <BigButton
          id="consent.decline"
          icon="cross"
          color={COLORS.cancel}
          pxPerMm={pxPerMm}
          onTap={() => send({ type: 'CONSENT_DECLINED' })}
        />
        <BigButton
          id="consent.grant"
          icon="tick"
          color={COLORS.confirm}
          pxPerMm={pxPerMm}
          onTap={() => send({ type: 'CONSENT_GRANTED', tapConfirmed: true, archiveOptIn: archive })}
        />
      </Row>
    </div>
  );
}

function Bands({ send, pxPerMm }: KioskScreenProps): ReactElement {
  return (
    <div style={centre}>
      <Row>
        <BigButton
          id="bands.child"
          icon="child"
          color={COLORS.cancel}
          pxPerMm={pxPerMm}
          onTap={() => send({ type: 'UNDER_AGE' })}
        />
        <BigButton
          id="bands.adult"
          icon="adult"
          color={COLORS.confirm}
          pxPerMm={pxPerMm}
          onTap={() =>
            send({
              type: 'BANDS_ANSWERED',
              bands: {
                age: 'prefer_not_to_say',
                literacy: 'prefer_not_to_say',
                edu: 'prefer_not_to_say',
                gender: 'prefer_not_to_say',
                device_use: 'prefer_not_to_say',
                played_before: 'prefer_not_to_say',
              },
            })
          }
        />
      </Row>
    </div>
  );
}

function Report({ send, pxPerMm }: KioskScreenProps): ReactElement {
  return (
    <div style={centre}>
      <div style={{ color: '#ffd166' }}>
        <Icon name="sun" size={200} />
      </div>
      <BigButton
        id="report.done"
        icon="tick"
        color={COLORS.confirm}
        pxPerMm={pxPerMm}
        onTap={() => send({ type: 'REPORT_DONE' })}
      />
    </div>
  );
}

function Survey({ send, pxPerMm }: KioskScreenProps): ReactElement {
  const [enjoy, setEnjoy] = useState<'happy' | 'neutral' | 'sad' | null>(null);
  if (enjoy === null) {
    return (
      <div style={centre}>
        <Row>
          <BigButton
            id="survey.sad"
            icon="face_sad"
            color={COLORS.cancel}
            pxPerMm={pxPerMm}
            onTap={() => setEnjoy('sad')}
          />
          <BigButton
            id="survey.neutral"
            icon="face_neutral"
            color={COLORS.accent}
            pxPerMm={pxPerMm}
            onTap={() => setEnjoy('neutral')}
          />
          <BigButton
            id="survey.happy"
            icon="face_happy"
            color={COLORS.confirm}
            pxPerMm={pxPerMm}
            onTap={() => setEnjoy('happy')}
          />
        </Row>
      </div>
    );
  }
  return (
    <div style={centre}>
      <Row>
        <BigButton
          id="survey.again_no"
          icon="cross"
          color={COLORS.cancel}
          pxPerMm={pxPerMm}
          onTap={() => send({ type: 'SURVEY_DONE', enjoy, playAgain: 'no' })}
        />
        <BigButton
          id="survey.again_yes"
          icon="tick"
          color={COLORS.confirm}
          pxPerMm={pxPerMm}
          onTap={() => send({ type: 'SURVEY_DONE', enjoy, playAgain: 'yes' })}
        />
      </Row>
    </div>
  );
}

function ContactOptIn({ send, pxPerMm }: KioskScreenProps): ReactElement {
  return (
    <div style={centre}>
      <Icon name="phone" size={160} style={{ color: COLORS.paper }} />
      <Row>
        <BigButton
          id="optin.no"
          icon="cross"
          color={COLORS.cancel}
          pxPerMm={pxPerMm}
          onTap={() => send({ type: 'OPTIN_DONE', contactOptIn: false })}
        />
        <BigButton
          id="optin.yes"
          icon="tick"
          color={COLORS.confirm}
          pxPerMm={pxPerMm}
          onTap={() => send({ type: 'OPTIN_DONE', contactOptIn: true })}
        />
      </Row>
    </div>
  );
}

function Farewell(): ReactElement {
  return (
    <div style={{ ...centre, justifyContent: 'center', color: COLORS.paper }}>
      <Icon name="hand" size={220} />
    </div>
  );
}

/** Default screens per state (play/warm-up render on the Pixi stage; wipe is blank). */
export const FALLBACK_SCREENS: ScreenMap = {
  attract: Attract,
  languageSelect: LanguageSelect,
  consent: Consent,
  bands: Bands,
  report: Report,
  survey: Survey,
  contactOptIn: ContactOptIn,
  farewell: Farewell,
};

/** Persistent "hand" stop control (ONB-06): keep or delete. */
export function ExitControl({
  send,
  pxPerMm,
}: Pick<KioskScreenProps, 'send' | 'pxPerMm'>): ReactElement {
  const [open, setOpen] = useState(false);
  const size = Math.round(22 * pxPerMm);
  return (
    <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 16, zIndex: 20 }}>
      {open && (
        <>
          <BigButton
            id="exit.delete"
            icon="bin"
            color={COLORS.cancel}
            sizeMm={22}
            pxPerMm={pxPerMm}
            onTap={() => send({ type: 'EXIT', erase: true })}
          />
          <BigButton
            id="exit.keep"
            icon="keep"
            color={COLORS.confirm}
            sizeMm={22}
            pxPerMm={pxPerMm}
            onTap={() => send({ type: 'EXIT', erase: false })}
          />
        </>
      )}
      <button
        type="button"
        data-target="exit.hand"
        onPointerUp={() => setOpen((o) => !o)}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          border: 'none',
          background: 'rgba(29,29,27,0.55)',
          color: COLORS.paper,
          display: 'grid',
          placeItems: 'center',
          padding: 0,
        }}
      >
        <Icon name="hand" size={size * 0.6} />
      </button>
    </div>
  );
}

/** Walkaway overlay: re-prompt pulse, "still there?" and a shrinking countdown ring (no numbers). */
export function WalkawayOverlay({
  stage,
}: {
  readonly stage: KioskSessionView['walkawayStage'];
}): ReactElement | null {
  if (!stage) return null;
  const veil: CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    background: stage === 'reprompt' ? 'transparent' : 'rgba(29,29,27,0.45)',
    pointerEvents: 'none',
    zIndex: 30,
    color: COLORS.paper,
  };
  if (stage === 'reprompt') {
    return (
      <div style={veil}>
        <div style={{ animation: 'shriii-pulse 1s ease-in-out infinite' }}>
          <Icon name="hand" size={160} />
        </div>
      </div>
    );
  }
  return (
    <div style={veil}>
      <div
        style={{
          position: 'relative',
          width: 260,
          height: 260,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        {stage === 'countdown' && (
          <svg
            viewBox="0 0 100 100"
            width={260}
            height={260}
            style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}
            aria-hidden="true"
          >
            <circle
              cx="50"
              cy="50"
              r="46"
              fill="none"
              stroke="currentColor"
              strokeWidth="6"
              strokeDasharray="289"
              style={{ animation: 'shriii-ring 10s linear forwards' }}
            />
          </svg>
        )}
        <Icon name="question" size={150} />
      </div>
    </div>
  );
}

/** Keyframes used by the fallback shell (no flashing above 3 Hz). */
export const FALLBACK_CSS = `
@keyframes shriii-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
@keyframes shriii-ring { from { stroke-dashoffset: 0; } to { stroke-dashoffset: 289; } }
`;
