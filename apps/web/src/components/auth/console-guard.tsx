'use client';

import { Loader2Icon, LockIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { EmptyState, ErrorState } from '@/components/data/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-context';
import { canOpen, defaultLanding } from '@/lib/nav';

/**
 * Client-side gate for every console route: signed-out users go to /login (with a return path);
 * signed-in users without the route's permission get a 403 panel. The API enforces the same rules.
 */
export function ConsoleGuard({ children }: { readonly children: ReactNode }) {
  const { status, principal, error, retry } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (status === 'anonymous') {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [status, pathname, router]);

  if (status === 'loading' || status === 'anonymous') {
    return (
      <div
        role="status"
        className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        {status === 'loading' ? 'Checking your session…' : 'Redirecting to sign in…'}
      </div>
    );
  }
  if (status === 'error') {
    return <ErrorState error={error} title="Could not load your account" onRetry={retry} />;
  }
  if (!canOpen(principal, pathname)) {
    return (
      <div data-testid="forbidden">
        <EmptyState
          icon={LockIcon}
          title="You do not have access to this page"
          description="Your role or study scope does not include it. Ask a system administrator if you need access."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={defaultLanding(principal)}>Go to your start page</Link>
            </Button>
          }
        />
      </div>
    );
  }
  return <>{children}</>;
}
