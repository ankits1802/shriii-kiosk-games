import type { Metadata } from 'next';
import { RoutePlaceholder } from '@/components/shell/route-placeholder';

export const metadata: Metadata = { title: 'Instruments' };

export default function ResearchInstrumentsPage() {
  return (
    <RoutePlaceholder
      href="/research/instruments"
      planned={[
        'Instrument registry with licensing and permission history',
        'Versions with item structure, reverse keys, subscales and scoring keys (no licensed wording committed)',
        'Language versions through the ITC adaptation workflow (two approvers)',
        'Researcher-administered mode (tablet layout, audio-assist slots)',
        'CSV/XLSX import with column mapping, validation and manual review queue',
        'Response corrections and rescoring with audit history',
      ]}
      endpoints={[
        'GET /api/v1/instruments',
        'GET /api/v1/instruments/{instrument_id}/versions/{version}',
        'GET /api/v1/instruments/{instrument_id}/licensing',
        'POST /api/v1/assessment-responses',
        'POST /api/v1/assessment-responses/imports',
        'GET /api/v1/assessment-responses/scores',
      ]}
      features={['CRT-02', 'CRT-03', 'CRT-04', 'CRT-05']}
      layer="Layer 3 · criterion scores"
    />
  );
}
