import type { EventEnvelope, EventEnvelopeBase, EventType } from './generated/types.ts';

/** The event envelope narrowed to a single `event_type`. */
export type EventOf<T extends EventType> = Extract<EventEnvelope, { event_type: T }>;

/** The typed payload for a given `event_type`. */
export type PayloadOf<T extends EventType> = EventOf<T>['payload'];

/** Map of every event type to its payload type. */
export type EventPayloadMap = { [T in EventType]: PayloadOf<T> };

/** Envelope fields shared by every event (everything except the discriminated `event_type`/`payload`). */
export type EnvelopeCommon = Omit<EventEnvelopeBase, 'event_type' | 'payload'>;

/**
 * Build a typed event from its common envelope fields and a payload. This is a pure, typed helper:
 * it performs no validation (run {@link validateEvent} before persisting).
 */
export function makeEvent<T extends EventType>(
  common: EnvelopeCommon,
  eventType: T,
  payload: PayloadOf<T>,
): EventOf<T> {
  return { ...common, event_type: eventType, payload } as unknown as EventOf<T>;
}
