import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AuthConfigError, parseAuthConfig } from './config';
import {
  beginLogin,
  completeLogin,
  logoutUrl,
  OIDC_PENDING_KEY,
  type OidcClientConfig,
  type OidcDeps,
  pkceChallenge,
  safeReturnTo,
} from './oidc';

const ISSUER = 'https://idp.example.org/realms/shriii';
const config: OidcClientConfig = {
  issuer: ISSUER,
  clientId: 'shriii-web',
  scope: 'openid profile',
  audience: 'shriii-api',
  redirectUri: 'http://localhost:3000/auth/callback',
};

const discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
};

function enc(o: object): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

function makeDeps(tokenResponse: (body: URLSearchParams) => object, now = 1_700_000_000_000) {
  const map = new Map<string, string>();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify(discovery), { status: 200 });
    }
    if (url === discovery.token_endpoint) {
      return new Response(JSON.stringify(tokenResponse(init?.body as URLSearchParams)), {
        status: 200,
      });
    }
    return new Response('not found', { status: 404 });
  });
  const deps: OidcDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    storage: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    },
    crypto: webcrypto as unknown as Crypto,
    now: () => now,
  };
  return { deps, map, fetchMock };
}

describe('PKCE', () => {
  it('derives the RFC 7636 S256 challenge', async () => {
    // RFC 7636 appendix B test vector.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(await pkceChallenge(webcrypto as unknown as Crypto, verifier)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('authorization code flow', () => {
  it('builds the authorization URL and completes the exchange', async () => {
    let pendingNonce = '';
    const { deps, map } = makeDeps((body) => {
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('the-code');
      expect(body.get('client_id')).toBe('shriii-web');
      expect(body.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
      return {
        access_token: `${enc({ alg: 'RS256' })}.${enc({ exp: 1_700_000_900 })}.s`,
        id_token: `${enc({ alg: 'RS256' })}.${enc({ nonce: pendingNonce })}.s`,
        expires_in: 300,
      };
    });
    const url = new URL(await beginLogin(config, '/research/validation', deps));
    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('audience')).toBe('shriii-api');
    const pending = JSON.parse(map.get(OIDC_PENDING_KEY) ?? '{}') as {
      state: string;
      nonce: string;
    };
    pendingNonce = pending.nonce;
    expect(url.searchParams.get('state')).toBe(pending.state);

    const { session, returnTo } = await completeLogin(
      config,
      `${config.redirectUri}?code=the-code&state=${pending.state}`,
      deps,
    );
    expect(returnTo).toBe('/research/validation');
    expect(session.provider).toBe('oidc');
    expect(session.expiresAt).toBe(1_700_000_000 + 300);
    expect(map.has(OIDC_PENDING_KEY)).toBe(false); // single use
  });

  it('rejects a state mismatch, a provider error and a nonce mismatch', async () => {
    const { deps } = makeDeps(() => ({
      access_token: 'a.b.c',
      id_token: `${enc({})}.${enc({ nonce: 'other' })}.s`,
    }));
    await beginLogin(config, '/research', deps);
    await expect(
      completeLogin(config, `${config.redirectUri}?code=c&state=wrong`, deps),
    ).rejects.toThrow(/does not match/);

    await beginLogin(config, '/research', deps);
    await expect(
      completeLogin(
        config,
        `${config.redirectUri}?error=access_denied&error_description=Denied`,
        deps,
      ),
    ).rejects.toThrow(/Denied/);

    const url = new URL(await beginLogin(config, '/research', deps));
    const state = url.searchParams.get('state') ?? '';
    await expect(
      completeLogin(config, `${config.redirectUri}?code=c&state=${state}`, deps),
    ).rejects.toThrow(/nonce/);
  });

  it('refuses a callback without a pending login', async () => {
    const { deps } = makeDeps(() => ({}));
    await expect(
      completeLogin(config, `${config.redirectUri}?code=c&state=s`, deps),
    ).rejects.toThrow(/No sign-in/);
  });

  it('builds the RP-initiated logout URL', async () => {
    const { deps } = makeDeps(() => ({}));
    const url = new URL(
      (await logoutUrl(config, 'idt', 'http://localhost:3000/login', deps)) ?? '',
    );
    expect(url.searchParams.get('id_token_hint')).toBe('idt');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000/login');
  });
});

describe('safeReturnTo', () => {
  it('allows same-origin paths only', () => {
    expect(safeReturnTo('/research/studies')).toBe('/research/studies');
    expect(safeReturnTo('//evil.example')).toBe('/research');
    expect(safeReturnTo('/\\evil.example')).toBe('/research');
    expect(safeReturnTo('https://evil.example')).toBe('/research');
    expect(safeReturnTo(null, '')).toBe('');
  });
});

describe('parseAuthConfig', () => {
  it('defaults to dev mode', () => {
    expect(parseAuthConfig({})).toEqual({ mode: 'dev' });
  });
  it('validates OIDC settings', () => {
    expect(() => parseAuthConfig({ NEXT_PUBLIC_AUTH_MODE: 'oidc' })).toThrow(AuthConfigError);
    expect(() =>
      parseAuthConfig({
        NEXT_PUBLIC_AUTH_MODE: 'oidc',
        NEXT_PUBLIC_OIDC_ISSUER: 'http://idp.example.org',
        NEXT_PUBLIC_OIDC_CLIENT_ID: 'c',
      }),
    ).toThrow(/https/);
    expect(() => parseAuthConfig({ NEXT_PUBLIC_AUTH_MODE: 'saml' })).toThrow(AuthConfigError);
    expect(
      parseAuthConfig({
        NEXT_PUBLIC_AUTH_MODE: 'oidc',
        NEXT_PUBLIC_OIDC_ISSUER: `${ISSUER}/`,
        NEXT_PUBLIC_OIDC_CLIENT_ID: 'shriii-web',
        NEXT_PUBLIC_OIDC_SCOPE: 'profile',
      }),
    ).toEqual({
      mode: 'oidc',
      issuer: ISSUER,
      clientId: 'shriii-web',
      scope: 'openid profile',
      audience: null,
    });
  });
});
