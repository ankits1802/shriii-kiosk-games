'use client';

import { LockIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { EmptyState } from '@/components/data/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-context';

/** Signed in, but no console section is open to this principal (e.g. no recognised permissions). */
export default function NoAccessPage() {
  const { principal, signOut } = useAuth();
  const router = useRouter();
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <EmptyState
        icon={LockIcon}
        className="max-w-lg"
        title="Your account has no console access"
        description={
          principal
            ? `Signed in as ${principal.sub}. None of your roles opens a research or admin page. Ask a system administrator to grant a role.`
            : 'Sign in with an account that has a research or admin role.'
        }
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void signOut('user').then(() => router.replace('/login'))}
          >
            Sign in as someone else
          </Button>
        }
      />
    </div>
  );
}
