'use client';

import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangleIcon,
  FileSignatureIcon,
  LockIcon,
  SendIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { usePermission } from '@/components/auth/can';
import { AuditStamp, TimeStamp } from '@/components/data/audit-stamp';
import { Section } from '@/components/data/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { useApi, useAuth } from '@/lib/auth/auth-context';
import { cn } from '@/lib/utils';
import { canonicalJson, isPlainObject } from '../shared/canonical-json';
import { Hash, KeyValues, NeedsApi, useAdminMutation } from '../shared/components';
import { adminKeys } from '../shared/query-keys';
import {
  approve,
  changedKeys,
  nextPolicyVersion,
  POLICY_FIELDS,
  POLICY_SETTING_KEY,
  type PolicyDocument,
  type PolicyField,
  type PolicyValue,
  type PolicyValues,
  parsePolicyDocument,
  planDefaults,
  propose,
  sortByVersion,
  validatePolicy,
} from './policy';

const MIN_NOTE = 10;

function display(field: PolicyField, value: PolicyValue): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (Array.isArray(value)) return value.join(', ');
  if (isPlainObject(value))
    return Object.entries(value)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(' : ');
  const opt = field.options?.find((o) => o.value === value);
  return opt?.label ?? String(value);
}

function FieldControl({
  field,
  value,
  onChange,
  languages,
  lines,
  id,
}: {
  readonly field: PolicyField;
  readonly value: PolicyValue;
  readonly onChange: (v: PolicyValue) => void;
  readonly languages: readonly string[];
  readonly lines: readonly string[];
  readonly id: string;
}) {
  const disabled = Boolean(field.locked);
  switch (field.kind) {
    case 'integer':
      return (
        <Input
          id={id}
          type="number"
          className="w-28"
          disabled={disabled}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'boolean':
      return (
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            disabled={disabled}
            checked={value === true}
            onCheckedChange={(v) => onChange(v === true)}
          />
          <Label htmlFor={id} className="font-normal">
            {value === true ? 'On' : 'Off'}
          </Label>
        </div>
      );
    case 'enum':
      return (
        <Select
          disabled={disabled}
          value={typeof value === 'string' ? value : undefined}
          onValueChange={onChange}
        >
          <SelectTrigger id={id} className="w-full max-w-sm">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'line':
      return (
        <Select
          disabled={disabled}
          value={typeof value === 'string' ? value : undefined}
          onValueChange={onChange}
        >
          <SelectTrigger id={id} className="w-full max-w-sm font-mono text-xs">
            <SelectValue placeholder="Choose a consent or report line…" />
          </SelectTrigger>
          <SelectContent>
            {lines.map((l) => (
              <SelectItem key={l} value={l} className="font-mono text-xs">
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'languages': {
      const list = Array.isArray(value) ? (value as readonly string[]) : [];
      return (
        <fieldset className="flex flex-wrap gap-3" id={id} aria-label={field.label}>
          {languages.map((l) => (
            <div key={l} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                id={`${id}-${l}`}
                checked={list.includes(l)}
                disabled={disabled}
                onCheckedChange={(v) =>
                  onChange(v === true ? [...list, l].sort() : list.filter((x) => x !== l))
                }
              />
              <Label htmlFor={`${id}-${l}`} className="font-mono text-xs font-normal">
                {l}
              </Label>
            </div>
          ))}
        </fieldset>
      );
    }
    case 'ratio': {
      const ratio = isPlainObject(value) ? (value as Readonly<Record<string, number>>) : {};
      return (
        <div className="flex flex-wrap items-center gap-3" id={id}>
          {Object.entries(ratio).map(([arm, n]) => (
            <div key={arm} className="flex items-center gap-1.5 text-sm">
              <Label htmlFor={`${id}-${arm}`} className="font-mono text-xs font-normal">
                {arm}
              </Label>
              <Input
                id={`${id}-${arm}`}
                type="number"
                min={1}
                className="h-8 w-16"
                disabled={disabled}
                value={n}
                onChange={(e) => onChange({ ...ratio, [arm]: Number(e.target.value) })}
              />
            </div>
          ))}
        </div>
      );
    }
  }
}

/**
 * Deployment policy (PRV-01): view the stored policy, propose a new version with the §1.4 keys, and
 * approve a colleague's proposal. Stored as the `deployment_policy` runtime setting (every PUT is
 * audited with the previous and new value). Signing needs an API endpoint that does not exist yet.
 */
export function PolicyPanel({
  catalogueLanguages,
  statementLines,
}: {
  readonly catalogueLanguages: readonly string[];
  readonly statementLines: readonly string[];
}) {
  const api = useApi();
  const { principal } = useAuth();
  const canAudit = usePermission({ all: ['audit.read'] });
  const canGates = usePermission({ all: ['gates.read'] });
  const settings = useQuery({
    queryKey: adminKeys.settings(),
    queryFn: () => unwrap(api.GET('/api/v1/admin/settings')),
  });
  const pack = useQuery({
    queryKey: adminKeys.releasePack(),
    enabled: canGates,
    retry: false,
    queryFn: async () => {
      try {
        const p = await unwrap(api.GET('/api/v1/admin/gates/release-pack/current'));
        return {
          valid: p.revoked_at === null && Date.parse(p.expires_at) > Date.now(),
          version: p.release_pack_version,
        };
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) return { valid: false, version: null };
        throw e;
      }
    },
  });
  const history = useQuery({
    queryKey: adminKeys.audit({ action: 'settings.put', policy: true }),
    enabled: canAudit,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/admin/audit', {
          params: { query: { action: 'settings.put', limit: 500 } },
        }),
      ),
  });

  const row = settings.data?.find((s) => s.key === POLICY_SETTING_KEY) ?? null;
  const current = row ? parsePolicyDocument(row.value) : null;
  const baseValues: PolicyValues = current?.values ?? planDefaults();
  const [draft, setDraft] = useState<Record<string, PolicyValue>>({ ...baseValues });
  const [note, setNote] = useState('');
  const baseKey = canonicalJson(baseValues);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the draft only when the stored values change
  useEffect(() => setDraft({ ...baseValues }), [baseKey]);
  const fieldId = useId();

  const ctx = {
    catalogueLanguages,
    statementLines,
    releasePackValid: canGates ? (pack.data?.valid ?? null) : null,
  };
  const issues = validatePolicy(draft, ctx);
  const changed = changedKeys(baseValues, draft);
  const approvedValues = current?.status === 'approved' ? current.values : null;

  const versions = useMemo(() => {
    const docs = (history.data?.items ?? [])
      .filter((a) => a.resource_id === POLICY_SETTING_KEY && a.outcome === 'success')
      .map((a) => ({
        doc: parsePolicyDocument((a.details as Record<string, unknown>).new),
        audit: a,
      }))
      .filter((x): x is { doc: PolicyDocument; audit: (typeof x)['audit'] } => x.doc !== null);
    const order = sortByVersion(docs.map((d) => d.doc));
    return docs.sort((a, b) => order.indexOf(a.doc) - order.indexOf(b.doc));
  }, [history.data]);

  const approvedBase =
    current && current.status === 'proposed' && current.previous_sha256
      ? (current.last_approved ??
        versions.find(
          (v) => v.doc.status === 'approved' && v.doc.sha256 === current.previous_sha256,
        )?.doc ??
        null)
      : null;

  const save = useAdminMutation({
    mutationFn: (doc: PolicyDocument) =>
      unwrap(
        api.PUT('/api/v1/admin/settings/{key}', {
          params: { path: { key: POLICY_SETTING_KEY } },
          body: {
            value: doc as unknown as Record<string, unknown>,
            description: `Deployment policy ${doc.policy_version} (${doc.status}); PRV-01, plan §1.4`,
          },
        }),
      ),
    invalidate: [adminKeys.settings(), adminKeys.auditAll()],
  });
  const [approveError, setApproveError] = useState<string | null>(null);

  if (settings.isPending) return <LoadingState rows={6} label="Loading policy" />;
  if (settings.isError)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;

  const me = principal?.sub ?? '';
  const valid =
    issues.length === 0 && note.trim().length >= MIN_NOTE && changed.length + (current ? 0 : 1) > 0;

  return (
    <div className="space-y-8">
      <Section
        title="Stored policy"
        description="Latest version in the deployment_policy setting. Kiosks may only run an approved, signed version (deployment policy_version)."
      >
        {current ? (
          <div className="space-y-3 rounded-lg border bg-card p-4" data-testid="policy-current">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold">v{current.policy_version}</span>
              <StatusBadge
                status={current.status === 'approved' ? 'approved' : 'pending'}
                label={current.status === 'approved' ? 'approved' : 'awaiting second approver'}
              />
              <StatusBadge status="unsigned" tone="warning" label="not signed" />
            </div>
            <KeyValues
              items={[
                [
                  'In force',
                  current.status === 'approved' ? (
                    `v${current.policy_version} (this version)`
                  ) : current.last_approved ? (
                    <span key="if" data-testid="policy-in-force">
                      v{current.last_approved.policy_version} stays in force until this proposal is
                      approved
                    </span>
                  ) : (
                    'No approved policy yet: kiosks cannot be deployed'
                  ),
                ],
                ['sha256', <Hash key="h" value={current.sha256} length={16} />],
                [
                  'Proposed',
                  <AuditStamp
                    key="p"
                    actor={current.proposed_by}
                    at={current.proposed_at}
                    verb="Proposed"
                  />,
                ],
                [
                  'Approvals',
                  current.approvals.length === 0
                    ? 'None yet'
                    : current.approvals.map((a) => (
                        <span key={a.by} className="block">
                          <AuditStamp actor={a.by} at={a.at} verb="Approved" />
                        </span>
                      )),
                ],
                [
                  'Changes vs approved',
                  approvedBase
                    ? changedKeys(approvedBase.values, current.values).join(', ') || 'none'
                    : current.previous_sha256
                      ? 'previous approved version not in the audit trail'
                      : 'first version',
                ],
                ['Change note', current.change_note || '—'],
                [
                  'Previous approved',
                  <Hash key="pv" value={current.previous_sha256} length={16} />,
                ],
                [
                  'Signature',
                  current.signature ? (
                    <Hash key="sg" value={current.signature} />
                  ) : (
                    'Unsigned: kiosks must not accept it as a signed policy yet'
                  ),
                ],
              ]}
            />
            {current.status === 'proposed' && (
              <div className="flex flex-wrap items-center gap-3 border-t pt-3">
                {current.proposed_by === me ? (
                  <p className="text-sm text-muted-foreground">
                    You proposed this version. A different person must approve it.
                  </p>
                ) : (
                  <Button
                    disabled={save.isPending}
                    onClick={async () => {
                      setApproveError(null);
                      const res = await approve(current, me, { ctx });
                      if (!res.ok) {
                        setApproveError(
                          res.reason === 'invalid'
                            ? `Cannot approve: ${(res.issues ?? []).map((i) => i.message).join(' ')}`
                            : {
                                not_proposed: 'This version is not awaiting approval.',
                                own_proposal: 'You cannot approve your own proposal.',
                                already_approved: 'You already approved it.',
                                hash_mismatch:
                                  'The stored values do not match their hash; do not approve, propose again.',
                              }[res.reason],
                        );
                        return;
                      }
                      save.mutate(res.doc);
                    }}
                  >
                    <ShieldCheckIcon aria-hidden="true" />
                    Approve v{current.policy_version} as {me}
                  </Button>
                )}
                {approveError && (
                  <p className="flex items-center gap-1 text-sm text-destructive" role="alert">
                    <XCircleIcon className="size-4" aria-hidden="true" />
                    {approveError}
                  </p>
                )}
              </div>
            )}
            <NeedsApi endpoint="policySign" compact />
          </div>
        ) : (
          <EmptyState
            icon={FileSignatureIcon}
            title="No deployment policy stored yet"
            description="The editor below starts from the plan's defaults (§1.4). Propose it as version 1.0.0; a second person approves it."
          />
        )}
      </Section>

      <Section
        title={`Propose version ${nextPolicyVersion(current?.policy_version ?? null)}`}
        description="Two people: you propose, a colleague approves. Locked keys cannot change here. Scientific settings stay in stats/measurement-model YAML."
      >
        {current?.status === 'proposed' && (
          <Alert variant="warning">
            <AlertTriangleIcon aria-hidden="true" />
            <AlertTitle>A proposal is already waiting</AlertTitle>
            <AlertDescription>
              Proposing now replaces v{current.policy_version} before anyone approved it.
            </AlertDescription>
          </Alert>
        )}
        <div className="divide-y rounded-lg border bg-card">
          {POLICY_FIELDS.map((f) => {
            const id = `${fieldId}-${f.key}`;
            const value = draft[f.key] ?? null;
            const isChanged = changed.includes(f.key);
            const differsFromApproved =
              approvedValues &&
              canonicalJson(approvedValues[f.key] ?? null) !== canonicalJson(value);
            const fieldIssues = issues.filter((i) => i.key === f.key);
            return (
              <div
                key={f.key}
                className={cn(
                  'grid gap-2 px-4 py-3 md:grid-cols-[16rem_1fr]',
                  isChanged && 'bg-info/5',
                )}
                data-policy-key={f.key}
              >
                <div className="space-y-0.5">
                  <Label htmlFor={id} className="flex items-center gap-1.5">
                    {f.locked && <LockIcon className="size-3" aria-label="Locked" />}
                    {f.label}
                  </Label>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {f.key} · {f.planRef}
                  </p>
                </div>
                <div className="space-y-1">
                  <FieldControl
                    field={f}
                    id={id}
                    value={value}
                    languages={catalogueLanguages}
                    lines={statementLines}
                    onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                  />
                  <p className="text-xs text-muted-foreground">
                    {f.locked ?? f.description} Plan default:{' '}
                    {f.planDefault === null ? 'none, must be chosen' : display(f, f.planDefault)}.
                    {isChanged && (
                      <span className="ml-1 font-medium text-info">
                        Changed from {display(f, baseValues[f.key] ?? null)}.
                      </span>
                    )}
                    {!isChanged && differsFromApproved && (
                      <span className="ml-1">Differs from the approved version.</span>
                    )}
                  </p>
                  {fieldIssues.map((i) => (
                    <p key={i.message} className="text-xs text-destructive">
                      {i.message}
                    </p>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${fieldId}-note`}>Change note</Label>
          <Textarea
            id={`${fieldId}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why this change, and which approval record (ethics board, PLT-09) covers it"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {changed.length} change{changed.length === 1 ? '' : 's'}
              {issues.length > 0 && ` · ${issues.length} problem${issues.length === 1 ? '' : 's'}`}
              {note.trim().length < MIN_NOTE && ` · note needs at least ${MIN_NOTE} characters`}
            </p>
            <Button
              disabled={!valid || save.isPending}
              onClick={async () => {
                const doc = await propose(draft, { current, actor: me, note: note.trim() });
                save.mutate(doc, { onSuccess: () => setNote('') });
              }}
            >
              <SendIcon aria-hidden="true" />
              Propose
            </Button>
          </div>
        </div>
      </Section>

      <Section
        title="Version history"
        description="From the audit log (each change records the previous and new value)"
      >
        {!canAudit ? (
          <p className="text-sm text-muted-foreground">Requires audit.read.</p>
        ) : history.isPending ? (
          <LoadingState rows={3} />
        ) : versions.length === 0 ? (
          <EmptyState title="No policy changes recorded" />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>sha256</TableHead>
                  <TableHead>Changed keys</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Recorded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map(({ doc, audit }) => {
                  const prev = parsePolicyDocument(
                    (audit.details as Record<string, unknown>).previous,
                  );
                  return (
                    <TableRow key={audit.id}>
                      <TableCell className="font-mono text-xs">{doc.policy_version}</TableCell>
                      <TableCell>
                        <StatusBadge
                          status={doc.status === 'approved' ? 'approved' : 'pending'}
                          label={doc.status}
                        />
                      </TableCell>
                      <TableCell>
                        <Hash value={doc.sha256} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {prev
                          ? changedKeys(prev.values, doc.values).join(', ') || '(approval)'
                          : 'initial'}
                      </TableCell>
                      <TableCell className="max-w-72 truncate text-xs text-muted-foreground">
                        {doc.change_note}
                      </TableCell>
                      <TableCell className="text-xs">
                        {audit.actor_sub} · <TimeStamp value={audit.occurred_at} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </div>
  );
}
