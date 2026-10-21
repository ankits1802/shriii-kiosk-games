import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Reports' };

export default function ResearchReportsPage() {
  return (
    <RoutePlaceholder
      href="/research/reports"
      planned={[
        'Scientific reports and exportable tables/figures (CSV, Parquet) with provenance',
        'Participant report templates (versioned) and the approval/withdrawal workflow',
        'Generated reports with gate evaluation (player reports only when every gate passes)',
        'Strengths-framed phrase allowlist and norm-table approvals (two people)',
      ]}
      endpoints={[
        'GET /api/v1/reports',
        'GET /api/v1/reports/templates',
        'POST /api/v1/reports/templates',
        'POST /api/v1/reports/{report_id}/withdraw',
        'GET /api/v1/norms/interpretations',
      ]}
      features={['REP-01', 'REP-02', 'VAL-15', 'VAL-17']}
      layer="Layer 5 · interpretations (release-gated)"
    />
  );
}
