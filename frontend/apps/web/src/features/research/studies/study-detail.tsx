'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClockIcon,
  DownloadIcon,
  FileCheck2Icon,
  LockIcon,
  PlusIcon,
  SnowflakeIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Can } from '@/components/auth/can';
import { BarCiChart } from '@/components/charts';
import { PageHeader, Section } from '@/components/data/page-header';
import { ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useApi, useAuth } from '@/lib/auth/auth-context';
import { hasPermission } from '@/lib/auth/principal';
import { downloadBlob } from '@/lib/export';
import { formatDate, formatDateTime, formatInteger, shortId } from '@/lib/format';
import {
  researchKeys,
  useDatasets,
  useDeviations,
  useEnrollments,
  useSessions,
  useStudyDesign,
} from '../api/hooks';
import {
  ARM_IDS,
  type DatasetOut,
  type RetestScheduleResult,
  type StudyDesign,
} from '../api/types';
import { Field, FormDialog, TextField } from '../components/form-dialog';
import { ResultTable } from '../components/result-table';
import { isSyntheticSnapshot, KeyValues, pct } from '../components/shared';
import { cellLabel, enrollmentBreakdowns, parseCellKey, quotaProgress } from '../lib/overview';
import { retestCandidates, retestPair, sha256Hex, windowCounts } from '../lib/studies';
import { useUrlState } from '../lib/url-state';

function useStudyMutation<T>(studyId: string, fn: () => Promise<T>, success: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      toast.success(success);
      await qc.invalidateQueries({ queryKey: researchKeys.study(studyId) });
      await qc.invalidateQueries({ queryKey: researchKeys.datasets(studyId) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

async function ok(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch {
    return false;
  }
}

export function StudyDetailPage({ studyId }: { readonly studyId: string }) {
  const design = useStudyDesign(studyId);
  const [tab, setTab] = useUrlState('tab');
  if (design.isPending) return <LoadingState rows={6} />;
  if (design.isError || !design.data)
    return <ErrorState error={design.error} onRetry={() => void design.refetch()} />;
  const d = design.data;
  const s = d.study;
  const frozen = s.status === 'frozen' || s.frozen_at !== null;
  return (
    <div className="space-y-6">
      <PageHeader
        title={s.name}
        description={s.description ?? undefined}
        meta={
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="font-mono">
              {s.study_id}
            </Badge>
            <Badge variant="secondary">
              {s.code} · {s.stage.replaceAll('_', ' ')}
            </Badge>
            <StatusBadge status={frozen ? 'frozen' : s.status} />
            {s.requires_prereg &&
              (s.prereg_id ? (
                <Badge variant="success">prereg {s.prereg_id}</Badge>
              ) : (
                <Badge variant="warning">pre-registration required</Badge>
              ))}
          </div>
        }
        actions={<StatusActions design={d} frozen={frozen} />}
      />
      {frozen && (
        <Alert>
          <LockIcon aria-hidden="true" />
          <AlertTitle>Study frozen {s.frozen_at ? formatDateTime(s.frozen_at) : ''}</AlertTitle>
          <AlertDescription>
            The design and its ready snapshots are locked; new records are refused by the API.
          </AlertDescription>
        </Alert>
      )}
      <Tabs value={tab ?? 'design'} onValueChange={(v) => setTab(v === 'design' ? null : v)}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="design">Design</TabsTrigger>
          <TabsTrigger value="recruitment">Recruitment</TabsTrigger>
          <TabsTrigger value="retests">Retests</TabsTrigger>
          <TabsTrigger value="deviations">Deviations</TabsTrigger>
          <TabsTrigger value="datasets">Datasets</TabsTrigger>
          <TabsTrigger value="plan">Analysis plan &amp; freeze</TabsTrigger>
        </TabsList>
        <TabsContent value="design">
          <DesignTab design={d} frozen={frozen} />
        </TabsContent>
        <TabsContent value="recruitment">
          <RecruitmentTab design={d} frozen={frozen} />
        </TabsContent>
        <TabsContent value="retests">
          <RetestsTab design={d} frozen={frozen} />
        </TabsContent>
        <TabsContent value="deviations">
          <DeviationsTab studyId={studyId} />
        </TabsContent>
        <TabsContent value="datasets">
          <DatasetsTab design={d} frozen={frozen} />
        </TabsContent>
        <TabsContent value="plan">
          <PlanTab design={d} frozen={frozen} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatusActions({
  design,
  frozen,
}: {
  readonly design: StudyDesign;
  readonly frozen: boolean;
}) {
  const api = useApi();
  const s = design.study;
  const patch = useStudyMutation(
    s.study_id,
    () =>
      unwrap(
        api.PATCH('/api/v1/studies/{study_id}', {
          params: { path: { study_id: s.study_id } },
          body: { status: s.status === 'active' ? 'closed' : 'active' },
        }),
      ),
    'Study status updated.',
  );
  if (frozen) return null;
  return (
    <Can all={['studies.write']}>
      <Button size="sm" variant="outline" onClick={() => patch.mutate()} disabled={patch.isPending}>
        {s.status === 'active' ? 'Close recruitment' : 'Activate study'}
      </Button>
    </Can>
  );
}

function DesignTab({ design, frozen }: { readonly design: StudyDesign; readonly frozen: boolean }) {
  const api = useApi();
  const s = design.study;
  const sid = s.study_id;
  const [pv, setPv] = useState({
    version: '',
    summary: '',
    effective: new Date().toISOString().slice(0, 10),
    approvers: '',
    sha: '',
  });
  const [cohort, setCohort] = useState({ id: '', name: '', holdout: false });
  const [arm, setArm] = useState<{
    id: (typeof ARM_IDS)[number];
    ratio: string;
    description: string;
  }>({ id: 'B_fixed', ratio: '1', description: '' });
  const [occ, setOcc] = useState({
    id: '',
    label: '',
    sequence: '1',
    min: '',
    max: '',
    instruments: '',
  });
  const addProtocol = useStudyMutation(
    sid,
    () =>
      unwrap(
        api.POST('/api/v1/studies/{study_id}/protocol-versions', {
          params: { path: { study_id: sid } },
          body: {
            version: pv.version,
            document_sha256: pv.sha,
            summary: pv.summary || null,
            effective_from: new Date(pv.effective).toISOString(),
            approved_by: pv.approvers
              .split(',')
              .map((a) => a.trim())
              .filter(Boolean),
            game_config: {},
            battery: {},
          },
        }),
      ),
    'Protocol version registered.',
  );
  const addCohort = useStudyMutation(
    sid,
    () =>
      unwrap(
        api.POST('/api/v1/studies/{study_id}/cohorts', {
          params: { path: { study_id: sid } },
          body: { cohort_id: cohort.id, name: cohort.name, holdout: cohort.holdout, criteria: {} },
        }),
      ),
    'Cohort added.',
  );
  const addArm = useStudyMutation(
    sid,
    () =>
      unwrap(
        api.POST('/api/v1/studies/{study_id}/arms', {
          params: { path: { study_id: sid } },
          body: {
            arm_id: arm.id,
            ratio: Number(arm.ratio) || 1,
            description: arm.description || null,
          },
        }),
      ),
    'Arm added.',
  );
  const addOcc = useStudyMutation(
    sid,
    () =>
      unwrap(
        api.POST('/api/v1/studies/{study_id}/occasions', {
          params: { path: { study_id: sid } },
          body: {
            occasion_id: occ.id,
            label: occ.label,
            sequence: Number(occ.sequence) || 1,
            wave: 1,
            offset_days_min: occ.min ? Number(occ.min) : null,
            offset_days_max: occ.max ? Number(occ.max) : null,
            instruments: occ.instruments
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
            game_required: true,
          },
        }),
      ),
    'Measurement occasion added.',
  );
  const writable = !frozen;
  const power = s.power_record as Record<string, unknown>;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Study</CardTitle>
        </CardHeader>
        <CardContent>
          <KeyValues
            items={[
              ['Target sample', formatInteger(s.target_sample)],
              [
                'Power record',
                Object.keys(power).length
                  ? Object.entries(power)
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(' · ')
                  : 'not recorded',
              ],
              ['Current protocol', s.current_protocol_version ?? '—'],
              [
                'Study config',
                <span key="c" className="font-mono text-xs">
                  {JSON.stringify(s.config)}
                </span>,
              ],
              ['Created', `${formatDateTime(s.created_at)} by ${s.created_by}`],
            ]}
          />
        </CardContent>
      </Card>
      <Section
        title="Protocol versions"
        actions={
          writable && (
            <Can all={['studies.write']}>
              <FormDialog
                title="Register a protocol version"
                description="The document hash is computed here from the file you choose; the document itself is not uploaded."
                trigger={
                  <Button size="sm" variant="outline">
                    <PlusIcon aria-hidden="true" /> Version
                  </Button>
                }
                pending={addProtocol.isPending}
                disabled={!pv.version || !/^[0-9a-f]{64}$/.test(pv.sha)}
                onSubmit={() => ok(addProtocol.mutateAsync())}
              >
                <TextField
                  id="pv-version"
                  label="Version"
                  value={pv.version}
                  onChange={(v) => setPv({ ...pv, version: v })}
                  placeholder="S2-pilot-v2"
                  required
                />
                <Field
                  id="pv-file"
                  label="Protocol document"
                  hint={
                    pv.sha ? (
                      <span className="font-mono">sha256 {pv.sha.slice(0, 16)}…</span>
                    ) : (
                      'PDF or DOCX of the approved protocol.'
                    )
                  }
                >
                  <Input
                    id="pv-file"
                    type="file"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) setPv({ ...pv, sha: await sha256Hex(await f.arrayBuffer()) });
                    }}
                  />
                </Field>
                <TextField
                  id="pv-summary"
                  label="Summary of changes"
                  value={pv.summary}
                  onChange={(v) => setPv({ ...pv, summary: v })}
                />
                <TextField
                  id="pv-effective"
                  label="Effective from"
                  type="date"
                  value={pv.effective}
                  onChange={(v) => setPv({ ...pv, effective: v })}
                />
                <TextField
                  id="pv-approvers"
                  label="Approved by (comma separated)"
                  value={pv.approvers}
                  onChange={(v) => setPv({ ...pv, approvers: v })}
                />
              </FormDialog>
            </Can>
          )
        }
      >
        <ResultTable
          rows={design.protocols}
          rowKey={(p) => p.version}
          empty="No protocol registered."
          exportName={`${sid}-protocols`}
          studyId={sid}
          columns={[
            {
              key: 'v',
              header: 'Version',
              cell: (p) => <span className="font-mono text-xs">{p.version}</span>,
              value: (p) => p.version,
            },
            { key: 's', header: 'Summary', cell: (p) => p.summary ?? '—', value: (p) => p.summary },
            {
              key: 'e',
              header: 'Effective',
              cell: (p) => formatDate(p.effective_from),
              value: (p) => p.effective_from,
            },
            {
              key: 'a',
              header: 'Approved by',
              cell: (p) => p.approved_by.join(', ') || '—',
              value: (p) => p.approved_by.join('; '),
            },
            {
              key: 'h',
              header: 'Document sha256',
              cell: (p) => (
                <span className="font-mono text-xs" title={p.document_sha256}>
                  {p.document_sha256.slice(0, 12)}
                </span>
              ),
              value: (p) => p.document_sha256,
            },
          ]}
        />
      </Section>
      <Section
        title="Cohorts"
        description="The holdout cohort stays untouched until final model confirmation."
        actions={
          writable && (
            <Can all={['studies.write']}>
              <FormDialog
                title="Add a cohort"
                trigger={
                  <Button size="sm" variant="outline">
                    <PlusIcon aria-hidden="true" /> Cohort
                  </Button>
                }
                pending={addCohort.isPending}
                disabled={!cohort.id || !cohort.name}
                onSubmit={() => ok(addCohort.mutateAsync())}
              >
                <TextField
                  id="co-id"
                  label="Cohort id"
                  value={cohort.id}
                  onChange={(v) => setCohort({ ...cohort, id: v })}
                  required
                />
                <TextField
                  id="co-name"
                  label="Name"
                  value={cohort.name}
                  onChange={(v) => setCohort({ ...cohort, name: v })}
                  required
                />
                <label className="flex items-center gap-2 text-sm" htmlFor="co-holdout">
                  <Checkbox
                    id="co-holdout"
                    checked={cohort.holdout}
                    onCheckedChange={(v) => setCohort({ ...cohort, holdout: v === true })}
                  />{' '}
                  Untouched holdout cohort
                </label>
              </FormDialog>
            </Can>
          )
        }
      >
        <ResultTable
          rows={design.cohorts}
          rowKey={(c) => c.cohort_id}
          empty="No cohorts."
          columns={[
            {
              key: 'id',
              header: 'Cohort',
              cell: (c) => <span className="font-mono text-xs">{c.cohort_id}</span>,
            },
            { key: 'n', header: 'Name', cell: (c) => c.name },
            {
              key: 'h',
              header: 'Role',
              cell: (c) =>
                c.holdout ? (
                  <Badge variant="warning">holdout</Badge>
                ) : (
                  <Badge variant="outline">analysis</Badge>
                ),
            },
          ]}
        />
      </Section>
      <Section
        title="Arms and allocation"
        description="Block randomisation within quota cells, seeded per study and cell (reproducible)."
        actions={
          writable && (
            <Can all={['studies.write']}>
              <FormDialog
                title="Add an arm"
                trigger={
                  <Button size="sm" variant="outline">
                    <PlusIcon aria-hidden="true" /> Arm
                  </Button>
                }
                pending={addArm.isPending}
                onSubmit={() => ok(addArm.mutateAsync())}
              >
                <Field id="arm-id" label="Arm">
                  <Select
                    value={arm.id}
                    onValueChange={(v) => setArm({ ...arm, id: v as (typeof ARM_IDS)[number] })}
                  >
                    <SelectTrigger id="arm-id" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ARM_IDS.map((a) => (
                        <SelectItem key={a} value={a}>
                          {a}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <TextField
                  id="arm-ratio"
                  label="Allocation ratio"
                  type="number"
                  value={arm.ratio}
                  onChange={(v) => setArm({ ...arm, ratio: v })}
                />
                <TextField
                  id="arm-desc"
                  label="Description"
                  value={arm.description}
                  onChange={(v) => setArm({ ...arm, description: v })}
                />
              </FormDialog>
            </Can>
          )
        }
      >
        <ResultTable
          rows={design.arms}
          rowKey={(a) => a.arm_id}
          empty="No arms."
          columns={[
            {
              key: 'a',
              header: 'Arm',
              cell: (a) => <span className="font-mono text-xs">{a.arm_id}</span>,
            },
            { key: 'r', header: 'Ratio', numeric: true, cell: (a) => a.ratio },
            { key: 'd', header: 'Description', cell: (a) => a.description ?? '—' },
          ]}
        />
      </Section>
      <Section
        title="Measurement occasions"
        description="Retest windows are offsets from the first occasion; out-of-window pairs are flagged."
        className="lg:col-span-2"
        actions={
          writable && (
            <Can all={['studies.write']}>
              <FormDialog
                title="Add a measurement occasion"
                trigger={
                  <Button size="sm" variant="outline">
                    <PlusIcon aria-hidden="true" /> Occasion
                  </Button>
                }
                pending={addOcc.isPending}
                disabled={!occ.id || !occ.label}
                onSubmit={() => ok(addOcc.mutateAsync())}
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <TextField
                    id="occ-id"
                    label="Occasion id"
                    value={occ.id}
                    onChange={(v) => setOcc({ ...occ, id: v })}
                    placeholder="T3"
                    required
                  />
                  <TextField
                    id="occ-label"
                    label="Label"
                    value={occ.label}
                    onChange={(v) => setOcc({ ...occ, label: v })}
                    required
                  />
                  <TextField
                    id="occ-seq"
                    label="Sequence"
                    type="number"
                    value={occ.sequence}
                    onChange={(v) => setOcc({ ...occ, sequence: v })}
                  />
                  <TextField
                    id="occ-min"
                    label="Window min (days)"
                    type="number"
                    value={occ.min}
                    onChange={(v) => setOcc({ ...occ, min: v })}
                  />
                  <TextField
                    id="occ-max"
                    label="Window max (days)"
                    type="number"
                    value={occ.max}
                    onChange={(v) => setOcc({ ...occ, max: v })}
                  />
                  <TextField
                    id="occ-inst"
                    label="Instruments"
                    value={occ.instruments}
                    onChange={(v) => setOcc({ ...occ, instruments: v })}
                    placeholder="bscs, grit_s"
                  />
                </div>
              </FormDialog>
            </Can>
          )
        }
      >
        <ResultTable
          rows={design.occasions}
          rowKey={(o) => o.occasion_id}
          empty="No occasions."
          exportName={`${sid}-occasions`}
          studyId={sid}
          columns={[
            {
              key: 'o',
              header: 'Occasion',
              cell: (o) => <span className="font-mono text-xs">{o.occasion_id}</span>,
              value: (o) => o.occasion_id,
            },
            { key: 'l', header: 'Label', cell: (o) => o.label, value: (o) => o.label },
            {
              key: 's',
              header: 'Sequence',
              numeric: true,
              cell: (o) => o.sequence,
              value: (o) => o.sequence,
            },
            {
              key: 'w',
              header: 'Window',
              cell: (o) =>
                o.offset_days_min === null
                  ? 'baseline'
                  : `${o.offset_days_min}–${o.offset_days_max} days`,
              value: (o) =>
                o.offset_days_min === null ? '' : `${o.offset_days_min}-${o.offset_days_max}`,
            },
            {
              key: 'i',
              header: 'Battery',
              cell: (o) => (
                <div className="flex flex-wrap gap-1">
                  {o.instruments.map((i) => (
                    <Badge key={i} variant="outline" className="font-mono">
                      {i}
                    </Badge>
                  ))}
                </div>
              ),
              value: (o) => o.instruments.join(' '),
            },
            {
              key: 'g',
              header: 'Game',
              cell: (o) => (o.game_required ? 'required' : 'optional'),
              value: (o) => o.game_required,
            },
          ]}
        />
      </Section>
    </div>
  );
}

function RecruitmentTab({
  design,
  frozen,
}: {
  readonly design: StudyDesign;
  readonly frozen: boolean;
}) {
  const api = useApi();
  const sid = design.study.study_id;
  const enrollments = useEnrollments(sid);
  const { principal } = useAuth();
  const q = quotaProgress(design.quotas);
  const breakdown = useMemo(() => enrollmentBreakdowns(enrollments.data ?? []), [enrollments.data]);
  const [cell, setCell] = useState({
    language: '*',
    age_band: '*',
    gender: '*',
    edu_band: '*',
    literacy_band: '*',
    target: '100',
  });
  const addQuota = useStudyMutation(
    sid,
    () =>
      unwrap(
        api.POST('/api/v1/studies/{study_id}/quotas', {
          params: { path: { study_id: sid } },
          body: {
            cell: {
              language: cell.language,
              age_band: cell.age_band,
              gender: cell.gender,
              edu_band: cell.edu_band,
              literacy_band: cell.literacy_band,
            },
            target: Number(cell.target) || 1,
          },
        }),
      ),
    'Recruitment target added.',
  );
  return (
    <div className="space-y-6">
      <Section
        title="Stratified recruitment targets"
        description={`${formatInteger(q.enrolled)} of ${formatInteger(q.target)} places filled (${pct(q.share, 0)}) · ${q.fullCells} of ${q.cells} cells full. Enrolment into a full cell is refused or warned by the API.`}
        actions={
          !frozen && (
            <Can all={['studies.write']}>
              <FormDialog
                title="Add a quota cell"
                description="Use * for any value."
                trigger={
                  <Button size="sm" variant="outline">
                    <PlusIcon aria-hidden="true" /> Quota cell
                  </Button>
                }
                pending={addQuota.isPending}
                onSubmit={() => ok(addQuota.mutateAsync())}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['language', 'age_band', 'gender', 'edu_band', 'literacy_band'] as const).map(
                    (f) => (
                      <TextField
                        key={f}
                        id={`cell-${f}`}
                        label={f.replace('_', ' ')}
                        value={cell[f]}
                        onChange={(v) => setCell({ ...cell, [f]: v })}
                      />
                    ),
                  )}
                  <TextField
                    id="cell-target"
                    label="Target"
                    type="number"
                    value={cell.target}
                    onChange={(v) => setCell({ ...cell, target: v })}
                  />
                </div>
              </FormDialog>
            </Can>
          )
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {design.quotas.map((c) => (
            <div key={c.cell_key} className="space-y-2 rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{cellLabel(c.cell)}</span>
                {c.full && <StatusBadge status="closed" tone="good" label="full" />}
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={`${cellLabel(c.cell)} quota`}
                aria-valuemin={0}
                aria-valuemax={c.target}
                aria-valuenow={c.enrolled}
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.min(100, (c.enrolled / c.target) * 100)}%` }}
                />
              </div>
              <p className="text-xs tabular-nums text-muted-foreground">
                {formatInteger(c.enrolled)} / {formatInteger(c.target)} enrolled
              </p>
            </div>
          ))}
        </div>
      </Section>
      {hasPermission(principal, 'participants.read') && (
        <Section
          title="Enrolments"
          description="Pseudonymous ids, quota cell, cohort, arm and criterion block (planned-missing form)."
        >
          {enrollments.isPending ? (
            <LoadingState rows={3} />
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                <BarCiChart
                  title="By arm"
                  data={{
                    categories: breakdown.byArm.map((r) => r.key),
                    series: [
                      {
                        name: 'Participants',
                        values: breakdown.byArm.map((r) => ({ value: r.count })),
                      },
                    ],
                    valueLabel: 'Participants',
                    valueStyle: 'number',
                    digits: 0,
                  }}
                  height={200}
                  provenance={{ n: breakdown.total, exclusions: breakdown.withdrawn }}
                />
                <BarCiChart
                  title="By criterion block"
                  data={{
                    categories: breakdown.byBlock.map((r) => r.key),
                    series: [
                      {
                        name: 'Participants',
                        values: breakdown.byBlock.map((r) => ({ value: r.count })),
                      },
                    ],
                    valueLabel: 'Participants',
                    valueStyle: 'number',
                    digits: 0,
                  }}
                  height={200}
                  provenance={{ n: breakdown.total, exclusions: breakdown.withdrawn }}
                />
                <BarCiChart
                  title="By cohort"
                  data={{
                    categories: breakdown.byCohort.map((r) => r.key),
                    series: [
                      {
                        name: 'Participants',
                        values: breakdown.byCohort.map((r) => ({ value: r.count })),
                      },
                    ],
                    valueLabel: 'Participants',
                    valueStyle: 'number',
                    digits: 0,
                  }}
                  height={200}
                  provenance={{ n: breakdown.total, exclusions: breakdown.withdrawn }}
                />
              </div>
              <ResultTable
                rows={enrollments.data ?? []}
                pageSize={25}
                rowKey={(e) => e.pid}
                exportName={`${sid}-enrollments`}
                studyId={sid}
                columns={[
                  {
                    key: 'pid',
                    header: 'pid',
                    cell: (e) => <span className="font-mono text-xs">{e.pid}</span>,
                    value: (e) => e.pid,
                  },
                  {
                    key: 'cell',
                    header: 'Cell',
                    cell: (e) => (
                      <span className="text-xs">
                        {Object.values(parseCellKey(e.cell_key)).join(' · ') || '—'}
                      </span>
                    ),
                    value: (e) => e.cell_key,
                  },
                  {
                    key: 'cohort',
                    header: 'Cohort',
                    cell: (e) => e.cohort_id ?? '—',
                    value: (e) => e.cohort_id,
                  },
                  {
                    key: 'arm',
                    header: 'Arm',
                    cell: (e) => e.arm_id ?? '—',
                    value: (e) => e.arm_id,
                  },
                  {
                    key: 'block',
                    header: 'Block',
                    cell: (e) => e.criterion_block ?? '—',
                    value: (e) => e.criterion_block,
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    cell: (e) => <StatusBadge status={e.status} />,
                    value: (e) => e.status,
                  },
                  {
                    key: 'at',
                    header: 'Enrolled',
                    cell: (e) => formatDate(e.created_at),
                    value: (e) => e.created_at,
                  },
                ]}
              />
            </>
          )}
        </Section>
      )}
    </div>
  );
}

function RetestsTab({
  design,
  frozen,
}: {
  readonly design: StudyDesign;
  readonly frozen: boolean;
}) {
  const api = useApi();
  const sid = design.study.study_id;
  const sessions = useSessions(sid);
  const pair = retestPair(design.occasions);
  const [now] = useState(() => Date.now());
  const candidates = useMemo(
    () =>
      pair && sessions.data
        ? retestCandidates(sessions.data.items, pair.first, pair.retest, now)
        : [],
    [pair, sessions.data, now],
  );
  const counts = windowCounts(candidates);
  const [channel, setChannel] = useState<'ivr' | 'sms' | 'phone'>('ivr');
  const [result, setResult] = useState<RetestScheduleResult | null>(null);
  const toSchedule = candidates.filter((c) => c.state === 'not_open' || c.state === 'open');
  const schedule = useMutation({
    mutationFn: async () =>
      (await unwrap(
        api.POST('/api/v1/studies/{study_id}/retests', {
          params: { path: { study_id: sid } },
          body: {
            occasion_id: pair?.retest.occasion_id ?? '',
            anchors: Object.fromEntries(toSchedule.map((c) => [c.pid, c.anchor])),
            channel,
          },
        }),
      )) as unknown as RetestScheduleResult,
    onSuccess: (r) => {
      setResult(r);
      toast.success(
        `${r.scheduled.length} retest window(s) scheduled; ${r.refused.length} refused (no contact opt-in).`,
      );
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!pair) {
    return (
      <p className="text-sm text-muted-foreground">
        Add a later measurement occasion with a retest window (e.g. 14–28 days) to schedule retests.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <Section
        title={`Retest scheduling · ${pair.first.occasion_id} → ${pair.retest.occasion_id}`}
        description={`Window ${pair.retest.offset_days_min}–${pair.retest.offset_days_max} days after the completed ${pair.first.label.toLowerCase()} session. Reminders need a contact opt-in; the API refuses the others. Retests outside the window are flagged as out-of-window pairs.`}
        actions={
          !frozen && (
            <Can all={['studies.write']}>
              <div className="flex items-center gap-2">
                <Select
                  value={channel}
                  onValueChange={(v) => setChannel(v as 'ivr' | 'sms' | 'phone')}
                >
                  <SelectTrigger size="sm" aria-label="Reminder channel" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['ivr', 'sms', 'phone'] as const).map((c) => (
                      <SelectItem key={c} value={c}>
                        {c.toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={() => schedule.mutate()}
                  disabled={schedule.isPending || toSchedule.length === 0}
                >
                  <CalendarClockIcon aria-hidden="true" /> Schedule {toSchedule.length}
                </Button>
              </div>
            </Can>
          )
        }
      >
        <div className="grid gap-3 sm:grid-cols-4">
          {(
            [
              ['not_open', 'Window not open yet'],
              ['open', 'Window open now'],
              ['closed', 'Window passed (no retest)'],
              ['done', 'Retest completed'],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="rounded-lg border bg-card px-4 py-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-2xl font-semibold tabular-nums">{formatInteger(counts[k])}</p>
            </div>
          ))}
        </div>
        {result && (
          <Alert variant="info">
            <AlertTitle>
              {result.scheduled.length} scheduled · {result.refused.length} refused
            </AlertTitle>
            <AlertDescription>
              Refusals are participants without a contact opt-in; they can still be retested in
              person.
            </AlertDescription>
          </Alert>
        )}
        {sessions.isPending ? (
          <LoadingState rows={3} />
        ) : (
          <ResultTable
            rows={candidates}
            pageSize={25}
            rowKey={(c) => c.pid}
            exportName={`${sid}-retest-windows`}
            studyId={sid}
            columns={[
              {
                key: 'pid',
                header: 'pid',
                cell: (c) => <span className="font-mono text-xs">{c.pid}</span>,
                value: (c) => c.pid,
              },
              {
                key: 'anchor',
                header: `${pair.first.occasion_id} completed`,
                cell: (c) => c.anchor,
                value: (c) => c.anchor,
              },
              {
                key: 'window',
                header: 'Window',
                cell: (c) => `${c.windowStart} → ${c.windowEnd}`,
                value: (c) => `${c.windowStart}/${c.windowEnd}`,
              },
              {
                key: 'days',
                header: 'Days since',
                numeric: true,
                cell: (c) => c.daysSinceAnchor,
                value: (c) => c.daysSinceAnchor,
              },
              {
                key: 'state',
                header: 'State',
                cell: (c) => (
                  <StatusBadge
                    status={c.state}
                    tone={
                      c.state === 'done'
                        ? 'good'
                        : c.state === 'open'
                          ? 'info'
                          : c.state === 'closed'
                            ? 'warning'
                            : 'neutral'
                    }
                    label={c.state.replace('_', ' ')}
                  />
                ),
                value: (c) => c.state,
              },
            ]}
          />
        )}
      </Section>
    </div>
  );
}

function DeviationsTab({ studyId }: { readonly studyId: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const deviations = useDeviations(studyId);
  const [form, setForm] = useState<{
    category: string;
    severity: 'minor' | 'major' | 'critical';
    description: string;
    pid: string;
  }>({ category: 'procedure', severity: 'minor', description: '', pid: '' });
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/studies/{study_id}/deviations', {
          params: { path: { study_id: studyId } },
          body: {
            category: form.category,
            severity: form.severity,
            description: form.description,
            pid: form.pid || null,
          },
        }),
      ),
    onSuccess: async () => {
      toast.success('Deviation recorded.');
      setForm({ ...form, description: '', pid: '' });
      await qc.invalidateQueries({ queryKey: researchKeys.deviations(studyId) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Section
      title="Protocol deviations"
      description="Recorded by field administrators and researchers; reported in the scientific report."
      actions={
        <Can all={['studies.enroll']}>
          <FormDialog
            title="Record a protocol deviation"
            trigger={
              <Button size="sm" variant="outline">
                <PlusIcon aria-hidden="true" /> Deviation
              </Button>
            }
            pending={add.isPending}
            disabled={form.description.length < 3}
            onSubmit={() => ok(add.mutateAsync())}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="dev-cat" label="Category">
                <Select
                  value={form.category}
                  onValueChange={(v) => setForm({ ...form, category: v })}
                >
                  <SelectTrigger id="dev-cat" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      'procedure',
                      'consent',
                      'eligibility',
                      'retest_window',
                      'device',
                      'language',
                      'other',
                    ].map((c) => (
                      <SelectItem key={c} value={c}>
                        {c.replace('_', ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id="dev-sev" label="Severity">
                <Select
                  value={form.severity}
                  onValueChange={(v) =>
                    setForm({ ...form, severity: v as 'minor' | 'major' | 'critical' })
                  }
                >
                  <SelectTrigger id="dev-sev" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['minor', 'major', 'critical'] as const).map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <TextField
                id="dev-pid"
                label="pid (optional)"
                value={form.pid}
                onChange={(v) => setForm({ ...form, pid: v })}
              />
              <Field id="dev-desc" label="What happened" className="sm:col-span-2">
                <Textarea
                  id="dev-desc"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                />
              </Field>
            </div>
          </FormDialog>
        </Can>
      }
    >
      {deviations.isPending ? (
        <LoadingState rows={3} />
      ) : (
        <ResultTable
          rows={deviations.data ?? []}
          rowKey={(d) => String(d.id)}
          exportName={`${studyId}-deviations`}
          studyId={studyId}
          empty="No deviations recorded."
          columns={[
            {
              key: 'at',
              header: 'Recorded',
              cell: (d) => formatDateTime(d.created_at),
              value: (d) => d.created_at,
            },
            {
              key: 'cat',
              header: 'Category',
              cell: (d) => d.category.replace('_', ' '),
              value: (d) => d.category,
            },
            {
              key: 'sev',
              header: 'Severity',
              cell: (d) => (
                <StatusBadge
                  status={d.severity}
                  tone={
                    d.severity === 'critical'
                      ? 'critical'
                      : d.severity === 'major'
                        ? 'serious'
                        : 'warning'
                  }
                />
              ),
              value: (d) => d.severity,
            },
            {
              key: 'desc',
              header: 'Description',
              cell: (d) => d.description,
              value: (d) => d.description,
            },
            { key: 'by', header: 'By', cell: (d) => d.reported_by, value: (d) => d.reported_by },
          ]}
        />
      )}
    </Section>
  );
}

function DatasetsTab({
  design,
  frozen,
}: {
  readonly design: StudyDesign;
  readonly frozen: boolean;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const sid = design.study.study_id;
  const datasets = useDatasets(sid);
  const [name, setName] = useState('');
  const [holdout, setHoldout] = useState<string[]>(
    design.cohorts.filter((c) => c.holdout).map((c) => c.cohort_id),
  );
  const [pathway, setPathway] = useState<string>('any');
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/validation/datasets', {
          body: {
            study_id: sid,
            name,
            spec: {
              pathway: pathway === 'any' ? null : pathway,
              holdout_cohorts: holdout,
              require_game: true,
              require_criterion: true,
              include_synthetic: false,
            },
          },
        }),
      ),
    onSuccess: async () => {
      toast.success('Snapshot queued: the worker builds the matched participant × occasion file.');
      await qc.invalidateQueries({ queryKey: researchKeys.datasets(sid) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const freeze = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST('/api/v1/validation/datasets/{snapshot_id}/freeze', {
          params: { path: { snapshot_id: id } },
        }),
      ),
    onSuccess: async () => {
      toast.success('Snapshot frozen (locked).');
      await qc.invalidateQueries({ queryKey: researchKeys.datasets(sid) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const download = useMutation({
    mutationFn: async (d: DatasetOut) => {
      const { data, error, response } = await api.GET(
        '/api/v1/validation/datasets/{snapshot_id}/download',
        { params: { path: { snapshot_id: d.snapshot_id } }, parseAs: 'blob' },
      );
      if (!response.ok || error !== undefined || !(data instanceof Blob))
        throw new Error(`download failed (${response.status})`);
      downloadBlob(data, `${d.study_id}-${d.snapshot_id}.parquet`);
    },
    onSuccess: () => toast.success('Snapshot downloaded (the download is audited).'),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Section
      title="Analysis datasets"
      description="Matched participant × occasion snapshots (de-identified research ids). Confirmatory analyses run on frozen snapshots only."
      actions={
        !frozen && (
          <Can all={['datasets.write']}>
            <FormDialog
              title="Build a snapshot"
              description="Exclusions (withdrawn, no core consent, blocking quality flags, synthetic) are applied and reported by reason."
              trigger={
                <Button size="sm" variant="outline">
                  <PlusIcon aria-hidden="true" /> Build snapshot
                </Button>
              }
              pending={create.isPending}
              disabled={!name}
              onSubmit={() => ok(create.mutateAsync())}
            >
              <TextField
                id="snap-name"
                label="Name"
                value={name}
                onChange={setName}
                required
                placeholder="criterion pilot wave 1"
              />
              <Field id="snap-pathway" label="Pathway">
                <Select value={pathway} onValueChange={setPathway}>
                  <SelectTrigger id="snap-pathway" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Both</SelectItem>
                    <SelectItem value="A">A</SelectItem>
                    <SelectItem value="B">B</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field id="snap-holdout" label="Holdout cohorts (kept out of model training)">
                <div className="flex flex-wrap gap-3">
                  {design.cohorts.map((c) => (
                    <label
                      key={c.cohort_id}
                      className="flex items-center gap-2 text-sm"
                      htmlFor={`snap-h-${c.cohort_id}`}
                    >
                      <Checkbox
                        id={`snap-h-${c.cohort_id}`}
                        checked={holdout.includes(c.cohort_id)}
                        onCheckedChange={(v) =>
                          setHoldout(
                            v === true
                              ? [...holdout, c.cohort_id]
                              : holdout.filter((x) => x !== c.cohort_id),
                          )
                        }
                      />
                      {c.cohort_id}
                    </label>
                  ))}
                </div>
              </Field>
            </FormDialog>
          </Can>
        )
      }
    >
      {datasets.isPending ? (
        <LoadingState rows={3} />
      ) : (
        <ResultTable
          rows={datasets.data ?? []}
          rowKey={(d) => d.snapshot_id}
          exportName={`${sid}-snapshots`}
          studyId={sid}
          empty="No snapshots yet."
          columns={[
            {
              key: 'name',
              header: 'Snapshot',
              cell: (d) => (
                <span>
                  <span className="font-medium">{d.name}</span>{' '}
                  <span className="text-xs text-muted-foreground">v{d.version}</span>
                  {isSyntheticSnapshot(d) && (
                    <Badge variant="warning" className="ml-1.5">
                      synthetic
                    </Badge>
                  )}
                  <span
                    className="block font-mono text-xs text-muted-foreground"
                    title={d.snapshot_id}
                  >
                    {shortId(d.snapshot_id)}
                  </span>
                </span>
              ),
              value: (d) => d.snapshot_id,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (d) => <StatusBadge status={d.status} />,
              value: (d) => d.status,
            },
            {
              key: 'rows',
              header: 'Rows',
              numeric: true,
              cell: (d) => formatInteger(d.row_count),
              value: (d) => d.row_count,
            },
            {
              key: 'n',
              header: 'Participants',
              numeric: true,
              cell: (d) => formatInteger(d.n_participants),
              value: (d) => d.n_participants,
            },
            {
              key: 'ex',
              header: 'Excluded',
              numeric: true,
              cell: (d) => {
                const ex = d.exclusions as Record<string, unknown>;
                const by = (ex.by_reason ?? {}) as Record<string, number>;
                return (
                  <span
                    title={Object.entries(by)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(', ')}
                  >
                    {formatInteger(Number(ex.total ?? 0))}
                  </span>
                );
              },
              value: (d) => Number((d.exclusions as Record<string, unknown>).total ?? 0),
            },
            {
              key: 'sha',
              header: 'sha256',
              cell: (d) => (
                <span className="font-mono text-xs">{d.sha256?.slice(0, 10) ?? '—'}</span>
              ),
              value: (d) => d.sha256,
            },
            {
              key: 'at',
              header: 'Built',
              cell: (d) => formatDateTime(d.created_at),
              value: (d) => d.created_at,
            },
            {
              key: 'act',
              header: '',
              cell: (d) => (
                <div className="flex justify-end gap-1">
                  {d.status === 'ready' && (
                    <Can all={['datasets.write']}>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => freeze.mutate(d.snapshot_id)}
                        disabled={freeze.isPending}
                      >
                        <SnowflakeIcon aria-hidden="true" /> Freeze
                      </Button>
                    </Can>
                  )}
                  {(d.status === 'ready' || d.status === 'frozen') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => download.mutate(d)}
                      disabled={download.isPending}
                      aria-label={`Download ${d.name}`}
                    >
                      <DownloadIcon aria-hidden="true" /> Parquet
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      )}
    </Section>
  );
}

function PlanTab({ design, frozen }: { readonly design: StudyDesign; readonly frozen: boolean }) {
  const api = useApi();
  const sid = design.study.study_id;
  const [plan, setPlan] = useState({
    version: '',
    prereg: design.study.prereg_id ?? '',
    url: '',
    text: '',
  });
  const [reason, setReason] = useState('');
  const register = useStudyMutation(
    sid,
    () =>
      unwrap(
        api.POST('/api/v1/studies/{study_id}/analysis-plans', {
          params: { path: { study_id: sid } },
          body: {
            version: plan.version,
            prereg_id: plan.prereg || null,
            registry_url: plan.url || null,
            document: plan.text ? { text: plan.text } : {},
          },
        }),
      ),
    'Analysis plan registered: hypotheses.yaml and gates.yaml hashes frozen.',
  );
  const freezeStudy = useStudyMutation(
    sid,
    () =>
      unwrap(
        api.POST('/api/v1/studies/{study_id}/freeze', {
          params: { path: { study_id: sid } },
          body: { reason },
        }),
      ),
    'Study frozen and ready snapshots locked.',
  );
  return (
    <div className="space-y-6">
      <Section
        title="Registered analysis plans"
        description="Registering freezes the current hypotheses.yaml, gates.yaml and dictionary hashes. Results outside the registry are exploratory."
        actions={
          !frozen && (
            <Can all={['studies.write']}>
              <FormDialog
                title="Register an analysis plan"
                trigger={
                  <Button size="sm" variant="outline">
                    <FileCheck2Icon aria-hidden="true" /> Register plan
                  </Button>
                }
                pending={register.isPending}
                disabled={!plan.version}
                onSubmit={() => ok(register.mutateAsync())}
              >
                <TextField
                  id="plan-version"
                  label="Plan version"
                  value={plan.version}
                  onChange={(v) => setPlan({ ...plan, version: v })}
                  required
                />
                <TextField
                  id="plan-prereg"
                  label="Pre-registration id"
                  value={plan.prereg}
                  onChange={(v) => setPlan({ ...plan, prereg: v })}
                  placeholder="osf.io/abcd1"
                />
                <TextField
                  id="plan-url"
                  label="Registry URL"
                  value={plan.url}
                  onChange={(v) => setPlan({ ...plan, url: v })}
                />
                <Field id="plan-text" label="Plan summary">
                  <Textarea
                    id="plan-text"
                    value={plan.text}
                    onChange={(e) => setPlan({ ...plan, text: e.target.value })}
                    rows={3}
                  />
                </Field>
              </FormDialog>
            </Can>
          )
        }
      >
        <ResultTable
          rows={design.analysis_plans}
          rowKey={(p) => p.plan_id}
          exportName={`${sid}-analysis-plans`}
          studyId={sid}
          empty="No analysis plan registered."
          columns={[
            {
              key: 'v',
              header: 'Version',
              cell: (p) => <span className="font-mono text-xs">{p.version}</span>,
              value: (p) => p.version,
            },
            {
              key: 'pr',
              header: 'Pre-registration',
              cell: (p) => p.prereg_id ?? '—',
              value: (p) => p.prereg_id,
            },
            {
              key: 'h',
              header: 'hypotheses.yaml',
              cell: (p) => (
                <span className="font-mono text-xs" title={p.hypotheses_sha256}>
                  {p.hypotheses_sha256.slice(0, 12)}
                </span>
              ),
              value: (p) => p.hypotheses_sha256,
            },
            {
              key: 'g',
              header: 'gates.yaml',
              cell: (p) => (
                <span className="font-mono text-xs" title={p.gates_sha256}>
                  {p.gates_sha256.slice(0, 12)}
                </span>
              ),
              value: (p) => p.gates_sha256,
            },
            {
              key: 'at',
              header: 'Registered',
              cell: (p) => formatDateTime(p.registered_at),
              value: (p) => p.registered_at,
            },
          ]}
        />
      </Section>
      {!frozen && (
        <Can all={['studies.write']}>
          <Section
            title="Freeze and lock"
            description="Freezing locks the study design and every ready snapshot. It cannot be undone from the console."
          >
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-destructive/30 bg-card p-4">
              <Field
                id="freeze-reason"
                label="Reason (recorded in the audit log)"
                className="min-w-80 flex-1"
              >
                <Input
                  id="freeze-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Data collection complete; unblinding for Stage 2"
                />
              </Field>
              <Button
                variant="destructive"
                size="sm"
                disabled={reason.length < 3 || freezeStudy.isPending}
                onClick={() => {
                  if (window.confirm('Freeze this study and lock its ready snapshots?'))
                    freezeStudy.mutate();
                }}
              >
                <LockIcon aria-hidden="true" /> Freeze study
              </Button>
            </div>
          </Section>
        </Can>
      )}
    </div>
  );
}
