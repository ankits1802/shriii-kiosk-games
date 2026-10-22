'use client';

/**
 * Trait registry from the scoring dictionary (layer 2 definitions): construct definitions, the ECD
 * chain construct → evidence → task, indicators with minimum valid trials, pre-registered expected
 * relations, approval status (recorded trait gates, caps, permanent withholds) and version history.
 */
import { ArrowRightIcon, LockIcon } from 'lucide-react';
import { useMemo } from 'react';
import { PageHeader, Section } from '@/components/data/page-header';
import { ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCoefficient, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useConstructs, useContentVersions, useGates, useIndicatorDefinitions } from '../api/hooks';
import {
  asArray,
  asRecord,
  asString,
  type ConstructOut,
  type IndicatorDefinitionOut,
} from '../api/types';
import { ResultTable } from '../components/result-table';
import { KeyValues } from '../components/shared';
import type { ScienceConfig } from '../lib/science';
import { useUrlState } from '../lib/url-state';

const KIND_LABEL: Record<string, string> = {
  E: 'Kind E · trait indicators',
  S: 'Kind S · style constructs',
  M: 'Kind M constructs',
};

interface Relation {
  readonly relation: string;
  readonly criterion: string;
  readonly block: string | null;
  readonly sign: string | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly hypothesis: string | null;
  readonly note: string | null;
}

export function relationsOf(c: ConstructOut): Relation[] {
  const rel = asRecord(asRecord(c.definition).criterion_relations);
  return ['convergent', 'discriminant', 'nomological'].flatMap((relation) =>
    asArray(rel[relation]).map((raw) => {
      const r = asRecord(raw);
      return {
        relation,
        criterion: asString(r.criterion) ?? '—',
        block: asString(r.block),
        sign: asString(r.expected_sign),
        low: typeof r.expected_r_low === 'number' ? r.expected_r_low : null,
        high: typeof r.expected_r_high === 'number' ? r.expected_r_high : null,
        hypothesis: asString(r.hypothesis_id),
        note: asString(r.note),
      };
    }),
  );
}

export function TraitsPage({ science }: { readonly science: ScienceConfig }) {
  const constructs = useConstructs();
  const defs = useIndicatorDefinitions();
  const gates = useGates();
  const versions = useContentVersions();
  const [traitParam, setTrait] = useUrlState('trait');
  const list = constructs.data ?? [];
  const selected = list.find((c) => c.construct_id === traitParam) ?? list[0] ?? null;
  const groups = useMemo(() => {
    const m = new Map<string, ConstructOut[]>();
    for (const c of [...list].sort(
      (a, b) =>
        Number(asRecord(a.definition).number ?? 0) - Number(asRecord(b.definition).number ?? 0),
    )) {
      const k = c.kind ?? 'other';
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m.entries()];
  }, [list]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Traits"
        description="The competency model from the versioned scoring dictionary: what each construct claims, which behaviour counts as evidence, which tasks produce it, and how it is expected to relate to criterion scales. Nothing here is a validated score."
        meta={
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="font-mono">
              dictionary v{list[0]?.dictionary_version ?? '—'}
            </Badge>
            <Badge variant="outline" className="font-mono">
              gates.yaml v{science.gates.version}
            </Badge>
            <Badge variant="secondary">{science.gates.status}</Badge>
          </div>
        }
      />
      {constructs.isPending ? (
        <LoadingState rows={8} />
      ) : constructs.isError ? (
        <ErrorState error={constructs.error} onRetry={() => void constructs.refetch()} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <nav aria-label="Constructs" className="space-y-4">
            {groups.map(([kind, items]) => (
              <div key={kind} className="space-y-1">
                <p className="px-2 text-xs font-medium text-muted-foreground">
                  {KIND_LABEL[kind] ?? `Kind ${kind}`}
                </p>
                {items.map((c) => {
                  const d = asRecord(c.definition);
                  const recorded = (gates.data?.traits ?? []).filter(
                    (g) => g.trait === c.construct_id,
                  );
                  return (
                    <button
                      key={c.construct_id}
                      type="button"
                      onClick={() => setTrait(c.construct_id)}
                      aria-current={selected?.construct_id === c.construct_id ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent',
                        selected?.construct_id === c.construct_id && 'bg-accent font-medium',
                      )}
                    >
                      <span className="truncate">
                        <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">
                          {String(d.number ?? '')}
                        </span>
                        {c.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {d.restricted === true && (
                          <LockIcon
                            className="size-3 text-muted-foreground"
                            aria-label="restricted"
                          />
                        )}
                        <Badge variant="outline" className="px-1 text-[10px]">
                          T{String(d.tier ?? '–')}
                        </Badge>
                        {recorded.some((g) => g.status !== 'unvalidated') && (
                          <span
                            className="size-1.5 rounded-full bg-primary"
                            role="img"
                            aria-label="status recorded"
                          />
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          {selected && (
            <TraitDetail
              construct={selected}
              indicators={((defs.data ?? []) as IndicatorDefinitionOut[]).filter(
                (d) => d.construct_id === selected.construct_id,
              )}
              gates={(gates.data?.trait_history ?? gates.data?.traits ?? []).filter(
                (g) => g.trait === selected.construct_id,
              )}
              current={(gates.data?.traits ?? []).filter((g) => g.trait === selected.construct_id)}
              versions={(versions.data ?? []).filter(
                (v) => v.kind === 'dictionary' || v.kind === 'gates' || v.kind === 'hypotheses',
              )}
              science={science}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TraitDetail({
  construct,
  indicators,
  gates,
  current,
  versions,
  science,
}: {
  readonly construct: ConstructOut;
  readonly indicators: readonly IndicatorDefinitionOut[];
  readonly gates: readonly {
    id: number;
    status: string;
    language: string;
    pathway: string;
    approvers: readonly string[];
    evidence_ids: readonly string[];
    effective_from: string;
    note: string | null;
    recorded_by: string;
  }[];
  readonly current: readonly { id: number; status: string; language: string; pathway: string }[];
  readonly versions: readonly {
    id: string;
    kind: string;
    version: string;
    sha256: string;
    status: string;
    approved_by: string[];
    created_at: string;
  }[];
  readonly science: ScienceConfig;
}) {
  const d = asRecord(construct.definition);
  const ecd = asRecord(d.ecd);
  const tasks = asArray(ecd.tasks).map(String);
  const pathways = asRecord(d.pathways);
  const report = asRecord(d.report);
  const cap = science.gates.caps.find((c) => c.construct === construct.construct_id);
  const withholds = science.gates.withholds.filter((w) => w.construct === construct.construct_id);
  const relations = relationsOf(construct);
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{construct.name}</h2>
          <Badge variant="outline" className="font-mono">
            {construct.construct_id}
          </Badge>
          <Badge variant="secondary">Tier {String(d.tier ?? '—')}</Badge>
          {d.restricted === true && <Badge variant="warning">restricted</Badge>}
          <Badge variant="outline">{String(d.modelled_as ?? '').replaceAll('_', ' ')}</Badge>
        </div>
        <p className="max-w-4xl text-sm">{String(d.definition ?? '')}</p>
        {typeof d.theoretical_justification === 'string' && (
          <p className="max-w-4xl text-xs text-muted-foreground">{d.theoretical_justification}</p>
        )}
      </div>

      <Section
        title="Evidence-centred design"
        description="Claim → observable evidence → tasks that elicit it."
      >
        <div className="grid items-stretch gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle className="text-xs text-muted-foreground">Construct claim</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">{String(ecd.claim ?? '—')}</CardContent>
          </Card>
          <ArrowRightIcon
            className="hidden size-5 self-center text-muted-foreground md:block"
            aria-hidden="true"
          />
          <Card>
            <CardHeader>
              <CardTitle className="text-xs text-muted-foreground">Evidence</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">{String(ecd.evidence ?? '—')}</CardContent>
          </Card>
          <ArrowRightIcon
            className="hidden size-5 self-center text-muted-foreground md:block"
            aria-hidden="true"
          />
          <Card>
            <CardHeader>
              <CardTitle className="text-xs text-muted-foreground">Tasks</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-1 pl-4 text-sm">
                {tasks.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(pathways).map(([p, v]) => {
            const r = asRecord(v);
            return (
              <StatusBadge
                key={p}
                status={String(r.status ?? '')}
                tone={
                  r.status === 'scored' ? 'good' : r.status === 'withheld' ? 'serious' : 'neutral'
                }
                label={`Pathway ${p}: ${String(r.status ?? '—')}`}
              />
            );
          })}
        </div>
      </Section>

      <Section
        title={`Indicators (${indicators.length})`}
        description="Versioned behavioural indicators; values below the minimum valid trials are null with an insufficient_trials flag, never imputed."
      >
        <ResultTable
          exportName={`indicators-${construct.construct_id}`}
          rows={indicators}
          rowKey={(i) => `${i.pathway}-${i.indicator_id}`}
          empty="No indicators in the dictionary."
          columns={[
            {
              key: 'id',
              header: 'Indicator',
              cell: (i) => <span className="font-mono text-xs">{i.indicator_id}</span>,
              value: (i) => i.indicator_id,
            },
            { key: 'p', header: 'Pathway', cell: (i) => i.pathway, value: (i) => i.pathway },
            { key: 'role', header: 'Role', cell: (i) => i.role ?? '—', value: (i) => i.role },
            {
              key: 'tier',
              header: 'Tier',
              numeric: true,
              cell: (i) => i.tier ?? '—',
              value: (i) => i.tier,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (i) => <StatusBadge status={i.status ?? 'draft'} />,
              value: (i) => i.status,
            },
            {
              key: 'module',
              header: 'Task',
              cell: (i) => i.module_id ?? '—',
              value: (i) => i.module_id,
            },
            {
              key: 'min',
              header: 'Min valid trials',
              cell: (i) => {
                const m = asRecord(asRecord(i.definition).min_valid_trials);
                return m.count !== undefined
                  ? `${String(m.count)} ${String(m.unit ?? '').replaceAll('_', ' ')}`
                  : '—';
              },
              value: (i) => String(asRecord(asRecord(i.definition).min_valid_trials).count ?? ''),
            },
            {
              key: 'dir',
              header: 'Direction',
              cell: (i) =>
                String(asRecord(i.definition).direction ?? '—').replace('higher_', 'higher = '),
              value: (i) => String(asRecord(i.definition).direction ?? ''),
            },
            {
              key: 'f',
              header: 'Formula',
              cell: (i) => (
                <span className="text-xs text-muted-foreground">
                  {String(asRecord(asRecord(i.definition).formula).description ?? '')}
                </span>
              ),
              value: (i) => String(asRecord(asRecord(i.definition).formula).description ?? ''),
              className: 'min-w-72 whitespace-normal',
            },
          ]}
        />
      </Section>

      <Section
        title="Expected relations"
        description="Pre-registered criterion relations. Expected r ranges are literature expectations, not acceptance thresholds; gates use the observed lower bound (gates.yaml B3)."
      >
        <ResultTable
          exportName={`relations-${construct.construct_id}`}
          rows={relations}
          rowKey={(r, i) => `${r.relation}-${r.criterion}-${i}`}
          empty="No relations."
          columns={[
            {
              key: 'rel',
              header: 'Relation',
              cell: (r) => (
                <Badge variant={r.relation === 'convergent' ? 'info' : 'outline'}>
                  {r.relation}
                </Badge>
              ),
              value: (r) => r.relation,
            },
            {
              key: 'crit',
              header: 'Criterion scale',
              cell: (r) => <span className="font-mono text-xs">{r.criterion}</span>,
              value: (r) => r.criterion,
            },
            { key: 'block', header: 'Block', cell: (r) => r.block ?? '—', value: (r) => r.block },
            {
              key: 'sign',
              header: 'Expected sign',
              cell: (r) => r.sign ?? 'none',
              value: (r) => r.sign,
            },
            {
              key: 'range',
              header: 'Expected r',
              cell: (r) =>
                r.low === null
                  ? '—'
                  : `${formatCoefficient(r.low)} to ${formatCoefficient(r.high)}`,
              value: (r) => (r.low === null ? null : `${r.low}-${r.high}`),
            },
            {
              key: 'h',
              header: 'Hypothesis',
              cell: (r) => <span className="font-mono text-xs">{r.hypothesis ?? '—'}</span>,
              value: (r) => r.hypothesis,
            },
            {
              key: 'note',
              header: 'Note',
              cell: (r) => <span className="text-xs text-muted-foreground">{r.note ?? ''}</span>,
              value: (r) => r.note,
              className: 'whitespace-normal',
            },
          ]}
        />
      </Section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section
          title="Approval status"
          description="Recorded trait-gate status per language and pathway (release-pack input)."
        >
          {(cap || withholds.length > 0) && (
            <Alert variant="warning">
              <LockIcon aria-hidden="true" />
              <AlertTitle>
                {withholds.length
                  ? `Permanently withheld for Pathway ${withholds.map((w) => w.pathway).join(', ')}`
                  : `Capped at ${cap?.maxStatus.replaceAll('_', ' ')}`}
              </AlertTitle>
              <AlertDescription>{withholds[0]?.reason ?? cap?.reason}</AlertDescription>
            </Alert>
          )}
          <KeyValues
            items={[
              [
                'Report ceiling (dictionary)',
                String(report.max_status ?? '—').replaceAll('_', ' '),
              ],
              [
                'Current',
                current.length ? (
                  <span key="c" className="flex flex-wrap gap-1">
                    {current.map((g) => (
                      <StatusBadge
                        key={g.id}
                        status={g.status}
                        label={`${g.language} · ${g.pathway}: ${g.status.replaceAll('_', ' ')}`}
                      />
                    ))}
                  </span>
                ) : (
                  'unvalidated everywhere (no status recorded)'
                ),
              ],
              ['Notes', String(d.notes ?? '—')],
            ]}
          />
        </Section>
        <Section
          title="Version history"
          description="Dictionary and gate-rule versions, and every recorded status change for this construct."
        >
          <ResultTable
            rows={gates}
            rowKey={(g) => String(g.id)}
            empty="No status changes recorded."
            columns={[
              { key: 'at', header: 'Effective', cell: (g) => formatDateTime(g.effective_from) },
              { key: 'lp', header: 'Scope', cell: (g) => `${g.language} · ${g.pathway}` },
              { key: 's', header: 'Status', cell: (g) => <StatusBadge status={g.status} /> },
              { key: 'a', header: 'Approvers', cell: (g) => g.approvers.join(', ') || '—' },
            ]}
          />
          {versions.length > 0 && (
            <ResultTable
              rows={versions}
              rowKey={(v) => v.id}
              columns={[
                { key: 'k', header: 'Content', cell: (v) => v.kind },
                {
                  key: 'v',
                  header: 'Version',
                  cell: (v) => <span className="font-mono text-xs">{v.version}</span>,
                },
                {
                  key: 'h',
                  header: 'sha256',
                  cell: (v) => <span className="font-mono text-xs">{v.sha256.slice(0, 12)}</span>,
                },
                { key: 's', header: 'Status', cell: (v) => <StatusBadge status={v.status} /> },
                { key: 'at', header: 'Stamped', cell: (v) => formatDateTime(v.created_at) },
              ]}
            />
          )}
          <p className="text-xs text-muted-foreground">
            Dictionary v{construct.dictionary_version} · gates.yaml{' '}
            {science.gates.sha256.slice(0, 12)} · hypotheses.yaml{' '}
            {science.hypotheses.sha256.slice(0, 12)}
          </p>
        </Section>
      </div>
    </div>
  );
}
