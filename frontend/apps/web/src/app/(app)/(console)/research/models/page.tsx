import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoadingState } from '@/components/data/states';
import { ModelsPage } from '@/features/research/models/models-page';

export const metadata: Metadata = { title: 'Models' };

export default function Page() {
  return (
    <Suspense fallback={<LoadingState rows={6} />}>
      <ModelsPage />
    </Suspense>
  );
}
