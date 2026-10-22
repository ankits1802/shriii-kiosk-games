'use client';

import { AlertOctagonIcon, CheckCircle2Icon, FileWarningIcon } from 'lucide-react';
import { ExportMenu } from '@/components/data/export-menu';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { columnsFromRecords } from '@/lib/export';
import {
  itcTrail,
  type LanguageCoverage,
  orderedStatuses,
  RECORDING_STATUSES,
} from './catalogue-model';
import type { ContentSnapshot, Workflow } from './content-types';

/**
 * Workflow progress is ordinal (machine draft → approved), so it uses one sequential hue from light to
 * dark; "flagged for revision" is a state, so it takes the reserved "serious" status colour and an icon.
 */
function stageColor(rank: number | null, maxRank: number): string {
  if (rank === null) return 'var(--status-serious)';
  const t = maxRank === 0 ? 1 : rank / maxRank;
  return `color-mix(in oklab, var(--seq-high) ${Math.round(12 + t * 88)}%, var(--seq-low))`;
}

function StackedBar({
  segments,
  total,
  label,
}: {
  readonly segments: readonly { key: string; label: string; count: number; color: string }[];
  readonly total: number;
  readonly label: string;
}) {
  const shown = segments.filter((s) => s.count > 0);
  return (
    <div
      role="img"
      aria-label={`${label}: ${shown.map((s) => `${s.label} ${s.count}`).join(', ')}`}
      className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px] bg-muted"
    >
      {shown.map((s) => (
        <Tooltip key={s.key}>
          <TooltipTrigger asChild>
            <span
              className="h-full first:rounded-l-[4px] last:rounded-r-[4px]"
              style={{ width: `${(s.count / total) * 100}%`, background: s.color }}
            />
          </TooltipTrigger>
          <TooltipContent>
            {s.label}: {s.count} of {total}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function LanguageCard({
  cov,
  workflow,
  name,
  snapshot,
}: {
  readonly cov: LanguageCoverage;
  readonly workflow: Workflow;
  readonly name: string;
  readonly snapshot: ContentSnapshot;
}) {
  const statuses = orderedStatuses(workflow);
  const maxRank = Math.max(0, ...statuses.map((s) => s.rank ?? 0));
  const itcSegments = statuses.map((s) => ({
    key: s.id,
    label: s.label,
    count: cov.byTranslation[s.id] ?? 0,
    color: stageColor(s.rank, maxRank),
  }));
  const recSegments = RECORDING_STATUSES.map((s, i) => ({
    key: s,
    label: s.replaceAll('_', ' '),
    count: cov.byRecording[s] ?? 0,
    color: stageColor(i, RECORDING_STATUSES.length - 1),
  }));
  const trail = cov.isReference ? [] : itcTrail(snapshot, cov.language);
  const trailColumns = columnsFromRecords(trail);

  return (
    <Card data-testid={`coverage-${cov.language}`}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span>
            {name}{' '}
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {cov.language}
            </span>
          </span>
          {cov.isReference ? (
            <Badge variant="secondary">Reference</Badge>
          ) : (
            <ExportMenu
              dataset={`itc-trail-${cov.language}`}
              rows={trail}
              columns={trailColumns}
              label="ITC trail"
              provenance={{ catalogue_version: snapshot.catalogueVersion }}
            />
          )}
        </CardTitle>
        <CardDescription>
          {cov.total} lines · {cov.voiced} voiced
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-xs">
        {!cov.isReference && (
          <div className="space-y-1.5">
            <p className="font-medium">Translation (ITC)</p>
            <StackedBar
              segments={itcSegments}
              total={cov.total}
              label={`${cov.language} translation status`}
            />
            <ul className="grid grid-cols-1 gap-y-0.5 text-muted-foreground">
              {itcSegments
                .filter((s) => s.count > 0)
                .map((s) => (
                  <li key={s.key} className="flex items-center gap-1.5">
                    <span
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ background: s.color }}
                      aria-hidden="true"
                    />
                    <span>{s.label}</span>
                    <span className="ml-auto tabular-nums text-foreground">{s.count}</span>
                  </li>
                ))}
            </ul>
          </div>
        )}
        <div className="space-y-1.5">
          <p className="font-medium">Recording</p>
          <StackedBar
            segments={recSegments}
            total={cov.total}
            label={`${cov.language} recording status`}
          />
          <ul className="grid grid-cols-1 gap-y-0.5 text-muted-foreground">
            {recSegments
              .filter((s) => s.count > 0)
              .map((s) => (
                <li key={s.key} className="flex items-center gap-1.5">
                  <span
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ background: s.color }}
                    aria-hidden="true"
                  />
                  <span className="capitalize">{s.label}</span>
                  <span className="ml-auto tabular-nums text-foreground">{s.count}</span>
                </li>
              ))}
          </ul>
        </div>
        {!cov.isReference && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-3">
            {Object.entries(cov.eligible).map(([pack, n]) => (
              <Tooltip key={pack}>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1" data-testid={`eligible-${pack}`}>
                    <CheckCircle2Icon className="size-3 text-success" aria-hidden="true" />
                    {pack} pack{' '}
                    <span className="tabular-nums font-medium">
                      {n} / {cov.toRecord}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-64">
                  Lines this language records whose status is{' '}
                  {(workflow.packEligibility[pack] ?? []).join(' or ')}, excluding stale
                  translations. Same base as the shriii-i18n coverage report.
                </TooltipContent>
              </Tooltip>
            ))}
            {cov.flagged > 0 && (
              <span className="flex items-center gap-1">
                <AlertOctagonIcon className="size-3 text-status-serious" aria-hidden="true" />
                flagged <span className="tabular-nums font-medium">{cov.flagged}</span>
              </span>
            )}
            {cov.stale > 0 && (
              <span className="flex items-center gap-1">
                <FileWarningIcon className="size-3 text-warning" aria-hidden="true" />
                source changed <span className="tabular-nums font-medium">{cov.stale}</span>
              </span>
            )}
            {cov.missingTranslation > 0 && <span>missing {cov.missingTranslation}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function displayLanguage(tag: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export function CoveragePanel({
  snapshot,
  coverage,
}: {
  readonly snapshot: ContentSnapshot;
  readonly coverage: readonly LanguageCoverage[];
}) {
  const names = new Map(snapshot.workflow.languages.map((l) => [l.tag, l.name]));
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {coverage.map((c) => (
        <LanguageCard
          key={c.language}
          cov={c}
          workflow={snapshot.workflow}
          name={names.get(c.language) ?? displayLanguage(c.language)}
          snapshot={snapshot}
        />
      ))}
    </div>
  );
}
