'use client';

/** Last-resort boundary (replaces the root layout, so it renders its own document). */
export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <html lang="en-IN">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'grid',
          placeItems: 'center',
          minHeight: '100dvh',
          margin: 0,
          background: '#f9f9f7',
          color: '#0b0b0b',
        }}
      >
        <main role="alert" style={{ textAlign: 'center', padding: 16 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>The application failed to load</h1>
          <p style={{ color: '#5c5b57', fontSize: 14 }}>
            {error.digest ? `Reference ${error.digest}. ` : ''}Reload the page or try again shortly.
          </p>
          <button type="button" onClick={reset} style={{ padding: '6px 12px', fontSize: 14 }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
