import { describe, expect, it, vi } from 'vitest';
import { createApiClient, unwrap } from './client';
import { ApiError, errorMessage, toApiError } from './errors';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('API client', () => {
  it('attaches the bearer token and a request id', async () => {
    const fetchMock = vi.fn(async (req: Request) => {
      expect(req.headers.get('Authorization')).toBe('Bearer tok');
      expect(req.headers.get('x-request-id')).toMatch(/^[0-9a-f]{16,}$/);
      return jsonResponse(200, {
        sub: 'u',
        kind: 'user',
        roles: ['analyst'],
        studies: ['*'],
        permissions: [],
        kiosk_id: null,
      });
    });
    const api = createApiClient({
      baseUrl: 'http://api.test',
      getToken: () => 'tok',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const me = await unwrap(api.GET('/api/v1/auth/me'));
    expect(me.roles).toEqual(['analyst']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('omits Authorization when signed out and reports 401s only for authenticated calls', async () => {
    const onUnauthorized = vi.fn();
    let token: string | null = null;
    const fetchMock = vi.fn(async (req: Request) => {
      if (token) expect(req.headers.get('Authorization')).toBe(`Bearer ${token}`);
      else expect(req.headers.has('Authorization')).toBe(false);
      return jsonResponse(401, { detail: { code: 'unauthenticated', message: 'token expired' } });
    });
    const api = createApiClient({
      baseUrl: 'http://api.test',
      getToken: () => token,
      onUnauthorized,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(unwrap(api.GET('/api/v1/auth/me'))).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
    token = 'expired';
    const err = await unwrap(api.GET('/api/v1/auth/me')).catch((e: unknown) => e);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(err).toMatchObject({ status: 401, code: 'unauthenticated', message: 'token expired' });
  });

  it('serialises request bodies with the generated types', async () => {
    const fetchMock = vi.fn(async (req: Request) => {
      expect(await req.json()).toEqual({
        sub: 'dev',
        roles: ['researcher'],
        studies: null,
        ttl_minutes: null,
      });
      return jsonResponse(200, { access_token: 'a', token_type: 'bearer', expires_at: 1 });
    });
    const api = createApiClient({
      baseUrl: 'http://api.test',
      getToken: () => null,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await unwrap(
      api.POST('/api/v1/auth/dev-login', {
        body: { sub: 'dev', roles: ['researcher'], studies: null, ttl_minutes: null },
      }),
    );
    expect(res.access_token).toBe('a');
  });
});

describe('toApiError', () => {
  it('normalises FastAPI detail shapes', () => {
    expect(toApiError(403, { detail: 'forbidden: scores.read' }).message).toBe(
      'forbidden: scores.read',
    );
    const v = toApiError(422, {
      detail: [
        { loc: ['body', 'roles', 0], msg: 'Input should be admin', type: 'enum' },
        { loc: ['body', 'sub'], msg: 'Field required', type: 'missing' },
      ],
    });
    expect(v.fieldErrors).toEqual([
      { path: 'roles.0', message: 'Input should be admin' },
      { path: 'sub', message: 'Field required' },
    ]);
    expect(v.message).toBe('roles.0: Input should be admin (+1 more)');
    expect(toApiError(502, 'Bad gateway', 'rid').message).toBe('The API is unreachable.');
    expect(toApiError(502, null, 'rid').requestId).toBe('rid');
  });

  it('classifies errors', () => {
    const e = new ApiError({ status: 404, message: 'x' });
    expect(e.isNotFound && e.isClientError).toBe(true);
    expect(errorMessage(new TypeError('fetch failed'))).toMatch(/Network error/);
  });
});
