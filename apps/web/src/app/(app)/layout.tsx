import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';

/** Research/admin console and sign-in pages share the client providers (the kiosk does not). */
export default function AppLayout({ children }: { readonly children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
