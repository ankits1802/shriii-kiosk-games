import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseOrigin, resolveConfig } from '../src/main/config.ts';
import { contentSecurityPolicy, isAllowedNavigation, isAllowedRequest } from '../src/main/csp.ts';
import {
  assignRing,
  canApplyUpdate,
  compareVersions,
  parseEd25519PublicKey,
  type ReleaseManifest,
  rolloutBucket,
  verifyRelease,
} from '../src/main/update-policy.ts';
import { RendererWatchdog } from '../src/main/watchdog.ts';

describe('config', () => {
  const base = { file: null, env: {}, isPackaged: false, devKioskId: 'kiosk-dev-test' };

  it('uses safe development defaults', () => {
    const c = resolveConfig(base);
    expect(c.kioskId).toBe('kiosk-dev-test');
    expect(c.apiOrigin).toBeNull();
    expect(c.printer).toEqual({ kind: 'virtual', outputDir: null });
    expect(c.allowPlaintextOutbox).toBe(true);
    expect(c.update.ring10Percent).toBe(10);
  });

  it('requires a provisioned kiosk id and https in packaged builds', () => {
    expect(() => resolveConfig({ ...base, isPackaged: true })).toThrow(ConfigError);
    const ok = resolveConfig({
      ...base,
      isPackaged: true,
      env: { SHRIII_KIOSK_ID: 'kiosk-001', SHRIII_API_ORIGIN: 'https://api.shriii.in' },
    });
    expect(ok.apiOrigin).toBe('https://api.shriii.in');
    expect(ok.allowPlaintextOutbox).toBe(false);
    expect(ok.devUrl).toBeNull();
    expect(() =>
      resolveConfig({
        ...base,
        isPackaged: true,
        env: { SHRIII_KIOSK_ID: 'kiosk-001', SHRIII_API_ORIGIN: 'http://api.local' },
      }),
    ).toThrow(/https/);
  });

  it('merges file and env (env wins) and parses printers', () => {
    const c = resolveConfig({
      ...base,
      file: {
        kioskId: 'kiosk-file',
        printer: { kind: 'network', host: '10.0.0.5' },
        update: { ring: 'canary' },
      },
      env: { SHRIII_KIOSK_ID: 'kiosk-env' },
    });
    expect(c.kioskId).toBe('kiosk-env');
    expect(c.printer).toEqual({ kind: 'network', host: '10.0.0.5', port: 9100 });
    expect(c.update.ring).toBe('canary');
    expect(
      resolveConfig({ ...base, env: { SHRIII_PRINTER: 'device:/dev/usb/lp0' } }).printer,
    ).toEqual({ kind: 'device', path: '/dev/usb/lp0' });
    expect(
      resolveConfig({ ...base, env: { SHRIII_PRINTER: 'tcp://printer:9101' } }).printer,
    ).toEqual({ kind: 'network', host: 'printer', port: 9101 });
    expect(() => resolveConfig({ ...base, file: { update: { ring: 'beta' } } })).toThrow(/ring/);
    expect(() => resolveConfig({ ...base, env: { SHRIII_KIOSK_ID: 'bad id!' } })).toThrow(
      /kioskId/,
    );
  });

  it('accepts only bare origins', () => {
    expect(parseOrigin('https://a.b:8443', 'x', false)).toBe('https://a.b:8443');
    expect(() => parseOrigin('https://a.b/path', 'x', false)).toThrow(/origin/);
    expect(() => parseOrigin('https://u:p@a.b', 'x', false)).toThrow(/credentials/);
    expect(() => parseOrigin('ftp://a.b', 'x', true)).toThrow();
  });
});

describe('CSP and allow-lists', () => {
  const opts = { apiOrigin: 'https://api.shriii.in', devUrl: null };

  it('builds a strict policy with only self and the API', () => {
    const csp = contentSecurityPolicy(opts);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("connect-src 'self' https://api.shriii.in");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(contentSecurityPolicy({ apiOrigin: null, devUrl: 'http://localhost:5173' })).toContain(
      'ws://localhost:5173',
    );
  });

  it('allows only app, in-memory, API and dev-server requests', () => {
    const o = { ...opts, devtools: false };
    expect(isAllowedRequest('app://kiosk/assets/index.js', o)).toBe(true);
    expect(isAllowedRequest('app://evil/x', o)).toBe(false);
    expect(isAllowedRequest('https://api.shriii.in/api/v1/events/batch', o)).toBe(true);
    expect(isAllowedRequest('https://api.shriii.in.evil.com/', o)).toBe(false);
    expect(isAllowedRequest('https://example.com/', o)).toBe(false);
    expect(isAllowedRequest('file:///etc/passwd', o)).toBe(false);
    expect(isAllowedRequest('devtools://devtools/x', o)).toBe(false);
    expect(isAllowedRequest('devtools://devtools/x', { ...o, devtools: true })).toBe(true);
    expect(isAllowedRequest('data:image/png;base64,AA==', o)).toBe(true);
    expect(isAllowedRequest('not a url', o)).toBe(false);
  });

  it('restricts navigation to the app', () => {
    expect(isAllowedNavigation('app://kiosk/index.html', null)).toBe(true);
    expect(isAllowedNavigation('https://example.com', null)).toBe(false);
    expect(isAllowedNavigation('http://localhost:5173/', 'http://localhost:5173')).toBe(true);
  });
});

describe('watchdog', () => {
  it('reloads a crashed renderer well within 5 s', () => {
    const w = new RendererWatchdog();
    const a = w.handle({ type: 'renderer_gone', reason: 'killed', at: 0 });
    expect(a).toMatchObject({ kind: 'reload' });
    expect(a.kind === 'reload' && a.delayMs).toBeLessThan(5000);
  });

  it('force-crashes on heartbeat silence and on unresponsive', () => {
    const w = new RendererWatchdog({ hangTimeoutMs: 15_000 });
    expect(w.handle({ type: 'tick', at: 100_000 }).kind).toBe('none'); // no heartbeats yet
    w.handle({ type: 'heartbeat', at: 0 });
    expect(w.handle({ type: 'tick', at: 15_000 }).kind).toBe('none');
    expect(w.handle({ type: 'tick', at: 15_001 })).toMatchObject({
      kind: 'force_crash',
      reason: 'heartbeat_timeout',
    });
    expect(w.handle({ type: 'tick', at: 20_000 }).kind).toBe('none'); // already recovering
    w.handle({ type: 'loaded', at: 21_000 });
    expect(w.handle({ type: 'unresponsive', at: 22_000 })).toMatchObject({ kind: 'force_crash' });
  });

  it('escalates crash loops to an app relaunch, then out of service', () => {
    const w = new RendererWatchdog(
      { maxCrashes: 3, windowMs: 60_000, maxRelaunches: 2 },
      [0, 1000],
    );
    expect(w.handle({ type: 'renderer_gone', reason: 'oom', at: 5000 }).kind).toBe('reload');
    expect(w.handle({ type: 'renderer_gone', reason: 'oom', at: 6000 }).kind).toBe('reload');
    expect(w.handle({ type: 'renderer_gone', reason: 'oom', at: 7000 }).kind).toBe(
      'out_of_service',
    );
    expect(w.isOutOfService).toBe(true);
    const fresh = new RendererWatchdog({ maxCrashes: 2, windowMs: 60_000, maxRelaunches: 2 });
    fresh.handle({ type: 'renderer_gone', reason: 'x', at: 0 });
    expect(fresh.handle({ type: 'renderer_gone', reason: 'x', at: 10 }).kind).toBe('relaunch_app');
    expect(fresh.relaunchHistory).toEqual([10]);
    // Crashes spread out in time are not a loop.
    const spread = new RendererWatchdog({ maxCrashes: 2, windowMs: 1000 });
    expect(spread.handle({ type: 'renderer_gone', reason: 'x', at: 0 }).kind).toBe('reload');
    expect(spread.handle({ type: 'renderer_gone', reason: 'x', at: 5000 }).kind).toBe('reload');
  });
});

describe('update rings and signed manifests', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const manifest: ReleaseManifest = {
    schema: 'shriii.release-manifest.v1',
    channel: 'ring10',
    version: '0.2.0',
    sha512: 'abc==',
    released_at: '2026-10-01T00:00:00Z',
    expires_at: '2027-01-01T00:00:00Z',
  };
  const bytes = (m: object): Uint8Array => new TextEncoder().encode(JSON.stringify(m));
  const sig = (b: Uint8Array): Uint8Array => new Uint8Array(sign(null, b, privateKey));
  const base = {
    publicKey: parseEd25519PublicKey(pem),
    offered: { version: '0.2.0', sha512: 'abc==' },
    currentVersion: '0.1.0',
    ring: 'ring10' as const,
    frozenVersion: null as string | null,
    nowMs: Date.parse('2026-10-21T00:00:00Z'),
  };

  it('assigns rings deterministically by kiosk bucket', () => {
    expect(rolloutBucket('kiosk-001')).toBe(rolloutBucket('kiosk-001'));
    const ids = Array.from({ length: 2000 }, (_, i) => `kiosk-${i}`);
    const share = ids.filter((id) => assignRing(id, null, 10) === 'ring10').length / ids.length;
    expect(share).toBeGreaterThan(0.07);
    expect(share).toBeLessThan(0.13);
    expect(assignRing('kiosk-1', 'lab', 10)).toBe('lab');
  });

  it('accepts a correctly signed, newer, unexpired manifest (PEM or raw key)', () => {
    const b = bytes(manifest);
    expect(verifyRelease({ ...base, manifestBytes: b, signature: sig(b) }).ok).toBe(true);
    expect(
      verifyRelease({
        ...base,
        publicKey: parseEd25519PublicKey(raw),
        manifestBytes: b,
        signature: sig(b),
      }).ok,
    ).toBe(true);
  });

  it('rejects tampering, wrong channel, mismatched artefact, downgrade, expiry and freeze', () => {
    const b = bytes(manifest);
    const s = sig(b);
    const tampered = bytes({ ...manifest, version: '9.9.9' });
    expect(verifyRelease({ ...base, manifestBytes: tampered, signature: s })).toMatchObject({
      ok: false,
      reason: /signature/,
    });
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(
      verifyRelease({ ...base, manifestBytes: b, signature: new Uint8Array(sign(null, b, other)) })
        .ok,
    ).toBe(false);
    const check = (m: object, over: Partial<typeof base> = {}) => {
      const mb = bytes(m);
      return verifyRelease({ ...base, ...over, manifestBytes: mb, signature: sig(mb) });
    };
    expect(check({ ...manifest, channel: 'stable' })).toMatchObject({
      ok: false,
      reason: /channel/,
    });
    expect(check(manifest, { offered: { version: '0.2.0', sha512: 'other==' } })).toMatchObject({
      ok: false,
      reason: /sha512/,
    });
    expect(check(manifest, { currentVersion: '0.2.0' })).toMatchObject({
      ok: false,
      reason: /downgrade/,
    });
    expect(check(manifest, { currentVersion: '0.3.0' })).toMatchObject({
      ok: false,
      reason: /downgrade/,
    });
    expect(check(manifest, { nowMs: Date.parse('2027-02-01T00:00:00Z') })).toMatchObject({
      ok: false,
      reason: /expired/,
    });
    expect(check(manifest, { frozenVersion: '0.1.5' })).toMatchObject({
      ok: false,
      reason: /freeze/,
    });
    expect(check({ ...manifest, min_from_version: '0.1.5' })).toMatchObject({
      ok: false,
      reason: /min_from/,
    });
    expect(check({ ...manifest, schema: 'x' })).toMatchObject({ ok: false, reason: /schema/ });
  });

  it('compares versions including pre-releases', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(-1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(() => compareVersions('1.x', '1.0')).toThrow();
  });

  it('installs only in idle attract', () => {
    expect(canApplyUpdate('play', 600_000)).toBe(false);
    expect(canApplyUpdate('attract', 10_000)).toBe(false);
    expect(canApplyUpdate('attract', 60_000)).toBe(true);
  });
});
