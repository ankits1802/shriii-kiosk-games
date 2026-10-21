'use client';

import { useEffect } from 'react';

export default function RootError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    console.error('[app] unhandled error', error);
  }, [error]);
  return (
    <main
      role="alert"
      className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center"
    >
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The page could not be displayed.{error.digest ? ` Reference ${error.digest}.` : ''}
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
      >
        Try again
      </button>
    </main>
  );
}
