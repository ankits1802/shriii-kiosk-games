/**
 * Auth provider configuration (build-time `NEXT_PUBLIC_*` values).
 *
 * - `dev`: local signed-JWT login via `POST /api/v1/auth/dev-login` (the API refuses it outside
 *   ENV=dev/test with AUTH_MODE=dev).
 * - `oidc`: any OpenID Connect provider, authorization code + PKCE as a public client. The API
 *   verifies the access token against the provider JWKS (AUTH_MODE=oidc).
 */

export const OIDC_CALLBACK_PATH = '/auth/callback';

export type AuthConfig =
  | { readonly mode: 'dev' }
  | {
      readonly mode: 'oidc';
      readonly issuer: string;
      readonly clientId: string;
      readonly scope: string;
      readonly audience: string | null;
    };

export interface AuthEnv {
  readonly NEXT_PUBLIC_AUTH_MODE?: string | undefined;
  readonly NEXT_PUBLIC_OIDC_ISSUER?: string | undefined;
  readonly NEXT_PUBLIC_OIDC_CLIENT_ID?: string | undefined;
  readonly NEXT_PUBLIC_OIDC_SCOPE?: string | undefined;
  readonly NEXT_PUBLIC_OIDC_AUDIENCE?: string | undefined;
}

export class AuthConfigError extends Error {
  override readonly name = 'AuthConfigError';
}

export function parseAuthConfig(env: AuthEnv): AuthConfig {
  const mode = (env.NEXT_PUBLIC_AUTH_MODE ?? 'dev').trim().toLowerCase();
  if (mode === '' || mode === 'dev') return { mode: 'dev' };
  if (mode !== 'oidc') {
    throw new AuthConfigError(`NEXT_PUBLIC_AUTH_MODE must be "dev" or "oidc", got "${mode}"`);
  }
  const issuer = (env.NEXT_PUBLIC_OIDC_ISSUER ?? '').trim().replace(/\/+$/, '');
  const clientId = (env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? '').trim();
  if (!issuer || !clientId) {
    throw new AuthConfigError(
      'OIDC mode needs NEXT_PUBLIC_OIDC_ISSUER and NEXT_PUBLIC_OIDC_CLIENT_ID',
    );
  }
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new AuthConfigError(`NEXT_PUBLIC_OIDC_ISSUER is not a URL: ${issuer}`);
  }
  if (issuerUrl.protocol !== 'https:' && issuerUrl.hostname !== 'localhost') {
    throw new AuthConfigError('NEXT_PUBLIC_OIDC_ISSUER must use https (localhost excepted)');
  }
  const scope = (env.NEXT_PUBLIC_OIDC_SCOPE ?? '').trim() || 'openid profile email';
  const audience = (env.NEXT_PUBLIC_OIDC_AUDIENCE ?? '').trim() || null;
  return {
    mode: 'oidc',
    issuer,
    clientId,
    scope: scope.split(/\s+/).includes('openid') ? scope : `openid ${scope}`,
    audience,
  };
}

/** The app's configuration. `process.env.NEXT_PUBLIC_*` must be referenced literally to inline. */
export function readAuthConfig(): AuthConfig {
  return parseAuthConfig({
    NEXT_PUBLIC_AUTH_MODE: process.env.NEXT_PUBLIC_AUTH_MODE,
    NEXT_PUBLIC_OIDC_ISSUER: process.env.NEXT_PUBLIC_OIDC_ISSUER,
    NEXT_PUBLIC_OIDC_CLIENT_ID: process.env.NEXT_PUBLIC_OIDC_CLIENT_ID,
    NEXT_PUBLIC_OIDC_SCOPE: process.env.NEXT_PUBLIC_OIDC_SCOPE,
    NEXT_PUBLIC_OIDC_AUDIENCE: process.env.NEXT_PUBLIC_OIDC_AUDIENCE,
  });
}
