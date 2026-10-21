import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Settings' };

export default function AdminSettingsPage() {
  return (
    <RoutePlaceholder
      href="/admin/settings"
      planned={[
        'Runtime settings (audited changes)',
        'Roles and permission matrix (read-only view of the API RBAC)',
        'Audit log and system events',
        'Retention schedule runs, legal holds and erasure queue',
        'Battery and trait gates, signed release packs',
      ]}
      endpoints={[
        'GET /api/v1/admin/settings',
        'PUT /api/v1/admin/settings/{key}',
        'GET /api/v1/admin/audit',
        'POST /api/v1/admin/retention/run',
        'POST /api/v1/admin/legal-holds',
        'GET /api/v1/admin/gates/release-pack/current',
      ]}
      features={['PRV-05', 'PRV-08', 'VAL-14']}
      studyScoped={false}
    />
  );
}
