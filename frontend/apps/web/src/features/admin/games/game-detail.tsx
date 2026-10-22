'use client';

import { useQuery } from '@tanstack/react-query';
import { LockIcon, ShieldCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { Can } from '@/components/auth/can';
import { AuditStamp, TimeStamp } from '@/components/data/audit-stamp';
import { Section } from '@/components/data/page-header';
import { ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Button } from '@/components/ui/button';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { unwrap } from '@/lib/api/client';
import type { Schema } from '@/lib/api/types';
import { useApi } from '@/lib/auth/auth-context';
import { jsonDiff } from '../shared/canonical-json';
import { ApprovalDialog, Hash, KeyValues, useAdminMutation } from '../shared/components';
import { adminKeys } from '../shared/query-keys';
import { ConfigEditor } from './config-editor';
import { ConfigOverview } from './config-overview';
import { DiffList } from './diff-list';

type Game = Schema<'GameOut'>;
type Version = Schema<'GameVersionOut'>;

/**
 * One game: versions, structured config, editor, diff against the approved version, approval.
 * Render with `key={game.game_id}` so the version selection resets when the game changes.
 */
export function GameDetail({ game }: { readonly game: Game }) {
  const api = useApi();
  const versions = useQuery({
    queryKey: adminKeys.gameVersions(game.game_id),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/games/{game_id}/versions', {
          params: { path: { game_id: game.game_id } },
        }),
      ),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const list = versions.data ?? [];
  const current = selected ?? game.latest_version?.version ?? list.at(-1)?.version ?? null;

  const detail = useQuery({
    queryKey: adminKeys.gameVersion(game.game_id, current ?? ''),
    enabled: current !== null,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/games/{game_id}/versions/{version}', {
          params: { path: { game_id: game.game_id, version: current ?? '' } },
        }),
      ),
  });
  const approvedVersion = game.approved_version?.version ?? null;
  const approved = useQuery({
    queryKey: adminKeys.gameVersion(game.game_id, approvedVersion ?? ''),
    enabled: approvedVersion !== null && approvedVersion !== current,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/games/{game_id}/versions/{version}', {
          params: { path: { game_id: game.game_id, version: approvedVersion ?? '' } },
        }),
      ),
  });

  const [approveOpen, setApproveOpen] = useState(false);
  const approve = useAdminMutation({
    mutationFn: ({ version, approvers }: { version: string; approvers: string[] }) =>
      unwrap(
        api.POST('/api/v1/games/{game_id}/versions/{version}/approve', {
          params: { path: { game_id: game.game_id, version } },
          body: { approvers },
        }),
      ),
    invalidate: [adminKeys.games()],
    success: (v: Version) => `${v.game_id}@${v.version} approved`,
  });

  if (versions.isPending) return <LoadingState rows={4} label="Loading versions" />;
  if (versions.isError)
    return <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />;

  const d = detail.data;
  const isApproved = d?.status === 'approved';
  const baseForDiff = approvedVersion === current ? null : (approved.data?.config ?? null);

  return (
    <div className="space-y-5" data-testid="game-detail">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <code className="font-mono">{game.game_id}</code>
            {d && <StatusBadge status={d.status} />}
            {isApproved && (
              <LockIcon className="size-4 text-muted-foreground" aria-label="Frozen" />
            )}
          </h2>
          <p className="text-xs text-muted-foreground">
            {game.kind} · pathway {game.pathways.join(', ')} · {list.length} version
            {list.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="game-version" className="text-xs">
              Version
            </Label>
            <Select value={current ?? undefined} onValueChange={setSelected}>
              <SelectTrigger id="game-version" className="w-44">
                <SelectValue placeholder="Version" />
              </SelectTrigger>
              <SelectContent>
                {[...list].reverse().map((v) => (
                  <SelectItem key={v.id} value={v.version}>
                    {v.version} · {v.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {d && !isApproved && (
            <Can all={['games.write']}>
              <Button onClick={() => setApproveOpen(true)}>
                <ShieldCheckIcon aria-hidden="true" />
                Approve version
              </Button>
            </Can>
          )}
        </div>
      </div>

      {detail.isPending ? (
        <LoadingState rows={6} label="Loading configuration" />
      ) : detail.isError || !d ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Configuration</TabsTrigger>
            <TabsTrigger value="editor">{isApproved ? 'JSON' : 'Edit draft'}</TabsTrigger>
            <TabsTrigger value="diff">Changes vs approved</TabsTrigger>
            <TabsTrigger value="trials">Trial definitions</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6 pt-2">
            <KeyValues
              className="rounded-lg border bg-card p-4"
              items={[
                ['Status', <StatusBadge key="s" status={d.status} />],
                ['Content sha256', <Hash key="h" value={d.sha256} length={16} />],
                [
                  'Source',
                  d.source_path ? (
                    <code key="src" className="font-mono text-xs">
                      {d.source_path}
                    </code>
                  ) : (
                    '—'
                  ),
                ],
                [
                  'Approval',
                  d.approved_at ? (
                    <span key="a">
                      {d.approved_by.join(' and ')} · <TimeStamp value={d.approved_at} />
                    </span>
                  ) : (
                    'Not approved: kiosks will not load this version'
                  ),
                ],
              ]}
            />
            <ConfigOverview config={d.config} />
          </TabsContent>

          <TabsContent value="editor" className="pt-2">
            <ConfigEditor base={d.config} sourcePath={d.source_path} readOnly={isApproved} />
          </TabsContent>

          <TabsContent value="diff" className="pt-2">
            {approvedVersion === null ? (
              <p className="text-sm text-muted-foreground">
                No approved version yet: everything in this version is new.
              </p>
            ) : approvedVersion === current ? (
              <p className="text-sm text-muted-foreground">This is the approved version.</p>
            ) : approved.isPending ? (
              <LoadingState rows={3} />
            ) : baseForDiff ? (
              <Section title={`${current} vs approved ${approvedVersion}`}>
                <DiffList diff={jsonDiff(baseForDiff, d.config)} />
              </Section>
            ) : (
              <ErrorState error={approved.error} />
            )}
          </TabsContent>

          <TabsContent value="trials" className="pt-2">
            {(d.trial_definitions ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No server-side trial definitions for this version (micro-games schedule trials from
                blocks at run time).
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right">#</TableHead>
                      <TableHead>Block</TableHead>
                      <TableHead>Phase</TableHead>
                      <TableHead>Condition</TableHead>
                      <TableHead className="text-right">Planned</TableHead>
                      <TableHead className="text-right">Minimum</TableHead>
                      <TableHead>Scored</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(d.trial_definitions ?? []).map((t) => (
                      <TableRow key={`${String(t.sequence)}-${String(t.block_id)}`}>
                        <TableCell className="text-right tabular-nums">
                          {String(t.sequence)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{String(t.block_id)}</TableCell>
                        <TableCell>{String(t.phase)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {String(t.condition_id)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {String(t.planned_trials)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {String(t.min_trials)}
                        </TableCell>
                        <TableCell>{t.scorable ? 'Yes' : 'No'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="versions" className="pt-2">
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Config id</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>sha256</TableHead>
                    <TableHead>Approval</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...list].reverse().map((v) => (
                    <TableRow
                      key={v.id}
                      className="cursor-pointer"
                      onClick={() => setSelected(v.version)}
                    >
                      <TableCell className="font-mono text-xs">{v.version}</TableCell>
                      <TableCell className="font-mono text-xs">{v.config_id}</TableCell>
                      <TableCell>
                        <StatusBadge status={v.status} />
                      </TableCell>
                      <TableCell>
                        <Hash value={v.sha256} />
                      </TableCell>
                      <TableCell>
                        {v.approved_at ? (
                          <AuditStamp
                            actor={v.approved_by.join(' and ')}
                            at={v.approved_at}
                            verb="Approved"
                          />
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      )}

      {d && (
        <ApprovalDialog
          open={approveOpen}
          onOpenChange={(o) => {
            setApproveOpen(o);
            if (!o) approve.reset();
          }}
          title="Approve game version"
          description="Approved versions are frozen and become loadable by kiosks (bundle check). Two different people must sign; both names are recorded in the audit log."
          subject={`${game.game_id}@${d.version} · sha256 ${d.sha256.slice(0, 16)}`}
          pending={approve.isPending}
          error={approve.error}
          onApprove={(approvers) =>
            approve.mutate(
              { version: d.version, approvers },
              { onSuccess: () => setApproveOpen(false) },
            )
          }
        />
      )}
    </div>
  );
}
