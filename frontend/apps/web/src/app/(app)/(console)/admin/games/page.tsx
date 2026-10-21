import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Games' };

export default function AdminGamesPage() {
  return (
    <RoutePlaceholder
      href="/admin/games"
      planned={[
        'Game catalogue and versions (draft → approved) with full config',
        'Trial counts, timing, stimulus sets and condition sequences per version',
        'Session plan and time budgets; study-specific game configuration',
        'Approved-version bundle check used by kiosks',
      ]}
      endpoints={[
        'GET /api/v1/games',
        'POST /api/v1/games/sync',
        'GET /api/v1/games/{game_id}/versions',
        'POST /api/v1/games/{game_id}/versions/{version}/approve',
        'GET /api/v1/games/session-plan',
      ]}
      features={['ENG-04', 'ENG-09']}
      studyScoped={false}
    />
  );
}
