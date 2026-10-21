/** Renderer-side helpers for the Electron kiosk shell (imported by apps/kiosk; no Node APIs). */

export * from '../shared/ipc-contract.ts';
export { BridgeError, getKioskBridge, IpcOutbox } from './ipc-outbox.ts';
