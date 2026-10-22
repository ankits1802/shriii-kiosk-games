'use client';

import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { PlugZapIcon, PlusIcon, ShieldCheckIcon, XIcon } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { MISSING_ENDPOINTS, type MissingEndpointId } from './missing-endpoints';
import { checkApprovers } from './two-person';

/** Inline notice for a capability whose API endpoint does not exist yet (no faked data). */
export function NeedsApi({
  endpoint,
  className,
  compact,
}: {
  readonly endpoint: MissingEndpointId;
  readonly className?: string;
  readonly compact?: boolean;
}) {
  const e = MISSING_ENDPOINTS[endpoint];
  return (
    <div
      data-slot="needs-api"
      data-endpoint={e.id}
      className={cn(
        'flex items-start gap-2 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground',
        className,
      )}
    >
      <PlugZapIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        <p>
          <span className="font-medium text-foreground/80">Needs API</span>{' '}
          <code className="font-mono text-[11px]">
            {e.method} {e.path}
          </code>{' '}
          <span className="opacity-80">({e.feature})</span>
        </p>
        {!compact && <p>{e.purpose}</p>}
      </div>
    </div>
  );
}

/** Small definition list for record details. */
export function KeyValues({
  items,
  className,
}: {
  readonly items: readonly (readonly [label: string, value: ReactNode])[];
  readonly className?: string;
}) {
  return (
    <dl
      className={cn('grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm', className)}
    >
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Short monospace hash with the full value in the title. */
export function Hash({
  value,
  length = 12,
}: {
  readonly value: string | null | undefined;
  readonly length?: number;
}) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <code className="font-mono text-xs" title={value}>
      {value.slice(0, length)}
    </code>
  );
}

/**
 * Mutation with toasts and cache invalidation. `invalidate` lists query-key prefixes to refetch on
 * success.
 */
export function useAdminMutation<TVars, TData>({
  mutationFn,
  invalidate = [],
  success,
}: {
  readonly mutationFn: (vars: TVars) => Promise<TData>;
  readonly invalidate?: readonly QueryKey[];
  readonly success?: string | ((data: TData) => string);
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (data) => {
      await Promise.all(invalidate.map((queryKey) => qc.invalidateQueries({ queryKey })));
      if (success) toast.success(typeof success === 'function' ? success(data) : success);
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
  });
}

/**
 * Two-person approval dialog: collects two (or more) distinct named approvers, checks them before
 * submitting, and shows the server's refusal if any.
 */
export function ApprovalDialog({
  open,
  onOpenChange,
  title,
  description,
  subject,
  exclude,
  pending,
  error,
  onApprove,
  confirmLabel = 'Approve',
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: ReactNode;
  /** What is being approved, shown prominently (e.g. `stall@0.1.0`). */
  readonly subject: ReactNode;
  readonly exclude?: readonly string[];
  readonly pending?: boolean;
  readonly error?: unknown;
  readonly onApprove: (approvers: string[]) => void;
  readonly confirmLabel?: string;
}) {
  const [names, setNames] = useState<string[]>(['', '']);
  const [touched, setTouched] = useState(false);
  const baseId = useId();
  const check = checkApprovers(names, exclude ? { exclude } : {});
  const showErrors = touched && check.errors.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setNames(['', '']);
          setTouched(false);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="rounded-md bg-muted px-3 py-2 font-mono text-sm">{subject}</div>
        <form
          className="space-y-3"
          aria-label="Approvers"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (check.errors.length === 0) onApprove([...check.approvers]);
          }}
        >
          {names.map((name, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: approver slots are positional
            <div key={i} className="space-y-1">
              <Label htmlFor={`${baseId}-${i}`}>Approver {i + 1}</Label>
              <div className="flex gap-2">
                <Input
                  id={`${baseId}-${i}`}
                  value={name}
                  autoComplete="off"
                  placeholder="Full name and role, e.g. Dr A. Rao (PI)"
                  onChange={(e) =>
                    setNames((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))
                  }
                />
                {names.length > 2 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove approver ${i + 1}`}
                    onClick={() => setNames((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <XIcon />
                  </Button>
                )}
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setNames((p) => [...p, ''])}
          >
            <PlusIcon aria-hidden="true" />
            Add approver
          </Button>
          {showErrors && (
            <ul className="space-y-0.5 text-sm text-destructive" role="alert">
              {check.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage(error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Recording…' : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Compact stat tile (counts only; this is the admin console, never shown to players). */
export function StatTile({
  label,
  value,
  hint,
  className,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn('rounded-lg border bg-card px-4 py-3', className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
