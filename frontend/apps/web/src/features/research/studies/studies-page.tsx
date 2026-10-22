'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Can } from '@/components/auth/can';
import { PageHeader } from '@/components/data/page-header';
import { ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useApi } from '@/lib/auth/auth-context';
import { formatDate, formatInteger } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { useStudyScope } from '@/lib/study-scope';
import { useStudyDesigns } from '../api/hooks';
import { STUDY_CODES, type StudyDesign } from '../api/types';
import { Field, FormDialog, TextField } from '../components/form-dialog';
import { ResultTable } from '../components/result-table';
import { pct } from '../components/shared';
import { quotaProgress } from '../lib/overview';
import { STUDY_ID_PATTERN } from '../lib/studies';

/** Indicative stages and samples (spec section 8; not a substitute for a power analysis). */
const STAGES = [
  ['think_aloud', 'Think-aloud (30–40)'],
  ['criterion_pilot', 'Criterion pilot (300–400 per language)'],
  ['retest', 'Retest (100 pilot participants, 2–4 weeks)'],
  ['fairness', 'Fairness (pooled pilot)'],
  ['criterion_norming', 'Criterion / norming (field sample)'],
] as const;

export function StudiesPage() {
  const { studies, isLoading, error } = useStudyScope();
  const designs = useStudyDesigns(studies.map((s) => s.study_id));
  const router = useRouter();
  const designOf = (id: string) =>
    designs.find((d) => d.data?.study.study_id === id)?.data as StudyDesign | undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Studies"
        description="Study protocols, cohorts, stratified recruitment, arms, retest scheduling, deviations, dataset freeze and analysis-plan registration."
        actions={
          <Can all={['studies.write']}>
            <CreateStudyDialog
              onCreated={(id) => router.push(`/research/studies/${encodeURIComponent(id)}`)}
            />
          </Can>
        }
      />
      {isLoading ? (
        <LoadingState rows={4} />
      ) : error ? (
        <ErrorState error={error} />
      ) : (
        <ResultTable
          exportName="studies"
          rows={studies}
          rowKey={(s) => s.study_id}
          empty="No studies registered yet."
          columns={[
            {
              key: 'name',
              header: 'Study',
              cell: (s) => (
                <button
                  type="button"
                  className="text-left hover:underline"
                  onClick={() => router.push(`/research/studies/${encodeURIComponent(s.study_id)}`)}
                >
                  <span className="font-mono text-xs text-muted-foreground">{s.code}</span>{' '}
                  <span className="font-medium">{s.name}</span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {s.study_id}
                  </span>
                </button>
              ),
              value: (s) => s.name,
            },
            {
              key: 'stage',
              header: 'Stage',
              cell: (s) => s.stage.replaceAll('_', ' '),
              value: (s) => s.stage,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (s) => <StatusBadge status={s.frozen_at ? 'frozen' : s.status} />,
              value: (s) => s.status,
            },
            {
              key: 'protocol',
              header: 'Protocol',
              cell: (s) => (
                <span className="font-mono text-xs">{s.current_protocol_version ?? '—'}</span>
              ),
              value: (s) => s.current_protocol_version,
            },
            {
              key: 'recruit',
              header: 'Recruitment',
              cell: (s) => {
                const d = designOf(s.study_id);
                if (!d) return <span className="text-xs text-muted-foreground">—</span>;
                const q = quotaProgress(d.quotas);
                return (
                  <div className="min-w-40 space-y-1">
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, (q.share ?? 0) * 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatInteger(q.enrolled)} / {formatInteger(q.target || s.target_sample)} ·{' '}
                      {pct(q.share, 0)}
                    </span>
                  </div>
                );
              },
            },
            {
              key: 'prereg',
              header: 'Pre-registration',
              cell: (s) =>
                s.requires_prereg ? (
                  s.prereg_id ? (
                    <Badge variant="success">{s.prereg_id}</Badge>
                  ) : (
                    <Badge variant="warning">required, missing</Badge>
                  )
                ) : (
                  <span className="text-xs text-muted-foreground">not required</span>
                ),
              value: (s) => s.prereg_id,
            },
            {
              key: 'plans',
              header: 'Plans',
              numeric: true,
              cell: (s) => formatInteger(designOf(s.study_id)?.analysis_plans.length),
              value: (s) => designOf(s.study_id)?.analysis_plans.length ?? null,
            },
            {
              key: 'created',
              header: 'Created',
              cell: (s) => formatDate(s.created_at),
              value: (s) => s.created_at,
            },
          ]}
        />
      )}
    </div>
  );
}

function CreateStudyDialog({ onCreated }: { readonly onCreated: (id: string) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [studyId, setStudyId] = useState('');
  const [code, setCode] = useState<(typeof STUDY_CODES)[number]>('S2');
  const [name, setName] = useState('');
  const [stage, setStage] = useState<string>('criterion_pilot');
  const [target, setTarget] = useState('');
  const [description, setDescription] = useState('');
  const [power, setPower] = useState('');
  const validId = STUDY_ID_PATTERN.test(studyId);
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/studies', {
          body: {
            study_id: studyId,
            code,
            name,
            stage,
            description: description || null,
            target_sample: target ? Number(target) : null,
            power_record: power ? { note: power } : {},
            config: {},
          },
        }),
      ),
    onSuccess: async (s) => {
      toast.success(`Study ${s.study_id} created (draft).`);
      await qc.invalidateQueries({ queryKey: queryKeys.studies() });
      onCreated(s.study_id);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <FormDialog
      title="Create a study"
      description="Starts as a draft. Stages from S2 onwards require a pre-registered analysis plan before confirmatory analyses."
      trigger={
        <Button size="sm">
          <PlusIcon aria-hidden="true" /> New study
        </Button>
      }
      submitLabel="Create study"
      pending={create.isPending}
      disabled={!validId || !name}
      onSubmit={async () => {
        try {
          await create.mutateAsync();
          return true;
        } catch {
          return false;
        }
      }}
      wide
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="study-id"
          label="Study id"
          value={studyId}
          onChange={setStudyId}
          placeholder="s2-pilot-2027"
          hint={
            studyId && !validId
              ? 'Lower-case letters, digits and . _ : - only.'
              : 'Permanent; used in audit records.'
          }
          required
        />
        <Field id="study-code" label="Stage code">
          <Select value={code} onValueChange={(v) => setCode(v as (typeof STUDY_CODES)[number])}>
            <SelectTrigger id="study-code" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STUDY_CODES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <TextField
          id="study-name"
          label="Name"
          value={name}
          onChange={setName}
          required
          className="sm:col-span-2"
        />
        <Field id="study-stage" label="Stage">
          <Select value={stage} onValueChange={setStage}>
            <SelectTrigger id="study-stage" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STAGES.map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <TextField
          id="study-target"
          label="Target sample"
          type="number"
          value={target}
          onChange={setTarget}
          hint="Indicative; record the power analysis below."
        />
        <Field id="study-power" label="Sample-size / power record" className="sm:col-span-2">
          <Textarea
            id="study-power"
            value={power}
            onChange={(e) => setPower(e.target.value)}
            rows={2}
            placeholder="e.g. VAL-02: r = .20, α = .05 (Holm over 8), power .80 → n = 313 per language"
          />
        </Field>
        <Field id="study-desc" label="Description" className="sm:col-span-2">
          <Textarea
            id="study-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </Field>
      </div>
    </FormDialog>
  );
}
