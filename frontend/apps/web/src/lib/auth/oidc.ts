/**
 * OpenID Connect authorization-code flow with PKCE (RFC 7636) for a public browser client.
 * Provider-agnostic: endpoints come from the issuer's discovery document. No client secret.
 *
 * The access token is what the API verifies (issuer, audience, JWKS signature). The id_token's
 * nonce is checked here to bind the response to this browser's request.
 */
import type { StoredSession } from './token-store';
import { decodeJwtPayload } from './token-store';

export interface OidcClientConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly scope: string;
  readonly audience: string | null;
  readonly redirectUri: string;
}

export interface OidcDiscovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly end_session_endpoint?: string;
}

export interface OidcDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly crypto: Crypto;
  readonly now: () => number;
}

interface PendingLogin {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly returnTo: string;
  readonly createdAt: number;
}

export const OIDC_PENDING_KEY = 'shriii.oidc.pending';
/** A login round-trip older than this is refused. */
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export class OidcError extends Error {
  override readonly name = 'OidcError';
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(crypto: Crypto, byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function pkceChallenge(crypto: Crypto, verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Only same-origin relative paths are allowed as post-login destinations (no open redirects). */
export function safeReturnTo(value: string | null | undefined, fallback = '/research'): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback;
  }
  return value;
}

export async function discover(
  issuer: string,
  deps: Pick<OidcDeps, 'fetch'>,
): Promise<OidcDiscovery> {
  const res = await deps.fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new OidcError(`OIDC discovery failed (${res.status})`);
  const doc = (await res.json()) as Partial<OidcDiscovery>;
  if (
    typeof doc.authorization_endpoint !== 'string' ||
    typeof doc.token_endpoint !== 'string' ||
    typeof doc.issuer !== 'string'
  ) {
    throw new OidcError('OIDC discovery document is missing required endpoints');
  }
  if (doc.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
    throw new OidcError('OIDC discovery issuer does not match the configured issuer');
  }
  return {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    ...(typeof doc.end_session_endpoint === 'string'
      ? { end_session_endpoint: doc.end_session_endpoint }
      : {}),
  };
}

/** Prepare a login: persist state/nonce/verifier and return the provider URL to navigate to. */
export async function beginLogin(
  config: OidcClientConfig,
  returnTo: string,
  deps: OidcDeps,
): Promise<string> {
  const discovery = await discover(config.issuer, deps);
  const pending: PendingLogin = {
    state: randomToken(deps.crypto),
    nonce: randomToken(deps.crypto),
    verifier: randomToken(deps.crypto, 48),
    returnTo: safeReturnTo(returnTo),
    createdAt: deps.now(),
  };
  deps.storage.setItem(OIDC_PENDING_KEY, JSON.stringify(pending));
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', pending.state);
  url.searchParams.set('nonce', pending.nonce);
  url.searchParams.set('code_challenge', await pkceChallenge(deps.crypto, pending.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (config.audience) url.searchParams.set('audience', config.audience);
  return url.toString();
}

function readPending(deps: OidcDeps): PendingLogin {
  const raw = deps.storage.getItem(OIDC_PENDING_KEY);
  deps.storage.removeItem(OIDC_PENDING_KEY);
  if (!raw) throw new OidcError('No sign-in is in progress in this tab. Start again.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OidcError('Sign-in state is corrupt. Start again.');
  }
  const p = parsed as Partial<PendingLogin>;
  if (
    typeof p.state !== 'string' ||
    typeof p.nonce !== 'string' ||
    typeof p.verifier !== 'string' ||
    typeof p.returnTo !== 'string' ||
    typeof p.createdAt !== 'number'
  ) {
    throw new OidcError('Sign-in state is corrupt. Start again.');
  }
  if (deps.now() - p.createdAt > PENDING_MAX_AGE_MS) {
    throw new OidcError('Sign-in took too long. Start again.');
  }
  return p as PendingLogin;
}

/** Finish a login from the callback URL: verify state, exchange the code, check the nonce. */
export async function completeLogin(
  config: OidcClientConfig,
  callbackUrl: string,
  deps: OidcDeps,
): Promise<{ session: StoredSession; returnTo: string }> {
  const url = new URL(callbackUrl);
  const pending = readPending(deps);
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description');
    throw new OidcError(`Sign-in was refused: ${description ?? error}`);
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new OidcError('The sign-in response is incomplete.');
  if (state !== pending.state) throw new OidcError('The sign-in response does not match this tab.');

  const discovery = await discover(config.issuer, deps);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: pending.verifier,
  });
  const res = await deps.fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!res.ok) throw new OidcError(`Token exchange failed (${res.status})`);
  const tokens = (await res.json()) as {
    access_token?: unknown;
    id_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new OidcError('The provider returned no access token.');
  }
  const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : undefined;
  if (idToken) {
    const claims = decodeJwtPayload(idToken);
    if (!claims || claims.nonce !== pending.nonce) {
      throw new OidcError('The sign-in response failed the nonce check.');
    }
  }
  const nowSeconds = Math.floor(deps.now() / 1000);
  const accessClaims = decodeJwtPayload(tokens.access_token);
  const expiresAt =
    typeof tokens.expires_in === 'number' && tokens.expires_in > 0
      ? nowSeconds + Math.floor(tokens.expires_in)
      : typeof accessClaims?.exp === 'number'
        ? accessClaims.exp
        : nowSeconds + 300;
  return {
    session: {
      accessToken: tokens.access_token,
      expiresAt,
      provider: 'oidc',
      ...(idToken ? { idToken } : {}),
    },
    returnTo: pending.returnTo,
  };
}

/** RP-initiated logout URL, or null when the provider has no end-session endpoint. */
export async function logoutUrl(
  config: OidcClientConfig,
  idToken: string | undefined,
  postLogoutRedirectUri: string,
  deps: Pick<OidcDeps, 'fetch'>,
): Promise<string | null> {
  const discovery = await discover(config.issuer, deps);
  if (!discovery.end_session_endpoint) return null;
  const url = new URL(discovery.end_session_endpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  if (idToken) url.searchParams.set('id_token_hint', idToken);
  return url.toString();
}
