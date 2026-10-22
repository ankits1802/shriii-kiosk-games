import { describe, expect, it } from 'vitest';
import {
  activeDeployments,
  contentDrift,
  fleetSummary,
  heartbeatView,
  KIOSK_ID_PATTERN,
  type Kiosk,
} from './heartbeat';

const kiosk = (over: Partial<Kiosk>): Kiosk => ({
  kiosk_id: 'k-1',
  site_id: 'site-a',
  label: null,
  status: 'active',
  hardware_sku: null,
  app_version: '0.1.0',
  last_heartbeat_at: '2026-10-22T10:00:00Z',
  last_heartbeat: {},
  health_status: 'healthy',
  created_at: '2026-10-01T00:00:00Z',
  revoked_at: null,
  ...over,
});

describe('heartbeatView', () => {
  it('reads device_health fields and derives the last sync time', () => {
    const v = heartbeatView(
      kiosk({
        last_heartbeat: {
          outbox_depth: 42,
          last_upload_age_s: 120,
          frame_time_p99_ms: 18.2,
          content_pack_version: 'content-0.1.0',
          temperature: { cpu_c: 51 },
          printer: 'ok',
        },
      }),
    );
    expect(v.outboxDepth).toBe(42);
    expect(v.lastSyncAt).toBe('2026-10-22T09:58:00.000Z');
    expect(v.contentVersion).toBe('content-0.1.0');
    expect(v.extras).toEqual([
      ['printer', 'ok'],
      ['temperature.cpu_c', '51'],
    ]);
  });

  it('tolerates an empty payload and the unsynced_count alias', () => {
    expect(heartbeatView(kiosk({ last_heartbeat: {} })).outboxDepth).toBeNull();
    expect(heartbeatView(kiosk({ last_heartbeat: { unsynced_count: 3 } })).outboxDepth).toBe(3);
    expect(
      heartbeatView(kiosk({ last_heartbeat_at: null, last_heartbeat: { last_upload_age_s: 5 } }))
        .lastSyncAt,
    ).toBeNull();
  });
});

describe('fleet', () => {
  it('summarises health and backlog, ignoring revoked kiosks', () => {
    const s = fleetSummary([
      kiosk({ last_heartbeat: { outbox_depth: 5 } }),
      kiosk({ kiosk_id: 'k-2', health_status: 'stale', last_heartbeat: { outbox_depth: 7 } }),
      kiosk({ kiosk_id: 'k-3', health_status: 'unknown' }),
      kiosk({ kiosk_id: 'k-4', status: 'revoked', last_heartbeat: { outbox_depth: 100 } }),
    ]);
    expect(s).toEqual({
      total: 4,
      active: 3,
      healthy: 1,
      stale: 1,
      unknown: 1,
      revoked: 1,
      backlog: 12,
      backlogReporting: 2,
    });
  });

  it('picks the latest active deployment per kiosk', () => {
    const base = {
      site_id: 's',
      site_mode: 'supervised',
      study_id: null,
      policy_version: '1',
      app_version: '1',
      content_version_id: null,
      ring: 'pilot',
      created_by: 'a',
    };
    const m = activeDeployments([
      {
        ...base,
        id: '1',
        kiosk_id: 'k-1',
        status: 'superseded',
        effective_from: '2026-10-03T00:00:00Z',
      },
      {
        ...base,
        id: '2',
        kiosk_id: 'k-1',
        status: 'active',
        effective_from: '2026-10-02T00:00:00Z',
      },
      {
        ...base,
        id: '3',
        kiosk_id: 'k-2',
        status: 'active',
        effective_from: '2026-10-01T00:00:00Z',
      },
    ]);
    expect(m.get('k-1')?.id).toBe('2');
    expect(m.get('k-2')?.id).toBe('3');
  });

  it('validates kiosk ids like the API', () => {
    expect(KIOSK_ID_PATTERN.test('pune-market-01')).toBe(true);
    expect(KIOSK_ID_PATTERN.test('Pune')).toBe(false);
    expect(KIOSK_ID_PATTERN.test('a')).toBe(false);
  });
});

describe('content drift', () => {
  it('compares the reported semantic version with the assigned one', () => {
    expect(contentDrift('content-0.1.0+3fa2c1', '0.1.0')).toBe(false);
    expect(contentDrift('content-0.0.9+aa11bb', '0.1.0')).toBe(true);
    expect(contentDrift('nightly', '0.1.0')).toBe(false);
    expect(contentDrift(null, '0.1.0')).toBe(false);
    expect(contentDrift('content-0.1.0', null)).toBe(false);
  });
});
