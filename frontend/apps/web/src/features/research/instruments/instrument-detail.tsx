'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheckIcon, FileUpIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Can } from '@/components/auth/can';
import { PageHeader, Section } from '@/components/data/page-header';
import { ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useApi } from '@/lib/auth/auth-context';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  researchKeys,
  useInstruments,
  useInstrumentVersion,
  useInstrumentVersions,
  useLicensing,
} from '../api/hooks';
import { asArray, asNumber, asRecord, asString, type PermissionOut } from '../api/types';
import { Field, FormDialog, TextField } from '../components/form-dialog';
import { ResultTable } from '../components/result-table';
import { KeyValues } from '../components/shared';
import { definitionItems, readScale } from '../lib/administration';
import { licenceTone } from './instruments-page';

const ITC_STATES = [
  'draft',
  'forward_translated',
  'back_translated',
  'expert_reviewed',
  'recorded',
  'audio_qc',
  'think_aloud_tested',
  'approved',
  'flagged_for_revision',
] as const;
const PERMISSION_STATES = [
  'not_requested',
  'requested',
  'granted',
  'denied',
  'not_required',
] as const;

export function InstrumentDetailPage({ instrumentId }: { readonly instrumentId: string }) {
  const instruments = useInstruments();
  const inst = instruments.data?.find((i) => i.instrument_id === instrumentId) ?? null;
  const versions = useInstrumentVersions(instrumentId);
  const [versionChoice, setVersion] = useState<string | null>(null);
  const version = versionChoice ?? inst?.current_version ?? null;
  const detail = useInstrumentVersion(instrumentId, version);
  const licensing = useLicensing(instrumentId);
  const def = (detail.data?.definition ?? {}) as Record<string, unknown>;
  const items = useMemo(() => definitionItems(def), [def]);
  const scale = useMemo(() => readScale(def), [def]);
  const subscales = asArray(def.subscales).map(asRecord);
  const scoring = asRecord(def.scoring);
  const admin = asRecord(def.administration);

  if (instruments.isPending) return <LoadingState rows={6} />;
  if (instruments.isError) return <ErrorState error={instruments.error} />;
  if (!inst)
    return <ErrorState error={new Error(`Instrument ${instrumentId} is not in the registry.`)} />;
  return (
    <div className="space-y-6">
      <PageHeader
        title={`${inst.short_name} · ${inst.name}`}
        description={inst.citation}
        meta={
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="font-mono">
              {inst.instrument_id}
            </Badge>
            <Badge variant="secondary">{inst.kind}</Badge>
            <StatusBadge
              status={inst.licensing?.permission_status ?? 'unknown'}
              tone={licenceTone(inst.licensing?.permission_status)}
              label={`licence ${inst.licensing?.permission_status?.replaceAll('_', ' ') ?? 'unknown'}`}
            />
            {inst.constructs_measured.map((c) => (
              <Badge key={c} variant="outline">
                {c.replaceAll('_', ' ')}
              </Badge>
            ))}
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {versions.data && versions.data.length > 1 && (
              <Select value={version ?? ''} onValueChange={setVersion}>
                <SelectTrigger size="sm" aria-label="Version" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {versions.data.map((v) => (
                    <SelectItem key={v.version} value={v.version}>
                      v{v.version} · {v.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Can all={['imports.write']}>
              <Button asChild size="sm" variant="outline">
                <Link
                  href={`/research/instruments/imports?instrument=${encodeURIComponent(instrumentId)}`}
                >
                  <FileUpIcon aria-hidden="true" /> Import
                </Link>
              </Button>
            </Can>
            <Can all={['responses.write']}>
              <Button asChild size="sm">
                <Link href={`/research/instruments/${encodeURIComponent(instrumentId)}/administer`}>
                  <ClipboardCheckIcon aria-hidden="true" /> Administer
                </Link>
              </Button>
            </Can>
          </div>
        }
      />
      {(inst.licensing_warnings ?? []).length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Administration blocked</AlertTitle>
          <AlertDescription>{(inst.licensing_warnings ?? []).join(' · ')}</AlertDescription>
        </Alert>
      )}
      {detail.isPending ? (
        <LoadingState rows={6} />
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : (
        <Tabs defaultValue="items">
          <TabsList>
            <TabsTrigger value="items">Items</TabsTrigger>
            <TabsTrigger value="scoring">Scoring key</TabsTrigger>
            <TabsTrigger value="languages">Language versions</TabsTrigger>
            <TabsTrigger value="licensing">Licensing</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
          </TabsList>
          <TabsContent value="items">
            <Section
              title={`${items.length} items`}
              description="Registry structure only: copyrighted wording is not stored; each item carries a placeholder and the reference to its licensed source."
            >
              <ResultTable
                exportName={`${instrumentId}-items`}
                rows={items}
                rowKey={(i) => i.itemId}
                columns={[
                  {
                    key: 'n',
                    header: '#',
                    numeric: true,
                    cell: (i) => i.number,
                    value: (i) => i.number,
                  },
                  {
                    key: 'id',
                    header: 'Item id',
                    cell: (i) => <span className="font-mono text-xs">{i.itemId}</span>,
                    value: (i) => i.itemId,
                  },
                  {
                    key: 'text',
                    header: 'Text (placeholder)',
                    cell: (i) => (
                      <span className="text-xs italic text-muted-foreground">
                        {i.placeholderText}
                      </span>
                    ),
                    value: (i) => i.placeholderText,
                    className: 'max-w-72 whitespace-normal',
                  },
                  {
                    key: 'src',
                    header: 'Licensed source',
                    cell: (i) => <span className="text-xs">{i.sourceReference ?? '—'}</span>,
                    value: (i) => i.sourceReference,
                    className: 'max-w-80 whitespace-normal',
                  },
                  {
                    key: 'sub',
                    header: 'Subscales',
                    cell: (i) => i.subscales.join(', '),
                    value: (i) => i.subscales.join(' '),
                  },
                  {
                    key: 'block',
                    header: 'Block',
                    cell: (i) => <Badge variant="outline">{i.block}</Badge>,
                    value: (i) => i.block,
                  },
                  {
                    key: 'rev',
                    header: 'Reverse',
                    cell: (i) => (i.reverseKeyed ? <Badge variant="info">reverse</Badge> : '—'),
                    value: (i) => i.reverseKeyed,
                  },
                  {
                    key: 'att',
                    header: 'Attention',
                    cell: (i) => (i.attentionCheck ? <Badge variant="warning">check</Badge> : '—'),
                    value: (i) => i.attentionCheck,
                  },
                  {
                    key: 'm',
                    header: 'Measures',
                    cell: (i) => i.measures.join(', ') || '—',
                    value: (i) => i.measures.join(' '),
                  },
                ]}
              />
            </Section>
          </TabsContent>
          <TabsContent value="scoring">
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Response scale and keys</CardTitle>
                </CardHeader>
                <CardContent>
                  <KeyValues
                    items={[
                      [
                        'Scale',
                        `${scale.type}${scale.min !== null ? ` ${scale.min}–${scale.max}` : ''}`,
                      ],
                      [
                        'Anchors',
                        scale.anchors.map((a) => `${a.value}: ${a.labelKey ?? ''}`).join(' · ') ||
                          '—',
                      ],
                      [
                        'Reverse formula',
                        asString(asRecord(def.response_scale).reverse_formula) ?? '—',
                      ],
                      [
                        'Key version',
                        asString(scoring.key_version) ?? detail.data?.key_version ?? '—',
                      ],
                      [
                        'Prorating',
                        asNumber(scoring.prorate_min_prop) !== null
                          ? `score when ≥ ${Math.round((asNumber(scoring.prorate_min_prop) ?? 0) * 100)}% of items answered`
                          : 'not allowed',
                      ],
                      ['Attention-check flag', asString(scoring.attention_check_fail_flag) ?? '—'],
                      [
                        'Administration',
                        `${asArray(admin.modes).join(', ')} · ${admin.audio_assisted === true ? 'audio-assisted' : 'no audio'} · ~${String(admin.estimated_minutes ?? '?')} min`,
                      ],
                      [
                        'Public kiosk',
                        admin.public_kiosk_allowed === true
                          ? 'allowed'
                          : 'never (supervised pilots only)',
                      ],
                    ]}
                  />
                </CardContent>
              </Card>
              <ResultTable
                title="Subscales"
                exportName={`${instrumentId}-scoring-key`}
                rows={subscales}
                rowKey={(s) => String(s.scale_id)}
                empty="No subscales."
                columns={[
                  {
                    key: 'id',
                    header: 'Scale',
                    cell: (s) => <span className="font-mono text-xs">{String(s.scale_id)}</span>,
                    value: (s) => String(s.scale_id),
                  },
                  {
                    key: 'name',
                    header: 'Name',
                    cell: (s) => String(s.name ?? ''),
                    value: (s) => String(s.name ?? ''),
                  },
                  {
                    key: 'items',
                    header: 'Items',
                    numeric: true,
                    cell: (s) => asArray(s.items).length,
                    value: (s) => asArray(s.items).length,
                  },
                  {
                    key: 'rev',
                    header: 'Reverse-keyed',
                    cell: (s) =>
                      asArray(s.items)
                        .filter((id) => items.find((i) => i.itemId === id)?.reverseKeyed)
                        .map(String)
                        .join(', ') || '—',
                    value: (s) =>
                      asArray(s.items)
                        .filter((id) => items.find((i) => i.itemId === id)?.reverseKeyed)
                        .join(' '),
                    className: 'max-w-80 whitespace-normal',
                  },
                  {
                    key: 'method',
                    header: 'Score',
                    cell: (s) => String(s.method ?? s.score ?? 'mean'),
                    value: (s) => String(s.method ?? s.score ?? 'mean'),
                  },
                ]}
              />
            </div>
          </TabsContent>
          <TabsContent value="languages">
            <LanguageVersions
              instrumentId={instrumentId}
              version={version ?? ''}
              rows={detail.data?.language_versions ?? []}
            />
          </TabsContent>
          <TabsContent value="licensing">
            <LicensingPanel
              instrumentId={instrumentId}
              history={(licensing.data ?? []) as PermissionOut[]}
              current={inst.licensing ?? null}
            />
          </TabsContent>
          <TabsContent value="versions">
            <ResultTable
              exportName={`${instrumentId}-versions`}
              rows={versions.data ?? []}
              rowKey={(v) => v.version}
              columns={[
                {
                  key: 'v',
                  header: 'Version',
                  cell: (v) => <span className="font-mono text-xs">{v.version}</span>,
                  value: (v) => v.version,
                },
                {
                  key: 'k',
                  header: 'Key version',
                  cell: (v) => v.key_version,
                  value: (v) => v.key_version,
                },
                {
                  key: 's',
                  header: 'Status',
                  cell: (v) => <StatusBadge status={v.status} />,
                  value: (v) => v.status,
                },
                {
                  key: 'p',
                  header: 'Source',
                  cell: (v) => <span className="font-mono text-xs">{v.source_path ?? '—'}</span>,
                  value: (v) => v.source_path,
                },
                {
                  key: 'at',
                  header: 'Loaded',
                  cell: (v) => formatDate(v.created_at),
                  value: (v) => v.created_at,
                },
              ]}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function LanguageVersions({
  instrumentId,
  version,
  rows,
}: {
  readonly instrumentId: string;
  readonly version: string;
  readonly rows: readonly {
    language: string;
    itc_state: string;
    approved: boolean;
    translation_permission: string;
    approved_by: string[];
    approved_at: string | null;
  }[];
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [language, setLanguage] = useState(rows[0]?.language ?? 'hi-IN');
  const [state, setState] = useState<(typeof ITC_STATES)[number]>('forward_translated');
  const [approvers, setApprovers] = useState('');
  const advance = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/instruments/{instrument_id}/versions/{version}/languages/{language}', {
          params: { path: { instrument_id: instrumentId, version, language } },
          body: {
            itc_state: state,
            approvers: approvers
              .split(',')
              .map((a) => a.trim())
              .filter(Boolean),
          },
        }),
      ),
    onSuccess: async () => {
      toast.success('Language version updated.');
      await qc.invalidateQueries({
        queryKey: researchKeys.instrumentVersion(instrumentId, version),
      });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Section
      title="Language versions"
      description="ITC translation workflow: forward and back translation, expert review, recording, audio QC, think-aloud, approval (two approvers)."
      actions={
        <Can all={['instruments.write']}>
          <FormDialog
            title="Advance a language version"
            trigger={
              <Button size="sm" variant="outline">
                <PlusIcon aria-hidden="true" /> Update state
              </Button>
            }
            pending={advance.isPending}
            onSubmit={async () => {
              try {
                await advance.mutateAsync();
                return true;
              } catch {
                return false;
              }
            }}
          >
            <Field id="lv-lang" label="Language">
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger id="lv-lang" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rows.map((r) => (
                    <SelectItem key={r.language} value={r.language}>
                      {r.language}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="lv-state" label="ITC state">
              <Select
                value={state}
                onValueChange={(v) => setState(v as (typeof ITC_STATES)[number])}
              >
                <SelectTrigger id="lv-state" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ITC_STATES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.replaceAll('_', ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <TextField
              id="lv-approvers"
              label="Approvers (two for approval)"
              value={approvers}
              onChange={setApprovers}
            />
          </FormDialog>
        </Can>
      }
    >
      <ResultTable
        rows={rows}
        rowKey={(r) => r.language}
        columns={[
          { key: 'l', header: 'Language', cell: (r) => r.language },
          {
            key: 's',
            header: 'ITC state',
            cell: (r) => (
              <StatusBadge
                status={r.itc_state}
                tone={
                  r.approved
                    ? 'good'
                    : r.itc_state === 'flagged_for_revision'
                      ? 'serious'
                      : 'neutral'
                }
              />
            ),
          },
          {
            key: 'p',
            header: 'Translation permission',
            cell: (r) => r.translation_permission.replaceAll('_', ' '),
          },
          { key: 'a', header: 'Approved by', cell: (r) => r.approved_by.join(', ') || '—' },
          {
            key: 'at',
            header: 'Approved',
            cell: (r) => (r.approved_at ? formatDate(r.approved_at) : '—'),
          },
        ]}
      />
    </Section>
  );
}

function LicensingPanel({
  instrumentId,
  history,
  current,
}: {
  readonly instrumentId: string;
  readonly history: readonly PermissionOut[];
  readonly current: PermissionOut | null;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    holder: current?.holder ?? '',
    licence: current?.licence ?? '',
    status: (current?.permission_status ?? 'not_requested') as (typeof PERMISSION_STATES)[number],
    document: current?.permission_document ?? '',
    allowed: current?.allowed_use ?? 'Research use.',
    expiry: current?.expiry ?? '',
    commercial: current?.commercial_use ?? false,
    notes: current?.notes ?? '',
  });
  const record = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/instruments/{instrument_id}/licensing', {
          params: { path: { instrument_id: instrumentId } },
          body: {
            holder: form.holder,
            licence: form.licence,
            permission_status: form.status,
            permission_document: form.document || null,
            allowed_use: form.allowed,
            expiry: form.expiry || null,
            commercial_use: form.commercial,
            notes: form.notes || null,
          },
        }),
      ),
    onSuccess: async () => {
      toast.success('Licensing update recorded (append-only).');
      await qc.invalidateQueries({ queryKey: researchKeys.licensing(instrumentId) });
      await qc.invalidateQueries({ queryKey: researchKeys.instruments() });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Section
      title="Licensing history"
      description="Append-only permission records; the newest applies."
      actions={
        <Can all={['instruments.write']}>
          <FormDialog
            title="Record a licensing update"
            wide
            trigger={
              <Button size="sm" variant="outline">
                <PlusIcon aria-hidden="true" /> Record update
              </Button>
            }
            pending={record.isPending}
            disabled={!form.holder || !form.licence}
            onSubmit={async () => {
              try {
                await record.mutateAsync();
                return true;
              } catch {
                return false;
              }
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                id="lic-holder"
                label="Holder"
                value={form.holder}
                onChange={(v) => setForm({ ...form, holder: v })}
              />
              <TextField
                id="lic-licence"
                label="Licence"
                value={form.licence}
                onChange={(v) => setForm({ ...form, licence: v })}
              />
              <Field id="lic-status" label="Permission status">
                <Select
                  value={form.status}
                  onValueChange={(v) =>
                    setForm({ ...form, status: v as (typeof PERMISSION_STATES)[number] })
                  }
                >
                  <SelectTrigger id="lic-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PERMISSION_STATES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s.replaceAll('_', ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <TextField
                id="lic-doc"
                label="Permission document reference"
                value={form.document}
                onChange={(v) => setForm({ ...form, document: v })}
              />
              <TextField
                id="lic-use"
                label="Allowed use"
                value={form.allowed}
                onChange={(v) => setForm({ ...form, allowed: v })}
              />
              <TextField
                id="lic-exp"
                label="Expiry"
                type="date"
                value={form.expiry}
                onChange={(v) => setForm({ ...form, expiry: v })}
              />
              <TextField
                id="lic-notes"
                label="Notes"
                value={form.notes}
                onChange={(v) => setForm({ ...form, notes: v })}
                className="sm:col-span-2"
              />
              <label className="flex items-center gap-2 text-sm" htmlFor="lic-com">
                <Checkbox
                  id="lic-com"
                  checked={form.commercial}
                  onCheckedChange={(v) => setForm({ ...form, commercial: v === true })}
                />{' '}
                Commercial use permitted
              </label>
            </div>
          </FormDialog>
        </Can>
      }
    >
      <ResultTable
        exportName={`${instrumentId}-licensing`}
        rows={history}
        rowKey={(l) => String(l.id) + l.created_at}
        empty="No licensing records."
        columns={[
          {
            key: 'at',
            header: 'Recorded',
            cell: (l) => formatDateTime(l.created_at),
            value: (l) => l.created_at,
          },
          {
            key: 's',
            header: 'Status',
            cell: (l) => (
              <StatusBadge status={l.permission_status} tone={licenceTone(l.permission_status)} />
            ),
            value: (l) => l.permission_status,
          },
          { key: 'h', header: 'Holder', cell: (l) => l.holder, value: (l) => l.holder },
          {
            key: 'lic',
            header: 'Licence',
            cell: (l) => l.licence,
            value: (l) => l.licence,
            className: 'max-w-64 whitespace-normal',
          },
          {
            key: 'use',
            header: 'Allowed use',
            cell: (l) => l.allowed_use,
            value: (l) => l.allowed_use,
          },
          {
            key: 'doc',
            header: 'Document',
            cell: (l) => <span className="font-mono text-xs">{l.permission_document ?? '—'}</span>,
            value: (l) => l.permission_document,
          },
          { key: 'exp', header: 'Expiry', cell: (l) => l.expiry ?? '—', value: (l) => l.expiry },
          { key: 'by', header: 'By', cell: (l) => l.recorded_by, value: (l) => l.recorded_by },
        ]}
      />
    </Section>
  );
}
