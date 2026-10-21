import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Validation' };

export default function ResearchValidationPage() {
  return (
    <RoutePlaceholder
      href="/research/validation"
      planned={[
        'Trait Validation Workbench: construct selector, criterion r, retest r, reliability vs target, cross-construct bars',
        'Matched participant × occasion snapshots (build, freeze, download Parquet)',
        'Reliability: split-half, ICC, alpha/omega, retest with Bland–Altman',
        'Convergent/discriminant validity: correlation heatmaps, MTMM, forest plots with CIs',
        'Factor structure (EFA/CFA loadings), fairness and invariance by language/age/literacy',
        'Gate matrix from gates.yaml with evidence and sign-off status',
      ]}
      endpoints={[
        'POST /api/v1/validation/datasets',
        'GET /api/v1/validation/datasets',
        'POST /api/v1/validation/runs',
        'GET /api/v1/validation/runs/{run_id}',
        'GET /api/v1/validation/matched-records',
        'GET /api/v1/admin/gates',
      ]}
      features={['VAL-04', 'VAL-05', 'VAL-06', 'VAL-07', 'VAL-12', 'VAL-14']}
      layer="Layer 4 · validated estimates"
    />
  );
}
