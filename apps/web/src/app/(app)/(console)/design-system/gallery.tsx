'use client';

import { InboxIcon, PlusIcon } from 'lucide-react';
import { useMemo } from 'react';
import { Can } from '@/components/auth/can';
import {
  BarCiChart,
  BlandAltmanPlot,
  DistributionChart,
  ForestPlot,
  HeatmapChart,
  LoadingPlot,
  ScatterRegressionChart,
} from '@/components/charts';
import { AuditStamp, CopyId } from '@/components/data/audit-stamp';
import { DataTable, dataColumnHelper } from '@/components/data/data-table';
import { PageHeader, Section } from '@/components/data/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/data/states';
import { StatusBadge } from '@/components/data/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api/errors';
import { formatCoefficient } from '@/lib/format';
import { correlationCI } from '@/lib/stats/regression';
import { correlatedPairs, normalSampler, seededRandom } from '@/lib/synthetic';

interface DemoRow {
  readonly id: string;
  readonly code: string;
  readonly language: string;
  readonly status: string;
  readonly sessions: number;
  readonly createdBy: string;
  readonly createdAt: string;
}

const helper = dataColumnHelper<DemoRow>();
const demoColumns = helper.columns([
  helper.accessor('code', { header: 'Code', meta: { mono: true } }),
  helper.accessor('id', {
    header: 'Record',
    cell: (info) => <CopyId id={info.getValue()} />,
    meta: { label: 'Record id' },
  }),
  helper.accessor('language', { header: 'Language' }),
  helper.accessor('status', {
    header: 'Status',
    cell: (info) => <StatusBadge status={info.getValue()} />,
  }),
  helper.accessor('sessions', {
    header: 'Sessions',
    meta: { align: 'end', exportType: 'integer' },
  }),
  helper.accessor('createdAt', {
    header: 'Created',
    sortFn: 'datetime',
    cell: (info) => <AuditStamp actor={info.row.original.createdBy} at={info.getValue()} compact />,
    meta: { exportType: 'timestamp', exportValue: (row) => new Date((row as DemoRow).createdAt) },
  }),
]);

const SWATCHES = [
  ['--primary', 'Primary'],
  ['--secondary', 'Secondary'],
  ['--muted', 'Muted'],
  ['--accent', 'Accent'],
  ['--destructive', 'Destructive'],
  ['--border', 'Border'],
  ['--series-1', 'Series 1'],
  ['--series-2', 'Series 2'],
  ['--series-3', 'Series 3'],
  ['--series-4', 'Series 4'],
  ['--series-5', 'Series 5'],
  ['--series-6', 'Series 6'],
  ['--series-7', 'Series 7'],
  ['--series-8', 'Series 8'],
  ['--status-good', 'Good'],
  ['--status-warning', 'Warning'],
  ['--status-serious', 'Serious'],
  ['--status-critical', 'Critical'],
] as const;

const CONSTRUCTS = [
  'Self-control',
  'Emotional reg.',
  'Composure',
  'Decisiveness',
  'Adaptability',
  'Problem solving',
];
const CRITERIA = ['BSCS', 'ERQ reappraisal', 'DERS-16', 'GDMS rational', 'CFI', 'Tower of London'];

export function Gallery() {
  const demo = useMemo(() => {
    const rnd = seededRandom(20261021);
    const z = normalSampler(seededRandom(7));
    const languages = ['hi-IN', 'mr-IN', 'ta-IN', 'en-IN'];
    const statuses = ['active', 'draft', 'frozen', 'recruiting', 'closed'];
    const rows: DemoRow[] = Array.from({ length: 64 }, (_, i) => ({
      id: `0190a7c2-${(1000 + i).toString(16)}-7abc-8def-${(0xabcdef + i * 7919).toString(16).padStart(12, '0')}`,
      code: `SYN-${String(i + 1).padStart(3, '0')}`,
      language: languages[i % 4] as string,
      status: statuses[Math.floor(rnd() * statuses.length)] as string,
      sessions: Math.floor(rnd() * 400),
      createdBy: i % 3 === 0 ? 'dev-researcher' : 'dev-admin',
      createdAt: new Date(
        Date.UTC(2026, 9, 21) - Math.floor(rnd() * 60) * 86_400_000,
      ).toISOString(),
    }));

    const matrix = CONSTRUCTS.map((_, r) =>
      CRITERIA.map((_, c) => (r === c ? 0.28 + 0.12 * rnd() : (rnd() - 0.5) * 0.24)),
    );
    const scatter = correlatedPairs(180, 0.32, 11).map((p, i) => ({
      x: 50 + 10 * p.x,
      y: 3 + 0.6 * p.y,
      id: `P${i + 1}`,
      group: languages[i % 3] as string,
    }));
    const forestRows = languages
      .map((lang, i) => {
        const r = 0.22 + 0.05 * i - 0.04 * (i % 2);
        const n = 120 + 40 * i;
        const ci = correlationCI(r, n) ?? [r - 0.1, r + 0.1];
        return {
          label: `Self-control × BSCS`,
          group: lang,
          estimate: r,
          lower: ci[0],
          upper: ci[1],
          n,
        };
      })
      .map((row) => ({ ...row, label: row.group }));
    const bars = {
      categories: CONSTRUCTS,
      series: [
        {
          name: 'Criterion r',
          values: CONSTRUCTS.map((_, i) => {
            const v = 0.18 + 0.05 * (i % 3);
            return { value: v, lower: v - 0.09, upper: v + 0.09, n: 300 };
          }),
        },
        {
          name: 'Retest r',
          values: CONSTRUCTS.map((_, i) => {
            const v = 0.55 + 0.06 * ((i + 1) % 3);
            return { value: v, lower: v - 0.08, upper: v + 0.07, n: 100 };
          }),
        },
      ],
    };
    const distribution = Array.from(
      { length: 400 },
      () => 420 + 85 * z() + (rnd() < 0.1 ? 180 : 0),
    );
    const items = Array.from({ length: 9 }, (_, i) => `item_${i + 1}`);
    const loadings = items.map((_, i) =>
      [0, 1, 2].map((f) => (Math.floor(i / 3) === f ? 0.55 + 0.25 * rnd() : (rnd() - 0.5) * 0.3)),
    );
    if (loadings[4]) loadings[4][0] = 0.41; // one cross-loading item to show the flag
    const retest = correlatedPairs(100, 0.7, 23).map((p, i) => ({
      id: `P${i + 1}`,
      first: 0.3 + 0.08 * p.x,
      second: 0.31 + 0.08 * p.y,
    }));
    return { rows, matrix, scatter, forestRows, bars, distribution, items, loadings, retest };
  }, []);

  const heatmapData = useMemo(
    () => ({ rows: CONSTRUCTS, columns: CRITERIA, values: demo.matrix }),
    [demo.matrix],
  );
  const scatterData = useMemo(
    () => ({ points: demo.scatter, xLabel: 'Inhibition accuracy (%)', yLabel: 'BSCS total' }),
    [demo.scatter],
  );
  const forestData = useMemo(
    () => ({
      rows: demo.forestRows,
      xLabel: 'Pearson r',
      nullValue: 0,
      domain: [-0.2, 0.6] as const,
    }),
    [demo.forestRows],
  );
  const barData = useMemo(
    () => ({ ...demo.bars, valueLabel: 'r', domain: [0, 1] as const }),
    [demo.bars],
  );
  const distributionData = useMemo(
    () => ({ values: demo.distribution, xLabel: 'Go-trial RT (ms)' }),
    [demo.distribution],
  );
  const loadingData = useMemo(
    () => ({
      items: demo.items,
      factors: ['F1', 'F2', 'F3'],
      loadings: demo.loadings,
      salience: 0.4,
    }),
    [demo.items, demo.loadings],
  );
  const blandData = useMemo(
    () => ({ pairs: demo.retest, measure: 'Commission error rate' }),
    [demo.retest],
  );
  const synthetic = {
    n: 0,
    source: 'Synthetic generator (lib/synthetic.ts)',
    note: 'Illustrative values; not study data.',
  };

  return (
    <div className="space-y-10">
      <PageHeader
        title="Design system"
        description="Shared building blocks for the research and admin consoles. All figures on this page use generated data."
        meta={<Badge variant="warning">Synthetic data only</Badge>}
      />

      <Section
        title="Colour tokens"
        description="Categorical slots are used in fixed order; status colours never stand in for a series."
      >
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-9">
          {SWATCHES.map(([v, label]) => (
            <div key={v} className="space-y-1">
              <div className="h-10 rounded-md border" style={{ background: `var(${v})` }} />
              <div className="text-xs">{label}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Controls and status">
        <div className="flex flex-wrap items-center gap-2">
          <Button>
            <PlusIcon /> Primary
          </Button>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Can
            all={['admin.settings']}
            fallback={<Badge variant="outline">Hidden without admin.settings</Badge>}
          >
            <Badge>Visible with admin.settings</Badge>
          </Can>
        </div>
        <div className="flex flex-wrap gap-2">
          {['approved', 'running', 'provisional', 'withheld', 'failed', 'frozen', 'draft'].map(
            (s) => (
              <StatusBadge key={s} status={s} />
            ),
          )}
        </div>
        <Alert variant="info">
          <InboxIcon />
          <AlertTitle>Audit-friendly records</AlertTitle>
          <AlertDescription>
            <AuditStamp
              actor="dev-researcher"
              at={new Date(Date.now() - 3 * 3600_000).toISOString()}
            />
          </AlertDescription>
        </Alert>
      </Section>

      <Section
        title="Data table"
        description="Sort, search, column visibility, density, pagination and governed CSV/Parquet export."
      >
        <DataTable
          data={demo.rows}
          columns={demoColumns}
          getRowId={(r) => r.id}
          exportName="synthetic-demo-records"
          initialSort={{ id: 'createdAt', desc: true }}
          pageSize={10}
          caption="Synthetic demo records"
        />
      </Section>

      <Section title="States">
        <Tabs defaultValue="empty">
          <TabsList>
            <TabsTrigger value="empty">Empty</TabsTrigger>
            <TabsTrigger value="loading">Loading</TabsTrigger>
            <TabsTrigger value="error">Error</TabsTrigger>
          </TabsList>
          <TabsContent value="empty">
            <EmptyState
              title="No snapshots yet"
              description="Build a matched snapshot to start a validation run."
            />
          </TabsContent>
          <TabsContent value="loading">
            <LoadingState rows={3} />
          </TabsContent>
          <TabsContent value="error">
            <ErrorState
              error={
                new ApiError({
                  status: 503,
                  message: 'The API is unavailable.',
                  requestId: '9f1c2e',
                })
              }
              onRetry={() => undefined}
            />
          </TabsContent>
        </Tabs>
      </Section>

      <Section
        title="Charts"
        description="Every figure offers a table view and CSV of the plotted values, plus N and provenance."
      >
        <div className="grid gap-4 xl:grid-cols-2">
          <HeatmapChart
            title="Indicator × criterion correlations"
            description="Diverging scale centred on zero."
            data={heatmapData}
            synthetic
            provenance={{ ...synthetic, n: 300 }}
          />
          <ScatterRegressionChart
            title="Inhibition accuracy vs BSCS"
            description={`OLS fit with 95% CI band for the mean.`}
            data={scatterData}
            synthetic
            provenance={{ ...synthetic, n: demo.scatter.length }}
          />
          <ForestPlot
            title="Criterion correlation by language"
            description="Point estimate with 95% CI (Fisher z); marker size ∝ √n."
            data={forestData}
            synthetic
            provenance={{ ...synthetic, n: demo.forestRows.reduce((s, r) => s + r.n, 0) }}
          />
          <BarCiChart
            title="Cross-construct comparison"
            description="Criterion r and retest r with 95% CIs."
            data={barData}
            synthetic
            provenance={{ ...synthetic, n: 300 }}
          />
          <DistributionChart
            title="Go-trial reaction times"
            description="Histogram with kernel density on the count scale."
            data={distributionData}
            synthetic
            provenance={{ ...synthetic, n: demo.distribution.length, exclusions: 0 }}
          />
          <LoadingPlot
            title="EFA loadings (3 factors)"
            description={`Salient loadings |λ| ≥ ${formatCoefficient(0.4)} emphasised; ⚑ marks cross-loading items.`}
            data={loadingData}
            synthetic
            provenance={{ ...synthetic, n: 300 }}
          />
          <BlandAltmanPlot
            title="Test–retest agreement"
            description="Bias and 95% limits of agreement, each with its CI."
            data={blandData}
            synthetic
            provenance={{ ...synthetic, n: demo.retest.length }}
          />
        </div>
      </Section>
    </div>
  );
}
