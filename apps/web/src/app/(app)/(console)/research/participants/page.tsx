import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Participants' };

export default function ResearchParticipantsPage() {
  return (
    <RoutePlaceholder
      href="/research/participants"
      planned={[
        'Pseudonymous participant records (pid only; identity lives in the separate vault)',
        'Consent artefacts with full version history (core, archive, contact opt-ins)',
        'Session linkage by pairing code, QR token or two-person manual link',
        'Withdrawal and erasure requests with signed receipts',
        'Enrollment and occasion status per participant',
      ]}
      endpoints={[
        'GET /api/v1/participants',
        'POST /api/v1/participants',
        'GET /api/v1/participants/{pid}',
        'GET /api/v1/participants/{pid}/consents',
        'POST /api/v1/participants/link',
        'POST /api/v1/participants/{pid}/withdraw',
        'POST /api/v1/participants/erasure-requests',
      ]}
      features={['CRT-06', 'PRV-02', 'PRV-04', 'PRV-06a']}
      layer="Identity-separated"
    />
  );
}
