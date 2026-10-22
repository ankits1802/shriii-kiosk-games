import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoadingState } from '@/components/data/states';
import { loadScienceConfig } from '@/features/research/load-science.server';
import { ReportsPage } from '@/features/research/reports/reports-page';

export const metadata: Metadata = { title: 'Reports' };

export default function Page() {
  const science = loadScienceConfig();
  return (
    <Suspense fallback={<LoadingState rows={6} />}>
      <ReportsPage science={science} />
    </Suspense>
  );
}
