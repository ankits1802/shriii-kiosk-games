/**
 * Kiosk heartbeat view-model. The heartbeat payload is a free-form DeviceHeartbeat object (no PII)
 * whose core fields follow the `device_health` event payload in contracts (DeviceHealthPayload:
 * outbox_depth, last_upload_age_s, frame_time_p99_ms, disk_free_mb, clock_offset_estimate_ms,
 * audio_underruns, dropped_frames) plus KSK-10 extras (versions, temperature, printer, network…).
 * Health status itself is computed by the API (`health_status`, stale after the server's threshold).
 */
import type { Schema } from '@/lib/api/types';

export type Kiosk = Schema<'KioskOut'>;
export type Deployment = Schema<'DeploymentOut'>;

export interface HeartbeatView {
  /** Events waiting in the kiosk outbox (unsynced backlog). */
  readonly outboxDepth: number | null;
  /** When the kiosk last uploaded a batch (heartbeat time minus last_upload_age_s). */
  readonly lastSyncAt: string | null;
  readonly frameTimeP99Ms: number | null;
  readonly diskFreeMb: number | null;
  readonly clockOffsetMs: number | null;
  readonly audioUnderruns: number | null;
  readonly droppedFrames: number | null;
  /** Content pack version reported by the device, if any. */
  readonly contentVersion: string | null;
  readonly policyVersion: string | null;
  readonly releasePackVersion: string | null;
  /** Remaining scalar fields, for the detail view. */
  readonly extras: readonly (readonly [string, string])[];
}

const KNOWN = new Set([
  'outbox_depth',
  'unsynced_count',
  'last_upload_age_s',
  'frame_time_p99_ms',
  'disk_free_mb',
  'clock_offset_estimate_ms',
  'audio_underruns',
  'dropped_frames',
  'content_pack_version',
  'content_version',
  'policy_version',
  'release_pack_version',
]);

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function flatten(prefix: string, value: unknown, out: [string, string][], depth = 0): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out.push([prefix, String(value)]);
    return;
  }
  if (depth < 2 && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value))
      flatten(prefix ? `${prefix}.${k}` : k, v, out, depth + 1);
  }
}

export function heartbeatView(
  kiosk: Pick<Kiosk, 'last_heartbeat' | 'last_heartbeat_at'>,
): HeartbeatView {
  const p = (kiosk.last_heartbeat ?? {}) as Record<string, unknown>;
  const age = num(p.last_upload_age_s);
  const at = kiosk.last_heartbeat_at ? Date.parse(kiosk.last_heartbeat_at) : Number.NaN;
  const extras: [string, string][] = [];
  for (const [k, v] of Object.entries(p)) if (!KNOWN.has(k)) flatten(k, v, extras);
  return {
    outboxDepth: num(p.outbox_depth) ?? num(p.unsynced_count),
    lastSyncAt:
      age !== null && Number.isFinite(at) ? new Date(at - age * 1000).toISOString() : null,
    frameTimeP99Ms: num(p.frame_time_p99_ms),
    diskFreeMb: num(p.disk_free_mb),
    clockOffsetMs: num(p.clock_offset_estimate_ms),
    audioUnderruns: num(p.audio_underruns),
    droppedFrames: num(p.dropped_frames),
    contentVersion: text(p.content_pack_version) ?? text(p.content_version),
    policyVersion: text(p.policy_version),
    releasePackVersion: text(p.release_pack_version),
    extras: extras.sort(([a], [b]) => a.localeCompare(b)),
  };
}

/** The active deployment of each kiosk (most recent `active` row). */
export function activeDeployments(
  deployments: readonly Deployment[],
): ReadonlyMap<string, Deployment> {
  const out = new Map<string, Deployment>();
  for (const d of deployments) {
    if (d.status !== 'active') continue;
    const prev = out.get(d.kiosk_id);
    if (!prev || Date.parse(d.effective_from) > Date.parse(prev.effective_from))
      out.set(d.kiosk_id, d);
  }
  return out;
}

/** Device ids follow the API pattern (lower-case letters, digits and dashes, 2–64 chars). */
export const KIOSK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface FleetSummary {
  readonly total: number;
  readonly active: number;
  readonly healthy: number;
  readonly stale: number;
  readonly unknown: number;
  readonly revoked: number;
  /** Sum of `outbox_depth` over active kiosks whose last heartbeat reported it. */
  readonly backlog: number;
  /** Active kiosks whose last heartbeat reported an outbox depth (the backlog's N). */
  readonly backlogReporting: number;
}

export function fleetSummary(kiosks: readonly Kiosk[]): FleetSummary {
  let active = 0;
  let healthy = 0;
  let stale = 0;
  let unknown = 0;
  let revoked = 0;
  let backlog = 0;
  let backlogReporting = 0;
  for (const k of kiosks) {
    if (k.status === 'revoked') {
      revoked += 1;
      continue;
    }
    active += 1;
    if (k.health_status === 'healthy') healthy += 1;
    else if (k.health_status === 'stale') stale += 1;
    else unknown += 1;
    const depth = heartbeatView(k).outboxDepth;
    if (depth !== null) {
      backlog += depth;
      backlogReporting += 1;
    }
  }
  return {
    total: kiosks.length,
    active,
    healthy,
    stale,
    unknown,
    revoked,
    backlog,
    backlogReporting,
  };
}

/**
 * True when the device reports a content version that differs from the deployment's assigned one.
 * The heartbeat string has no contract format (e.g. `content-0.1.0+3fa2c1`), so only the first
 * semantic version in it is compared; with no version in the string, no drift is claimed.
 */
export function contentDrift(reported: string | null, assignedVersion: string | null): boolean {
  if (!reported || !assignedVersion) return false;
  const found = /(\d+\.\d+\.\d+)/.exec(reported)?.[1];
  return found !== undefined && found !== assignedVersion;
}
