/**
 * `app://kiosk/` protocol serving the built renderer (and the shell's static pages) from disk.
 *
 * Why not `file://`: ES module scripts, `fetch()` of local assets, workers and a stable origin for
 * storage and CSP all behave correctly only on a standard, secure scheme. The handler is a
 * read-only static server rooted at the renderer directory: traversal outside the roots, symlinks
 * escaping them and anything but GET/HEAD are refused.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { APP_HOST, APP_SCHEME } from './csp.ts';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.opus': 'audio/ogg; codecs=opus',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeType(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export interface ProtocolRoots {
  /** The built renderer (`index.html` + assets). */
  readonly renderer: string;
  /** Shell pages (out-of-service), served under `/__shell/`. */
  readonly shell: string;
}

export type Resolution =
  | { readonly ok: true; readonly root: string; readonly file: string }
  | { readonly ok: false; readonly status: 400 | 403 | 404 };

/** Map an app:// URL to a file path under one of the roots (pure path logic; no I/O). */
export function resolveAppUrl(rawUrl: string, roots: ProtocolRoots): Resolution {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400 };
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return { ok: false, status: 403 };
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, status: 400 };
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return { ok: false, status: 400 };
  let root = roots.renderer;
  if (pathname === '/__shell' || pathname.startsWith('/__shell/')) {
    root = roots.shell;
    pathname = pathname.slice('/__shell'.length) || '/';
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.resolve(root, `.${path.posix.normalize(pathname)}`);
  const rel = path.relative(root, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, status: 403 };
  return { ok: true, root, file };
}

export interface StaticResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | null;
}

/** Serve one request: resolution, symlink containment, file read and security headers. */
export async function serveAppRequest(
  request: { readonly url: string; readonly method: string },
  roots: ProtocolRoots,
  csp: string,
): Promise<StaticResponse> {
  const base: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-cache',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return { status: 405, headers: base, body: null };
  }
  const res = resolveAppUrl(request.url, roots);
  if (!res.ok) return { status: res.status, headers: base, body: null };
  try {
    const [real, realRoot] = await Promise.all([realpath(res.file), realpath(res.root)]);
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel))
      return { status: 403, headers: base, body: null };
    if (!(await stat(real)).isFile()) return { status: 404, headers: base, body: null };
    const body = request.method === 'HEAD' ? null : new Uint8Array(await readFile(real));
    // CSP on every response: documents and worker scripts each take theirs from their own response.
    const headers: Record<string, string> = {
      ...base,
      'content-type': mimeType(real),
      'content-security-policy': csp,
    };
    return { status: 200, headers, body };
  } catch {
    return { status: 404, headers: base, body: null };
  }
}
