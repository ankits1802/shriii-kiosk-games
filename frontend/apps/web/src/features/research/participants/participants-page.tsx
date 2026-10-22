'use client';

/**
 * Pseudonymous participant records (spec section 11): pids only, never identity fields. Linkage,
 * consent status and history, enrolments, and the withdrawal / erasure-request flow. Contact details
 * live in the separate identity vault and are never displayed here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EraserIcon, ShieldIcon, UserXIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Can } from '@/components/auth/can';
import { PageHeader, Section } from '@/components/data/page-header';
import { ErrorState, LoadingState } from '@/components/data/states';
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useApi, useAuth } from '@/lib/auth/auth-context';
import { hasPermission } from '@/lib/auth/principal';
import { formatDate, formatDateTime, formatInteger, shortId } from '@/lib/format';
import { useStudyScope } from '@/lib/study-scope';
import { researchKeys, useConsents, useParticipant, useParticipants } from '../api/hooks';
import type { ErasureOut } from '../api/types';
import { Field, FormDialog } from '../components/form-dialog';
import { ResultTable } from '../components/result-table';
import { KeyValues, StatTile } from '../components/shared';
import { useUrlState } from '../lib/url-state';

const PAGE = 50;

export function ParticipantsPage() {
  const { study } = useStudyScope();
  const participants = useParticipants(study?.study_id ?? null);
  const [pid, setPid] = useUrlState('pid');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const items = participants.data?.items ?? [];
  const filtered = useMemo(
    () =>
      items.filter(
        (p) =>
          (status === 'all' || p.status === status) &&
          (!search || p.pid.toLowerCase().includes(search.trim().toLowerCase())),
      ),
    [items, search, status],
  );
  const counts = useMemo(() => {
    const c = { active: 0, withdrawn: 0, other: 0 };
    for (const p of items) {
      if (p.status === 'active') c.active += 1;
      else if (p.status === 'withdrawn') c.withdrawn += 1;
      else c.other += 1;
    }
    return c;
  }, [items]);
  const pageRows = filtered.slice(page * PAGE, page * PAGE + PAGE);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Participants"
        description="Pseudonymous records only: pids, linkage, consent and enrolment. Identity and contact details are held in a separate vault and never shown in the research console."
        meta={
          <Badge variant="outline">
            {study ? `${study.code} · ${study.name}` : 'All studies in scope'}
          </Badge>
        }
        actions={<ErasureLookup />}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Records" value={formatInteger(participants.data?.total)} sub="in scope" />
        <StatTile label="Active" value={formatInteger(counts.active)} />
        <StatTile
          label="Withdrawn"
          value={formatInteger(counts.withdrawn)}
          sub="data excluded from new snapshots"
        />
      </div>
      {participants.isPending ? (
        <LoadingState rows={6} />
      ) : participants.isError ? (
        <ErrorState error={participants.error} onRetry={() => void participants.refetch()} />
      ) : (
        <ResultTable
          title={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Search pids"
                placeholder="Search pid…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                className="h-8 w-56"
              />
              <Select
                value={status}
                onValueChange={(v) => {
                  setStatus(v);
                  setPage(0);
                }}
              >
                <SelectTrigger size="sm" aria-label="Status filter" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="withdrawn">Withdrawn</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs font-normal text-muted-foreground">
                {formatInteger(filtered.length)} match
              </span>
            </div>
          }
          exportName="participants"
          studyId={study?.study_id ?? null}
          rows={pageRows}
          rowKey={(p) => p.pid}
          empty="No participant records."
          columns={[
            {
              key: 'pid',
              header: 'pid',
              cell: (p) => (
                <button
                  type="button"
                  className="font-mono text-xs text-primary hover:underline"
                  onClick={() => setPid(p.pid)}
                >
                  {p.pid}
                </button>
              ),
              value: (p) => p.pid,
            },
            {
              key: 'study',
              header: 'Study',
              cell: (p) => p.study_id ?? '—',
              value: (p) => p.study_id,
            },
            {
              key: 'source',
              header: 'Source',
              cell: (p) => p.source.replaceAll('_', ' '),
              value: (p) => p.source,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (p) => <StatusBadge status={p.status} />,
              value: (p) => p.status,
            },
            {
              key: 'created',
              header: 'Created',
              cell: (p) => formatDate(p.created_at),
              value: (p) => p.created_at,
            },
            {
              key: 'withdrawn',
              header: 'Withdrawn',
              cell: (p) => (p.withdrawn_at ? formatDate(p.withdrawn_at) : '—'),
              value: (p) => p.withdrawn_at,
            },
          ]}
          caption={
            <span className="flex items-center justify-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              Page {page + 1} of {Math.max(1, Math.ceil(filtered.length / PAGE))}
              <Button
                size="sm"
                variant="ghost"
                disabled={(page + 1) * PAGE >= filtered.length}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </span>
          }
        />
      )}
      <ParticipantSheet pid={pid} onClose={() => setPid(null)} />
    </div>
  );
}

function ParticipantSheet({
  pid,
  onClose,
}: {
  readonly pid: string | null;
  readonly onClose: () => void;
}) {
  const detail = useParticipant(pid);
  const consents = useConsents(pid);
  const { principal } = useAuth();
  const d = detail.data;
  return (
    <Sheet open={pid !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="font-mono">{pid}</SheetTitle>
          <SheetDescription>
            Pseudonymous participant record. Every view is audited.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          {detail.isPending ? (
            <LoadingState rows={4} />
          ) : detail.isError || !d ? (
            <ErrorState error={detail.error} />
          ) : (
            <>
              <KeyValues
                items={[
                  ['Status', <StatusBadge key="s" status={d.participant.status} />],
                  ['Study', d.participant.study_id ?? '—'],
                  ['Source', d.participant.source.replaceAll('_', ' ')],
                  ['Created', formatDateTime(d.participant.created_at)],
                  [
                    'Withdrawn',
                    d.participant.withdrawn_at ? formatDateTime(d.participant.withdrawn_at) : '—',
                  ],
                ]}
              />
              <Section
                title="Consent status"
                description="Current decision per consent kind (separate opt-ins for archive and contact)."
              >
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(d.consent).map(([kind, granted]) => (
                    <StatusBadge
                      key={kind}
                      status={granted ? 'granted' : 'not granted'}
                      tone={granted ? 'good' : 'neutral'}
                      label={`${kind.replaceAll('_', ' ')}: ${granted ? 'yes' : 'no'}`}
                    />
                  ))}
                </div>
              </Section>
              {hasPermission(principal, 'consent.read') && (
                <Section
                  title="Consent history"
                  description="Immutable artefacts; a new decision supersedes the previous one of the same kind."
                >
                  {consents.isPending ? (
                    <LoadingState rows={2} />
                  ) : (
                    <ResultTable
                      rows={consents.data ?? []}
                      rowKey={(c) => c.consent_id}
                      empty="No consent artefacts."
                      columns={[
                        { key: 'kind', header: 'Kind', cell: (c) => c.kind },
                        {
                          key: 'g',
                          header: 'Decision',
                          cell: (c) => (
                            <StatusBadge
                              status={c.granted ? 'granted' : 'declined'}
                              tone={c.granted ? 'good' : 'neutral'}
                            />
                          ),
                        },
                        { key: 'lang', header: 'Language', cell: (c) => c.language },
                        {
                          key: 'script',
                          header: 'Script',
                          cell: (c) => (
                            <span className="font-mono text-xs">{c.consent_script_id}</span>
                          ),
                        },
                        {
                          key: 'mode',
                          header: 'Input',
                          cell: (c) => c.input_mode.replaceAll('_', ' '),
                        },
                        { key: 'policy', header: 'Policy', cell: (c) => c.policy_version },
                        { key: 'at', header: 'Decided', cell: (c) => formatDateTime(c.decided_at) },
                      ]}
                    />
                  )}
                </Section>
              )}
              <Section
                title="Linked sessions"
                description="Game sessions linked by pairing code, QR token or two-person manual linking."
              >
                <ResultTable
                  rows={d.links}
                  rowKey={(l) => String(l.id)}
                  empty="No linked sessions."
                  columns={[
                    {
                      key: 'session',
                      header: 'Session',
                      cell: (l) => (
                        <span className="font-mono text-xs" title={l.session_id}>
                          {shortId(l.session_id)}
                        </span>
                      ),
                    },
                    { key: 'occ', header: 'Occasion', cell: (l) => l.occasion_id ?? '—' },
                    { key: 'visit', header: 'Visit', numeric: true, cell: (l) => l.visit_number },
                    { key: 'method', header: 'Method', cell: (l) => l.method.replaceAll('_', ' ') },
                    {
                      key: 'by',
                      header: 'Linked by',
                      cell: (l) =>
                        `${l.linked_by}${l.second_linker ? ` + ${l.second_linker}` : ''}`,
                    },
                    { key: 'at', header: 'When', cell: (l) => formatDateTime(l.created_at) },
                  ]}
                />
              </Section>
              <Section title="Enrolments">
                <ResultTable
                  rows={d.enrollments}
                  rowKey={(e, i) => `${String(e.study_id)}-${i}`}
                  empty="Not enrolled."
                  columns={[
                    { key: 'study', header: 'Study', cell: (e) => String(e.study_id ?? '—') },
                    { key: 'cohort', header: 'Cohort', cell: (e) => String(e.cohort_id ?? '—') },
                    { key: 'arm', header: 'Arm', cell: (e) => String(e.arm_id ?? '—') },
                    {
                      key: 'block',
                      header: 'Criterion block',
                      cell: (e) => String(e.criterion_block ?? '—'),
                    },
                    {
                      key: 'status',
                      header: 'Status',
                      cell: (e) => <StatusBadge status={String(e.status ?? '')} />,
                    },
                  ]}
                />
              </Section>
              {d.participant.status === 'active' && <WithdrawPanel pid={d.participant.pid} />}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function WithdrawPanel({ pid }: { readonly pid: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const [scope, setScope] = useState<'stop_participation' | 'withdraw_and_erase'>(
    'stop_participation',
  );
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const withdraw = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/participants/{pid}/withdraw', {
          params: { path: { pid } },
          body: { scope, reason_code: reason || null },
        }),
      ),
    onSuccess: async (r) => {
      toast.success(
        r.erasure_request_id
          ? `Withdrawn; erasure request ${shortId(r.erasure_request_id)} queued.`
          : 'Participation stopped.',
      );
      await qc.invalidateQueries({ queryKey: researchKeys.participant(pid) });
      await qc.invalidateQueries({ queryKey: ['research', 'participants'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Can all={['participants.withdraw']}>
      <Section
        title="Withdrawal"
        description="Stopping participation keeps already collected data under the consent; withdrawing with erasure removes it from every table and future snapshot, with a signed receipt."
      >
        <div className="space-y-3 rounded-lg border border-destructive/30 bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="wd-scope" label="Scope">
              <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
                <SelectTrigger id="wd-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stop_participation">Stop participation</SelectItem>
                  <SelectItem value="withdraw_and_erase">Withdraw and erase data</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field id="wd-reason" label="Reason code (optional)">
              <Input
                id="wd-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="participant_request"
                maxLength={64}
              />
            </Field>
            <Field
              id="wd-confirm"
              label={`Type the pid to confirm (${pid})`}
              className="sm:col-span-2"
            >
              <Input
                id="wd-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="font-mono"
              />
            </Field>
          </div>
          <Button
            variant="destructive"
            size="sm"
            disabled={confirm !== pid || withdraw.isPending}
            onClick={() => withdraw.mutate()}
          >
            <UserXIcon aria-hidden="true" />{' '}
            {scope === 'withdraw_and_erase' ? 'Withdraw and request erasure' : 'Stop participation'}
          </Button>
        </div>
      </Section>
    </Can>
  );
}

/** Look up an erasure request and its signed receipt; request a session-level erasure. */
function ErasureLookup() {
  const api = useApi();
  const [requestId, setRequestId] = useState('');
  const [lookup, setLookup] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [reason, setReason] = useState('');
  const status = useQuery({
    queryKey: researchKeys.erasure(lookup ?? ''),
    enabled: Boolean(lookup),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/participants/erasure-requests/{request_id}', {
          params: { path: { request_id: lookup ?? '' } },
        }),
      ) as Promise<ErasureOut>,
    refetchInterval: (q) =>
      q.state.data && q.state.data.status !== 'completed' && q.state.data.status !== 'failed'
        ? 5000
        : false,
  });
  const request = useMutation({
    mutationFn: async () =>
      (await unwrap(
        api.POST('/api/v1/participants/erasure-requests', {
          body: {
            scope: 'session',
            session_id: sessionId,
            channel: 'administrator',
            reason: reason || null,
          },
        }),
      )) as unknown as ErasureOut,
    onSuccess: (r) => {
      toast.success('Session erasure requested.');
      setLookup(r.request_id);
      setRequestId(r.request_id);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Can all={['erasure.request']}>
      <FormDialog
        title="Erasure requests"
        description="Request erasure of a single game session, or check the status and signed receipt of an existing request."
        trigger={
          <Button size="sm" variant="outline">
            <EraserIcon aria-hidden="true" /> Erasure
          </Button>
        }
        submitLabel="Request session erasure"
        pending={request.isPending}
        disabled={!/^[0-9a-f-]{36}$/i.test(sessionId)}
        onSubmit={async () => {
          try {
            await request.mutateAsync();
          } catch {
            /* toast shown */
          }
          return false;
        }}
        wide
      >
        <Field id="er-session" label="Session id">
          <Input
            id="er-session"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className="font-mono"
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </Field>
        <Field id="er-reason" label="Reason">
          <Input id="er-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="space-y-2 border-t pt-3">
          <Label htmlFor="er-lookup">Check a request</Label>
          <div className="flex gap-2">
            <Input
              id="er-lookup"
              value={requestId}
              onChange={(e) => setRequestId(e.target.value)}
              className="font-mono"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => setLookup(requestId.trim() || null)}
            >
              Check
            </Button>
          </div>
          {status.isError && (
            <p className="text-sm text-destructive">{errorMessage(status.error)}</p>
          )}
          {status.data && (
            <Alert variant={status.data.status === 'completed' ? 'info' : 'default'}>
              <ShieldIcon aria-hidden="true" />
              <AlertTitle>Erasure {status.data.status}</AlertTitle>
              <AlertDescription>
                Scope {status.data.scope} · requested {formatDateTime(status.data.created_at)}
                {status.data.completed_at
                  ? ` · completed ${formatDateTime(status.data.completed_at)}`
                  : ''}
                {status.data.receipt && (
                  <span className="block font-mono text-xs">
                    Receipt {String(status.data.receipt.receipt_id ?? '')} ·{' '}
                    {String(status.data.receipt.algorithm ?? '')} key{' '}
                    {String(status.data.receipt.key_id ?? '')}
                  </span>
                )}
                {status.data.error && (
                  <span className="block text-destructive">{status.data.error}</span>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>
      </FormDialog>
    </Can>
  );
}
