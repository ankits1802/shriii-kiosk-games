import { CheckIcon, MinusIcon } from 'lucide-react';
import { Section } from '@/components/data/page-header';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatInteger } from '@/lib/format';
import { isPlainObject } from '../shared/canonical-json';
import { KeyValues } from '../shared/components';

function ms(value: unknown): string {
  return typeof value === 'number' ? `${formatInteger(value)} ms` : '—';
}

function seconds(value: unknown): string {
  return typeof value === 'number' ? `${(value / 1000).toFixed(1)} s` : '—';
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function Flag({ on, label }: { readonly on: boolean; readonly label: string }) {
  return on ? (
    <CheckIcon className="size-3.5" aria-label={`${label}: yes`} />
  ) : (
    <MinusIcon className="size-3.5 text-muted-foreground" aria-label={`${label}: no`} />
  );
}

/** Structured read-only view of a game config: budget, levels, blocks (trial configuration), counts. */
export function ConfigOverview({ config }: { readonly config: Record<string, unknown> }) {
  const budget = isPlainObject(config.budget) ? config.budget : {};
  const levels = isPlainObject(config.levels) ? config.levels : {};
  const blocks = Array.isArray(config.blocks) ? config.blocks.filter(isPlainObject) : [];
  const minCounts = isPlainObject(config.min_counts) ? config.min_counts : {};
  const planned = isPlainObject(config.planned_counts) ? config.planned_counts : {};
  const levelIds = ['L1', 'L2', 'L3'].filter((l) => isPlainObject(levels[l]));
  const timingKeys = [
    ...new Set(
      levelIds.flatMap((l) => {
        const lv = levels[l];
        return isPlainObject(lv) && isPlainObject(lv.timing) ? Object.keys(lv.timing) : [];
      }),
    ),
  ];
  const countKeys = [...new Set([...Object.keys(minCounts), ...Object.keys(planned)])];

  return (
    <div className="space-y-8">
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Identity">
          <KeyValues
            items={[
              [
                'Config id',
                <code key="c" className="font-mono text-xs">
                  {String(config.config_id ?? '—')}
                </code>,
              ],
              ['Kind', String(config.kind ?? '—')],
              ['Pathways', list(config.pathways).join(', ') || '—'],
              ['Paradigms', list(config.paradigms).join(', ') || '—'],
              [
                'Constructs',
                <span key="k" className="flex flex-wrap gap-1">
                  {list(config.constructs).map((c) => (
                    <Badge key={c} variant="secondary">
                      {c.replaceAll('_', ' ')}
                    </Badge>
                  ))}
                </span>,
              ],
              ['Indicators', `${list(config.indicators).length} (from the scoring dictionary)`],
              ['Slot module', config.slot === true ? 'Yes' : 'No'],
              ['Scorable', config.scorable === true ? 'Yes' : 'No'],
              ['Forms', list(config.forms).join(', ') || '—'],
            ]}
          />
        </Section>
        <Section
          title="Time budget"
          description="Per module; the session plan caps the whole visit"
        >
          <KeyValues
            items={[
              ['Intro', ms(budget.intro_ms)],
              ['Outro', ms(budget.outro_ms)],
              ['L2 target', seconds(budget.target_ms_l2)],
              ['Soft cap', seconds(budget.soft_cap_ms)],
              ['Hard cap', seconds(budget.hard_cap_ms)],
            ]}
          />
        </Section>
      </div>

      <Section
        title="Calibration levels"
        description="Timing parameters and duration estimates per level (pilot runs at fixed L2)"
      >
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Parameter</TableHead>
                {levelIds.map((l) => (
                  <TableHead key={l} className="text-right">
                    {l}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {timingKeys.map((k) => (
                <TableRow key={k}>
                  <TableCell className="font-mono text-xs">{k}</TableCell>
                  {levelIds.map((l) => {
                    const lv = levels[l];
                    const v =
                      isPlainObject(lv) && isPlainObject(lv.timing) ? lv.timing[k] : undefined;
                    return (
                      <TableCell key={l} className="text-right tabular-nums">
                        {typeof v === 'number' ? formatInteger(v) : '—'}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {(['median', 'slow'] as const).map((k) => (
                <TableRow key={k}>
                  <TableCell className="text-xs">Estimated duration ({k} player)</TableCell>
                  {levelIds.map((l) => {
                    const lv = levels[l];
                    const est =
                      isPlainObject(lv) && isPlainObject(lv.estimated_duration_ms)
                        ? lv.estimated_duration_ms[k]
                        : undefined;
                    return (
                      <TableCell key={l} className="text-right tabular-nums">
                        {seconds(est)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      <Section
        title="Blocks and trials"
        description="Trial configuration in schedule order; minimums come from the scoring dictionary"
      >
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Block</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead className="text-right">Trials</TableHead>
                <TableHead className="text-right">Minimum</TableHead>
                <TableHead className="text-right">Trial budget</TableHead>
                <TableHead>Scored</TableHead>
                <TableHead>Conditions</TableHead>
                <TableHead>Beats</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {blocks.map((b, i) => {
                const conds = isPlainObject(b.conditions) ? b.conditions : {};
                return (
                  <TableRow key={String(b.block_id ?? i)}>
                    <TableCell className="font-mono text-xs">{String(b.block_id)}</TableCell>
                    <TableCell>{String(b.phase ?? '—')}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {String(b.condition_id ?? '—')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {String(b.trials ?? '—')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {String(b.min_trials ?? '—')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {b.budget_trial_ms == null ? '—' : ms(b.budget_trial_ms)}
                    </TableCell>
                    <TableCell>
                      <Flag on={b.scorable === true} label="Scored" />
                    </TableCell>
                    <TableCell className="text-xs">
                      {Object.entries(conds)
                        .filter(([, v]) => v === true)
                        .map(([k]) => k.replaceAll('_', ' '))
                        .join(', ') || '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {list(b.beats).join(', ') || '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </Section>

      {countKeys.length > 0 && (
        <Section
          title="Scheduled counts"
          description="Minimum the scheduler guarantees at every level vs planned at L2"
        >
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Count</TableHead>
                  <TableHead className="text-right">Minimum</TableHead>
                  <TableHead className="text-right">Planned (L2)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {countKeys.map((k) => (
                  <TableRow key={k}>
                    <TableCell className="font-mono text-xs">{k}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {String(minCounts[k] ?? '—')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {String(planned[k] ?? '—')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}
    </div>
  );
}
