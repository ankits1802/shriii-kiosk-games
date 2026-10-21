'use client';

import { AlertTriangleIcon, Loader2Icon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-context';

/** OIDC redirect target: exchanges the code, then continues to the saved return path. */
export default function OidcCallbackPage() {
  const { completeOidc } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // the code is single-use; StrictMode runs effects twice
    started.current = true;
    completeOidc(window.location.href)
      .then((returnTo) => router.replace(returnTo))
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [completeOidc, router]);

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      {error ? (
        <div className="w-full max-w-md space-y-4">
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Sign-in could not be completed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <Button asChild variant="outline">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </div>
      ) : (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          Completing sign-in…
        </p>
      )}
    </div>
  );
}
