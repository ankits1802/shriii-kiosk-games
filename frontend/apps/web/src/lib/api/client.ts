/**
 * Typed API client (openapi-fetch over the generated OpenAPI types).
 *
 * The browser calls the API through same-origin rewrites (`/api/v1/*` -> FastAPI, see
 * next.config.ts), so the base URL is the page origin and bearer tokens never appear in URLs.
 * A middleware attaches `Authorization: Bearer <jwt>` and an `x-request-id` for audit correlation;
 * a 401 on an authenticated call notifies the auth layer, which signs the user out.
 */
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import { ApiError, toApiError } from './errors';
import type { paths } from './types';

export type ApiClient = Client<paths>;

export interface ApiClientOptions {
  /** Absolute origin; defaults to the page origin in the browser. */
  readonly baseUrl?: string;
  /** Returns the current bearer token, or null when signed out. */
  readonly getToken: () => string | null;
  /** Called when an authenticated request is rejected with 401. */
  readonly onUnauthorized?: () => void;
  /** Injected fetch (tests). */
  readonly fetch?: typeof globalThis.fetch;
}

function newRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replaceAll('-', '');
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl =
    options.baseUrl ??
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');
  const client = createClient<paths>({
    baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const auth: Middleware = {
    onRequest({ request }) {
      const token = options.getToken();
      if (token && !request.headers.has('Authorization')) {
        request.headers.set('Authorization', `Bearer ${token}`);
      }
      if (!request.headers.has('x-request-id')) request.headers.set('x-request-id', newRequestId());
      return request;
    },
    onResponse({ request, response }) {
      if (response.status === 401 && request.headers.has('Authorization')) {
        options.onUnauthorized?.();
      }
      return response;
    },
  };
  client.use(auth);
  return client;
}

interface FetchResultLike<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: Response;
}

/**
 * Turn an openapi-fetch result into data-or-throw, for TanStack Query `queryFn`s:
 *
 * ```ts
 * queryFn: () => unwrap(api.GET('/api/v1/studies'))
 * ```
 */
export async function unwrap<T>(result: Promise<FetchResultLike<T>>): Promise<T> {
  const { data, error, response } = await result;
  if (response.ok && error === undefined) {
    return data as T;
  }
  throw toApiError(response.status, error, response.headers.get('x-request-id'));
}

export { ApiError };
