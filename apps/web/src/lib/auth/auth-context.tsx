'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { type ApiClient, createApiClient, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import type { DevLoginRole } from '@/lib/api/types';
import { queryKeys } from '@/lib/query';
import { type AuthConfig, OIDC_CALLBACK_PATH, readAuthConfig } from './config';
import { beginLogin, completeLogin, logoutUrl, type OidcDeps } from './oidc';
import { type Principal, principalFromMe } from './principal';
import { createTokenStore, EXPIRY_SKEW_SECONDS, type TokenStore } from './token-store';

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'error';
export type SignOutReason = 'user' | 'expired' | 'unauthorized';

export interface DevSignInInput {
  readonly sub: string;
  readonly roles: readonly DevLoginRole[];
  /** Study scope; null or omitted = all studies. */
  readonly studies?: readonly string[] | null;
  readonly ttlMinutes?: number;
}

export interface AuthContextValue {
  readonly status: AuthStatus;
  readonly principal: Principal | null;
  readonly config: AuthConfig | null;
  readonly configError: string | null;
  readonly api: ApiClient;
  /** Why the last session ended (shown on the login page). */
  readonly signOutReason: SignOutReason | null;
  /** Error from loading the principal (other than 401). */
  readonly error: unknown;
  /** Retry loading the principal after an `error` status. */
  retry(): void;
  signInDev(input: DevSignInInput): Promise<void>;
  signInOidc(returnTo: string): Promise<void>;
  completeOidc(callbackUrl: string): Promise<string>;
  signOut(reason?: SignOutReason): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthRuntime {
  readonly store: TokenStore;
  readonly api: ApiClient;
  onUnauthorized: () => void;
}

let runtime: AuthRuntime | null = null;

/** One token store and API client per browser tab. */
function getRuntime(): AuthRuntime {
  if (runtime) return runtime;
  const storage = typeof window === 'undefined' ? null : safeSessionStorage();
  const store = createTokenStore(storage);
  const rt: AuthRuntime = {
    store,
    api: createApiClient({
      getToken: () => store.get()?.accessToken ?? null,
      onUnauthorized: () => rt.onUnauthorized(),
    }),
    onUnauthorized: () => undefined,
  };
  runtime = rt;
  return rt;
}

function safeSessionStorage(): Storage | null {
  try {
    const s = window.sessionStorage;
    const probe = '__shriii_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function oidcDeps(): OidcDeps {
  const storage = safeSessionStorage();
  if (!storage) throw new Error('Session storage is blocked; OIDC sign-in needs it.');
  return { fetch: window.fetch.bind(window), storage, crypto: window.crypto, now: Date.now };
}

function loadConfig(): { config: AuthConfig | null; error: string | null } {
  try {
    return { config: readAuthConfig(), error: null };
  } catch (err) {
    return { config: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const rt = getRuntime();
  const queryClient = useQueryClient();
  const [{ config, error: configError }] = useState(loadConfig);
  const [signOutReason, setSignOutReason] = useState<SignOutReason | null>(null);

  // The token string is the external snapshot (a primitive, so React can compare it). On the
  // server and during hydration it is `undefined` = not yet known.
  const token = useSyncExternalStore<string | null | undefined>(
    (onChange) => rt.store.subscribe(onChange),
    () => rt.store.get()?.accessToken ?? null,
    () => undefined,
  );

  const signOut = useCallback(
    async (reason: SignOutReason = 'user') => {
      const session = rt.store.get();
      rt.store.clear();
      queryClient.clear(); // drop cached research data with the session
      setSignOutReason(reason);
      if (reason === 'user' && session?.provider === 'oidc' && config?.mode === 'oidc') {
        try {
          const url = await logoutUrl(
            { ...config, redirectUri: `${window.location.origin}${OIDC_CALLBACK_PATH}` },
            session.idToken,
            `${window.location.origin}/login`,
            { fetch: window.fetch.bind(window) },
          );
          if (url) window.location.assign(url);
        } catch {
          // Provider logout is best effort; the local session is already gone.
        }
      }
    },
    [rt, queryClient, config],
  );

  useEffect(() => {
    rt.onUnauthorized = () => {
      void signOut('unauthorized');
    };
    return () => {
      rt.onUnauthorized = () => undefined;
    };
  }, [rt, signOut]);

  // Sign out exactly when the token expires.
  useEffect(() => {
    if (!token) return;
    const session = rt.store.get();
    if (!session) return;
    const ms = (session.expiresAt - EXPIRY_SKEW_SECONDS) * 1000 - Date.now();
    const timer = window.setTimeout(() => void signOut('expired'), Math.max(0, ms));
    return () => window.clearTimeout(timer);
  }, [rt, token, signOut]);

  const me = useQuery({
    queryKey: queryKeys.me(token ?? null),
    queryFn: () => unwrap(rt.api.GET('/api/v1/auth/me')),
    enabled: typeof token === 'string',
    staleTime: 5 * 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.isClientError) && count < 2,
  });

  const principal = useMemo(() => (me.data ? principalFromMe(me.data) : null), [me.data]);

  const meError = me.error instanceof ApiError && me.error.isUnauthorized ? null : me.error;

  let status: AuthStatus;
  if (token === undefined) status = 'loading';
  else if (token === null) status = 'anonymous';
  else if (principal) status = 'authenticated';
  else if (me.isError) status = meError ? 'error' : 'anonymous';
  else status = 'loading';

  const { refetch } = me;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const signInDev = useCallback(
    async (input: DevSignInInput) => {
      const studies = input.studies && input.studies.length > 0 ? [...input.studies] : null;
      const res = await unwrap(
        rt.api.POST('/api/v1/auth/dev-login', {
          body: {
            sub: input.sub,
            roles: [...input.roles],
            studies,
            ttl_minutes: input.ttlMinutes ?? null,
          },
        }),
      );
      queryClient.clear();
      setSignOutReason(null);
      rt.store.set({ accessToken: res.access_token, expiresAt: res.expires_at, provider: 'dev' });
    },
    [rt, queryClient],
  );

  const signInOidc = useCallback(
    async (returnTo: string) => {
      if (config?.mode !== 'oidc') throw new Error('OIDC is not configured.');
      const url = await beginLogin(
        { ...config, redirectUri: `${window.location.origin}${OIDC_CALLBACK_PATH}` },
        returnTo,
        oidcDeps(),
      );
      window.location.assign(url);
    },
    [config],
  );

  const completeOidc = useCallback(
    async (callbackUrl: string) => {
      if (config?.mode !== 'oidc') throw new Error('OIDC is not configured.');
      const { session, returnTo } = await completeLogin(
        { ...config, redirectUri: `${window.location.origin}${OIDC_CALLBACK_PATH}` },
        callbackUrl,
        oidcDeps(),
      );
      queryClient.clear();
      setSignOutReason(null);
      rt.store.set(session);
      return returnTo;
    },
    [config, rt, queryClient],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      principal,
      config,
      configError,
      api: rt.api,
      signOutReason,
      error: meError,
      retry,
      signInDev,
      signInOidc,
      completeOidc,
      signOut,
    }),
    [
      status,
      principal,
      config,
      configError,
      rt.api,
      signOutReason,
      meError,
      retry,
      signInDev,
      signInOidc,
      completeOidc,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The typed API client bound to the current session. */
export function useApi(): ApiClient {
  return useAuth().api;
}
