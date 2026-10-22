'use client';

import { useQuery } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Can } from '@/components/auth/can';
import { DataTable, dataColumnHelper } from '@/components/data/data-table';
import { PageHeader, Section } from '@/components/data/page-header';
import { EmptyState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api/client';
import type { Schema } from '@/lib/api/types';
import { useApi } from '@/lib/auth/auth-context';
import { cn } from '@/lib/utils';
import { StatTile, useAdminMutation } from '../shared/components';
import { adminKeys } from '../shared/query-keys';
import { GameDetail } from './game-detail';
import { SessionPlanCard } from './session-plan-card';

type Game = Schema<'GameOut'>;

const col = dataColumnHelper<Game>();

/** `/admin/games`: game catalogue, versions and approval state, config viewer/editor. */
export function AdminGamesPage({ initialGame }: { readonly initialGame?: string | null }) {
  const api = useApi();
  const games = useQuery({
    queryKey: adminKeys.games(),
    queryFn: () => unwrap(api.GET('/api/v1/games')),
  });
  const [selected, setSelected] = useState<string | null>(initialGame ?? null);
  const sync = useAdminMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/games/sync')),
    invalidate: [adminKeys.games()],
    success: (s: Record<string, number>) =>
      `Synced ${s.games ?? 0} games: ${s.versions_added ?? 0} new draft version(s), ${s.unchanged ?? 0} unchanged`,
  });

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('game_id', {
          header: 'Game',
          cell: (c) => <code className="font-mono text-xs">{c.getValue()}</code>,
          meta: { mono: true },
        }),
        col.accessor('kind', { header: 'Kind' }),
        col.accessor((g) => g.pathways.join(', '), { id: 'pathways', header: 'Pathway' }),
        col.accessor((g) => g.latest_version?.version ?? '', {
          id: 'latest',
          header: 'Latest',
          cell: (c) => {
            const v = c.row.original.latest_version;
            return v ? (
              <span className="flex items-center gap-2">
                <code className="font-mono text-xs">{v.version}</code>
                <StatusBadge status={v.status} />
              </span>
            ) : (
              '—'
            );
          },
        }),
        col.accessor((g) => g.approved_version?.version ?? '', {
          id: 'approved',
          header: 'Approved (kiosks)',
          cell: (c) => {
            const v = c.row.original.approved_version;
            return v ? (
              <code className="font-mono text-xs">{v.version}</code>
            ) : (
              <StatusBadge status="none" tone="warning" label="none approved" />
            );
          },
        }),
        col.accessor((g) => g.constructs.length, {
          id: 'constructs',
          header: 'Constructs',
          cell: (c) => (
            <span className="flex max-w-72 flex-wrap gap-1">
              {c.row.original.constructs.slice(0, 3).map((k) => (
                <Badge key={k} variant="secondary" className="font-normal">
                  {k.replaceAll('_', ' ')}
                </Badge>
              ))}
              {c.row.original.constructs.length > 3 && (
                <span className="text-xs text-muted-foreground">
                  +{c.row.original.constructs.length - 3}
                </span>
              )}
            </span>
          ),
          meta: { exportValue: (r) => (r as Game).constructs.join(' ') },
        }),
        col.accessor((g) => (g.slot ? 'slot' : 'core'), { id: 'slot', header: 'Slot' }),
      ]),
    [],
  );

  const rows = games.data ?? [];
  const pending = rows.filter(
    (g) => g.latest_version && g.latest_version.status !== 'approved',
  ).length;
  const unapproved = rows.filter((g) => !g.approved_version).length;
  const game = rows.find((g) => g.game_id === selected) ?? null;
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selected]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Games"
        description="Game and trial configuration from content/games, with versions and two-person approval. Approved versions are frozen and are the only ones kiosks load."
        actions={
          <Can all={['games.write']}>
            <Button
              variant="outline"
              onClick={() => sync.mutate(undefined)}
              disabled={sync.isPending}
            >
              <RefreshCwIcon className={cn(sync.isPending && 'animate-spin')} aria-hidden="true" />
              Sync from content/games
            </Button>
          </Can>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Games"
          value={games.isPending ? '…' : rows.length}
          hint="Micro-games, episodes and warm-up"
        />
        <StatTile
          label="Awaiting approval"
          value={games.isPending ? '…' : pending}
          hint="Latest version is a draft"
        />
        <StatTile
          label="No approved version"
          value={games.isPending ? '…' : unapproved}
          hint="Kiosks cannot run these yet"
        />
      </div>

      <Section title="Catalogue" description="Select a game to view or edit its configuration">
        <DataTable
          data={games.data}
          columns={columns}
          getRowId={(g) => g.game_id}
          isLoading={games.isPending}
          error={games.error}
          onRetry={() => void games.refetch()}
          searchPlaceholder="Search games…"
          initialSort={{ id: 'game_id', desc: false }}
          exportName="admin-games"
          onRowClick={(g) => setSelected(g.game_id)}
          empty={
            <EmptyState
              title="No games registered"
              description="Sync loads every config in content/games as a draft version."
            />
          }
        />
      </Section>

      {game ? (
        <section
          ref={detailRef}
          className="scroll-mt-20 rounded-xl border bg-card/40 p-5"
          aria-label={`Game ${game.game_id}`}
        >
          <GameDetail key={game.game_id} game={game} />
        </section>
      ) : (
        rows.length > 0 && (
          <EmptyState
            className="py-6"
            title="No game selected"
            description="Pick a row above to see its configuration, versions and approval state."
          />
        )
      )}

      <SessionPlanCard />
    </div>
  );
}
