'use client';

import { useQuery } from '@tanstack/react-query';
import { Section } from '@/components/data/page-header';
import { QueryState } from '@/components/data/states';
import { Badge } from '@/components/ui/badge';
import { unwrap } from '@/lib/api/client';
import { useApi } from '@/lib/auth/auth-context';
import { isPlainObject } from '../shared/canonical-json';
import { Hash, KeyValues } from '../shared/components';
import { adminKeys } from '../shared/query-keys';

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function range(v: unknown): string {
  return isPlainObject(v) && typeof v.min === 'number' && typeof v.max === 'number'
    ? `${v.min}–${v.max} s`
    : '—';
}

function Order({ ids }: { readonly ids: readonly string[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1">
      {ids.map((id, i) => (
        <li key={id} className="flex items-center gap-1">
          <Badge variant="outline" className="font-mono font-normal">
            {id}
          </Badge>
          {i < ids.length - 1 && (
            <span className="text-muted-foreground" aria-hidden="true">
              →
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Session plan and time budgets (content/games/session-plan.json via the API). */
export function SessionPlanCard() {
  const api = useApi();
  const plan = useQuery({
    queryKey: adminKeys.sessionPlan(),
    queryFn: () => unwrap(api.GET('/api/v1/games/session-plan')),
  });
  return (
    <Section
      title="Session plan"
      description="Module order and time budgets for each pathway (read-only; changes go through content review)"
    >
      <QueryState query={plan}>
        {(data) => {
          const p = isPlainObject(data.plan) ? data.plan : {};
          const pathways = isPlainObject(p.pathways) ? p.pathways : {};
          const b = isPlainObject(pathways.B) ? pathways.B : {};
          const a = isPlainObject(pathways.A) ? pathways.A : {};
          const slot = isPlainObject(b.slot_randomisation) ? b.slot_randomisation : {};
          return (
            <div className="grid gap-6 rounded-lg border bg-card p-4 lg:grid-cols-2">
              <KeyValues
                items={[
                  ['Plan', `${String(p.plan_id ?? '—')} v${String(p.version ?? '—')}`],
                  [
                    'sha256',
                    <Hash
                      key="h"
                      value={typeof data.sha256 === 'string' ? data.sha256 : null}
                      length={16}
                    />,
                  ],
                  [
                    'Session cap',
                    typeof p.session_cap_s === 'number' ? `${p.session_cap_s} s` : '—',
                  ],
                  ['Scored play (median)', range(p.scored_play_median_s)],
                  ['B module', range(p.b_module_duration_s)],
                  ['A episode (median)', range(p.a_episode_median_s)],
                ]}
              />
              <div className="space-y-3 text-sm">
                <div className="space-y-1">
                  <p className="text-muted-foreground">Pathway B core order</p>
                  <Order ids={strings(b.core_order)} />
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground">
                    Pathway B slot candidates
                    {typeof slot.method === 'string' &&
                      ` (${slot.method.replaceAll('_', ' ')}, block ${String(slot.block_size)}, per ${String(slot.unit)})`}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {strings(b.slot_candidates).map((s) => (
                      <Badge key={s} variant="secondary" className="font-mono font-normal">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground">Pathway A episodes</p>
                  <Order ids={strings(a.order)} />
                </div>
              </div>
            </div>
          );
        }}
      </QueryState>
    </Section>
  );
}
