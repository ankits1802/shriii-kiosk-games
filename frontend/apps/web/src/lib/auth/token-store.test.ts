import { describe, expect, it, vi } from 'vitest';
import {
  createTokenStore,
  decodeJwtPayload,
  EXPIRY_SKEW_SECONDS,
  TOKEN_STORAGE_KEY,
} from './token-store';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

function jwt(payload: object): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256' })}.${enc(payload)}.sig`;
}

describe('token store', () => {
  it('persists, reads back and notifies', () => {
    const storage = memoryStorage();
    const now = 1_000_000_000_000;
    const store = createTokenStore(storage, () => now);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ accessToken: 't', expiresAt: now / 1000 + 3600, provider: 'dev' });
    expect(store.get()?.accessToken).toBe('t');
    expect(storage.map.has(TOKEN_STORAGE_KEY)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    store.clear();
    expect(store.get()).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(null);
  });

  it('treats tokens inside the skew window as expired and removes them', () => {
    const storage = memoryStorage();
    let now = 0;
    const store = createTokenStore(storage, () => now);
    store.set({ accessToken: 't', expiresAt: 100, provider: 'dev' });
    now = (100 - EXPIRY_SKEW_SECONDS - 1) * 1000;
    expect(store.get()).not.toBeNull();
    now = (100 - EXPIRY_SKEW_SECONDS) * 1000;
    expect(store.get()).toBeNull();
    expect(storage.map.has(TOKEN_STORAGE_KEY)).toBe(false);
  });

  it('ignores corrupt or foreign storage values', () => {
    const storage = memoryStorage();
    storage.setItem(TOKEN_STORAGE_KEY, '{"accessToken": 3}');
    expect(createTokenStore(storage).get()).toBeNull();
    storage.setItem(TOKEN_STORAGE_KEY, 'not json');
    expect(createTokenStore(storage).get()).toBeNull();
  });

  it('works without storage (memory only)', () => {
    const store = createTokenStore(null, () => 0);
    store.set({ accessToken: 'm', expiresAt: 10_000, provider: 'oidc' });
    expect(store.get()?.provider).toBe('oidc');
  });
});

describe('decodeJwtPayload', () => {
  it('decodes base64url payloads including non-ASCII', () => {
    expect(decodeJwtPayload(jwt({ sub: 'अनुज', exp: 5 }))).toEqual({ sub: 'अनुज', exp: 5 });
  });
  it('returns null for malformed tokens', () => {
    expect(decodeJwtPayload('abc')).toBeNull();
    expect(decodeJwtPayload('a.!!!.c')).toBeNull();
  });
});
