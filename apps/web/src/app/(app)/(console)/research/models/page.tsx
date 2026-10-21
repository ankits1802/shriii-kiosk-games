import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Models' };

export default function ResearchModelsPage() {
  return (
    <RoutePlaceholder
      href="/research/models"
      planned={[
        'Model versions and training runs (regularised regression, gradient boosting, hierarchical)',
        'Participant-grouped CV metrics (R², MAE, RMSE) with uncertainty; untouched holdout confirmation',
        'Incremental validity: game features vs battery vs combined',
        'Out-of-fold predictions (research ids only)',
      ]}
      endpoints={[
        'GET /api/v1/models',
        'POST /api/v1/models',
        'GET /api/v1/models/{model_id}/training-runs',
        'GET /api/v1/models/{model_id}/evaluations',
        'GET /api/v1/models/{model_id}/predictions',
      ]}
      features={['VAL-10']}
    />
  );
}
