'use client';

import { useQuery } from '@tanstack/react-query';
import {
  BanIcon,
  DownloadCloudIcon,
  KeyRoundIcon,
  LockIcon,
  MoreHorizontalIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  RocketIcon,
  Trash2Icon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Can, usePermission } from '@/components/auth/can';
import { TimeStamp } from '@/components/data/audit-stamp';
import { DataTable, dataColumnHelper } from '@/components/data/data-table';
import { PageHeader, Section } from '@/components/data/page-header';
import { EmptyState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { unwrap } from '@/lib/api/client';
import type { Schema } from '@/lib/api/types';
import { useApi } from '@/lib/auth/auth-context';
import { formatInteger, formatNumber } from '@/lib/format';
import { useStudyScope } from '@/lib/study-scope';
import { effectivePolicy, POLICY_SETTING_KEY, parsePolicyDocument } from '../settings/policy';
import { KeyValues, NeedsApi, StatTile, useAdminMutation } from '../shared/components';
import { adminKeys } from '../shared/query-keys';
import {
  activeDeployments,
  contentDrift,
  type Deployment,
  fleetSummary,
  heartbeatView,
  type Kiosk,
} from './heartbeat';
import {
  ConfirmKioskDialog,
  DeployDialog,
  RegisterKioskDialog,
  TokenOnceDialog,
} from './kiosk-dialogs';

type KioskToken = Schema<'KioskToken'>;
type SystemEvent = {
  id: number;
  occurred_at: string;
  kind: string;
  severity: string;
  kiosk_id: string | null;
  details: Record<string, unknown>;
};
type DlqSummary = { reason_code: string; app_version: string | null; count: number };

/** A kiosk joined with its active deployment and content label (computed into the row so the table re-renders when they load). */
type FleetRow = Kiosk & {
  readonly siteMode: string;
  /** Content version the device reports, else the one its deployment assigns. */
  readonly contentLabel: string;
  /** Assigned content version when the device reports a different one (update pending/failed). */
  readonly contentDrift: string | null;
};
const kcol = dataColumnHelper<FleetRow>();
const dcol = dataColumnHelper<Deployment>();
const ecol = dataColumnHelper<SystemEvent>();

const REMOTE_COMMANDS = [
  { id: 'lock', label: 'Lock', icon: LockIcon },
  { id: 'restart', label: 'Restart', icon: PowerIcon },
  { id: 'sync', label: 'Sync now', icon: RefreshCwIcon },
  { id: 'pull_logs', label: 'Pull scrubbed logs', icon: DownloadCloudIcon },
  { id: 'wipe', label: 'Wipe', icon: Trash2Icon },
] as const;

/** `/admin/kiosks`: fleet registration, device tokens, health, deployments and site modes. */
export function AdminKiosksPage() {
  const api = useApi();
  const { studies } = useStudyScope();
  const canSettings = usePermission({ all: ['admin.settings'] });
  const canContent = usePermission({ all: ['admin.content'] });
  const canDlq = usePermission({ all: ['dead_letter.manage'] });

  const kiosks = useQuery({
    queryKey: adminKeys.kiosks(),
    queryFn: () => unwrap(api.GET('/api/v1/admin/kiosks')),
    refetchInterval: 60_000,
  });
  const deployments = useQuery({
    queryKey: adminKeys.deployments(),
    queryFn: () => unwrap(api.GET('/api/v1/admin/deployments')),
  });
  const events = useQuery({
    queryKey: adminKeys.systemEvents(),
    queryFn: async () =>
      (await unwrap(
        api.GET('/api/v1/admin/system-events', { params: { query: { limit: 200 } } }),
      )) as SystemEvent[],
  });
  const contentVersions = useQuery({
    queryKey: adminKeys.contentVersions(),
    enabled: canContent,
    queryFn: () => unwrap(api.GET('/api/v1/admin/content-versions')),
  });
  const settings = useQuery({
    queryKey: adminKeys.settings(),
    enabled: canSettings,
    queryFn: () => unwrap(api.GET('/api/v1/admin/settings')),
  });
  const dlq = useQuery({
    queryKey: adminKeys.deadLetterSummary(),
    enabled: canDlq,
    queryFn: async () =>
      (await unwrap(api.GET('/api/v1/admin/dead-letters/summary'))) as DlqSummary[],
  });

  const active = useMemo(() => activeDeployments(deployments.data ?? []), [deployments.data]);
  const contentById = useMemo(
    () => new Map((contentVersions.data ?? []).map((c) => [c.id, c])),
    [contentVersions.data],
  );
  const fleetRows = useMemo<FleetRow[] | undefined>(
    () =>
      kiosks.data?.map((k) => {
        const d = active.get(k.kiosk_id);
        const cv = d?.content_version_id ? contentById.get(d.content_version_id) : undefined;
        const reported = heartbeatView(k).contentVersion;
        const assigned = cv ? `${cv.kind} ${cv.version}` : (d?.content_version_id ?? '');
        return {
          ...k,
          siteMode: d?.site_mode ?? '',
          contentLabel: reported ?? assigned,
          contentDrift: contentDrift(reported, cv?.version ?? null) ? assigned : null,
        };
      }),
    [kiosks.data, active, contentById],
  );
  const policyVersion = useMemo(() => {
    const row = settings.data?.find((s) => s.key === POLICY_SETTING_KEY);
    // Deploy only the approved policy in force, never a pending proposal.
    return row ? (effectivePolicy(parsePolicyDocument(row.value))?.policy_version ?? null) : null;
  }, [settings.data]);

  const [registerOpen, setRegisterOpen] = useState(false);
  const [token, setToken] = useState<KioskToken | null>(null);
  const [rotateTarget, setRotateTarget] = useState<Kiosk | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Kiosk | null>(null);
  const [deployTarget, setDeployTarget] = useState<Kiosk | null>(null);
  const [detail, setDetail] = useState<Kiosk | null>(null);

  const register = useAdminMutation({
    mutationFn: (body: Schema<'KioskCreate'>) => unwrap(api.POST('/api/v1/admin/kiosks', { body })),
    invalidate: [adminKeys.kiosks()],
  });
  const rotate = useAdminMutation({
    mutationFn: (kioskId: string) =>
      unwrap(
        api.POST('/api/v1/admin/kiosks/{kiosk_id}/rotate-token', {
          params: { path: { kiosk_id: kioskId } },
        }),
      ),
    invalidate: [adminKeys.kiosks()],
  });
  const revoke = useAdminMutation({
    mutationFn: (kioskId: string) =>
      unwrap(
        api.POST('/api/v1/admin/kiosks/{kiosk_id}/revoke', {
          params: { path: { kiosk_id: kioskId } },
        }),
      ),
    invalidate: [adminKeys.kiosks(), adminKeys.systemEvents()],
    success: (k: Kiosk) => `${k.kiosk_id} revoked: its token no longer authenticates`,
  });
  const deploy = useAdminMutation({
    mutationFn: (body: Schema<'DeploymentIn'>) =>
      unwrap(api.POST('/api/v1/admin/deployments', { body })),
    invalidate: [adminKeys.deployments()],
    success: (d: Deployment) =>
      `${d.kiosk_id} deployed to ${d.site_id} (${d.site_mode.replace('_', ' ')})`,
  });

  const summary = fleetSummary(kiosks.data ?? []);

  const kioskColumns = useMemo(
    () =>
      kcol.columns([
        kcol.accessor('kiosk_id', {
          header: 'Kiosk',
          cell: (c) => (
            <div className="min-w-0">
              <code className="font-mono text-xs">{c.getValue()}</code>
              {c.row.original.label && (
                <p className="truncate text-xs text-muted-foreground">{c.row.original.label}</p>
              )}
            </div>
          ),
        }),
        kcol.accessor('site_id', { header: 'Site' }),
        kcol.accessor((k) => k.siteMode, {
          id: 'site_mode',
          header: 'Site mode',
          cell: (c) =>
            c.getValue() ? (
              <Badge variant={c.getValue() === 'open_public' ? 'warning' : 'secondary'}>
                {c.getValue().replace('_', ' ')}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">not deployed</span>
            ),
        }),
        kcol.accessor((k) => (k.status === 'revoked' ? 'revoked' : k.health_status), {
          id: 'health',
          header: 'Health',
          cell: (c) => <StatusBadge status={c.getValue()} />,
        }),
        kcol.accessor('last_heartbeat_at', {
          header: 'Last heartbeat',
          cell: (c) => <TimeStamp value={c.getValue()} />,
          sortFn: 'datetime',
        }),
        kcol.accessor((k) => heartbeatView(k).outboxDepth ?? -1, {
          id: 'backlog',
          header: 'Outbox backlog',
          cell: (c) => (
            <span className="tabular-nums">
              {c.getValue() < 0 ? '—' : formatInteger(c.getValue())}
            </span>
          ),
          meta: { align: 'end', exportValue: (r) => heartbeatView(r as Kiosk).outboxDepth },
        }),
        kcol.accessor((k) => heartbeatView(k).lastSyncAt ?? '', {
          id: 'last_sync',
          header: 'Last sync',
          cell: (c) => <TimeStamp value={c.getValue() || null} />,
        }),
        kcol.accessor('app_version', {
          header: 'App',
          cell: (c) => <code className="font-mono text-xs">{c.getValue() ?? '—'}</code>,
        }),
        kcol.accessor((k) => k.contentLabel, {
          id: 'content',
          header: 'Content',
          cell: (c) =>
            c.getValue() ? (
              <span className="flex flex-col">
                <code className="font-mono text-xs">{c.getValue()}</code>
                {c.row.original.contentDrift && (
                  <span className="text-xs text-warning" data-testid="content-drift">
                    assigned {c.row.original.contentDrift}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">unpinned</span>
            ),
        }),
        kcol.display({
          id: 'actions',
          header: '',
          meta: { noExport: true },
          cell: (c) => {
            const k = c.row.original;
            return (
              <Can all={['admin.kiosks']}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${k.kiosk_id}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenuItem
                      onSelect={() => setDeployTarget(k)}
                      disabled={k.status === 'revoked'}
                    >
                      <RocketIcon /> Deploy to site…
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setRotateTarget(k)}>
                      <KeyRoundIcon />{' '}
                      {k.status === 'revoked' ? 'Reinstate with new token…' : 'Rotate token…'}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setRevokeTarget(k)}
                      disabled={k.status === 'revoked'}
                    >
                      <BanIcon /> Revoke…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </Can>
            );
          },
        }),
      ]),
    [],
  );

  const deploymentColumns = useMemo(
    () =>
      dcol.columns([
        dcol.accessor('kiosk_id', {
          header: 'Kiosk',
          cell: (c) => <code className="font-mono text-xs">{c.getValue()}</code>,
        }),
        dcol.accessor('site_id', { header: 'Site' }),
        dcol.accessor('site_mode', { header: 'Mode', cell: (c) => c.getValue().replace('_', ' ') }),
        dcol.accessor((d) => d.study_id ?? '', { id: 'study', header: 'Study' }),
        dcol.accessor('policy_version', { header: 'Policy' }),
        dcol.accessor('app_version', { header: 'App' }),
        dcol.accessor('ring', { header: 'Ring' }),
        dcol.accessor('status', {
          header: 'Status',
          cell: (c) => <StatusBadge status={c.getValue()} />,
        }),
        dcol.accessor('effective_from', {
          header: 'From',
          cell: (c) => <TimeStamp value={c.getValue()} />,
          sortFn: 'datetime',
        }),
        dcol.accessor('created_by', { header: 'By' }),
      ]),
    [],
  );

  const eventColumns = useMemo(
    () =>
      ecol.columns([
        ecol.accessor('occurred_at', {
          header: 'When',
          cell: (c) => <TimeStamp value={c.getValue()} />,
          sortFn: 'datetime',
        }),
        ecol.accessor('severity', {
          header: 'Severity',
          cell: (c) => (
            <StatusBadge
              status={c.getValue()}
              tone={
                c.getValue() === 'error' ? 'critical' : c.getValue() === 'warn' ? 'warning' : 'info'
              }
            />
          ),
        }),
        ecol.accessor('kind', {
          header: 'Event',
          cell: (c) => <code className="font-mono text-xs">{c.getValue()}</code>,
        }),
        ecol.accessor((e) => e.kiosk_id ?? '', { id: 'kiosk', header: 'Kiosk' }),
        ecol.accessor((e) => JSON.stringify(e.details), {
          id: 'details',
          header: 'Details',
          cell: (c) => (
            <span className="line-clamp-1 max-w-96 font-mono text-xs text-muted-foreground">
              {c.getValue()}
            </span>
          ),
        }),
      ]),
    [],
  );

  const dv = detail ? heartbeatView(detail) : null;
  const detailEvents = (events.data ?? [])
    .filter((e) => e.kiosk_id === detail?.kiosk_id)
    .slice(0, 10);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Kiosks"
        description="Kiosk fleet: registration and device tokens, heartbeat health, outbox backlog, deployments and site mode. Heartbeats carry no participant identifiers."
        actions={
          <Can all={['admin.kiosks']}>
            <Button onClick={() => setRegisterOpen(true)}>
              <PlusIcon aria-hidden="true" />
              Register kiosk
            </Button>
          </Can>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Active kiosks"
          value={kiosks.isPending ? '…' : summary.active}
          hint={`${summary.revoked} revoked`}
        />
        <StatTile
          label="Healthy"
          value={kiosks.isPending ? '…' : summary.healthy}
          hint="Heartbeat within the server's window"
        />
        <StatTile
          label="Stale"
          value={kiosks.isPending ? '…' : summary.stale}
          hint="Missed heartbeats"
        />
        <StatTile label="Never reported" value={kiosks.isPending ? '…' : summary.unknown} />
        <StatTile
          label="Outbox backlog"
          value={
            kiosks.isPending
              ? '…'
              : summary.backlogReporting === 0
                ? '—'
                : formatInteger(summary.backlog)
          }
          hint={
            kiosks.isPending
              ? 'Unsynced events'
              : `Unsynced events, last heartbeat of ${summary.backlogReporting} of ${summary.active} active kiosks`
          }
        />
      </div>

      <Section
        title="Fleet"
        description="Select a kiosk for its heartbeat, deployments and remote commands"
      >
        <DataTable
          data={fleetRows}
          columns={kioskColumns}
          getRowId={(k) => k.kiosk_id}
          isLoading={kiosks.isPending}
          error={kiosks.error}
          onRetry={() => void kiosks.refetch()}
          searchPlaceholder="Search kiosks…"
          initialSort={{ id: 'kiosk_id', desc: false }}
          exportName="kiosk-fleet"
          onRowClick={setDetail}
          empty={
            <EmptyState
              title="No kiosks registered"
              description="Register a kiosk to issue its device token, then deploy it to a site."
            />
          }
        />
      </Section>

      <Section
        title="Deployments"
        description="Site assignments; a new deployment supersedes the kiosk's active one"
      >
        <DataTable
          data={deployments.data}
          columns={deploymentColumns}
          getRowId={(d) => d.id}
          isLoading={deployments.isPending}
          error={deployments.error}
          onRetry={() => void deployments.refetch()}
          initialSort={{ id: 'effective_from', desc: true }}
          initialHidden={['created_by', 'ring']}
          pageSize={8}
          exportName="kiosk-deployments"
          empty={<EmptyState title="No deployments" />}
        />
      </Section>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Section
          title="Upload problems"
          description="Open dead letters by reason and app version (ingestion rejects)"
        >
          {!canDlq ? (
            <p className="text-sm text-muted-foreground">Requires dead_letter.manage.</p>
          ) : dlq.isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (dlq.data ?? []).length === 0 ? (
            <EmptyState
              title="No open dead letters"
              description="Every uploaded event validated and was accepted."
            />
          ) : (
            <ul className="divide-y rounded-lg border bg-card text-sm">
              {(dlq.data ?? []).map((r) => (
                <li
                  key={`${r.reason_code}-${r.app_version ?? ''}`}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span>
                    <code className="font-mono text-xs">{r.reason_code}</code>{' '}
                    <span className="text-xs text-muted-foreground">
                      app {r.app_version ?? 'unknown'}
                    </span>
                  </span>
                  <span className="tabular-nums font-medium">{formatInteger(r.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section
          title="System events"
          description="Operational events (stale heartbeats, revocations, ingestion)"
        >
          <DataTable
            data={events.data}
            columns={eventColumns}
            getRowId={(e) => String(e.id)}
            isLoading={events.isPending}
            error={events.error}
            onRetry={() => void events.refetch()}
            initialSort={{ id: 'occurred_at', desc: true }}
            pageSize={10}
            exportName="system-events"
            empty={<EmptyState title="No system events" />}
          />
        </Section>
      </div>

      <Sheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {detail && dv && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2 font-mono text-base">
                  {detail.kiosk_id}
                  <StatusBadge
                    status={detail.status === 'revoked' ? 'revoked' : detail.health_status}
                  />
                </SheetTitle>
                <SheetDescription>
                  {detail.label ?? 'No label'} · site {detail.site_id} · registered{' '}
                  <TimeStamp value={detail.created_at} />
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-6 px-4 pb-6">
                <KeyValues
                  items={[
                    ['Last heartbeat', <TimeStamp key="h" value={detail.last_heartbeat_at} />],
                    [
                      'Outbox backlog',
                      dv.outboxDepth === null ? '—' : `${formatInteger(dv.outboxDepth)} events`,
                    ],
                    ['Last sync', <TimeStamp key="s" value={dv.lastSyncAt} />],
                    ['App version', detail.app_version ?? '—'],
                    ['Content version', dv.contentVersion ?? '—'],
                    [
                      'Policy version',
                      dv.policyVersion ?? active.get(detail.kiosk_id)?.policy_version ?? '—',
                    ],
                    ['Release pack', dv.releasePackVersion ?? '—'],
                    [
                      'Frame time p99',
                      dv.frameTimeP99Ms === null ? '—' : `${formatNumber(dv.frameTimeP99Ms, 1)} ms`,
                    ],
                    [
                      'Clock offset',
                      dv.clockOffsetMs === null ? '—' : `${formatNumber(dv.clockOffsetMs, 0)} ms`,
                    ],
                    [
                      'Disk free',
                      dv.diskFreeMb === null ? '—' : `${formatInteger(dv.diskFreeMb)} MB`,
                    ],
                    [
                      'Audio underruns',
                      dv.audioUnderruns === null ? '—' : formatInteger(dv.audioUnderruns),
                    ],
                    ['Hardware', detail.hardware_sku ?? '—'],
                    ...dv.extras.map(([k, v]) => [k, v] as const),
                  ]}
                />
                <Section
                  title="Remote commands"
                  description="Applied within 2 minutes when online, or at next boot (KSK-10)"
                >
                  <div className="flex flex-wrap gap-2">
                    {REMOTE_COMMANDS.map((cmd) => (
                      <Button
                        key={cmd.id}
                        variant="outline"
                        size="sm"
                        disabled
                        title="Remote command endpoint not available yet"
                      >
                        <cmd.icon aria-hidden="true" />
                        {cmd.label}
                      </Button>
                    ))}
                  </div>
                  <NeedsApi endpoint="kioskCommands" compact />
                </Section>
                <Section title="Deployments">
                  <ul className="space-y-1 text-sm">
                    {(deployments.data ?? [])
                      .filter((d) => d.kiosk_id === detail.kiosk_id)
                      .map((d) => (
                        <li key={d.id} className="flex flex-wrap items-center gap-2">
                          <StatusBadge status={d.status} />
                          <span>
                            {d.site_id} · {d.site_mode.replace('_', ' ')} · policy{' '}
                            {d.policy_version} · app {d.app_version}
                          </span>
                          <TimeStamp
                            value={d.effective_from}
                            className="text-xs text-muted-foreground"
                          />
                        </li>
                      ))}
                  </ul>
                </Section>
                <Section title="Recent events">
                  {detailEvents.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No events for this kiosk.</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {detailEvents.map((e) => (
                        <li key={e.id} className="flex gap-2">
                          <TimeStamp
                            value={e.occurred_at}
                            className="text-xs text-muted-foreground"
                          />
                          <code className="font-mono text-xs">{e.kind}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <RegisterKioskDialog
        open={registerOpen}
        onOpenChange={(o) => {
          setRegisterOpen(o);
          if (!o) register.reset();
        }}
        existing={(kiosks.data ?? []).map((k) => k.kiosk_id)}
        pending={register.isPending}
        error={register.error}
        onSubmit={(body) =>
          register.mutate(body, {
            onSuccess: (t) => {
              setRegisterOpen(false);
              setToken(t);
            },
          })
        }
      />
      <ConfirmKioskDialog
        kiosk={rotateTarget}
        action={rotateTarget?.status === 'revoked' ? 'Reinstate' : 'Rotate token for'}
        description="Issues a new device token and invalidates the old one immediately. The kiosk stops uploading until the new token is entered on it."
        confirmLabel="Issue new token"
        pending={rotate.isPending}
        error={rotate.error}
        onClose={() => {
          setRotateTarget(null);
          rotate.reset();
        }}
        onConfirm={() =>
          rotateTarget &&
          rotate.mutate(rotateTarget.kiosk_id, {
            onSuccess: (t) => {
              setRotateTarget(null);
              setToken(t);
            },
          })
        }
      />
      <ConfirmKioskDialog
        kiosk={revokeTarget}
        action="Revoke"
        description="Use for a stolen or decommissioned kiosk. Its token stops authenticating at once; queued events on the device are not accepted until it is reinstated."
        confirmLabel="Revoke kiosk"
        destructive
        pending={revoke.isPending}
        error={revoke.error}
        onClose={() => {
          setRevokeTarget(null);
          revoke.reset();
        }}
        onConfirm={() =>
          revokeTarget &&
          revoke.mutate(revokeTarget.kiosk_id, { onSuccess: () => setRevokeTarget(null) })
        }
      />
      <DeployDialog
        kiosk={deployTarget}
        current={deployTarget ? (active.get(deployTarget.kiosk_id) ?? null) : null}
        options={{ studies, contentVersions: contentVersions.data ?? [], policyVersion }}
        pending={deploy.isPending}
        error={deploy.error}
        onClose={() => {
          setDeployTarget(null);
          deploy.reset();
        }}
        onSubmit={(body) => deploy.mutate(body, { onSuccess: () => setDeployTarget(null) })}
      />
      <TokenOnceDialog token={token} onClose={() => setToken(null)} />
    </div>
  );
}
