/**
 * Session lifecycle statechart (KSK-02), XState 5:
 *
 *   attract → languageSelect → consent → bands → practiceWarmup → play → report → survey
 *           → contactOptIn? → farewell → wipe → attract
 *
 * - Fail closed: `bands`, `practiceWarmup` and `play` are unreachable without
 *   `CONSENT_GRANTED{tapConfirmed:true}`; declining or an under-18 band goes straight to `wipe`.
 * - Every state has a hard ceiling (`session-plan.json#/state_ceilings_s`): onboarding ceilings
 *   abandon the session; play/report/survey/opt-in ceilings wrap up gracefully to the next state.
 * - The whole session has a hard cap (`session_cap_s`) after which it ends with `time_cap`.
 * - Walkaway (`IDLE_TIMEOUT`), the exit hand (`EXIT`) and crashes (`CRASH`) end the session from any
 *   state. Crash policy: abandon and keep consented events; there is no resume.
 *
 * The machine holds no I/O: logging, purging and module running are done by the
 * {@link SessionController} subscribing to it. All timers are statechart delays.
 */
import type { LanguageTag, SessionPlan, SessionState } from '@shriii/contracts';
import { assign, type SnapshotFrom, setup } from 'xstate';
import type {
  AbandonReason,
  CalibrationDecision,
  ModuleResult,
  SessionMachineEvent,
} from '../core/contracts.ts';

/** How a session ended (maps to `session_end.reason`). */
export type SessionEndReason =
  | 'completed'
  | 'abandoned'
  | 'withdrawn'
  | 'time_cap'
  | 'under_age'
  | 'consent_declined'
  | 'crash_recovery';

/** Internal events in addition to the public {@link SessionMachineEvent}s. */
export type InternalSessionEvent =
  | { readonly type: 'WIPE_DONE' }
  | { readonly type: 'FAREWELL_DONE' };

export type SessionEvent = SessionMachineEvent | InternalSessionEvent;

/** Timing configuration of the statechart (ms). */
export interface SessionTimers {
  readonly ceilingsMs: Readonly<Record<SessionState, number>>;
  readonly sessionCapMs: number;
  /** How long the farewell screen stays before the wipe. */
  readonly farewellMs: number;
}

export interface SessionMachineContext {
  readonly timers: SessionTimers;
  readonly offerContactOptIn: boolean;
  language: LanguageTag | null;
  consentGranted: boolean;
  archiveOptIn: boolean;
  contactOptIn: boolean;
  calibration: CalibrationDecision | null;
  completedModules: ModuleResult[];
  endReason: SessionEndReason | null;
  abandonReason: AbandonReason | null;
  /** EXIT with erase (in-session withdrawal: purge + tombstone). */
  erase: boolean;
}

const STATES: readonly SessionState[] = [
  'attract',
  'languageSelect',
  'consent',
  'bands',
  'practiceWarmup',
  'play',
  'report',
  'survey',
  'contactOptIn',
  'farewell',
  'wipe',
];

/** Build statechart timers from the session plan. `farewellMs` defaults to the farewell ceiling. */
export function sessionTimersFromPlan(
  plan: SessionPlan,
  overrides: Partial<SessionTimers> = {},
): SessionTimers {
  const ceilingsMs = {} as Record<SessionState, number>;
  for (const s of STATES) {
    const v = plan.state_ceilings_s[s];
    if (v === undefined) throw new RangeError(`session plan has no ceiling for state ${s}`);
    ceilingsMs[s] = v * 1000;
  }
  return {
    ceilingsMs: overrides.ceilingsMs ?? ceilingsMs,
    sessionCapMs: overrides.sessionCapMs ?? plan.session_cap_s * 1000,
    farewellMs: overrides.farewellMs ?? Math.min(ceilingsMs.farewell, 6000),
  };
}

const freshSession = {
  language: null,
  consentGranted: false,
  archiveOptIn: false,
  contactOptIn: false,
  calibration: null,
  completedModules: [],
  endReason: null,
  abandonReason: null,
  erase: false,
} satisfies Omit<SessionMachineContext, 'timers' | 'offerContactOptIn'>;

/** The session statechart. Provide `input` with timers and policy flags. */
export const sessionMachine = setup({
  types: {
    context: {} as SessionMachineContext,
    events: {} as SessionEvent,
    input: {} as { timers: SessionTimers; offerContactOptIn: boolean },
  },
  delays: {
    sessionCap: ({ context }) => context.timers.sessionCapMs,
    languageSelectCeiling: ({ context }) => context.timers.ceilingsMs.languageSelect,
    consentCeiling: ({ context }) => context.timers.ceilingsMs.consent,
    bandsCeiling: ({ context }) => context.timers.ceilingsMs.bands,
    practiceWarmupCeiling: ({ context }) => context.timers.ceilingsMs.practiceWarmup,
    playCeiling: ({ context }) => context.timers.ceilingsMs.play,
    reportCeiling: ({ context }) => context.timers.ceilingsMs.report,
    surveyCeiling: ({ context }) => context.timers.ceilingsMs.survey,
    contactOptInCeiling: ({ context }) => context.timers.ceilingsMs.contactOptIn,
    farewellDelay: ({ context }) => context.timers.farewellMs,
    wipeCeiling: ({ context }) => context.timers.ceilingsMs.wipe,
  },
  guards: {
    tapConfirmed: ({ event }) => event.type === 'CONSENT_GRANTED' && event.tapConfirmed === true,
    consentGranted: ({ context }) => context.consentGranted,
    offerContactOptIn: ({ context }) => context.offerContactOptIn && context.consentGranted,
  },
  actions: {
    reset: assign(() => ({ ...freshSession, completedModules: [] })),
    setLanguage: assign({
      language: ({ context, event }) =>
        event.type === 'LANGUAGE_SELECTED' ? event.language : context.language,
    }),
    grantConsent: assign({
      consentGranted: () => true,
      archiveOptIn: ({ event }) => (event.type === 'CONSENT_GRANTED' ? event.archiveOptIn : false),
    }),
    declineConsent: assign({
      endReason: () => 'consent_declined',
      abandonReason: () => 'consent_declined',
    }),
    underAge: assign({ endReason: () => 'under_age', abandonReason: () => 'under_age' }),
    setCalibration: assign({
      calibration: ({ context, event }) =>
        event.type === 'WARMUP_DONE' ? event.calibration : context.calibration,
    }),
    addModule: assign({
      completedModules: ({ context, event }) =>
        event.type === 'MODULE_DONE'
          ? [...context.completedModules, event.result]
          : context.completedModules,
    }),
    setContact: assign({
      contactOptIn: ({ event }) => event.type === 'OPTIN_DONE' && event.contactOptIn,
    }),
    abandonTimeout: assign({ endReason: () => 'abandoned', abandonReason: () => 'timeout' }),
    exit: assign({
      endReason: ({ event }) => (event.type === 'EXIT' && event.erase ? 'withdrawn' : 'abandoned'),
      abandonReason: () => 'explicit_exit',
      erase: ({ event }) => event.type === 'EXIT' && event.erase,
    }),
    crash: assign({ endReason: () => 'crash_recovery', abandonReason: () => 'crash_recovery' }),
    timeCap: assign({ endReason: () => 'time_cap' }),
    completed: assign({ endReason: ({ context }) => context.endReason ?? 'completed' }),
  },
}).createMachine({
  id: 'session',
  context: ({ input }) => ({ ...freshSession, completedModules: [], ...input }),
  initial: 'attract',
  states: {
    attract: {
      entry: 'reset',
      on: { TOUCH_START: { target: 'active' } },
    },
    active: {
      initial: 'languageSelect',
      after: { sessionCap: { target: 'wipe', actions: 'timeCap' } },
      on: {
        IDLE_TIMEOUT: { target: 'wipe', actions: 'abandonTimeout' },
        EXIT: { target: 'wipe', actions: 'exit' },
        CRASH: { target: 'wipe', actions: 'crash' },
      },
      states: {
        languageSelect: {
          on: { LANGUAGE_SELECTED: { target: 'consent', actions: 'setLanguage' } },
          after: { languageSelectCeiling: { target: '#session.wipe', actions: 'abandonTimeout' } },
        },
        consent: {
          on: {
            LANGUAGE_SELECTED: { actions: 'setLanguage' },
            CONSENT_GRANTED: { guard: 'tapConfirmed', target: 'bands', actions: 'grantConsent' },
            CONSENT_DECLINED: { target: '#session.wipe', actions: 'declineConsent' },
          },
          after: { consentCeiling: { target: '#session.wipe', actions: 'abandonTimeout' } },
        },
        bands: {
          on: {
            BANDS_ANSWERED: { guard: 'consentGranted', target: 'practiceWarmup' },
            UNDER_AGE: { target: '#session.wipe', actions: 'underAge' },
          },
          after: { bandsCeiling: { target: '#session.wipe', actions: 'abandonTimeout' } },
        },
        practiceWarmup: {
          on: {
            WARMUP_DONE: { guard: 'consentGranted', target: 'play', actions: 'setCalibration' },
          },
          after: { practiceWarmupCeiling: { target: '#session.wipe', actions: 'abandonTimeout' } },
        },
        play: {
          on: {
            MODULE_DONE: { actions: 'addModule' },
            PLAY_DONE: { target: 'report' },
          },
          // Graceful wrap-up: the play ceiling moves on to the report.
          after: { playCeiling: { target: 'report' } },
        },
        report: {
          on: { REPORT_DONE: { target: 'survey' } },
          after: { reportCeiling: { target: 'survey' } },
        },
        survey: {
          on: {
            SURVEY_DONE: [
              { guard: 'offerContactOptIn', target: 'contactOptIn' },
              { target: 'farewell' },
            ],
          },
          after: { surveyCeiling: { target: 'farewell' } },
        },
        contactOptIn: {
          on: { OPTIN_DONE: { target: 'farewell', actions: 'setContact' } },
          // Timeout or skip counts as "no" (ONB-03).
          after: { contactOptInCeiling: { target: 'farewell' } },
        },
        farewell: {
          entry: 'completed',
          on: { FAREWELL_DONE: { target: '#session.wipe' } },
          after: { farewellDelay: { target: '#session.wipe' } },
        },
      },
    },
    wipe: {
      on: { WIPE_DONE: { target: 'attract' } },
      after: { wipeCeiling: { target: 'attract' } },
    },
  },
});

export type SessionMachineSnapshot = SnapshotFrom<typeof sessionMachine>;

/** Map a machine snapshot to the contract's state name. */
export function stateNameOf(snapshot: SessionMachineSnapshot): SessionState {
  const value = snapshot.value;
  if (typeof value === 'string') return value;
  const inner = (value as { active?: string }).active;
  return (inner ?? 'languageSelect') as SessionState;
}
