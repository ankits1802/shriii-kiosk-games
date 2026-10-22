'use client';

/**
 * Scientific report generation and exports: assemble a report from one snapshot's engine results
 * (sections chosen by the researcher), preview it, and export it as standalone HTML, per-table CSV,
 * the flat evidence table (CSV/Parquet, audited above the justification threshold), figure SVGs and
 * the de-identified snapshot Parquet. Participant-facing reports are not produced here.
 */
import { DownloadIcon, FileCodeIcon, ImageDownIcon, PrinterIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BarCiChart } from '@/components/charts';
import { ExportMenu } from '@/components/data/export-menu';
import { PageHeader } from '@/components/data/page-header';
import { LoadingState } from '@/components/data/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { errorMessage } from '@/lib/api/errors';
import { useApi, useAuth } from '@/lib/auth/auth-context';
import { downloadBlob } from '@/lib/export';
import { formatDateTime, shortId } from '@/lib/format';
import { useConstructs, useDeviations, useRunDetails, useRuns } from '../api/hooks';
import type { RunOut } from '../api/types';
import { asRecord } from '../api/types';
import { useSnapshotSelection } from '../components/snapshot-bar';
import {
  buildReport,
  evidenceExportColumns,
  reportHtml,
  SECTION_IDS,
  SECTION_TITLES,
  type SectionId,
  tableCsv,
} from '../lib/report';
import {
  criterionCorrelations,
  flattenResults,
  latestGateEvaluation,
  latestRuns,
  retestRows,
  subgroupLanguage,
} from '../lib/results';
import type { ScienceConfig } from '../lib/science';

export function ReportsPage({ science }: { readonly science: ScienceConfig }) {
  const api = useApi();
  const { principal } = useAuth();
  const sel = useSnapshotSelection();
  const sid = sel.snapshot?.snapshot_id ?? null;
  const runsQ = useRuns(sid);
  const runs = runsQ.data ?? [];
  const latest = useMemo(
    () => latestRuns(runs.filter((r) => r.analysis !== 'gate_evaluation')),
    [runs],
  );
  const gateRef = latestGateEvaluation(runs);
  const ids = [...[...latest.values()].map((r) => r.run_id), ...(gateRef ? [gateRef.run_id] : [])];
  const details = useRunDetails(ids);
  const full = details.map((d) => d.data).filter((d): d is RunOut => Boolean(d));
  const rows = useMemo(
    () => flattenResults(full.filter((r) => r.analysis !== 'gate_evaluation')),
    [full],
  );
  const gateRun = full.find((r) => r.analysis === 'gate_evaluation') ?? null;
  const deviations = useDeviations(sel.study?.study_id ?? null);
  const constructs = useConstructs();
  const names = useMemo(
    () => new Map((constructs.data ?? []).map((c) => [c.construct_id, c.name])),
    [constructs.data],
  );
  const [include, setInclude] = useState<SectionId[]>([...SECTION_IDS]);
  const previewRef = useRef<HTMLDivElement>(null);
  const sections = useMemo(
    () =>
      sel.snapshot
        ? buildReport(
            {
              snapshot: sel.snapshot,
              rows,
              runs: full,
              gateRun,
              deviations: deviations.data ?? [],
              names,
            },
            include,
          )
        : [],
    [sel.snapshot, rows, full, gateRun, deviations.data, names, include],
  );
  const manifest = asRecord(sel.snapshot?.manifest);
  const gitSha = String(
    asRecord(asRecord(full[0]?.manifest).provenance).git_sha ??
      asRecord(full[0]?.manifest).git_sha ??
      '—',
  );
  const meta: [string, string][] = sel.snapshot
    ? [
        ['Study', `${sel.study?.code ?? ''} · ${sel.study?.name ?? sel.snapshot.study_id}`],
        [
          'Snapshot',
          `${sel.snapshot.name} v${sel.snapshot.version} (${sel.snapshot.status}) · ${sel.snapshot.snapshot_id}`,
        ],
        ['Snapshot sha256', sel.snapshot.sha256 ?? '—'],
        [
          'Rows / participants',
          `${sel.snapshot.row_count ?? '—'} / ${sel.snapshot.n_participants ?? '—'}`,
        ],
        ['Engine', full[0]?.engine ?? '—'],
        [
          'gates.yaml',
          `v${science.gates.version} · ${String(manifest.gates_sha256 ?? science.gates.sha256)}`,
        ],
        [
          'hypotheses.yaml',
          `v${science.hypotheses.version} · ${String(manifest.hypotheses_sha256 ?? science.hypotheses.sha256)}`,
        ],
        [
          'Dictionary',
          // One sha per dictionary pathway, e.g. "A 924113… · B c5850a…" (full values in the manifest export).
          Object.entries((manifest.dictionary_sha256 ?? {}) as Record<string, unknown>)
            .map(([pathway, sha]) => `${pathway} ${String(sha)}`)
            .join(' · ') || '—',
        ],
        [
          'Validation runs',
          [...latest.values()].map((r) => `${r.analysis} ${shortId(r.run_id)}`).join(', '),
        ],
        ['Code version', gitSha],
        ['Generated', `${formatDateTime(new Date().toISOString())} by ${principal?.sub ?? '—'}`],
      ]
    : [];
  const title = `Validation report · ${sel.study?.code ?? ''} ${sel.study?.name ?? ''}`.trim();

  const downloadHtml = () => {
    const html = reportHtml(title, meta, sections, sel.synthetic);
    downloadBlob(
      new Blob([html], { type: 'text/html;charset=utf-8' }),
      `${sel.snapshot?.study_id ?? 'study'}-validation-report.html`,
    );
  };
  const downloadFigures = () => {
    const svgs = previewRef.current?.querySelectorAll('[data-report-figure] svg') ?? [];
    let k = 0;
    for (const svg of Array.from(svgs)) {
      const clone = svg.cloneNode(true) as SVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      k += 1;
      downloadBlob(
        new Blob([clone.outerHTML], { type: 'image/svg+xml' }),
        `${sel.snapshot?.study_id ?? 'study'}-figure-${k}.svg`,
      );
    }
    toast[k ? 'success' : 'info'](
      k ? `${k} figure(s) downloaded as SVG.` : 'No figures in the preview.',
    );
  };
  const downloadSnapshot = async () => {
    if (!sel.snapshot) return;
    try {
      const { data, response } = await api.GET(
        '/api/v1/validation/datasets/{snapshot_id}/download',
        { params: { path: { snapshot_id: sel.snapshot.snapshot_id } }, parseAs: 'blob' },
      );
      if (!response.ok || !(data instanceof Blob))
        throw new Error(`download failed (${response.status})`);
      downloadBlob(data, `${sel.snapshot.study_id}-${sel.snapshot.snapshot_id}.parquet`);
      toast.success('Snapshot downloaded (the download is audited).');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const figureData = useMemo(() => {
    const cs = [
      ...new Set(
        rows
          .filter((r) => r.analysis === 'reliability' && r.subject_kind === 'construct')
          .map((r) => r.subject),
      ),
    ].sort();
    return {
      categories: cs.map((c) => names.get(c) ?? c),
      series: [
        {
          name: 'Retest ICC(A,1)',
          values: cs.map((c) => {
            const r = retestRows(rows, c).find((x) => subgroupLanguage(x) === null);
            return r
              ? { value: r.estimate, lower: r.ci_low, upper: r.ci_high, n: r.n }
              : { value: null };
          }),
        },
        {
          name: 'Primary criterion r',
          values: cs.map((c) => {
            const r = criterionCorrelations(rows, c).find(
              (x) => x.family === 'primary' && x.language === null && x.row.estimate !== null,
            )?.row;
            return r
              ? { value: r.estimate, lower: r.ci_low, upper: r.ci_high, n: r.n }
              : { value: null };
          }),
        },
      ],
      valueLabel: 'Coefficient',
      domain: [-0.6, 1] as const,
      ...(science.gates.retest.pointMin !== null
        ? {
            referenceLines: [
              {
                value: science.gates.retest.pointMin,
                label: 'retest target',
                kind: 'target' as const,
              },
            ],
          }
        : {}),
    };
  }, [rows, names, science.gates.retest.pointMin]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Scientific reports and exports from one snapshot. Every table carries N, confidence intervals, exclusions and the provenance needed to reproduce it. Participant-facing reports stay disabled until the battery gate opens."
      />
      {sel.bar}
      {sel.blocker ??
        (runsQ.isPending || details.some((d) => d.isPending) ? (
          <LoadingState rows={6} />
        ) : (
          <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="space-y-4">
              <div className="space-y-2 rounded-lg border bg-card p-4">
                <p className="text-sm font-semibold">Sections</p>
                {SECTION_IDS.map((id) => (
                  <label key={id} htmlFor={`sec-${id}`} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={`sec-${id}`}
                      checked={include.includes(id)}
                      onCheckedChange={(v) =>
                        setInclude(
                          v === true
                            ? SECTION_IDS.filter((s) => s === id || include.includes(s))
                            : include.filter((s) => s !== id),
                        )
                      }
                    />
                    {SECTION_TITLES[id]}
                  </label>
                ))}
              </div>
              <div className="space-y-2 rounded-lg border bg-card p-4">
                <p className="text-sm font-semibold">Export</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={downloadHtml}
                >
                  <FileCodeIcon aria-hidden="true" /> Report (HTML)
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => window.print()}
                >
                  <PrinterIcon aria-hidden="true" /> Print / PDF
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={downloadFigures}
                >
                  <ImageDownIcon aria-hidden="true" /> Figures (SVG)
                </Button>
                <div className="flex items-center gap-2">
                  <ExportMenu
                    dataset="validation-evidence"
                    rows={rows}
                    columns={evidenceExportColumns()}
                    studyId={sel.study?.study_id ?? null}
                    provenance={{ 'shriii.snapshot_id': sid ?? '', 'shriii.git_sha': gitSha }}
                    size="sm"
                    label="All statistics"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => void downloadSnapshot()}
                >
                  <DownloadIcon aria-hidden="true" /> Snapshot (Parquet)
                </Button>
                <p className="text-xs text-muted-foreground">
                  {rows.length} statistics · exports over the configured row limit ask for a
                  justification and are audited.
                </p>
              </div>
            </aside>
            <article
              ref={previewRef}
              data-testid="report-preview"
              className="space-y-6 rounded-lg border bg-card p-6 print:border-0"
            >
              <header className="space-y-2 border-b pb-4">
                <h2 className="text-xl font-semibold">{title}</h2>
                {sel.synthetic && (
                  <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                    Synthetic / demo data: simulator output, not evidence about real participants.
                  </p>
                )}
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-xs">
                  {meta.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="break-all font-mono">{v}</dd>
                    </div>
                  ))}
                </dl>
              </header>
              {include.includes('reliability') && figureData.categories.length > 0 && (
                <div data-report-figure>
                  <BarCiChart
                    title="Figure 1 · Retest reliability and primary criterion correlation by construct"
                    data={figureData}
                    synthetic={sel.synthetic}
                    height={300}
                    exportName="figure-1"
                    provenance={{
                      n: Math.max(0, ...rows.map((r) => r.n ?? 0)),
                      ...(sid ? { snapshotId: sid } : {}),
                      source: 'reliability + construct_validity runs',
                    }}
                  />
                </div>
              )}
              {sections.map((s) => (
                <section key={s.id} className="space-y-3">
                  <h3 className="text-base font-semibold">{s.title}</h3>
                  <p className="text-sm text-muted-foreground">{s.text}</p>
                  {s.tables.map((t) => (
                    <div key={t.id} className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">{t.title}</p>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            downloadBlob(
                              new Blob([tableCsv(t)], { type: 'text/csv;charset=utf-8' }),
                              `${sel.snapshot?.study_id ?? 'study'}-${t.id}.csv`,
                            )
                          }
                        >
                          <DownloadIcon aria-hidden="true" /> CSV
                        </Button>
                      </div>
                      <div className="overflow-x-auto rounded-md border">
                        <table className="w-full text-xs">
                          <thead className="bg-muted/50">
                            <tr>
                              {t.columns.map((c) => (
                                <th
                                  key={c}
                                  className="px-2 py-1.5 text-left font-medium text-muted-foreground"
                                >
                                  {c}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {t.rows.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={t.columns.length}
                                  className="px-2 py-3 text-center text-muted-foreground"
                                >
                                  No results in this snapshot.
                                </td>
                              </tr>
                            ) : (
                              t.rows
                                .map((r, idx) => ({ r, rowKey: `${t.id}:${idx}` }))
                                .map(({ r, rowKey }) => (
                                  <tr key={rowKey} className="border-t">
                                    {t.columns.map((col, ci) => {
                                      const v = r[ci] ?? null;
                                      return (
                                        <td
                                          key={col}
                                          className={`px-2 py-1 ${typeof v === 'number' ? 'text-right tabular-nums' : ''}`}
                                        >
                                          {v === null ? '—' : String(v)}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </article>
          </div>
        ))}
      <p className="text-xs text-muted-foreground">
        Player reports are generated by the API only when every gate passes (otherwise a thank-you
        page) and are managed per session; they never appear in scientific exports.
      </p>
    </div>
  );
}
