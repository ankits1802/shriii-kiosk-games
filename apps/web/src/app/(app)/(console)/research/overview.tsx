'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRightIcon, ShieldCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { PageHeader, Section } from '@/components/data/page-header';
import { StatusBadge } from '@/components/data/status-badge';
import { NavIcon } from '@/components/shell/nav-icon';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-context';
import { ALL_STUDIES, ROLE_LABELS } from '@/lib/auth/permissions';
import { isAdmin } from '@/lib/auth/principal';
import { visibleNav } from '@/lib/nav';
import { queryKeys } from '@/lib/query';
import { useStudyScope } from '@/lib/study-scope';

interface Readiness {
  readonly ok: boolean;
  readonly checks: Readonly<Record<string, unknown>>;
}

async function fetchReadiness(): Promise<Readiness> {
  const res = await fetch('/readyz', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => ({}))) as { checks?: Record<string, unknown> };
  return { ok: res.ok, checks: body.checks ?? {} };
}

const FIVE_LAYERS = [
  ['1', 'Raw events', 'Append-only kiosk telemetry'],
  ['2', 'Behavioural indicators', 'Versioned scoring dictionary'],
  ['3', 'Criterion scores', 'Versioned questionnaire keys'],
  ['4', 'Validated trait estimates', 'Only after gates pass'],
  ['5', 'Participant interpretations', 'Banded, strengths-framed, release-gated'],
] as const;

export function ResearchOverview() {
  const { principal } = useAuth();
  const { studies, isLoading: studiesLoading } = useStudyScope();
  const health = useQuery({ queryKey: queryKeys.health(), queryFn: fetchReadiness, retry: false });
  const sections = visibleNav(principal);
  const unscoped = principal
    ? isAdmin(principal) || principal.studies.includes(ALL_STUDIES)
    : false;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Research overview"
        description="Studies, validation evidence and operations for the SHRIII kiosk behavioural games. Interpretations stay provisional until the validation gates pass."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card data-testid="access-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <ShieldCheckIcon className="size-4" aria-hidden="true" />
              Your access
            </CardTitle>
            <CardDescription>Enforced by the API on every request and audited.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-1">
              {principal?.roles.map((r) => (
                <Badge key={r} variant="secondary">
                  {ROLE_LABELS[r]}
                </Badge>
              ))}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Subject</dt>
              <dd className="truncate font-mono text-xs leading-5">{principal?.sub}</dd>
              <dt className="text-muted-foreground">Study scope</dt>
              <dd>{unscoped ? 'All studies' : (principal?.studies.join(', ') ?? '—')}</dd>
              <dt className="text-muted-foreground">Permissions</dt>
              <dd>{principal?.permissions.size ?? 0}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Studies in scope</CardTitle>
            <CardDescription>Select one in the top bar to focus every page on it.</CardDescription>
          </CardHeader>
          <CardContent>
            {studiesLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : studies.length === 0 ? (
              <p className="text-sm text-muted-foreground">No studies registered yet.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {studies.slice(0, 5).map((s) => (
                  <li key={s.study_id} className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      <span className="font-mono text-xs text-muted-foreground">{s.code}</span>{' '}
                      {s.name}
                    </span>
                    <StatusBadge status={s.status} />
                  </li>
                ))}
                {studies.length > 5 && (
                  <li className="text-xs text-muted-foreground">+{studies.length - 5} more</li>
                )}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Backend status</CardTitle>
            <CardDescription>API readiness (databases and migrations).</CardDescription>
          </CardHeader>
          <CardContent>
            {health.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : health.isError ? (
              <StatusBadge status="offline" label="API unreachable" />
            ) : (
              <div className="space-y-2">
                <StatusBadge
                  status={health.data.ok ? 'healthy' : 'degraded'}
                  label={health.data.ok ? 'Ready' : 'Not ready'}
                />
                <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
                  {Object.entries(health.data.checks).map(([k, v]) => (
                    <li key={k}>
                      {k}: {String(v)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Section title="Sections" description="Only the sections your role can open are listed.">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sections
            .flatMap((s) => s.items)
            .filter((i) => i.href !== '/research')
            .map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="group flex items-start gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40"
              >
                <span className="rounded-md bg-muted p-2 text-muted-foreground group-hover:text-primary">
                  <NavIcon id={item.icon} className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between text-sm font-medium">
                    {item.label}
                    <ArrowRightIcon
                      className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="block text-xs text-muted-foreground">{item.description}</span>
                </span>
              </Link>
            ))}
        </div>
      </Section>

      <Section
        title="Five data layers"
        description="Kept separate end to end; every derived value references its algorithm version, sources and snapshot."
      >
        <ol className="grid gap-2 sm:grid-cols-5">
          {FIVE_LAYERS.map(([n, name, note]) => (
            <li key={n} className="rounded-lg border bg-card p-3">
              <span className="text-xs font-semibold text-muted-foreground">Layer {n}</span>
              <span className="block text-sm font-medium">{name}</span>
              <span className="block text-xs text-muted-foreground">{note}</span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
