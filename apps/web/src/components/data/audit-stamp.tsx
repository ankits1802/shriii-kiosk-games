'use client';

import { CheckIcon, CopyIcon, HistoryIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { auditInfo } from '@/lib/audit';
import { formatActor, formatDateTime, formatIsoUtc, formatRelative, shortId } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Relative time that re-renders each minute; the exact UTC time is in the tooltip. */
export function TimeStamp({
  value,
  className,
}: {
  readonly value: string | null;
  readonly className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  if (!value) return <span className={className}>—</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={value} className={cn('tabular-nums', className)}>
          {formatRelative(value, now)}
        </time>
      </TooltipTrigger>
      <TooltipContent>
        <div>{formatDateTime(value)}</div>
        <div className="font-mono opacity-80">{formatIsoUtc(value)}</div>
      </TooltipContent>
    </Tooltip>
  );
}

export interface AuditStampProps {
  /** Any API record carrying `*_by` / `*_at` fields. */
  readonly record?: Readonly<Record<string, unknown>>;
  /** Or explicit values. */
  readonly actor?: string | null;
  readonly at?: string | null;
  readonly verb?: string;
  readonly className?: string;
  readonly compact?: boolean;
}

/** "Created by dev-researcher · 3 hours ago" — every record shows who and when. */
export function AuditStamp({ record, actor, at, verb, className, compact }: AuditStampProps) {
  const info = record ? auditInfo(record) : null;
  const who = actor ?? info?.actor ?? null;
  const when = at ?? info?.at ?? null;
  const v = verb ?? info?.verb ?? 'Created';
  if (!who && !when) return null;
  return (
    <span
      data-slot="audit-stamp"
      className={cn(
        'inline-flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground',
        className,
      )}
    >
      {!compact && <HistoryIcon className="size-3" aria-hidden="true" />}
      <span>{compact ? '' : `${v} `}</span>
      {who && (
        <>
          {!compact && <span>by</span>}
          <span className="font-medium text-foreground/80">{formatActor(who)}</span>
        </>
      )}
      {who && when && <span aria-hidden="true">·</span>}
      {when && <TimeStamp value={when} />}
      {info?.updated && (
        <span>
          {' '}
          (updated{info.updated.actor ? ` by ${formatActor(info.updated.actor)}` : ''}
          {info.updated.at ? (
            <>
              {' '}
              <TimeStamp value={info.updated.at} />
            </>
          ) : null}
          )
        </span>
      )}
    </span>
  );
}

/** Monospace short id with a copy button; the full id is in the title and clipboard. */
export function CopyId({ id, className }: { readonly id: string; readonly className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={cn('inline-flex items-center gap-1 font-mono text-xs', className)} title={id}>
      {shortId(id)}
      <button
        type="button"
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`Copy ${id}`}
        onClick={() => {
          void navigator.clipboard?.writeText(id).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
    </span>
  );
}
