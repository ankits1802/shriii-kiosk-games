'use client';

/**
 * Gate status with its evidence, and the sign-off workflow. The gate evaluation is evaluate-only
 * (never promotes); recording a trait status is a separate, audited admin action with named
 * sign-offs (gates.yaml B6) that the API checks against the caps and permanent withholds.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GavelIcon, PlayIcon, ShieldAlertIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Can } from '@/components/auth/can';
import { Section } from '@/components/data/page-header';
import { StatusBadge } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { formatDateTime, shortId } from '@/lib/format';
import { loose, researchKeys, useGates } from '../api/hooks';
import {
  asString,
  type DatasetOut,
  type RunOut,
  TRAIT_STATUSES,
  type TraitStatus,
} from '../api/types';
import { ResultTable } from '../components/result-table';
import { batteryGateDecisions, traitGateDecisions } from '../lib/results';
import { BATTERY_GATE_RULES, type ScienceConfig, TRAIT_GATE_RULES } from '../lib/science';

function RuleChips({
  rules,
  descriptions,
}: {
  readonly rules: Readonly<Record<string, string>>;
  readonly descriptions: Readonly<Record<string, string>>;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {Object.entries(rules).map(([rule, verdict]) => (
        <span key={rule} title={descriptions[rule] ?? rule}>
          <StatusBadge
            status={verdict}
            tone={verdict === 'pass' ? 'good' : verdict === 'fail' ? 'serious' : 'neutral'}
            label={`${rule} ${verdict}`}
          />
        </span>
      ))}
    </div>
  );
}

/** Status options allowed for a construct/pathway by gates.yaml caps and permanent withholds. */
export function allowedStatuses(
  science: ScienceConfig,
  construct: string,
  pathway: string,
): TraitStatus[] {
  if (science.gates.withholds.some((w) => w.construct === construct && w.pathway === pathway)) {
    return ['withheld'];
  }
  const cap = science.gates.caps.find((c) => c.construct === construct);
  const order: TraitStatus[] = [
    'unvalidated',
    'research_only',
    'validated_broad_style',
    'validated_banded',
  ];
  const maxIdx = cap ? order.indexOf(cap.maxStatus as TraitStatus) : order.length - 1;
  return [...order.slice(0, maxIdx < 0 ? order.length : maxIdx + 1), 'withheld'];
}

export function GatesPanel({
  construct,
  constructName,
  gateRun,
  latest,
  science,
  snapshot,
  languages,
}: {
  readonly construct: string;
  readonly constructName: string;
  readonly gateRun: RunOut | null;
  readonly latest: ReadonlyMap<string, RunOut>;
  readonly science: ScienceConfig;
  readonly snapshot: DatasetOut;
  readonly languages: readonly string[];
}) {
  const api = useApi();
  const qc = useQueryClient();
  const gates = useGates();
  const pathway = asString((snapshot.spec as Record<string, unknown>).pathway) ?? 'B';
  const decisions = traitGateDecisions(gateRun).filter((d) => d.trait === construct);
  const battery = batteryGateDecisions(gateRun);
  const recorded = (gates.data?.traits ?? []).filter((g) => g.trait === construct);
  const history = (gates.data?.trait_history ?? [])
    .filter((g) => g.trait === construct)
    .slice()
    .reverse();
  const cap = science.gates.caps.find((c) => c.construct === construct);
  const withhold = science.gates.withholds.find(
    (w) => w.construct === construct && w.pathway === pathway,
  );

  const evaluate = useMutation({
    mutationFn: () =>
      unwrap(
        loose(api).POST('/api/v1/validation/datasets/{snapshot_id}/gate-evaluation', {
          params: { path: { snapshot_id: snapshot.snapshot_id } },
          body: { pathway, languages: languages.length ? languages : null },
        }),
      ),
    onSuccess: async () => {
      toast.success('Gate evaluation recorded (evaluate-only).');
      await qc.invalidateQueries({ queryKey: researchKeys.runs(snapshot.snapshot_id) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-6">
      {(cap || withhold) && (
        <Alert variant="warning">
          <ShieldAlertIcon aria-hidden="true" />
          <AlertTitle>
            {withhold
              ? 'Permanently withheld for this pathway'
              : `Capped at ${cap?.maxStatus.replaceAll('_', ' ')}`}
          </AlertTitle>
          <AlertDescription>{withhold?.reason ?? cap?.reason}</AlertDescription>
        </Alert>
      )}
      <Section
        title={`Trait gate · ${constructName}`}
        description={`Evaluated by the engine against gates.yaml v${science.gates.version} from the latest succeeded run of each analysis on this snapshot.`}
        actions={
          <Can all={['validation.run']}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => evaluate.mutate()}
              disabled={evaluate.isPending}
            >
              <PlayIcon aria-hidden="true" />
              {evaluate.isPending ? 'Evaluating…' : 'Evaluate gates'}
            </Button>
          </Can>
        }
      >
        {gateRun ? (
          <ResultTable
            exportName={`trait-gate-${construct}`}
            studyId={snapshot.study_id}
            rows={decisions}
            rowKey={(d) => `${d.language}-${d.pathway}`}
            columns={[
              {
                key: 'lang',
                header: 'Language',
                cell: (d) => d.language,
                value: (d) => d.language,
              },
              { key: 'path', header: 'Pathway', cell: (d) => d.pathway, value: (d) => d.pathway },
              {
                key: 'status',
                header: 'Evaluated status',
                cell: (d) => (
                  <StatusBadge
                    status={d.evaluatedStatus}
                    tone={
                      d.evaluatedStatus.startsWith('validated')
                        ? 'good'
                        : d.evaluatedStatus === 'withheld'
                          ? 'serious'
                          : 'neutral'
                    }
                  />
                ),
                value: (d) => d.evaluatedStatus,
              },
              {
                key: 'rules',
                header: 'Rules',
                cell: (d) => <RuleChips rules={d.rules} descriptions={TRAIT_GATE_RULES} />,
                value: (d) => JSON.stringify(d.rules),
                className: 'min-w-72 whitespace-normal',
              },
              {
                key: 'why',
                header: 'Reasons',
                cell: (d) => (
                  <span className="text-xs text-muted-foreground">{d.reasons.join(' · ')}</span>
                ),
                value: (d) => d.reasons.join('; '),
                className: 'whitespace-normal',
              },
            ]}
            caption={`Evaluation run ${shortId(gateRun.run_id)} · ${formatDateTime(gateRun.finished_at ?? gateRun.created_at)} · source runs ${Object.entries(
              (gateRun.manifest as Record<string, unknown>).source_runs ?? {},
            )
              .map(([a, id]) => `${a} ${shortId(String(id))}`)
              .join(', ')}`}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No gate evaluation on this snapshot yet.</p>
        )}
        <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
          {Object.entries(TRAIT_GATE_RULES).map(([k, v]) => (
            <li key={k}>
              <span className="font-mono font-medium text-foreground">{k}</span> {v}
            </li>
          ))}
        </ul>
      </Section>

      {battery.length > 0 && (
        <Section
          title="Battery release gate"
          description="Participant reports stay disabled (thank-you only) until this opens in at least two language groups. Fail closed."
        >
          <ResultTable
            exportName="battery-gate"
            studyId={snapshot.study_id}
            rows={battery}
            rowKey={(b) => `${b.language}-${b.pathway}-${b.siteMode}`}
            columns={[
              { key: 'l', header: 'Language', cell: (b) => b.language, value: (b) => b.language },
              { key: 'p', header: 'Pathway', cell: (b) => b.pathway, value: (b) => b.pathway },
              { key: 's', header: 'Site mode', cell: (b) => b.siteMode, value: (b) => b.siteMode },
              {
                key: 'st',
                header: 'Status',
                cell: (b) => <StatusBadge status={b.status} />,
                value: (b) => b.status,
              },
              {
                key: 'r',
                header: 'Rules',
                cell: (b) => <RuleChips rules={b.rules} descriptions={BATTERY_GATE_RULES} />,
                value: (b) => JSON.stringify(b.rules),
                className: 'min-w-72 whitespace-normal',
              },
              {
                key: 'why',
                header: 'Reasons',
                cell: (b) => (
                  <span className="text-xs text-muted-foreground">{b.reasons.join(' · ')}</span>
                ),
                value: (b) => b.reasons.join('; '),
                className: 'whitespace-normal',
              },
            ]}
          />
        </Section>
      )}

      <Section
        title="Recorded status and sign-off"
        description="What the release pack uses. Append-only; every change needs evidence ids and named approvers."
      >
        <ResultTable
          exportName={`trait-gate-history-${construct}`}
          studyId={snapshot.study_id}
          rows={history.length ? history : recorded}
          rowKey={(g) => String(g.id)}
          empty="No status has been recorded for this construct: it stays unvalidated and out of participant reports."
          columns={[
            {
              key: 'when',
              header: 'Effective',
              cell: (g) => formatDateTime(g.effective_from),
              value: (g) => g.effective_from,
            },
            { key: 'lang', header: 'Language', cell: (g) => g.language, value: (g) => g.language },
            { key: 'path', header: 'Pathway', cell: (g) => g.pathway, value: (g) => g.pathway },
            {
              key: 'status',
              header: 'Status',
              cell: (g) => <StatusBadge status={g.status} />,
              value: (g) => g.status,
            },
            {
              key: 'ev',
              header: 'Evidence',
              cell: (g) => (
                <span className="font-mono text-xs">
                  {g.evidence_ids.map((e) => shortId(e)).join(', ') || '—'}
                </span>
              ),
              value: (g) => g.evidence_ids.join(' '),
            },
            {
              key: 'ap',
              header: 'Approvers',
              cell: (g) => g.approvers.join(', ') || '—',
              value: (g) => g.approvers.join('; '),
            },
            {
              key: 'by',
              header: 'Recorded by',
              cell: (g) => g.recorded_by,
              value: (g) => g.recorded_by,
            },
            {
              key: 'cur',
              header: '',
              cell: (g) =>
                recorded.some((r) => r.id === g.id) ? <Badge variant="info">current</Badge> : null,
            },
          ]}
        />
        <Can
          all={['gates.write']}
          fallback={
            <p className="text-xs text-muted-foreground">
              Recording a gate status needs the gates.write permission (study admin). Share the
              evaluation run id with them.
            </p>
          }
        >
          <SignOffForm
            construct={construct}
            pathway={pathway}
            languages={languages}
            science={science}
            defaultEvidence={[...latest.values()]
              .map((r) => r.run_id)
              .concat(gateRun ? [gateRun.run_id] : [])}
          />
        </Can>
      </Section>
    </div>
  );
}

function SignOffForm({
  construct,
  pathway,
  languages,
  science,
  defaultEvidence,
}: {
  readonly construct: string;
  readonly pathway: string;
  readonly languages: readonly string[];
  readonly science: ScienceConfig;
  readonly defaultEvidence: readonly string[];
}) {
  const api = useApi();
  const qc = useQueryClient();
  const options = useMemo(
    () => allowedStatuses(science, construct, pathway),
    [science, construct, pathway],
  );
  const [language, setLanguage] = useState(languages[0] ?? 'hi-IN');
  const [status, setStatus] = useState<TraitStatus>(options[0] ?? 'unvalidated');
  const [evidence, setEvidence] = useState(defaultEvidence.join(', '));
  const [approvers, setApprovers] = useState('');
  const [note, setNote] = useState('');
  const minSigners = science.gates.minNamedSigners ?? 2;
  const approverList = approvers
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const evidenceList = evidence
    .split(/[\s,]+/)
    .map((a) => a.trim())
    .filter(Boolean);
  const opening = status.startsWith('validated');
  const problems = [
    ...(opening && new Set(approverList).size < minSigners
      ? [`Name at least ${minSigners} distinct approvers.`]
      : []),
    ...(opening && evidenceList.length === 0 ? ['Cite the evidence run ids.'] : []),
  ];
  const record = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/admin/gates/trait', {
          body: {
            trait: construct,
            language,
            pathway: pathway as 'A' | 'B',
            status,
            evidence_ids: evidenceList,
            approvers: approverList,
            note: note || null,
          },
        }),
      ),
    onSuccess: async () => {
      toast.success('Trait gate status recorded.');
      setNote('');
      await qc.invalidateQueries({ queryKey: researchKeys.gates() });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <form
      aria-label="Record trait gate status"
      className="grid gap-3 rounded-lg border bg-card p-4 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.length === 0) record.mutate();
      }}
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold md:col-span-2">
        <GavelIcon className="size-4" aria-hidden="true" /> Record a status for{' '}
        {construct.replaceAll('_', ' ')} · Pathway {pathway}
      </p>
      <div className="space-y-1">
        <Label htmlFor="gate-lang">Language</Label>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger id="gate-lang" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(languages.length ? languages : ['hi-IN', 'mr-IN', 'ta-IN']).map((l) => (
              <SelectItem key={l} value={l}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="gate-status">Status</Label>
        <Select value={status} onValueChange={(v) => setStatus(v as TraitStatus)}>
          <SelectTrigger id="gate-status" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRAIT_STATUSES.filter((s) => options.includes(s)).map((s) => (
              <SelectItem key={s} value={s}>
                {s.replaceAll('_', ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1 md:col-span-2">
        <Label htmlFor="gate-evidence">Evidence run ids</Label>
        <Input
          id="gate-evidence"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          className="font-mono text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="gate-approvers">Approvers (comma separated)</Label>
        <Input
          id="gate-approvers"
          value={approvers}
          onChange={(e) => setApprovers(e.target.value)}
          placeholder={science.gates.battery.signoffRoles.join(', ')}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="gate-note">Note</Label>
        <Textarea id="gate-note" value={note} onChange={(e) => setNote(e.target.value)} rows={1} />
      </div>
      <div className="flex flex-wrap items-center gap-3 md:col-span-2">
        <Button type="submit" size="sm" disabled={record.isPending || problems.length > 0}>
          {record.isPending ? 'Recording…' : 'Record status'}
        </Button>
        {problems.map((p) => (
          <span key={p} className="text-xs text-destructive">
            {p}
          </span>
        ))}
        <span className="text-xs text-muted-foreground">
          The API rejects statuses above the gates.yaml cap.
        </span>
      </div>
    </form>
  );
}
