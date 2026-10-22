'use client';

/**
 * Controlled import of historical questionnaire data (spec section 5): CSV/XLSX upload, column
 * mapping onto registry item ids, client pre-check, staging (server validation), the manual-review
 * queue for ambiguous rows (unknown pid, out-of-range values, duplicates) and commit.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, FileSpreadsheetIcon, UploadIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Can } from '@/components/auth/can';
import { PageHeader, Section } from '@/components/data/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useApi } from '@/lib/auth/auth-context';
import { formatDateTime, formatInteger, shortId } from '@/lib/format';
import {
  researchKeys,
  useImportBatch,
  useImportRows,
  useInstruments,
  useInstrumentVersion,
  useStudyDesign,
} from '../api/hooks';
import type { ImportOut, ImportRowOut } from '../api/types';
import { Field } from '../components/form-dialog';
import { ResultTable } from '../components/result-table';
import { KeyValues, StudySelect, useFocusStudy } from '../components/shared';
import { type AdministrationBlock, buildPlan } from '../lib/administration';
import {
  type CsvPreview,
  checkImport,
  hasErrors,
  parseCsv,
  suggestMapping,
} from '../lib/import-mapping';
import { useUrlState } from '../lib/url-state';

const RECENT_KEY = 'shriii.research.recent-imports';
const LANGUAGES = ['hi-IN', 'mr-IN', 'ta-IN', 'en-IN'] as const;
const BLOCKS: readonly AdministrationBlock[] = [
  'X',
  'A',
  'B',
  'C',
  'performance',
  'teamwork',
  'retest_short',
];

interface RecentImport {
  readonly id: string;
  readonly filename: string;
  readonly instrument: string;
  readonly at: string;
}

function readRecent(): RecentImport[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentImport[]) : [];
  } catch {
    return [];
  }
}

function rememberImport(entry: RecentImport) {
  try {
    const list = [entry, ...readRecent().filter((r) => r.id !== entry.id)].slice(0, 10);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Convenience only.
  }
}

export function ImportsPage() {
  const [importId, setImportId] = useUrlState('import');
  return (
    <div className="space-y-6">
      <PageHeader
        title="Import questionnaire data"
        description="CSV or XLSX (ODK exports included). Map columns to registry item ids, pre-check, then stage: the API validates every row and sends ambiguous rows to manual review before anything is committed."
        meta={
          <Link
            href="/research/instruments"
            className="text-xs text-muted-foreground hover:underline"
          >
            ← Instruments
          </Link>
        }
        actions={
          importId && (
            <Button size="sm" variant="outline" onClick={() => setImportId(null)}>
              New import
            </Button>
          )
        }
      />
      {importId ? <ReviewQueue importId={importId} /> : <ImportWizard onStaged={setImportId} />}
    </div>
  );
}

function ImportWizard({ onStaged }: { readonly onStaged: (id: string) => void }) {
  const api = useApi();
  const { study, studies, setStudyId } = useFocusStudy();
  const design = useStudyDesign(study?.study_id ?? null);
  const instruments = useInstruments();
  const [instrumentParam] = useUrlState('instrument');
  const [instrumentId, setInstrumentId] = useState<string | null>(instrumentParam);
  const inst = instruments.data?.find((i) => i.instrument_id === instrumentId) ?? null;
  const version = useInstrumentVersion(instrumentId, inst?.current_version ?? null);
  const [occasion, setOccasion] = useState<string | null>(null);
  const [language, setLanguage] = useState<string>('hi-IN');
  const [block, setBlock] = useState<AdministrationBlock>('X');
  const [mode, setMode] = useState<'self' | 'read_aloud'>('self');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [recent, setRecent] = useState<RecentImport[]>([]);
  useEffect(() => setRecent(readRecent()), []);

  const plan = useMemo(() => {
    const def = version.data?.definition;
    if (!def || !inst) return null;
    const person = block === 'A' || block === 'B' || block === 'C' ? block : null;
    return buildPlan(
      inst.instrument_id,
      version.data?.version ?? inst.current_version,
      def,
      person,
    );
  }, [version.data, inst, block]);
  const occasionId = occasion ?? design.data?.occasions[0]?.occasion_id ?? null;
  const xlsx = file?.name.toLowerCase().endsWith('.xlsx') ?? false;
  const checks = useMemo(
    () => (plan && preview ? checkImport(preview, mapping, plan.items, plan.scale) : []),
    [plan, preview, mapping],
  );
  const xlsxProblems = xlsx && plan ? (mapping.pid ? [] : ['Map the participant id column.']) : [];

  const onFile = async (f: File | null) => {
    setFile(f);
    setPreview(null);
    setMapping({});
    if (!f || !plan) return;
    if (f.name.toLowerCase().endsWith('.csv')) {
      const p = parseCsv(await f.text());
      setPreview(p);
      setMapping(suggestMapping(p.headers, plan.items));
    }
  };

  const stage = useMutation({
    mutationFn: async () => {
      if (!file || !plan || !study || !occasionId)
        throw new Error('Choose the study, instrument, occasion and file.');
      const spec = {
        study_id: study.study_id,
        instrument_id: plan.instrumentId,
        instrument_version: plan.version,
        language,
        occasion_id: occasionId,
        wave: 1,
        block,
        administration_mode: mode,
        column_mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
      };
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('spec', JSON.stringify(spec));
      return (await unwrap(
        api.POST('/api/v1/assessment-responses/imports', {
          body: { file: '', spec: '' } as never,
          bodySerializer: () => fd,
        }),
      )) as ImportOut;
    },
    onSuccess: (out) => {
      rememberImport({
        id: out.import_id,
        filename: out.filename,
        instrument: out.instrument_id,
        at: out.created_at,
      });
      toast.success(`Staged ${formatInteger(Number(out.counts.rows ?? 0))} rows for review.`);
      onStaged(out.import_id);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <Section
        title="1 · Administration context"
        description="Every imported row is stored with this study, occasion, instrument version, language version and form."
      >
        <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="imp-study" label="Study">
            <StudySelect value={study?.study_id ?? null} studies={studies} onChange={setStudyId} />
          </Field>
          <Field id="imp-inst" label="Instrument">
            <Select
              value={instrumentId ?? ''}
              onValueChange={(v) => {
                setInstrumentId(v);
                setFile(null);
                setPreview(null);
                setMapping({});
              }}
            >
              <SelectTrigger id="imp-inst" className="w-full">
                <SelectValue placeholder="Choose an instrument" />
              </SelectTrigger>
              <SelectContent>
                {(instruments.data ?? []).map((i) => (
                  <SelectItem key={i.instrument_id} value={i.instrument_id}>
                    {i.short_name} · {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="imp-occ" label="Occasion">
            <Select value={occasionId ?? ''} onValueChange={setOccasion}>
              <SelectTrigger id="imp-occ" className="w-full">
                <SelectValue placeholder="Occasion" />
              </SelectTrigger>
              <SelectContent>
                {(design.data?.occasions ?? []).map((o) => (
                  <SelectItem key={o.occasion_id} value={o.occasion_id}>
                    {o.occasion_id} · {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="imp-lang" label="Language version">
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger id="imp-lang" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            id="imp-block"
            label="Form / block"
            hint="Rotating forms A–C: items of the other forms are planned missing."
          >
            <Select value={block} onValueChange={(v) => setBlock(v as AdministrationBlock)}>
              <SelectTrigger id="imp-block" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BLOCKS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="imp-mode" label="Administration mode">
            <Select value={mode} onValueChange={(v) => setMode(v as 'self' | 'read_aloud')}>
              <SelectTrigger id="imp-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="self">Self</SelectItem>
                <SelectItem value="read_aloud">Read aloud</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Section>

      <Section
        title="2 · File"
        description="CSV files are previewed and checked here; XLSX files are parsed by the server, so map their column names by hand."
      >
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed bg-card p-4">
          <FileSpreadsheetIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          <Input
            type="file"
            accept=".csv,.xlsx"
            aria-label="Import file"
            disabled={!plan}
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            className="max-w-sm"
          />
          {file && (
            <span className="text-sm text-muted-foreground">
              {file.name} · {formatInteger(preview?.totalRows ?? null)} data rows
            </span>
          )}
          {!plan && (
            <span className="text-xs text-muted-foreground">Choose an instrument first.</span>
          )}
        </div>
      </Section>

      {plan && file && (
        <Section
          title="3 · Column mapping"
          description={`${plan.items.length} response ids for ${plan.instrumentId} v${plan.version}${plan.plannedMissing.length ? ` (${plan.plannedMissing.length} planned missing for form ${block})` : ''}. Suggestions match item ids and item numbers (Q3, item3, i03).`}
        >
          <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <ResultTable
              rows={[
                { key: 'pid', label: 'Participant id (pid)', item: null },
                ...plan.items.flatMap((i) => [
                  { key: `item:${i.responseId}`, label: i.responseId, item: i },
                  ...(i.attentionCheck || i.needsKey
                    ? [
                        {
                          key: `expected:${i.responseId}`,
                          label: `${i.responseId} · expected (administration key)`,
                          item: i,
                        },
                      ]
                    : []),
                ]),
              ]}
              rowKey={(r) => r.key}
              columns={[
                {
                  key: 'target',
                  header: 'Registry field',
                  cell: (r) => <span className="font-mono text-xs">{r.label}</span>,
                },
                {
                  key: 'flags',
                  header: '',
                  cell: (r) =>
                    r.item ? (
                      <div className="flex gap-1">
                        {r.item.reverseKeyed && <Badge variant="info">reverse</Badge>}
                        {r.item.attentionCheck && <Badge variant="warning">attention</Badge>}
                      </div>
                    ) : null,
                },
                {
                  key: 'col',
                  header: 'File column',
                  cell: (r) =>
                    preview ? (
                      <Select
                        value={mapping[r.key] ?? '__none'}
                        onValueChange={(v) =>
                          setMapping({ ...mapping, [r.key]: v === '__none' ? '' : v })
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-48"
                          aria-label={`Column for ${r.label}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">— not mapped —</SelectItem>
                          {preview.headers.filter(Boolean).map((h) => (
                            <SelectItem key={h} value={h}>
                              {h}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        className="h-8 w-48"
                        aria-label={`Column for ${r.label}`}
                        value={mapping[r.key] ?? ''}
                        onChange={(e) => setMapping({ ...mapping, [r.key]: e.target.value })}
                        placeholder="column name"
                      />
                    ),
                },
              ]}
            />
            <div className="space-y-3">
              <div className="rounded-lg border bg-card p-4">
                <p className="mb-2 text-sm font-semibold">Pre-check</p>
                {preview ? (
                  checks.length === 0 ? (
                    <p className="text-sm text-success">No problems found in the preview.</p>
                  ) : (
                    <ul className="max-h-80 space-y-1 overflow-y-auto text-xs">
                      {checks.slice(0, 40).map((c) => (
                        <li
                          key={`${c.row ?? 0}|${c.column ?? ''}|${c.message}`}
                          className={
                            c.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'
                          }
                        >
                          {c.severity === 'error' ? '✕' : '!'} {c.row ? `Row ${c.row}: ` : ''}
                          {c.message}
                        </li>
                      ))}
                      {checks.length > 40 && (
                        <li className="text-muted-foreground">+{checks.length - 40} more</li>
                      )}
                    </ul>
                  )
                ) : (
                  <p className="text-xs text-muted-foreground">
                    XLSX: values are checked by the server when the file is staged.
                  </p>
                )}
              </div>
              <Can all={['imports.write']}>
                <Button
                  className="w-full"
                  disabled={
                    stage.isPending ||
                    !occasionId ||
                    (preview ? hasErrors(checks) : xlsxProblems.length > 0)
                  }
                  onClick={() => stage.mutate()}
                >
                  <UploadIcon aria-hidden="true" />{' '}
                  {stage.isPending ? 'Staging…' : 'Stage import for review'}
                </Button>
              </Can>
            </div>
          </div>
          {preview && preview.rows.length > 0 && (
            <ResultTable
              title="Preview (first rows)"
              rows={preview.rows.slice(0, 6)}
              rowKey={(_, i) => String(i)}
              columns={preview.headers.map((h, idx) => ({
                key: `${h}-${idx}`,
                header: h || `(column ${idx + 1})`,
                cell: (r: readonly string[]) => <span className="text-xs">{r[idx] ?? ''}</span>,
              }))}
            />
          )}
        </Section>
      )}

      {recent.length > 0 && (
        <Section title="Recent imports on this device">
          <ul className="space-y-1 text-sm">
            {recent.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => onStaged(r.id)}
                >
                  {r.filename}
                </button>{' '}
                <span className="text-xs text-muted-foreground">
                  {r.instrument} · {formatDateTime(r.at)} ·{' '}
                  <span className="font-mono">{shortId(r.id)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function ReviewQueue({ importId }: { readonly importId: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const batch = useImportBatch(importId);
  const rows = useImportRows(importId);
  const [fixPid, setFixPid] = useState<Record<number, string>>({});
  const [filter, setFilter] = useState<'review' | 'all'>('review');
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: researchKeys.importBatch(importId) });
    await qc.invalidateQueries({ queryKey: researchKeys.importRows(importId) });
  };
  const resolve = useMutation({
    mutationFn: ({ row, action }: { row: ImportRowOut; action: 'approve' | 'reject' }) =>
      unwrap(
        api.POST('/api/v1/assessment-responses/imports/{import_id}/rows/{row_number}/resolve', {
          params: { path: { import_id: importId, row_number: row.row_number } },
          body: {
            action,
            pid: fixPid[row.row_number] || null,
            note: action === 'approve' && fixPid[row.row_number] ? 'pid corrected in review' : null,
          },
        }),
      ),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const commit = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/assessment-responses/imports/{import_id}/commit', {
          params: { path: { import_id: importId } },
        }),
      ),
    onSuccess: async () => {
      toast.success('Ready and approved rows committed and scored.');
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/assessment-responses/imports/{import_id}/cancel', {
          params: { path: { import_id: importId } },
        }),
      ),
    onSuccess: async () => {
      toast.success('Import cancelled.');
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (batch.isPending) return <LoadingState rows={5} />;
  if (batch.isError || !batch.data) return <ErrorState error={batch.error} />;
  const b = batch.data;
  const counts = b.counts as Record<string, number>;
  const all = rows.data ?? [];
  const shown =
    filter === 'review'
      ? all.filter((r) => r.status === 'needs_review' || r.status === 'ambiguous')
      : all;
  const open = b.status === 'staged';
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="rounded-lg border bg-card p-4">
          <KeyValues
            items={[
              ['File', `${b.filename} (${b.file_format})`],
              [
                'sha256',
                <span key="s" className="font-mono text-xs">
                  {b.file_sha256.slice(0, 16)}…
                </span>,
              ],
              ['Instrument', `${b.instrument_id} v${b.instrument_version}`],
              ['Context', `${b.study_id} · ${b.occasion_id} · ${b.language} · form ${b.block}`],
              ['Status', <StatusBadge key="st" status={b.status} />],
              ['Staged', `${formatDateTime(b.created_at)} by ${b.created_by}`],
            ]}
          />
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Rows', counts.rows],
              ['Ready', counts.ready],
              ['Needs review', counts.needs_review],
              ['Rejected', counts.rejected ?? 0],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-lg border bg-card px-4 py-3">
                <p className="text-xs text-muted-foreground">{k}</p>
                <p className="text-2xl font-semibold tabular-nums">
                  {formatInteger(Number(v ?? 0))}
                </p>
              </div>
            ))}
          </div>
          {open && (
            <Can all={['imports.write']}>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => commit.mutate()} disabled={commit.isPending}>
                  <CheckIcon aria-hidden="true" /> Commit {formatInteger(Number(counts.ready ?? 0))}{' '}
                  ready rows
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => cancel.mutate()}
                  disabled={cancel.isPending}
                >
                  <XIcon aria-hidden="true" /> Cancel import
                </Button>
              </div>
            </Can>
          )}
          {b.status === 'committed' && (
            <Alert variant="info">
              <AlertTitle>
                Committed {b.committed_at ? formatDateTime(b.committed_at) : ''}
              </AlertTitle>
              <AlertDescription>
                Responses were stored with source "import" and scored; corrections later create
                superseding rows with an audit trail.
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>
      <Section
        title="Manual review queue"
        description="Ambiguous rows: unknown or missing pid, out-of-range values, duplicates. Approve (optionally correcting the pid) or reject each one."
        actions={
          <Select value={filter} onValueChange={(v) => setFilter(v as 'review' | 'all')}>
            <SelectTrigger size="sm" aria-label="Rows shown" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="review">Needs review</SelectItem>
              <SelectItem value="all">All rows</SelectItem>
            </SelectContent>
          </Select>
        }
      >
        {rows.isPending ? (
          <LoadingState rows={4} />
        ) : shown.length === 0 ? (
          <EmptyState
            title="Nothing to review"
            description="Every staged row is ready, approved or rejected."
          />
        ) : (
          <ResultTable
            exportName={`import-${shortId(importId)}-rows`}
            rows={shown}
            rowKey={(r) => String(r.row_number)}
            columns={[
              {
                key: 'n',
                header: 'Row',
                numeric: true,
                cell: (r) => r.row_number,
                value: (r) => r.row_number,
              },
              {
                key: 'pid',
                header: 'pid',
                cell: (r) => <span className="font-mono text-xs">{r.pid ?? '—'}</span>,
                value: (r) => r.pid,
              },
              {
                key: 'issues',
                header: 'Issues',
                cell: (r) => (
                  <div className="flex max-w-96 flex-wrap gap-1">
                    {r.issues.map((i) => {
                      const rec = (i ?? {}) as Record<string, unknown>;
                      return (
                        <Badge key={JSON.stringify(i)} variant="warning">
                          {String(rec.code ?? i)}
                          {rec.item_id ? ` · ${String(rec.item_id)}` : ''}
                          {rec.value !== undefined && rec.value !== ''
                            ? ` = ${String(rec.value)}`
                            : ''}
                        </Badge>
                      );
                    })}
                  </div>
                ),
                value: (r) => JSON.stringify(r.issues),
                className: 'whitespace-normal',
              },
              {
                key: 'vals',
                header: 'Answered',
                numeric: true,
                cell: (r) => Object.values(r.values).filter((v) => v !== null).length,
                value: (r) => Object.values(r.values).filter((v) => v !== null).length,
              },
              {
                key: 'status',
                header: 'Status',
                cell: (r) => (
                  <StatusBadge
                    status={r.status}
                    tone={
                      r.status === 'needs_review'
                        ? 'warning'
                        : r.status === 'rejected'
                          ? 'serious'
                          : 'good'
                    }
                  />
                ),
                value: (r) => r.status,
              },
              {
                key: 'res',
                header: 'Resolution',
                cell: (r) =>
                  r.resolved_by ? (
                    <span className="text-xs text-muted-foreground">
                      {r.resolved_by}
                      {r.resolution_note ? ` · ${r.resolution_note}` : ''}
                    </span>
                  ) : open ? (
                    <Can all={['imports.write']}>
                      <div className="flex items-center gap-1">
                        <Input
                          aria-label={`Corrected pid for row ${r.row_number}`}
                          placeholder="corrected pid"
                          className="h-8 w-32 font-mono text-xs"
                          value={fixPid[r.row_number] ?? ''}
                          onChange={(e) => setFixPid({ ...fixPid, [r.row_number]: e.target.value })}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => resolve.mutate({ row: r, action: 'approve' })}
                          disabled={resolve.isPending}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => resolve.mutate({ row: r, action: 'reject' })}
                          disabled={resolve.isPending}
                        >
                          Reject
                        </Button>
                      </div>
                    </Can>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        )}
      </Section>
    </div>
  );
}
