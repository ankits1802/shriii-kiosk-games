import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Traits' };

export default function ResearchTraitsPage() {
  return (
    <RoutePlaceholder
      href="/research/traits"
      planned={[
        'The 15-construct trait registry with stable construct ids, definitions and approval status',
        'Primary/secondary indicators and the ECD chain (construct → evidence → task)',
        'Feature-extraction algorithm metadata, scoring direction and minimum valid trials',
        'Expected criterion relationships (from hypotheses.yaml) and version history',
        'Repeated-measure properties (consistency, persistence, stability) shown as such, not as independent dimensions',
      ]}
      endpoints={[
        'GET /api/v1/features/constructs',
        'GET /api/v1/features/definitions',
        'GET /api/v1/features/feature-definitions',
      ]}
      features={['SCR-01', 'SCR-02', 'SCR-10']}
      layer="Layer 2 · indicators"
      studyScoped={false}
    />
  );
}
