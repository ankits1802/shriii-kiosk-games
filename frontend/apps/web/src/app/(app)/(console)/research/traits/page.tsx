import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoadingState } from '@/components/data/states';
import { loadScienceConfig } from '@/features/research/load-science.server';
import { TraitsPage } from '@/features/research/traits/traits-page';

export const metadata: Metadata = { title: 'Traits' };

export default function Page() {
  const science = loadScienceConfig();
  return (
    <Suspense fallback={<LoadingState rows={6} />}>
      <TraitsPage science={science} />
    </Suspense>
  );
}
