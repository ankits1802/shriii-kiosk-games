/**
 * Idle / walkaway / abandon statechart (KSK-04), XState 5.
 *
 * Thresholds are cumulative idle times from `session-plan.json#/walkaway` (defaults 8 s re-prompt,
 * 20 s "still there?", 45 s countdown, abandon 10 s after the countdown starts). Idle time counts
 * only outside timed response windows; any touch resets it (and logs `walkaway.resumed` if a prompt
 * was showing). Walkaway is disabled in the modes listed in `disabled_in_modes` (think-aloud).
 */
import type { SessionMode, SessionPlan } from '@shriii/contracts';
import { type Actor, assign, createActor, setup } from 'xstate';

export type WalkawayStage = 'reprompt' | 'still_there' | 'countdown';

/** Walkaway timing in ms (cumulative idle thresholds). */
export interface WalkawayConfig {
  readonly repromptMs: number;
  readonly stillThereMs: number;
  readonly countdownMs: number;
  readonly abandonAfterCountdownMs: number;
  readonly disabledInModes: readonly SessionMode[];
}

/** Read the walkaway timers from the session plan (seconds -> ms). */
export function walkawayConfigFromPlan(plan: SessionPlan): WalkawayConfig {
  const w = plan.walkaway;
  if (!(w.reprompt_s < w.still_there_s && w.still_there_s < w.countdown_s)) {
    throw new RangeError('walkaway thresholds must increase: reprompt < still_there < countdown');
  }
  return {
    repromptMs: w.reprompt_s * 1000,
    stillThereMs: w.still_there_s * 1000,
    countdownMs: w.countdown_s * 1000,
    abandonAfterCountdownMs: w.abandon_after_countdown_s * 1000,
    disabledInModes: w.disabled_in_modes,
  };
}

/** Side effects of the walkaway machine. */
export interface WalkawayCallbacks {
  onPrompt(stage: WalkawayStage, elapsedIdleMs: number): void;
  onResume(stage: WalkawayStage, elapsedIdleMs: number): void;
  onAbandon(elapsedIdleMs: number): void;
  /** Idle period ended by a touch after at least the re-prompt threshold (logs `idle`). */
  onIdle?(durationMs: number): void;
}

type WalkawayEvent =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'ACTIVITY' }
  | { type: 'WINDOW_OPEN' }
  | { type: 'WINDOW_CLOSE' }
  | { type: 'SIMULATE'; stage: WalkawayStage | 'abandon' };

interface WalkawayContext {
  readonly config: WalkawayConfig;
  readonly callbacks: WalkawayCallbacks;
  readonly now: () => number;
  idleSince: number;
  stage: WalkawayStage | null;
}

/** The walkaway statechart (exported for model-based tests). */
export const walkawayMachine = setup({
  types: {
    context: {} as WalkawayContext,
    events: {} as WalkawayEvent,
    input: {} as { config: WalkawayConfig; callbacks: WalkawayCallbacks; now: () => number },
  },
  delays: {
    toReprompt: ({ context }) => context.config.repromptMs,
    toStillThere: ({ context }) => context.config.stillThereMs - context.config.repromptMs,
    toCountdown: ({ context }) => context.config.countdownMs - context.config.stillThereMs,
    toAbandon: ({ context }) => context.config.abandonAfterCountdownMs,
  },
  actions: {
    markIdle: assign({ idleSince: ({ context }) => context.now(), stage: () => null }),
    prompt: assign({
      stage: (_, params: { stage: WalkawayStage }) => params.stage,
    }),
    notifyPrompt: ({ context }, params: { stage: WalkawayStage }) => {
      context.callbacks.onPrompt(params.stage, context.now() - context.idleSince);
    },
    notifyResume: ({ context }) => {
      const elapsed = context.now() - context.idleSince;
      if (context.stage) context.callbacks.onResume(context.stage, elapsed);
      if (elapsed >= context.config.repromptMs) context.callbacks.onIdle?.(elapsed);
    },
    notifyAbandon: ({ context }) => {
      context.callbacks.onAbandon(context.now() - context.idleSince);
    },
  },
}).createMachine({
  id: 'walkaway',
  context: ({ input }) => ({ ...input, idleSince: input.now(), stage: null }),
  initial: 'inactive',
  states: {
    inactive: {
      on: { START: { target: 'monitoring' } },
    },
    monitoring: {
      initial: 'counting',
      on: {
        STOP: { target: 'inactive' },
        WINDOW_OPEN: { target: '.window' },
        SIMULATE: [
          { guard: ({ event }) => event.stage === 'reprompt', target: '.reprompt' },
          { guard: ({ event }) => event.stage === 'still_there', target: '.stillThere' },
          { guard: ({ event }) => event.stage === 'countdown', target: '.countdown' },
          { target: '.abandoned' },
        ],
      },
      states: {
        window: {
          entry: assign({ stage: () => null }),
          on: {
            WINDOW_CLOSE: { target: 'counting' },
            ACTIVITY: {},
          },
        },
        counting: {
          entry: 'markIdle',
          on: { ACTIVITY: { target: 'counting', reenter: true, actions: 'notifyResume' } },
          after: { toReprompt: { target: 'reprompt' } },
        },
        reprompt: {
          entry: [
            { type: 'prompt', params: { stage: 'reprompt' } },
            { type: 'notifyPrompt', params: { stage: 'reprompt' } },
          ],
          on: { ACTIVITY: { target: 'counting', actions: 'notifyResume' } },
          after: { toStillThere: { target: 'stillThere' } },
        },
        stillThere: {
          entry: [
            { type: 'prompt', params: { stage: 'still_there' } },
            { type: 'notifyPrompt', params: { stage: 'still_there' } },
          ],
          on: { ACTIVITY: { target: 'counting', actions: 'notifyResume' } },
          after: { toCountdown: { target: 'countdown' } },
        },
        countdown: {
          entry: [
            { type: 'prompt', params: { stage: 'countdown' } },
            { type: 'notifyPrompt', params: { stage: 'countdown' } },
          ],
          on: { ACTIVITY: { target: 'counting', actions: 'notifyResume' } },
          after: { toAbandon: { target: 'abandoned' } },
        },
        abandoned: {
          entry: 'notifyAbandon',
          type: 'final',
        },
      },
    },
  },
});

/** Convenience wrapper around the walkaway actor. */
export class WalkawayMonitor {
  private readonly actor: Actor<typeof walkawayMachine>;
  private readonly config: WalkawayConfig;
  private current: WalkawayStage | null = null;

  constructor(
    config: WalkawayConfig,
    callbacks: WalkawayCallbacks,
    now: () => number = () => performance.now(),
  ) {
    this.config = config;
    // Track the visible stage here: callbacks run inside entry actions, before the snapshot commits.
    const tracked: WalkawayCallbacks = {
      onPrompt: (stage, idle) => {
        this.current = stage;
        callbacks.onPrompt(stage, idle);
      },
      onResume: (stage, idle) => {
        this.current = null;
        callbacks.onResume(stage, idle);
      },
      onAbandon: (idle) => {
        this.current = null;
        callbacks.onAbandon(idle);
      },
      ...(callbacks.onIdle ? { onIdle: callbacks.onIdle } : {}),
    };
    this.actor = createActor(walkawayMachine, { input: { config, callbacks: tracked, now } });
    this.actor.start();
  }

  /** Start monitoring a session (no-op in disabled modes). */
  start(mode: SessionMode): void {
    if (this.config.disabledInModes.includes(mode)) return;
    this.actor.send({ type: 'START' });
  }

  stop(): void {
    this.current = null;
    this.actor.send({ type: 'STOP' });
  }

  activity(): void {
    this.actor.send({ type: 'ACTIVITY' });
  }

  windowOpen(): void {
    this.current = null;
    this.actor.send({ type: 'WINDOW_OPEN' });
  }

  windowClose(): void {
    this.actor.send({ type: 'WINDOW_CLOSE' });
  }

  /** Devtools: jump to a stage. */
  simulate(stage: WalkawayStage | 'abandon'): void {
    this.actor.send({ type: 'SIMULATE', stage });
  }

  /** Current stage shown to the player (null when no prompt is showing). */
  get stage(): WalkawayStage | null {
    return this.current;
  }

  get monitoring(): boolean {
    return this.actor.getSnapshot().matches('monitoring');
  }

  dispose(): void {
    this.actor.stop();
  }
}
