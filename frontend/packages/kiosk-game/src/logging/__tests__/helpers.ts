import type { EventSessionContext, EventVersions } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import { SessionClock } from '../../engine/clock.ts';
import {
  ajvEventValidator,
  createSessionLogger,
  type SessionEventLogger,
} from '../event-logger.ts';
import type { KioskOutbox } from '../outbox/types.ts';
import { uuidv7 } from '../uuid.ts';

export const TEST_CONTEXT: EventSessionContext = {
  participant_pid: null,
  kiosk_id: 'kiosk-test',
  site_id: 'site-test',
  site_mode: 'supervised',
  mode: 'pilot',
  battery_arm: 'B_fixed',
  slot_form: 'four_stalls',
  language: 'hi-IN',
  player_slot: 1,
  synthetic: true,
};

export const TEST_VERSIONS: EventVersions = {
  app_version: '0.1.0',
  bundle_hash: 'a'.repeat(64),
  audio_manifest_hash: null,
  variant_pack_id: null,
  scoring_dict_version: '0.1.0',
  indicator_set_version: '0.1.0',
  protocol_version: null,
  policy_version: '1.0.0',
  release_pack_version: null,
  device_profile_id: 'dev-browser',
  hardware_sku: 'dev-browser',
  timing_profile_version: 'uncertified-dev',
};

/** A clock driven by a manual counter. */
export function manualClock(start = 0): { clock: SessionClock; advance(ms: number): void } {
  let t = start;
  const clock = new SessionClock({
    anchorPerfMs: 0,
    platform: { perfNow: () => t, wallNow: () => 1_760_000_000_000 + t },
  });
  return { clock, advance: (ms) => (t += ms) };
}

export function testLogger(
  outbox: KioskOutbox,
  opts: { consent?: { granted: boolean }; sessionId?: string; strict?: boolean } = {},
): SessionEventLogger {
  const consent = opts.consent ?? { granted: true };
  const { clock } = manualClock();
  return createSessionLogger({
    sessionId: opts.sessionId ?? uuidv7(),
    outbox,
    clock,
    context: () => TEST_CONTEXT,
    versions: TEST_VERSIONS,
    consentGranted: () => consent.granted,
    ...(opts.strict === false ? {} : { validate: ajvEventValidator(validateEventEnvelope) }),
  });
}
