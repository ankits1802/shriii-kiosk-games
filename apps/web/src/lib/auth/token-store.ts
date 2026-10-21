/**
 * Bearer-token store. Tokens live in `sessionStorage` (cleared when the tab closes, never shared
 * across tabs, never sent automatically like a cookie) with an in-memory fallback when storage is
 * unavailable. Expired tokens read back as null.
 */

export type AuthProviderId = 'dev' | 'oidc';

export interface StoredSession {
  readonly accessToken: string;
  /** Expiry, epoch seconds (JWT `exp`). */
  readonly expiresAt: number;
  readonly provider: AuthProviderId;
  /** OIDC id_token, kept only for RP-initiated logout (`id_token_hint`). */
  readonly idToken?: string;
}

export interface TokenStore {
  get(): StoredSession | null;
  set(session: StoredSession): void;
  clear(): void;
  subscribe(listener: (session: StoredSession | null) => void): () => void;
}

export const TOKEN_STORAGE_KEY = 'shriii.auth.session';

/** Treat tokens as expired this many seconds early, to absorb clock skew and in-flight requests. */
export const EXPIRY_SKEW_SECONDS = 30;

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === 'string' &&
    v.accessToken.length > 0 &&
    typeof v.expiresAt === 'number' &&
    Number.isFinite(v.expiresAt) &&
    (v.provider === 'dev' || v.provider === 'oidc') &&
    (v.idToken === undefined || typeof v.idToken === 'string')
  );
}

export function isExpired(session: StoredSession, nowMs: number): boolean {
  return session.expiresAt - EXPIRY_SKEW_SECONDS <= nowMs / 1000;
}

export function createTokenStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
  now: () => number = Date.now,
): TokenStore {
  let memory: StoredSession | null = null;
  const listeners = new Set<(session: StoredSession | null) => void>();

  const read = (): StoredSession | null => {
    if (!storage) return memory;
    try {
      const raw = storage.getItem(TOKEN_STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isStoredSession(parsed) ? parsed : null;
    } catch {
      return memory;
    }
  };

  const write = (session: StoredSession | null): void => {
    memory = session;
    if (!storage) return;
    try {
      if (session) storage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(session));
      else storage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // Storage full or blocked: the in-memory copy still serves this page.
    }
  };

  const emit = (session: StoredSession | null): void => {
    for (const listener of listeners) listener(session);
  };

  return {
    get() {
      const session = read();
      if (!session) return null;
      if (isExpired(session, now())) {
        write(null);
        return null;
      }
      return session;
    },
    set(session) {
      write(session);
      emit(session);
    },
    clear() {
      write(null);
      emit(null);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Decode a JWT payload without verifying it (display/expiry only; the API verifies). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    const payload: unknown = JSON.parse(json);
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
