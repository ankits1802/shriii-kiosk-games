/**
 * The production logger SDK surface (ENG-07) as one bundle entry, used to measure the SDK against
 * its 25 kB gzip budget (`measure-bundle.ts`). Dev-only pieces are excluded on purpose: the strict
 * Ajv event-envelope validator is loaded only in dev builds (frontend/apps/kiosk), and the in-memory outbox
 * is a test/harness fallback.
 */
export { createSessionLogger, SessionEventLogger } from '../event-logger.ts';
export { GatedLogger, LoggerGate } from '../gated-logger.ts';
export { DexieOutbox } from '../outbox/dexie-outbox.ts';
export { recoverInterruptedSessions } from '../recovery.ts';
export { BatchUploader } from '../uploader.ts';
export { randomSeedHex, uuidv7 } from '../uuid.ts';
