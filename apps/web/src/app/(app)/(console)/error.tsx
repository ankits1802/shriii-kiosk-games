'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/data/states';

/** Render-time failure inside a console page; the shell and navigation stay usable. */
export default function ConsoleError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    console.error('[console] page error', error);
  }, [error]);
  return <ErrorState error={error} title="This page hit an error" onRetry={reset} />;
}
