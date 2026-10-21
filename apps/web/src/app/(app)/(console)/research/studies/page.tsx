import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Studies' };

export default function ResearchStudiesPage() {
  return (
    <RoutePlaceholder
      href="/research/studies"
      planned={[
        'Study creation, protocol versioning and status/milestones',
        'Cohorts, stratified recruitment targets (quota cells with fill), arms and allocation ratios',
        'Measurement occasions, retest scheduling (2–4 week windows) and out-of-window flags',
        'Enrollment with eligibility, block randomisation and criterion-block assignment',
        'Protocol deviations, observation forms, analysis-plan registration (hypotheses/gates hashes)',
        'Dataset freeze and lock; cross-study comparison',
      ]}
      endpoints={[
        'GET /api/v1/studies',
        'POST /api/v1/studies',
        'GET /api/v1/studies/{study_id}',
        'POST /api/v1/studies/{study_id}/cohorts',
        'GET /api/v1/studies/{study_id}/quotas',
        'POST /api/v1/studies/{study_id}/enrollments',
        'POST /api/v1/studies/{study_id}/retests',
        'POST /api/v1/studies/{study_id}/deviations',
        'POST /api/v1/studies/{study_id}/analysis-plans',
        'POST /api/v1/studies/{study_id}/freeze',
      ]}
      features={['CRT-01', 'CRT-07', 'CRT-10', 'CRT-11']}
    />
  );
}
