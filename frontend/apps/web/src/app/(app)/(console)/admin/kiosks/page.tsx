import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Kiosks' };

export default function AdminKiosksPage() {
  return (
    <RoutePlaceholder
      href="/admin/kiosks"
      planned={[
        'Kiosk fleet with heartbeat health, app version and outbox backlog',
        'Registration (token shown once), token rotation and revocation',
        'Deployments to sites; dead-letter queue triage and replay',
        'Job queue status (ingestion, scoring, validation) with retry/cancel',
      ]}
      endpoints={[
        'GET /api/v1/admin/kiosks',
        'POST /api/v1/admin/kiosks',
        'POST /api/v1/admin/kiosks/{kiosk_id}/revoke',
        'GET /api/v1/admin/deployments',
        'GET /api/v1/admin/dead-letters',
        'GET /api/v1/admin/jobs',
      ]}
      features={['KSK-10', 'ING-04']}
      studyScoped={false}
    />
  );
}
