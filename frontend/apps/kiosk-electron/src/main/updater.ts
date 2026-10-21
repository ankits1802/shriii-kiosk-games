/**
 * Auto-update wiring (KSK-11 scaffold) on electron-updater with per-ring generic feeds
 * (`<feedUrl>/<ring>/latest.yml`). Nothing downloads until the signed release manifest
 * (`<feedUrl>/<ring>/release-manifest.json` + `.sig`) verifies (see `update-policy.ts`), and a
 * downloaded update installs only while the kiosk sits idle in attract.
 *
 * Snap installs are updated by snapd (store channels mirror the rings), so electron-updater is
 * disabled when running inside a snap. Rollback after a failed health check is snapd's
 * `snap revert` on Ubuntu Core; AppImage/Windows keep the previous installer for manual rollback.
 */
import type { KeyObject } from 'node:crypto';
import type { UpdateConfig, UpdateRing } from './config.ts';
import type { Logger } from './log.ts';
import { canApplyUpdate, parseEd25519PublicKey, verifyRelease } from './update-policy.ts';

/** The subset of electron-updater's AppUpdater used here (injected; mocked in tests). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  setFeedURL(options: { provider: 'generic'; url: string; channel?: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(
    event: 'update-available',
    cb: (info: { version: string; sha512?: string; files?: { sha512: string }[] }) => void,
  ): unknown;
  on(event: 'update-downloaded', cb: (info: { version: string }) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

export type UpdateStatus =
  | { readonly state: 'disabled'; readonly reason: string }
  | { readonly state: 'idle' | 'checking' }
  | { readonly state: 'rejected'; readonly version: string; readonly reason: string }
  | { readonly state: 'downloading' | 'ready'; readonly version: string }
  | { readonly state: 'error'; readonly message: string };

export class KioskUpdater {
  private status: UpdateStatus = { state: 'idle' };
  private readonly key: KeyObject | null;
  private readonly feed: string | null;
  private timer: NodeJS.Timeout | null = null;
  private lifecycle = { state: 'boot', since: Date.now() };
  private readyVersion: string | null = null;

  constructor(
    private readonly updater: UpdaterLike,
    private readonly cfg: UpdateConfig,
    readonly ring: UpdateRing,
    private readonly currentVersion: string,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.feed = cfg.feedUrl ? `${cfg.feedUrl}/${ring}` : null;
    this.key = cfg.manifestPublicKey ? parseEd25519PublicKey(cfg.manifestPublicKey) : null;
    if (!this.feed) this.status = { state: 'disabled', reason: 'no feed configured' };
    else if (!this.key)
      this.status = { state: 'disabled', reason: 'no manifest public key (fail closed)' };
  }

  get current(): UpdateStatus {
    return this.status;
  }

  start(): void {
    if (this.status.state === 'disabled' || !this.feed) return;
    const u = this.updater;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = false;
    u.allowDowngrade = false;
    u.allowPrerelease = this.ring === 'lab';
    u.setFeedURL({ provider: 'generic', url: this.feed });
    u.on('update-available', (info) => void this.onAvailable(info));
    u.on('update-downloaded', (info) => {
      this.readyVersion = info.version;
      this.status = { state: 'ready', version: info.version };
      this.log.info('update downloaded', { version: info.version });
      this.maybeInstall();
    });
    u.on('error', (err) => {
      this.status = { state: 'error', message: err.message };
      this.log.warn('updater error', { error: err.message });
    });
    const check = (): void => {
      this.status = { state: 'checking' };
      this.updater.checkForUpdates().catch((err: Error) => {
        this.status = { state: 'error', message: err.message };
      });
    };
    check();
    this.timer = setInterval(check, this.cfg.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Renderer lifecycle state changes (install only in idle attract). */
  setLifecycleState(state: string, now = Date.now()): void {
    if (state !== this.lifecycle.state) this.lifecycle = { state, since: now };
    this.maybeInstall(now);
  }

  private maybeInstall(now = Date.now()): void {
    if (!this.readyVersion) return;
    if (!canApplyUpdate(this.lifecycle.state, now - this.lifecycle.since)) return;
    this.log.info('installing update', { version: this.readyVersion });
    this.updater.quitAndInstall(true, true);
  }

  private async onAvailable(info: {
    version: string;
    sha512?: string;
    files?: { sha512: string }[];
  }): Promise<void> {
    const sha512 = info.files?.[0]?.sha512 ?? info.sha512 ?? '';
    if (!this.feed || !this.key) return;
    try {
      const [manifest, sig] = await Promise.all([
        this.fetchBytes(`${this.feed}/release-manifest.json`),
        this.fetchBytes(`${this.feed}/release-manifest.json.sig`),
      ]);
      const check = verifyRelease({
        manifestBytes: manifest,
        signature: decodeSignature(sig),
        publicKey: this.key,
        offered: { version: info.version, sha512 },
        currentVersion: this.currentVersion,
        ring: this.ring,
        frozenVersion: this.cfg.frozenVersion,
        nowMs: Date.now(),
      });
      if (!check.ok) {
        this.status = { state: 'rejected', version: info.version, reason: check.reason };
        this.log.warn('update rejected', { version: info.version, reason: check.reason });
        return;
      }
      this.status = { state: 'downloading', version: info.version };
      await this.updater.downloadUpdate();
    } catch (err) {
      this.status = { state: 'error', message: (err as Error).message };
      this.log.warn('update verification failed', { error: (err as Error).message });
    }
  }

  private async fetchBytes(url: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** Signature files may be raw 64 bytes or base64 text. */
export function decodeSignature(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 64) return bytes;
  const text = new TextDecoder().decode(bytes).trim();
  const raw = Buffer.from(text, 'base64');
  if (raw.length !== 64) throw new Error('signature must be 64 bytes (raw or base64)');
  return new Uint8Array(raw);
}
