'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ActivityIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  LinkIcon,
  ShieldCheckIcon,
  UsersIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { Can } from '@/components/auth/can';
import { BarCiChart, type BarCiInput, DistributionChart } from '@/components/charts';
import { PageHeader, Section } from '@/components/data/page-header';
import { ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { NavIcon } from '@/components/shell/nav-icon';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-context';
import { ALL_STUDIES, ROLE_LABELS } from '@/lib/auth/permissions';
import { hasPermission, isAdmin } from '@/lib/auth/principal';
import { formatDateTime, formatInteger } from '@/lib/format';
import { visibleNav } from '@/lib/nav';
import { queryKeys } from '@/lib/query';
import { useStudyScope } from '@/lib/study-scope';
import {
  useEnrollmentsFor,
  useIndicatorValues,
  useMatchedRecordsFor,
  useSessions,
  useStudyDesigns,
} from '../api/hooks';
import type { EnrollmentOut, IndicatorValueOut, MatchedRecord, QuotaStatus } from '../api/types';
import { pct, prov, StatTile, SyntheticNotice } from '../components/shared';
import {
  type CellField,
  type CountRow,
  cellLabel,
  enrollmentBreakdowns,
  quotaProgress,
  summariseMatches,
  summariseSessions,
} from '../lib/overview';

const FIELD_LABELS: Record<CellField, string> = {
  language: 'Language',
  age_band: 'Age band',
  literacy_band: 'Literacy',
  edu_band: 'Education',
  gender: 'Gender (where consented)',
};

function countBars(
  rows: readonly CountRow[],
  valueLabel: string,
  seriesName = 'Count',
): BarCiInput {
  return {
    categories: rows.map((r) => r.key),
    series: [{ name: seriesName, values: rows.map((r) => ({ value: r.count, n: r.count })) }],
    valueLabel,
    valueStyle: 'number',
    digits: 0,
  };
}

async function fetchReadiness(): Promise<{ ok: boolean; checks: Record<string, unknown> }> {
  const res = await fetch('/readyz', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => ({}))) as { checks?: Record<string, unknown> };
  return { ok: res.ok, checks: body.checks ?? {} };
}

export function ResearchOverviewPage() {
  const { principal } = useAuth();
  const { studies, study, isLoading: studiesLoading } = useStudyScope();
  const scopeIds = useMemo(
    () => (study ? [study.study_id] : studies.map((s) => s.study_id)),
    [study, studies],
  );
  const sessions = useSessions(study?.study_id ?? null);
  const designs = useStudyDesigns(scopeIds);
  const enrollmentsQ = useEnrollmentsFor(scopeIds);
  const matchedQ = useMatchedRecordsFor(scopeIds);
  const indicators = useIndicatorValues(study?.study_id ?? scopeIds[0] ?? null);
  const health = useQuery({ queryKey: queryKeys.health(), queryFn: fetchReadiness, retry: false });

  const enrollments = useMemo(
    () => enrollmentsQ.flatMap((q) => (q.data ?? []) as EnrollmentOut[]),
    [enrollmentsQ],
  );
  const matched = useMemo(
    () => matchedQ.flatMap((q) => (q.data ?? []) as MatchedRecord[]),
    [matchedQ],
  );
  const quotas = useMemo(
    () => designs.flatMap((q) => (q.data?.quotas ?? []) as QuotaStatus[]),
    [designs],
  );
  const sessionSummary = useMemo(
    () => (sessions.data ? summariseSessions(sessions.data.items) : null),
    [sessions.data],
  );
  const enrol = useMemo(() => enrollmentBreakdowns(enrollments), [enrollments]);
  const match = useMemo(() => summariseMatches(matched), [matched]);
  const quota = useMemo(() => quotaProgress(quotas), [quotas]);
  const indicatorRows = (indicators.data ?? []) as IndicatorValueOut[];
  const indicatorStatus = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of indicatorRows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return [...counts.entries()]
      .map(([key, count]) => ({
        key,
        count,
        share: indicatorRows.length ? count / indicatorRows.length : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }, [indicatorRows]);
  const validTrials = useMemo(
    () =>
      indicatorRows.map((r) => r.n_valid_trials).filter((n): n is number => typeof n === 'number'),
    [indicatorRows],
  );

  const unscoped = principal
    ? isAdmin(principal) || principal.studies.includes(ALL_STUDIES)
    : false;
  const canSessions = hasPermission(principal, 'sessions.read');
  const canParticipants = hasPermission(principal, 'participants.read');
  const enrolLoading = enrollmentsQ.some((q) => q.isPending && q.fetchStatus !== 'idle');
  const synthetic = (sessionSummary?.synthetic ?? 0) > 0;
  const scopeLabel = study
    ? `${study.code} · ${study.name}`
    : `All ${studies.length} studies in scope`;
  const provenance = {
    source: `GET /sessions, /studies/{id}, /studies/{id}/enrollments, /validation/matched-records`,
    generatedAt: new Date().toISOString(),
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title="Research overview"
        description="Recruitment, sessions, matched game × battery records and data quality. Counts only: no participant-level scores appear on this page."
        meta={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{scopeLabel}</Badge>
            {principal?.roles.map((r) => (
              <Badge key={r} variant="secondary">
                {ROLE_LABELS[r]}
              </Badge>
            ))}
            {health.data && (
              <StatusBadge
                status={health.data.ok ? 'healthy' : 'degraded'}
                label={health.data.ok ? 'API ready' : 'API not ready'}
              />
            )}
            {health.isError && <StatusBadge status="offline" label="API unreachable" />}
          </div>
        }
      />

      <SyntheticNotice
        show={synthetic}
        what={`${formatInteger(sessionSummary?.synthetic)} of ${formatInteger(sessionSummary?.total)} sessions in scope are simulator sessions`}
      />

      <section aria-label="Headline numbers" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          testId="kpi-participants"
          icon={<UsersIcon className="size-3.5" aria-hidden="true" />}
          label="Participants enrolled"
          value={canParticipants ? (enrolLoading ? '…' : formatInteger(enrol.active)) : '—'}
          sub={
            canParticipants
              ? `${formatInteger(enrol.withdrawn)} withdrawn · quota ${pct(quota.share, 0)} of ${formatInteger(quota.target)}`
              : 'Needs participants.read'
          }
        />
        <StatTile
          testId="kpi-sessions"
          icon={<ActivityIcon className="size-3.5" aria-hidden="true" />}
          label="Game sessions"
          value={canSessions ? formatInteger(sessionSummary?.total) : '—'}
          sub={
            !canSessions
              ? 'Needs sessions.read'
              : sessionSummary
                ? `${formatInteger(sessionSummary.completed)} completed · ${formatInteger(sessionSummary.linked)} linked to a pid`
                : sessions.isError
                  ? 'Could not load sessions'
                  : 'Loading…'
          }
        />
        <StatTile
          testId="kpi-matched"
          icon={<LinkIcon className="size-3.5" aria-hidden="true" />}
          label="Matched records"
          value={canParticipants ? formatInteger(match.matched) : '—'}
          sub={`game + battery, participant × occasion · ${formatInteger(match.records)} records`}
        />
        <StatTile
          testId="kpi-completion"
          icon={<CheckCircle2Icon className="size-3.5" aria-hidden="true" />}
          label="Completion"
          value={pct(sessionSummary?.completionRate)}
          sub={`abandonment ${pct(sessionSummary?.abandonmentRate)} · ${formatInteger(match.retestPairs)} retest pairs`}
        />
      </section>

      {sessions.isError && (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      )}

      <Section
        title="Sessions"
        description="Status and end reason of every session in scope; completion = completed ÷ ended."
      >
        {canSessions && sessions.isPending ? (
          <LoadingState rows={3} />
        ) : sessionSummary ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <BarCiChart
              title="Sessions by status"
              description="Active sessions are not counted in completion or abandonment."
              data={countBars(
                [
                  { key: 'completed', count: sessionSummary.completed, share: 0 },
                  { key: 'abandoned', count: sessionSummary.abandoned, share: 0 },
                  { key: 'withdrawn', count: sessionSummary.withdrawn, share: 0 },
                  { key: 'active', count: sessionSummary.active, share: 0 },
                  ...(sessionSummary.other
                    ? [{ key: 'other', count: sessionSummary.other, share: 0 }]
                    : []),
                ],
                'Sessions',
              )}
              provenance={{ ...provenance, n: sessionSummary.total, exclusions: 0 }}
              synthetic={synthetic}
              height={260}
            />
            <BarCiChart
              title="Sessions by language"
              description="Language chosen on the kiosk (spoken samples)."
              data={countBars(sessionSummary.byLanguage, 'Sessions')}
              provenance={{ ...provenance, n: sessionSummary.total }}
              synthetic={synthetic}
              height={260}
            />
            <BarCiChart
              title="End reasons"
              description="Why ended sessions stopped (walkaway, hard cap, withdrawal, completion)."
              data={countBars(sessionSummary.endReasons, 'Sessions')}
              provenance={{
                ...provenance,
                n: sessionSummary.completed + sessionSummary.abandoned + sessionSummary.withdrawn,
              }}
              synthetic={synthetic}
              height={260}
            />
            <BarCiChart
              title="Sessions by occasion and pathway"
              data={countBars(
                [...sessionSummary.byOccasion, ...sessionSummary.byPathway],
                'Sessions',
              )}
              provenance={{ ...provenance, n: sessionSummary.total }}
              synthetic={synthetic}
              height={260}
            />
          </div>
        ) : null}
      </Section>

      <Can all={['participants.read']}>
        <Section
          title="Recruitment breakdowns"
          description="Enrolled participants by quota-cell field (from enrolment, not from game play). Bands only, never identity fields."
        >
          {enrolLoading ? (
            <LoadingState rows={3} />
          ) : enrol.total === 0 ? (
            <p className="text-sm text-muted-foreground">
              No enrolments yet in the studies in scope.
            </p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {(['language', 'age_band', 'literacy_band', 'edu_band'] as const).map((f) => (
                <BarCiChart
                  key={f}
                  title={FIELD_LABELS[f]}
                  data={countBars(enrol.byField[f], 'Participants')}
                  provenance={{
                    n: enrol.total,
                    exclusions: enrol.withdrawn,
                    note: 'Withdrawn participants are counted as exclusions.',
                  }}
                  height={240}
                />
              ))}
            </div>
          )}
          {quotas.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Quota cells</CardTitle>
                <CardDescription>
                  {quota.fullCells} of {quota.cells} cells full · {formatInteger(quota.enrolled)} of{' '}
                  {formatInteger(quota.target)} target places filled
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {quotas.map((q) => (
                    <li key={q.cell_key} className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate">{cellLabel(q.cell)}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {q.enrolled}/{q.target}
                        </span>
                      </div>
                      <div
                        className="h-1.5 overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                        aria-label={`${cellLabel(q.cell)} quota`}
                        aria-valuemin={0}
                        aria-valuemax={q.target}
                        aria-valuenow={q.enrolled}
                      >
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${Math.min(100, (q.enrolled / q.target) * 100)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </Section>
      </Can>

      <Section
        title="Data quality"
        description="Trial eligibility and session integrity distributions. Sessions with blocking quality flags never enter snapshots."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {sessionSummary && sessionSummary.eventCounts.length > 0 && (
            <DistributionChart
              title="Events per completed session"
              description={`${formatInteger(sessionSummary.seqGaps)} completed sessions still have a sequence gap.`}
              data={{ values: sessionSummary.eventCounts, xLabel: 'Events received' }}
              provenance={{ ...provenance, n: sessionSummary.eventCounts.length }}
              synthetic={synthetic}
            />
          )}
          {sessionSummary && sessionSummary.durationsMinutes.length > 0 && (
            <DistributionChart
              title="Session duration"
              description="Minutes from session start to completion."
              data={{ values: sessionSummary.durationsMinutes, xLabel: 'Minutes' }}
              provenance={{ ...provenance, n: sessionSummary.durationsMinutes.length }}
              synthetic={synthetic}
            />
          )}
          {indicatorRows.length > 0 && (
            <BarCiChart
              title="Indicator status"
              description="Scoring outcome of every current indicator value (insufficient trials, planned-missing slot, …)."
              data={countBars(indicatorStatus, 'Indicator values')}
              provenance={prov({
                n: indicatorRows.length,
                source: 'GET /features (first 1000 current values)',
                algorithmVersion: indicatorRows[0]?.algorithm_version,
              })}
              synthetic={synthetic}
              height={260}
            />
          )}
          {validTrials.length > 0 && (
            <DistributionChart
              title="Valid trials per indicator value"
              description="Trial eligibility: valid trials behind each indicator value (minimums are in the scoring dictionary)."
              data={{ values: validTrials, xLabel: 'Valid trials' }}
              provenance={{ n: validTrials.length, source: 'GET /features' }}
              synthetic={synthetic}
            />
          )}
          {match.issues.length > 0 && (
            <BarCiChart
              title="Matching issues"
              description="Participant × occasion records the matcher flagged (missing criterion, version mismatch, …)."
              data={countBars(match.issues, 'Records')}
              provenance={{ n: match.records, exclusions: match.withIssues }}
              height={260}
            />
          )}
          {match.byOccasion.length > 0 && (
            <BarCiChart
              title="Matched records by occasion"
              data={{
                categories: match.byOccasion.map((o) => o.occasion),
                series: [
                  { name: 'Matched', values: match.byOccasion.map((o) => ({ value: o.matched })) },
                  {
                    name: 'Unmatched',
                    values: match.byOccasion.map((o) => ({ value: o.records - o.matched })),
                  },
                ],
                valueLabel: 'Records',
                valueStyle: 'number',
                digits: 0,
              }}
              provenance={{ n: match.records, source: 'GET /validation/matched-records' }}
              height={260}
            />
          )}
        </div>
      </Section>

      <section aria-label="Access and scope" className="grid gap-4 lg:grid-cols-3">
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
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
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
                    <Link
                      href={`/research/studies/${encodeURIComponent(s.study_id)}`}
                      className="truncate hover:underline"
                    >
                      <span className="font-mono text-xs text-muted-foreground">{s.code}</span>{' '}
                      {s.name}
                    </Link>
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
            <CardTitle className="text-sm">Sections</CardTitle>
            <CardDescription>Only the sections your role can open are listed.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1 text-sm">
              {visibleNav(principal)
                .flatMap((group) => group.items)
                .filter((item) => item.href.startsWith('/research/'))
                .map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                    >
                      <NavIcon id={item.icon} className="size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{item.label}</span>
                        <span className="text-xs text-muted-foreground"> · {item.description}</span>
                      </span>
                      <ArrowRightIcon
                        className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      </section>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
        Every request is permission-checked and audited by the API. Figures refreshed{' '}
        {formatDateTime(provenance.generatedAt)}.{studiesLoading && ' Loading studies…'}
      </p>
    </div>
  );
}
