'use client';

import { AlertTriangleIcon, FileWarningIcon, VolumeXIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DataTable, dataColumnHelper } from '@/components/data/data-table';
import { PageHeader, Section } from '@/components/data/page-header';
import { StatusBadge, type StatusTone } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTime } from '@/lib/format';
import { Hash, NeedsApi } from '../shared/components';
import { coverage, orderedStatuses, statusById } from './catalogue-model';
import type { CatalogueLine, ContentSnapshot, TranslationEntry } from './content-types';
import { ContentVersions } from './content-versions';
import { CoveragePanel } from './coverage-panel';
import { LineDetail } from './line-detail';

const ALL = '__all__';
const HIDDEN_COLUMNS = ['speaker'] as const;
/** A line with its status in the selected language (in the row, so the table updates on language change). */
type LineRow = CatalogueLine & {
  readonly recordingStatus: string;
  readonly translationStatus: string;
  readonly entry: TranslationEntry | undefined;
  readonly isReference: boolean;
};
const col = dataColumnHelper<LineRow>();

function translationTone(status: string | undefined): StatusTone {
  if (!status) return 'neutral';
  if (status === 'approved') return 'good';
  if (status === 'flagged_for_revision') return 'serious';
  if (status === 'think_aloud_tested' || status === 'audio_qc') return 'info';
  return 'neutral';
}

/** `/admin/content`: narrative line catalogue, recording and ITC status, audio slots, content versions. */
export function AdminContentPage({ snapshot }: { readonly snapshot: ContentSnapshot }) {
  const cov = useMemo(() => coverage(snapshot), [snapshot]);
  const statuses = useMemo(() => statusById(snapshot.workflow), [snapshot]);
  const translated = snapshot.languages.filter((l) => l !== snapshot.referenceLanguage);
  const [language, setLanguage] = useState<string>(translated[0] ?? snapshot.referenceLanguage);
  const [category, setCategory] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [selected, setSelected] = useState<CatalogueLine | null>(null);
  const categories = useMemo(
    () => [...new Set(snapshot.lines.map((l) => l.category))].sort(),
    [snapshot],
  );
  const isRef = language === snapshot.referenceLanguage;
  const file = snapshot.translations[language];

  const rows = useMemo<LineRow[]>(
    () =>
      snapshot.lines
        .filter((l) => {
          if (category !== ALL && l.category !== category) return false;
          if (status !== ALL && !isRef && (file?.entries[l.id]?.status ?? '') !== status)
            return false;
          return true;
        })
        .map((l) => ({
          ...l,
          recordingStatus: l.recording[language]?.status ?? 'not_scripted',
          translationStatus: isRef ? 'reference' : (file?.entries[l.id]?.status ?? 'missing'),
          entry: isRef ? undefined : file?.entries[l.id],
          isReference: isRef,
        })),
    [snapshot, category, status, isRef, file, language],
  );

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('id', {
          header: 'Line',
          cell: (c) => (
            <span className="flex items-center gap-1.5">
              <code className="font-mono text-xs">{c.getValue()}</code>
              {c.row.original.voiceForbidden && (
                <VolumeXIcon
                  className="size-3 text-muted-foreground"
                  aria-label="Never voiced on speakers"
                />
              )}
            </span>
          ),
        }),
        col.accessor((l) => `${l.category}${l.moduleId ? ` · ${l.moduleId}` : ''}`, {
          id: 'where',
          header: 'Category',
        }),
        col.accessor('referenceText', {
          header: 'Reference script',
          cell: (c) => (
            <span className="line-clamp-1 max-w-[28rem] text-xs text-muted-foreground">
              {c.getValue()}
            </span>
          ),
        }),
        col.accessor((l) => l.targetDurationMs / 1000, {
          id: 'target',
          header: 'Target s',
          cell: (c) => <span className="tabular-nums">{c.getValue().toFixed(1)}</span>,
          meta: { align: 'end', exportType: 'number' },
        }),
        col.accessor((l) => l.recordingStatus, {
          id: 'recording',
          header: 'Recording',
          cell: (c) => <StatusBadge status={c.getValue()} />,
        }),
        col.accessor((l) => l.translationStatus, {
          id: 'translation',
          header: 'Translation (ITC)',
          cell: (c) => {
            const entry = c.row.original.entry;
            if (c.row.original.isReference)
              return <span className="text-xs text-muted-foreground">source language</span>;
            return (
              <span className="flex items-center gap-1.5">
                <StatusBadge
                  status={c.getValue()}
                  tone={translationTone(entry?.status)}
                  label={statuses.get(c.getValue())?.label ?? c.getValue()}
                />
                {entry?.stale && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <FileWarningIcon
                        className="size-3.5 text-warning"
                        aria-label="Source changed"
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      The reference script changed after this translation was made.
                    </TooltipContent>
                  </Tooltip>
                )}
              </span>
            );
          },
        }),
        col.accessor((l) => l.speakerRole, { id: 'speaker', header: 'Speaker' }),
        col.accessor((l) => l.tone, { id: 'tone', header: 'Tone' }),
      ]),
    [statuses],
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Content"
        description="Narrative voice lines, per-language recording and ITC adaptation status, audio QC and content-version approval. Every player-facing line is a pre-recorded clip; reference text is never synthesised in production."
        meta={
          <p className="text-xs text-muted-foreground">
            Catalogue v{snapshot.catalogueVersion} · {snapshot.lines.length} lines · read from the
            repository at build ({formatDateTime(snapshot.builtAt)}) ·{' '}
            {snapshot.sources.map((s, i) => (
              <span key={s.path}>
                {i > 0 && ', '}
                <code className="font-mono">{s.path.split('/').pop()}</code>{' '}
                <Hash value={s.sha256} length={8} />
              </span>
            ))}
          </p>
        }
      />

      {snapshot.problems.length > 0 && (
        <Alert variant="warning">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>{snapshot.problems.length} content problem(s) found while loading</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {snapshot.problems.slice(0, 8).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Section
        title="Coverage by language"
        description="Translation workflow (machine draft → approved) and recording status. Production packs take only approved lines; pilot packs also take think-aloud-tested lines."
      >
        <CoveragePanel snapshot={snapshot} coverage={cov} />
        <NeedsApi endpoint="contentLines" compact />
      </Section>

      <Section
        title="Line catalogue"
        description="Select a line for its scripts, sign-off trail, next ITC steps and audio slot"
      >
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(l) => l.id}
          searchPlaceholder="Search id or script…"
          initialSort={{ id: 'id', desc: false }}
          pageSize={15}
          initialHidden={HIDDEN_COLUMNS}
          exportName={`voice-lines-${language}`}
          onRowClick={setSelected}
          toolbar={
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="content-language" className="text-xs">
                  Language
                </Label>
                <Select
                  value={language}
                  onValueChange={(v) => {
                    setLanguage(v);
                    setStatus(ALL);
                  }}
                >
                  <SelectTrigger id="content-language" className="h-8 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {snapshot.languages.map((l) => (
                      <SelectItem key={l} value={l}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="content-category" className="text-xs">
                  Category
                </Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger id="content-category" className="h-8 w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All categories</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!isRef && (
                <div className="space-y-1">
                  <Label htmlFor="content-status" className="text-xs">
                    ITC status
                  </Label>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger id="content-status" className="h-8 w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>All statuses</SelectItem>
                      {orderedStatuses(snapshot.workflow).map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          }
        />
      </Section>

      <ContentVersions />

      <LineDetail
        line={selected}
        snapshot={snapshot}
        onOpenChange={(o) => !o && setSelected(null)}
      />
    </div>
  );
}
