'use client';

import { MenuIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { breadcrumbs } from '@/lib/nav';
import { SidebarNav } from './sidebar-nav';
import { StudySwitcher } from './study-switcher';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

function Brand() {
  return (
    <Link href="/research" className="flex items-center gap-2 px-4 py-3.5">
      <span
        aria-hidden="true"
        className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground"
      >
        S
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold">SHRIII</span>
        <span className="block text-[11px] text-muted-foreground">
          Behavioural Games · Research
        </span>
      </span>
    </Link>
  );
}

function Breadcrumbs() {
  const pathname = usePathname();
  const crumbs = breadcrumbs(pathname);
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
        {crumbs.map((c, i) => (
          <Fragment key={c.href}>
            {i > 0 && <li aria-hidden="true">/</li>}
            <li className="truncate">
              {i === crumbs.length - 1 ? (
                <span aria-current="page" className="font-medium text-foreground">
                  {c.label}
                </span>
              ) : (
                <Link href={c.href} className="hover:text-foreground">
                  {c.label}
                </Link>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

/** Console chrome: sidebar (sheet on small screens), top bar, main content. */
export function AppShell({ children }: { readonly children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col overflow-y-auto border-r bg-sidebar lg:flex">
        <Brand />
        <SidebarNav />
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Console sections you can open</SheetDescription>
          <Brand />
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur sm:px-5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <MenuIcon />
          </Button>
          <Breadcrumbs />
          <div className="ml-auto flex items-center gap-1.5">
            <StudySwitcher />
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-3 py-5 sm:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
