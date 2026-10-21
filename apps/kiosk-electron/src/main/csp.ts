/**
 * Content-Security-Policy and request allow-listing (KSK-01: strict CSP, no remote content except
 * the API). Pure functions, unit-tested.
 */

export const APP_SCHEME = 'app';
export const APP_HOST = 'kiosk';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export interface CspOptions {
  readonly apiOrigin: string | null;
  /** Development server origin (unpackaged only): allows its scripts and HMR socket. */
  readonly devUrl: string | null;
}

export function contentSecurityPolicy(o: CspOptions): string {
  const self = "'self'";
  const dev = o.devUrl;
  const devWs = dev ? dev.replace(/^http/, 'ws') : null;
  const connect = [self, o.apiOrigin, dev, devWs].filter(Boolean).join(' ');
  const script = [self, dev, dev ? "'unsafe-inline'" : null].filter(Boolean).join(' ');
  return [
    `default-src ${self}`,
    `script-src ${script}`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `media-src ${self} blob:`,
    `font-src ${self} data:`,
    `connect-src ${connect}`,
    `worker-src ${self} blob:`,
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Network allow-list applied in `session.webRequest.onBeforeRequest` (defence in depth behind the
 * CSP): only the app itself, in-memory URLs, devtools (unpackaged), the API origin and the dev
 * server. Everything else, including `file://`, is cancelled.
 */
export function isAllowedRequest(
  rawUrl: string,
  o: CspOptions & { readonly devtools: boolean },
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  switch (url.protocol) {
    case `${APP_SCHEME}:`:
      return url.host === APP_HOST;
    case 'data:':
    case 'blob:':
      return true;
    case 'devtools:':
    case 'chrome-extension:':
      return o.devtools;
    case 'http:':
    case 'https:':
    case 'ws:':
    case 'wss:': {
      if (o.apiOrigin && url.origin === o.apiOrigin) return true;
      if (o.devUrl) {
        const dev = new URL(o.devUrl);
        if (url.host === dev.host) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/** May the kiosk window navigate to this URL? Only within the app (or the dev server). */
export function isAllowedNavigation(rawUrl: string, devUrl: string | null): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST) return true;
    return devUrl !== null && url.origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}
