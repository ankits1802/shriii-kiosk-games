/**
 * Kiosk runtime configuration. Sources, later overriding earlier:
 *   1. built-in defaults,
 *   2. the JSON config file (`SHRIII_KIOSK_CONFIG`, default `<userData>/kiosk-config.json`;
 *      provisioned per device, KSK-10),
 *   3. environment variables (development and the snap's environment).
 * Pure: no Electron imports, so it is unit-tested directly.
 */

export type PrinterConfig =
  | { readonly kind: 'none' }
  | { readonly kind: 'virtual'; readonly outputDir: string | null }
  | { readonly kind: 'network'; readonly host: string; readonly port: number }
  | { readonly kind: 'device'; readonly path: string };

export type UpdateRing = 'lab' | 'canary' | 'ring10' | 'stable';

export interface UpdateConfig {
  /** Base URL of the update feeds; each ring is served from `<feedUrl>/<ring>/`. Null disables. */
  readonly feedUrl: string | null;
  /** Pinned ring (lab and canary are always explicit); otherwise ring10/stable by kiosk bucket. */
  readonly ring: UpdateRing | null;
  /** Percent of the fleet in ring10 (by stable hash of kiosk id). */
  readonly ring10Percent: number;
  /** Ed25519 public key (SPKI PEM or base64 raw 32 bytes) that signs release manifests. */
  readonly manifestPublicKey: string | null;
  /** Wave freeze: when set, only this exact app version may be installed (KSK-11). */
  readonly frozenVersion: string | null;
  /** Check interval. */
  readonly checkIntervalMs: number;
}

export interface KioskConfig {
  readonly kioskId: string;
  /** API origin (scheme://host[:port]) for uploads and the CSP connect-src. Null = offline only. */
  readonly apiOrigin: string | null;
  /** Vite dev server URL (honoured only in unpackaged runs). */
  readonly devUrl: string | null;
  /** Backend recipient keys file (JSON array of {kid, public_key, not_before, not_after}). */
  readonly recipientKeysPath: string | null;
  /** Allow the unencrypted `none_dev` outbox mode (never in packaged builds). */
  readonly allowPlaintextOutbox: boolean;
  /** Outbox policy YAML override (defaults to the packaged policy). */
  readonly outboxPolicyPath: string | null;
  readonly printer: PrinterConfig;
  readonly update: UpdateConfig;
  /** Upload request timeout and idle poll. */
  readonly uploadTimeoutMs: number;
  readonly uploadIdlePollMs: number;
  /** Renderer heartbeat silence treated as a hang. */
  readonly hangTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`kiosk config: ${message}`);
    this.name = 'ConfigError';
  }
}

const KIOSK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

function str(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ConfigError(`${field} must be a string`);
  return v.trim();
}

function num(v: unknown, field: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(`${field} must be a number in [${min}, ${max}]`);
  }
  return n;
}

/** Normalise an origin; rejects paths, credentials and non-http(s) schemes. */
export function parseOrigin(
  value: string | null,
  field: string,
  allowHttp: boolean,
): string | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${field} is not a URL`);
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new ConfigError(`${field} must use https${allowHttp ? ' or http' : ''}`);
  }
  if (url.username || url.password) throw new ConfigError(`${field} must not contain credentials`);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError(`${field} must be an origin without a path`);
  }
  return url.origin;
}

function parsePrinter(raw: unknown, env: NodeJS.ProcessEnv): PrinterConfig {
  const fromEnv = env.SHRIII_PRINTER;
  if (fromEnv) {
    // virtual[:dir] | tcp://host[:port] | device:/dev/usb/lp0 | none
    if (fromEnv === 'none') return { kind: 'none' };
    if (fromEnv.startsWith('virtual')) {
      const dir = fromEnv.slice('virtual'.length).replace(/^:/, '');
      return { kind: 'virtual', outputDir: dir === '' ? null : dir };
    }
    if (fromEnv.startsWith('tcp://')) {
      const u = new URL(fromEnv);
      return { kind: 'network', host: u.hostname, port: u.port ? Number(u.port) : 9100 };
    }
    if (fromEnv.startsWith('device:'))
      return { kind: 'device', path: fromEnv.slice('device:'.length) };
    throw new ConfigError(`SHRIII_PRINTER not understood: ${fromEnv}`);
  }
  if (raw === undefined || raw === null) return { kind: 'virtual', outputDir: null };
  if (typeof raw !== 'object') throw new ConfigError('printer must be an object');
  const p = raw as Record<string, unknown>;
  switch (p.kind) {
    case 'none':
      return { kind: 'none' };
    case 'virtual':
      return { kind: 'virtual', outputDir: str(p.outputDir, 'printer.outputDir') };
    case 'network': {
      const host = str(p.host, 'printer.host');
      if (!host) throw new ConfigError('printer.host is required');
      return { kind: 'network', host, port: num(p.port, 'printer.port', 1, 65535, 9100) };
    }
    case 'device': {
      const path = str(p.path, 'printer.path');
      if (!path) throw new ConfigError('printer.path is required');
      return { kind: 'device', path };
    }
    default:
      throw new ConfigError(`printer.kind must be none|virtual|network|device`);
  }
}

const RINGS: readonly UpdateRing[] = ['lab', 'canary', 'ring10', 'stable'];

export function resolveConfig(options: {
  readonly file: Record<string, unknown> | null;
  readonly env: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  /** Fallback kiosk id for development (hostname based). */
  readonly devKioskId: string;
}): KioskConfig {
  const f = options.file ?? {};
  const env = options.env;
  const pick = (envKey: string, fileKey: string): unknown => env[envKey] ?? f[fileKey];
  const kioskId =
    str(pick('SHRIII_KIOSK_ID', 'kioskId'), 'kioskId') ??
    (options.isPackaged ? null : options.devKioskId);
  if (!kioskId) throw new ConfigError('kioskId is required in packaged builds (provisioning)');
  if (!KIOSK_ID.test(kioskId)) throw new ConfigError(`invalid kioskId ${kioskId}`);
  const allowHttp = !options.isPackaged || env.SHRIII_ALLOW_HTTP_API === '1';
  const apiOrigin = parseOrigin(
    str(pick('SHRIII_API_ORIGIN', 'apiOrigin'), 'apiOrigin'),
    'apiOrigin',
    allowHttp,
  );
  const devUrl = options.isPackaged
    ? null
    : parseOrigin(str(env.SHRIII_KIOSK_DEV_URL, 'devUrl'), 'devUrl', true);
  const u = (f.update ?? {}) as Record<string, unknown>;
  const ringRaw = str(env.SHRIII_UPDATE_RING ?? u.ring, 'update.ring');
  if (ringRaw !== null && !RINGS.includes(ringRaw as UpdateRing)) {
    throw new ConfigError(`update.ring must be one of ${RINGS.join(', ')}`);
  }
  const feed = str(env.SHRIII_UPDATE_FEED ?? u.feedUrl, 'update.feedUrl');
  if (feed !== null) {
    const parsed = new URL(feed);
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
      throw new ConfigError('update.feedUrl must use https');
    }
  }
  return {
    kioskId,
    apiOrigin,
    devUrl,
    recipientKeysPath: str(pick('SHRIII_RECIPIENT_KEYS', 'recipientKeysPath'), 'recipientKeysPath'),
    allowPlaintextOutbox:
      !options.isPackaged &&
      String(env.SHRIII_PLAINTEXT_OUTBOX ?? f.allowPlaintextOutbox ?? 'true') !== 'false',
    outboxPolicyPath: str(pick('SHRIII_OUTBOX_POLICY', 'outboxPolicyPath'), 'outboxPolicyPath'),
    printer: parsePrinter(f.printer, env),
    update: {
      feedUrl: feed === null ? null : feed.replace(/\/+$/, ''),
      ring: ringRaw as UpdateRing | null,
      ring10Percent: num(u.ring10Percent, 'update.ring10Percent', 0, 100, 10),
      manifestPublicKey: str(
        env.SHRIII_UPDATE_PUBKEY ?? u.manifestPublicKey,
        'update.manifestPublicKey',
      ),
      frozenVersion: str(u.frozenVersion, 'update.frozenVersion'),
      checkIntervalMs: num(
        u.checkIntervalMs,
        'update.checkIntervalMs',
        60_000,
        7 * 86_400_000,
        3_600_000,
      ),
    },
    uploadTimeoutMs: num(f.uploadTimeoutMs, 'uploadTimeoutMs', 1000, 300_000, 30_000),
    uploadIdlePollMs: num(f.uploadIdlePollMs, 'uploadIdlePollMs', 1000, 3_600_000, 30_000),
    hangTimeoutMs: num(f.hangTimeoutMs, 'hangTimeoutMs', 5000, 300_000, 15_000),
  };
}
