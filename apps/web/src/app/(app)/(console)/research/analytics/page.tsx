import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Analytics' };

export default function ResearchAnalyticsPage() {
  return (
    <RoutePlaceholder
      href="/research/analytics"
      planned={[
        'Participants, sessions and matched-record counts; completion and abandonment',
        'Breakdowns by language, age band, literacy and education',
        'Trial eligibility and data-quality flag distributions',
        'Feature distributions and outliers; game-version comparisons',
        'Longitudinal trajectories across occasions',
      ]}
      endpoints={[
        'GET /api/v1/features/matrix',
        'GET /api/v1/features',
        'GET /api/v1/sessions',
        'GET /api/v1/validation/matched-records',
      ]}
      features={['VAL-03', 'PLT-07']}
    />
  );
}
