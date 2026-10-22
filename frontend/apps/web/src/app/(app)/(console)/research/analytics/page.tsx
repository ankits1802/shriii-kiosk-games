import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoadingState } from '@/components/data/states';
import { AnalyticsPage } from '@/features/research/analytics/analytics-page';
import { loadScienceConfig } from '@/features/research/load-science.server';

export const metadata: Metadata = { title: 'Analytics' };

export default function Page() {
  const science = loadScienceConfig();
  return (
    <Suspense fallback={<LoadingState rows={6} />}>
      <AnalyticsPage science={science} />
    </Suspense>
  );
}
