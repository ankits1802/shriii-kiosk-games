import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Content' };

export default function AdminContentPage() {
  return (
    <RoutePlaceholder
      href="/admin/content"
      planned={[
        'Content versions (games, instruments, dictionary, gates, hypotheses) with hash stamps',
        'Two-person approval of content versions',
        'Narrative line catalogue and audio manifest coverage per language',
        'Translation and cultural-adaptation workflow status',
      ]}
      endpoints={[
        'GET /api/v1/admin/content-versions',
        'POST /api/v1/admin/content-versions/sync',
        'POST /api/v1/admin/content-versions/{version_id}/approve',
      ]}
      features={['VOX-07', 'PLT-03']}
      studyScoped={false}
    />
  );
}
