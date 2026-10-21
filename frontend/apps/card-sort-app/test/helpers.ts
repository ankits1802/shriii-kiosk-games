import {
  completeAdministration,
  recordTrial,
  type StartInput,
  startAdministration,
} from '../src/app/administration.ts';
import { MemoryKv } from '../src/data/kv.ts';
import { CardSortStore } from '../src/data/store.ts';
import type { DeviceSettings, SessionRecord } from '../src/data/types.ts';
import { correctKey, type Dimension } from '../src/domain/cards.ts';
import { currentCard, respond } from '../src/domain/engine.ts';
import { luhnCheckChar } from '../src/domain/pid.ts';
import { PROTOCOL_64 } from '../src/domain/protocol.ts';

export const PID = `7K3M9QX2A${luhnCheckChar('7K3M9QX2A')}`;

export const SETTINGS: DeviceSettings = {
  apiBaseUrl: 'https://api.test',
  deviceToken: 'kdt_test',
  deviceId: 'tablet-01',
  administratorId: 'admin.asha',
  defaultStudyId: 's2',
  defaultLanguage: 'hi-IN',
  audioVersion: '1.0.0',
};

export const START: StartInput = {
  pid: PID,
  pidSource: 'typed',
  studyId: 's2',
  occasionId: 't1',
  wave: 1,
  language: 'hi-IN',
  protocol: PROTOCOL_64,
  administratorId: SETTINGS.administratorId,
  deviceId: SETTINGS.deviceId,
  audioVersion: '1.0.0',
};

export async function memoryStore(): Promise<CardSortStore> {
  const store = new CardSortStore(new MemoryKv());
  await store.init();
  return store;
}

/** Run a full administration where the participant sorts by `dim` (or the correct rule). */
export async function completedSession(
  store: CardSortStore,
  dim: Dimension | 'correct' = 'correct',
): Promise<SessionRecord> {
  const started = await startAdministration(store, START);
  let engine = started.engine;
  while (!engine.finished) {
    const card = currentCard(engine);
    if (!card) break;
    const rule = engine.config.ruleSequence[
      engine.categoriesCompleted % engine.config.ruleSequence.length
    ] as Dimension;
    const next = respond(
      engine,
      correctKey(card, dim === 'correct' ? rule : dim),
      900,
      new Date().toISOString(),
    );
    await recordTrial(store, started.session, next.trial);
    engine = next.state;
  }
  return completeAdministration(store, started.session, engine);
}
