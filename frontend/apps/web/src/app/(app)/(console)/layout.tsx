import type { ReactNode } from 'react';
import { ConsoleGuard } from '@/components/auth/console-guard';
import { AppShell } from '@/components/shell/app-shell';
import { StudyScopeProvider } from '@/lib/study-scope';

/** /research/* and /admin/*: authenticated, role-gated, study-scoped console. */
export default function ConsoleLayout({ children }: { readonly children: ReactNode }) {
  return (
    <StudyScopeProvider>
      <AppShell>
        <ConsoleGuard>{children}</ConsoleGuard>
      </AppShell>
    </StudyScopeProvider>
  );
}
