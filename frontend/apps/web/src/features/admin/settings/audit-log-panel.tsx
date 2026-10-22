'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, FilterXIcon } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import { TimeStamp } from '@/components/data/audit-stamp';
import { ExportMenu } from '@/components/data/export-menu';
import { Section } from '@/components/data/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import type { Schema } from '@/lib/api/types';
import { useApi } from '@/lib/auth/auth-context';
import { formatActor, formatInteger } from '@/lib/format';
import { adminKeys } from '../shared/query-keys';

type AuditRow = Schema<'AuditOut'>;

const ANY = '__any__';
const PAGE = 50;

export interface AuditFilters {
  readonly actor: string;
  readonly action: string;
  readonly outcome: string;
  /** Local date (YYYY-MM-DD) from which to show events. */
  readonly since: string;
}

export const EMPTY_FILTERS: AuditFilters = { actor: '', action: '', outcome: ANY, since: '' };

/** Query parameters for GET /api/v1/admin/audit (empty filters omitted; `action` is a prefix match). */
export function auditQuery(f: AuditFilters, offset: number): Record<string, string | number> {
  const q: Record<string, string | number> = { limit: PAGE, offset };
  if (f.actor.trim()) q.actor = f.actor.trim();
  if (f.action.trim()) q.action = f.action.trim();
  if (f.outcome !== ANY) q.outcome = f.outcome;
  if (f.since) {
    const d = new Date(`${f.since}T00:00:00`);
    if (!Number.isNaN(d.getTime())) q.since = d.toISOString();
  }
  return q;
}

const EXPORT_COLUMNS = [
  { key: 'id', value: (r: AuditRow) => r.id },
  { key: 'occurred_at', value: (r: AuditRow) => r.occurred_at },
  { key: 'actor_sub', value: (r: AuditRow) => r.actor_sub },
  { key: 'actor_roles', value: (r: AuditRow) => r.actor_roles.join(' ') },
  { key: 'action', value: (r: AuditRow) => r.action },
  { key: 'outcome', value: (r: AuditRow) => r.outcome },
  { key: 'method', value: (r: AuditRow) => r.method },
  { key: 'path', value: (r: AuditRow) => r.path },
  { key: 'status_code', value: (r: AuditRow) => r.status_code },
  { key: 'resource_type', value: (r: AuditRow) => r.resource_type },
  { key: 'resource_id', value: (r: AuditRow) => r.resource_id },
  { key: 'study_id', value: (r: AuditRow) => r.study_id },
  { key: 'request_id', value: (r: AuditRow) => r.request_id },
  { key: 'details', value: (r: AuditRow) => JSON.stringify(r.details) },
];

/** Audit log viewer with server-side filters (actor, action prefix, outcome, since) and paging. */
export function AuditLogPanel() {
  const api = useApi();
  const id = useId();
  const [form, setForm] = useState<AuditFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const query = auditQuery(filters, offset);
  const audit = useQuery({
    queryKey: adminKeys.audit(query),
    placeholderData: keepPreviousData,
    queryFn: () => unwrap(api.GET('/api/v1/admin/audit', { params: { query } })),
  });
  const page = audit.data;

  return (
    <Section
      title="Audit log"
      description="Every API call, sign-in and data access is recorded with who, what, when and the outcome. Newest first."
    >
      <form
        className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3"
        aria-label="Audit filters"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setFilters(form);
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={`${id}-actor`} className="text-xs">
            Actor (exact subject)
          </Label>
          <Input
            id={`${id}-actor`}
            className="h-8 w-48"
            value={form.actor}
            onChange={(e) => setForm({ ...form, actor: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-action`} className="text-xs">
            Action (prefix)
          </Label>
          <Input
            id={`${id}-action`}
            className="h-8 w-48 font-mono text-xs"
            placeholder="e.g. settings. or kiosks."
            value={form.action}
            onChange={(e) => setForm({ ...form, action: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-outcome`} className="text-xs">
            Outcome
          </Label>
          <Select value={form.outcome} onValueChange={(v) => setForm({ ...form, outcome: v })}>
            <SelectTrigger id={`${id}-outcome`} className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="denied">Denied</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-since`} className="text-xs">
            Since
          </Label>
          <Input
            id={`${id}-since`}
            type="date"
            className="h-8 w-40"
            value={form.since}
            onChange={(e) => setForm({ ...form, since: e.target.value })}
          />
        </div>
        <Button type="submit" size="sm">
          Apply
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setForm(EMPTY_FILTERS);
            setFilters(EMPTY_FILTERS);
            setOffset(0);
          }}
        >
          <FilterXIcon aria-hidden="true" />
          Clear
        </Button>
        <div className="ml-auto">
          <ExportMenu
            dataset="audit-log"
            rows={page?.items ?? []}
            columns={EXPORT_COLUMNS}
            label="Export page"
          />
        </div>
      </form>

      {audit.isPending ? (
        <LoadingState rows={8} label="Loading audit log" />
      ) : audit.isError || !page ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : page.items.length === 0 ? (
        <EmptyState title="No audit events match" description="Widen the filters or clear them." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead>Request</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.items.map((r) => (
                  <Fragment key={r.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                      aria-expanded={open === r.id}
                    >
                      <TableCell className="whitespace-nowrap">
                        <TimeStamp value={r.occurred_at} />
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{formatActor(r.actor_sub)}</span>
                        <span className="block text-xs text-muted-foreground">
                          {r.actor_roles.join(', ') || r.actor_kind}
                        </span>
                      </TableCell>
                      <TableCell>
                        <code className="font-mono text-xs">{r.action}</code>
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          status={r.outcome}
                          tone={
                            r.outcome === 'success'
                              ? 'good'
                              : r.outcome === 'denied'
                                ? 'warning'
                                : r.outcome === 'error'
                                  ? 'critical'
                                  : 'neutral'
                          }
                        />
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.resource_type ? `${r.resource_type} ` : ''}
                        <code className="font-mono">{r.resource_id ?? ''}</code>
                        {r.study_id && (
                          <span className="block text-muted-foreground">study {r.study_id}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.method} {r.path}
                        {r.status_code !== null && ` · ${r.status_code}`}
                      </TableCell>
                    </TableRow>
                    {open === r.id && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={6}>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
                            {JSON.stringify(r.details, null, 2)}
                          </pre>
                          {r.request_id && (
                            <p className="mt-1 font-mono text-xs text-muted-foreground">
                              request {r.request_id}
                            </p>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {formatInteger(page.offset + 1)}–{formatInteger(page.offset + page.items.length)} of{' '}
              {formatInteger(page.total)}
            </span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                <ChevronLeftIcon aria-hidden="true" />
                Newer
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + PAGE >= page.total}
                onClick={() => setOffset(offset + PAGE)}
              >
                Older
                <ChevronRightIcon aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      )}
    </Section>
  );
}
