import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  /** Small line under the description (scope, audit stamp, data-layer note). */
  readonly meta?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-4 pb-4', className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
        {meta && <div className="pt-1">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Titled section within a page. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
