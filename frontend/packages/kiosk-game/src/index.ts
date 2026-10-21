/**
 * @shriii/kiosk-game — the kiosk game library mounted by `frontend/apps/kiosk` (Vite/Electron) and by
 * `frontend/apps/web` at `/kiosk` (Next.js).
 *
 * The shared interfaces in `core/contracts.ts` are the boundary every engine service, micro-game,
 * episode, onboarding screen and report view codes against.
 */

export { KioskGame, type KioskGameProps } from './app/KioskGame.tsx';
export * from './core/contracts.ts';
// Engine, logger SDK/outbox, input layer and session orchestration (kiosk engine agent).
export * from './engine/index.ts';
export * from './input/index.ts';
export * from './logging/index.ts';
export * from './session/index.ts';
