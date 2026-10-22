'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * A page selection kept in the query string (`?construct=self_control`), so views are linkable and
 * survive reloads. Pages using it render inside a Suspense boundary (Next.js requirement).
 */
export function useUrlState(key: string): [string | null, (value: string | null) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = params.get(key);
  const set = useCallback(
    (next: string | null) => {
      const sp = new URLSearchParams(window.location.search);
      if (next === null || next === '') sp.delete(key);
      else sp.set(key, next);
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [key, pathname, router],
  );
  return [value, set];
}
