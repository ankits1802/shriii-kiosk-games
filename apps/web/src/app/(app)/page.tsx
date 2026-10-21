'use client';

import { Loader2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth/auth-context';
import { defaultLanding } from '@/lib/nav';

/** `/`: send signed-in users to their first permitted page, everyone else to sign-in. */
export default function HomePage() {
  const { status, principal } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === 'authenticated') router.replace(defaultLanding(principal));
    else if (status === 'anonymous' || status === 'error') router.replace('/login');
  }, [status, principal, router]);
  return (
    <div
      role="status"
      className="flex min-h-dvh items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      Loading…
    </div>
  );
}
