import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/errors';

/** Retry transient failures (network, 5xx) twice; never retry 4xx. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.isClientError) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

/** Query keys shared across features (feature pages add their own under their domain). */
export const queryKeys = {
  me: (token: string | null) => ['auth', 'me', token] as const,
  studies: () => ['studies', 'list'] as const,
  health: () => ['health'] as const,
};
