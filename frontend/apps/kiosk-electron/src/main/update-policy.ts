/**
 * Update ring assignment and signed release-manifest verification (KSK-11 scaffold).
 *
 * electron-updater already checks the downloaded file's sha512 against `latest.yml`, but that file
 * comes from the same server. The kiosk additionally requires a **release manifest signed offline
 * with the release Ed25519 key** (PLT-03/PRV-01). Before any download, `verifyRelease` checks:
 * - the detached signature over the exact manifest bytes with the pinned public key;
 * - manifest channel == this kiosk's ring, manifest version == offered version, sha512 == offered;
 * - not a downgrade (and not the same version);
 * - not expired; and, under a wave freeze, version == the frozen version.
 * Pure functions; Electron wiring lives in `updater.ts`.
 */
import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';
import type { UpdateRing } from './config.ts';

/** Stable 0..99 bucket for staged rollout. */
export function rolloutBucket(kioskId: string): number {
  const h = createHash('sha256').update(`shriii-rollout:${kioskId}`).digest();
  return h.readUInt32BE(0) % 100;
}

/** The ring a kiosk follows: pinned (lab/canary/explicit) or ring10/stable by bucket. */
export function assignRing(
  kioskId: string,
  pinned: UpdateRing | null,
  ring10Percent: number,
): UpdateRing {
  if (pinned) return pinned;
  return rolloutBucket(kioskId) < ring10Percent ? 'ring10' : 'stable';
}

export interface ReleaseManifest {
  readonly schema: 'shriii.release-manifest.v1';
  readonly channel: UpdateRing;
  readonly version: string;
  /** base64 sha512 of the installer, as in electron-updater's latest.yml. */
  readonly sha512: string;
  readonly released_at: string;
  readonly expires_at: string;
  /** Lowest version allowed to update to this one (optional). */
  readonly min_from_version?: string | null;
}

export interface OfferedUpdate {
  readonly version: string;
  readonly sha512: string;
}

export type ReleaseCheck =
  | { readonly ok: true; readonly manifest: ReleaseManifest }
  | { readonly ok: false; readonly reason: string };

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Ed25519 public key from SPKI PEM or base64 raw 32 bytes. */
export function parseEd25519PublicKey(text: string): KeyObject {
  const t = text.trim();
  if (t.startsWith('-----BEGIN')) return createPublicKey(t);
  const raw = Buffer.from(t, 'base64');
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** Compare dotted numeric versions with optional pre-release (`1.2.3-beta.1` < `1.2.3`). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const [core, pre] = v.split('-', 2) as [string, string | undefined];
    const nums = core.split('.').map((n) => {
      const x = Number(n);
      if (!Number.isInteger(x) || x < 0) throw new Error(`invalid version ${v}`);
      return x;
    });
    return { nums, pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i += 1) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export function verifyRelease(options: {
  readonly manifestBytes: Uint8Array;
  readonly signature: Uint8Array;
  readonly publicKey: KeyObject;
  readonly offered: OfferedUpdate;
  readonly currentVersion: string;
  readonly ring: UpdateRing;
  readonly frozenVersion: string | null;
  readonly nowMs: number;
}): ReleaseCheck {
  if (!verify(null, options.manifestBytes, options.publicKey, options.signature)) {
    return { ok: false, reason: 'manifest signature invalid' };
  }
  let m: ReleaseManifest;
  try {
    m = JSON.parse(new TextDecoder().decode(options.manifestBytes)) as ReleaseManifest;
  } catch {
    return { ok: false, reason: 'manifest is not JSON' };
  }
  if (m.schema !== 'shriii.release-manifest.v1')
    return { ok: false, reason: 'unknown manifest schema' };
  if (m.channel !== options.ring)
    return { ok: false, reason: `manifest channel ${m.channel} != ring ${options.ring}` };
  if (m.version !== options.offered.version)
    return { ok: false, reason: 'manifest version != offered version' };
  if (m.sha512 !== options.offered.sha512)
    return { ok: false, reason: 'manifest sha512 != offered sha512' };
  let cmp: number;
  try {
    cmp = compareVersions(m.version, options.currentVersion);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (cmp <= 0)
    return {
      ok: false,
      reason: `downgrade or same version (${m.version} <= ${options.currentVersion})`,
    };
  if (m.min_from_version && compareVersions(options.currentVersion, m.min_from_version) < 0) {
    return { ok: false, reason: `current version below min_from_version ${m.min_from_version}` };
  }
  const expires = Date.parse(m.expires_at);
  if (!Number.isFinite(expires) || options.nowMs >= expires)
    return { ok: false, reason: 'manifest expired' };
  if (options.frozenVersion !== null && m.version !== options.frozenVersion) {
    return { ok: false, reason: `wave freeze pins ${options.frozenVersion}` };
  }
  return { ok: true, manifest: m };
}

/** Updates install only while nobody is playing: in attract, after a quiet period. */
export function canApplyUpdate(state: string, msInState: number, quietMs = 60_000): boolean {
  return state === 'attract' && msInState >= quietMs;
}
