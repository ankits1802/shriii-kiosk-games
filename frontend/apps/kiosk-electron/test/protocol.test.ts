import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mimeType, resolveAppUrl, serveAppRequest } from '../src/main/app-protocol.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'app-protocol-'));
const renderer = path.join(dir, 'renderer');
const shell = path.join(dir, 'static');
mkdirSync(path.join(renderer, 'assets'), { recursive: true });
mkdirSync(shell, { recursive: true });
writeFileSync(path.join(renderer, 'index.html'), '<!doctype html><title>k</title>');
writeFileSync(path.join(renderer, 'assets', 'app-1.js'), 'export {}');
writeFileSync(path.join(renderer, 'assets', 'space name.png'), 'png');
writeFileSync(path.join(shell, 'out-of-service.html'), '<p>oos</p>');
writeFileSync(path.join(dir, 'secret.txt'), 'top secret');
let symlinked = false;
try {
  symlinkSync(path.join(dir, 'secret.txt'), path.join(renderer, 'link.txt'));
  symlinked = true;
} catch {
  // Symlinks need privileges on Windows; the containment check is still covered on Linux CI.
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const roots = { renderer, shell };
const CSP = "default-src 'self'";

describe('app:// resolution', () => {
  it('maps paths under the roots', () => {
    expect(resolveAppUrl('app://kiosk/', roots)).toMatchObject({
      ok: true,
      file: path.join(renderer, 'index.html'),
    });
    expect(resolveAppUrl('app://kiosk/assets/app-1.js?v=1#x', roots)).toMatchObject({
      ok: true,
      file: path.join(renderer, 'assets', 'app-1.js'),
    });
    expect(resolveAppUrl('app://kiosk/__shell/out-of-service.html', roots)).toMatchObject({
      ok: true,
      file: path.join(shell, 'out-of-service.html'),
    });
    expect(resolveAppUrl('app://kiosk/assets/space%20name.png', roots)).toMatchObject({ ok: true });
  });

  it('refuses traversal, foreign hosts and malformed input', () => {
    // The WHATWG URL parser collapses dot segments (also percent-encoded ones) at the root.
    expect(resolveAppUrl('app://kiosk/../secret.txt', roots)).toMatchObject({
      ok: true,
      file: path.join(renderer, 'secret.txt'),
    });
    expect(resolveAppUrl('app://kiosk/%2e%2e/secret.txt', roots)).toMatchObject({
      ok: true,
      file: path.join(renderer, 'secret.txt'),
    });
    // Encoded separators decode to dot segments that normalisation clamps at the root.
    expect(resolveAppUrl('app://kiosk/assets/..%2F..%2Fsecret.txt', roots)).toMatchObject({
      ok: true,
      file: path.join(renderer, 'secret.txt'),
    });
    expect(resolveAppUrl('app://kiosk/..%5Csecret.txt', roots)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(resolveAppUrl('app://other/index.html', roots)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(resolveAppUrl('https://kiosk/index.html', roots)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(resolveAppUrl('app://kiosk/%E0%A4%A', roots)).toMatchObject({ ok: false, status: 400 });
    expect(resolveAppUrl('app://kiosk/a%00b', roots)).toMatchObject({ ok: false, status: 400 });
  });

  it('knows the MIME types the renderer needs', () => {
    expect(mimeType('x.js')).toContain('javascript');
    expect(mimeType('x.wasm')).toBe('application/wasm');
    expect(mimeType('x.opus')).toContain('opus');
    expect(mimeType('x.unknown')).toBe('application/octet-stream');
  });
});

describe('app:// serving', () => {
  it('serves files with CSP and security headers', async () => {
    const r = await serveAppRequest({ url: 'app://kiosk/index.html', method: 'GET' }, roots, CSP);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['content-security-policy']).toBe(CSP);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(new TextDecoder().decode(r.body ?? new Uint8Array())).toContain('<title>k</title>');
    const head = await serveAppRequest(
      { url: 'app://kiosk/assets/app-1.js', method: 'HEAD' },
      roots,
      CSP,
    );
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
  });

  it('returns 404/405/403 without leaking files', async () => {
    expect(
      (await serveAppRequest({ url: 'app://kiosk/missing.js', method: 'GET' }, roots, CSP)).status,
    ).toBe(404);
    expect(
      (await serveAppRequest({ url: 'app://kiosk/assets', method: 'GET' }, roots, CSP)).status,
    ).toBe(404);
    expect(
      (await serveAppRequest({ url: 'app://kiosk/index.html', method: 'POST' }, roots, CSP)).status,
    ).toBe(405);
    const traversal = await serveAppRequest(
      { url: 'app://kiosk/assets/..%2F..%2Fsecret.txt', method: 'GET' },
      roots,
      CSP,
    );
    expect(traversal.status).toBe(404);
    expect(traversal.body).toBeNull();
  });

  it.runIf(symlinked)('refuses symlinks that escape the root', async () => {
    const r = await serveAppRequest({ url: 'app://kiosk/link.txt', method: 'GET' }, roots, CSP);
    expect(r.status).toBe(403);
  });
});
