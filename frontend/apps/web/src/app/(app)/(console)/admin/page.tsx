'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LoadingState } from '@/components/data/states';
import { useAuth } from '@/lib/auth/auth-context';
import { satisfies } from '@/lib/auth/principal';
import { ADMIN_NAV } from '@/lib/nav';

/** `/admin`: open the first admin page this principal may use. */
export default function AdminIndexPage() {
  const { principal } = useAuth();
  const router = useRouter();
  const target = ADMIN_NAV.find((item) => satisfies(principal, item.requires));
  useEffect(() => {
    if (target) router.replace(target.href);
  }, [target, router]);
  return <LoadingState rows={3} label="Opening admin" />;
}
