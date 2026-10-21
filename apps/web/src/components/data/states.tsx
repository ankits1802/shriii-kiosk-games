'use client';

import { AlertTriangleIcon, InboxIcon, LockIcon, RefreshCwIcon, WifiOffIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly icon?: ComponentType<{ className?: string }>;
  readonly action?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string | undefined;
}

/** Nothing to show yet: says what will appear and how it gets there. */
export function EmptyState({
  title,
  description,
  icon: Icon = InboxIcon,
  action,
  children,
  className,
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card/50 px-6 py-10 text-center',
        className,
      )}
    >
      <div className="rounded-full bg-muted p-3 text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="max-w-prose space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      {children}
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  readonly error: unknown;
  readonly title?: string;
  readonly onRetry?: () => void;
  readonly className?: string | undefined;
}

/** Load failure with the API's reason, the request id for support, and a retry. */
export function ErrorState({ error, title, onRetry, className }: ErrorStateProps) {
  const forbidden = error instanceof ApiError && error.isForbidden;
  const network = error instanceof TypeError;
  const Icon = forbidden ? LockIcon : network ? WifiOffIcon : AlertTriangleIcon;
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <div
      role="alert"
      data-slot="error-state"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-card px-6 py-10 text-center',
        className,
      )}
    >
      <div className="rounded-full bg-destructive/10 p-3 text-destructive">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="max-w-prose space-y-1">
        <p className="text-sm font-medium">
          {title ?? (forbidden ? 'Access denied' : 'Could not load this data')}
        </p>
        <p className="text-sm text-muted-foreground">{errorMessage(error)}</p>
        {requestId && (
          <p className="font-mono text-xs text-muted-foreground">Request ID {requestId}</p>
        )}
      </div>
      {onRetry && !forbidden && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCwIcon aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}

/** Skeleton rows for tables and lists while data loads. */
export function LoadingState({
  rows = 5,
  label = 'Loading',
  className,
}: {
  readonly rows?: number;
  readonly label?: string;
  readonly className?: string | undefined;
}) {
  return (
    <div role="status" aria-live="polite" className={cn('space-y-2', className)}>
      <span className="sr-only">{label}…</span>
      <Skeleton className="h-8 w-1/3" />
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/** Generic query-result switch: loading -> error -> empty -> content. */
export function QueryState<T>({
  query,
  isEmpty,
  empty,
  loading,
  children,
}: {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: unknown;
    readonly data: T | undefined;
    readonly refetch: () => unknown;
  };
  readonly isEmpty?: (data: T) => boolean;
  readonly empty?: ReactNode;
  readonly loading?: ReactNode;
  readonly children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <>{loading ?? <LoadingState />}</>;
  if (query.isError || query.data === undefined) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (isEmpty?.(query.data) && empty) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
