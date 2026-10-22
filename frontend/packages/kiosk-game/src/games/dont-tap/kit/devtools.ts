/**
 * Development hooks: the current game phase is published on `globalThis.__shriiiGame` and as
 * `data-game-phase` / `data-game-module` on `document.body` so the Playwright screenshot and bot
 * scripts can wait for a phase. Never read by game logic; compiled out of production builds.
 */
import type { GamePhase } from './types.ts';

/** Snapshot published for scripts. */
export interface GamePhaseSnapshot {
  readonly moduleId: string;
  readonly phase: GamePhase;
  readonly trialIndex: number | null;
  readonly blockId: string | null;
  /** Monotonic counter of phase/trial updates (scripts wait for changes). */
  readonly tick: number;
}

let tick = 0;

function devBuild(): boolean {
  try {
    return import.meta.env?.PROD !== true;
  } catch {
    return true;
  }
}

/** Publish the current phase (no-op in production builds). */
export function markPhase(
  moduleId: string,
  phase: GamePhase,
  trial: { readonly trialIndex?: number | null; readonly blockId?: string | null } = {},
): void {
  if (!devBuild()) return;
  tick += 1;
  const snap: GamePhaseSnapshot = {
    moduleId,
    phase,
    trialIndex: trial.trialIndex ?? null,
    blockId: trial.blockId ?? null,
    tick,
  };
  (globalThis as { __shriiiGame?: GamePhaseSnapshot }).__shriiiGame = snap;
  const body = (globalThis as { document?: Document }).document?.body;
  if (body) {
    body.dataset.gamePhase = phase;
    body.dataset.gameModule = moduleId;
    body.dataset.gameBlock = snap.blockId ?? '';
    body.dataset.gameTrial = snap.trialIndex === null ? '' : String(snap.trialIndex);
  }
}

/** Publish which stimulus is on screen (`data-game-stim`; empty when none). Dev builds only. */
export function markStimulus(label: string | null): void {
  if (!devBuild()) return;
  const body = (globalThis as { document?: Document }).document?.body;
  if (body) body.dataset.gameStim = label ?? '';
}
