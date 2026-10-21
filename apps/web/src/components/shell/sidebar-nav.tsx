'use client';

import { ExternalLinkIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { navItemFor, visibleNav } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { NavIcon } from './nav-icon';

/** Role-aware navigation: only routes the principal may open are listed. */
export function SidebarNav({ onNavigate }: { readonly onNavigate?: () => void }) {
  const { principal } = useAuth();
  const pathname = usePathname();
  const active = navItemFor(pathname)?.href ?? null;
  const sections = visibleNav(principal);

  return (
    <nav aria-label="Console" className="flex flex-col gap-5 px-3 py-4">
      {sections.map((section) => (
        <div key={section.id} className="space-y-1" data-testid={`nav-section-${section.id}`}>
          <p className="px-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            {section.label}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const isActive = active === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    {...(onNavigate ? { onClick: onNavigate } : {})}
                    aria-current={isActive ? 'page' : undefined}
                    data-testid={`nav-${item.href.slice(1).replaceAll('/', '-')}`}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                    )}
                  >
                    <NavIcon id={item.icon} className="size-4 shrink-0 opacity-80" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="space-y-1 border-t pt-4">
        <p className="px-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          Kiosk
        </p>
        <a
          href="/kiosk"
          target="_blank"
          rel="noopener"
          className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent/60"
        >
          <ExternalLinkIcon className="size-4 opacity-80" aria-hidden="true" />
          Open kiosk
        </a>
      </div>
    </nav>
  );
}
