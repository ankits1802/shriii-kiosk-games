import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoadingState } from '@/components/data/states';
import { ImportsPage } from '@/features/research/instruments/imports-page';

export const metadata: Metadata = { title: 'Import questionnaire data' };

export default function Page() {
  return (
    <Suspense fallback={<LoadingState rows={6} />}>
      <ImportsPage />
    </Suspense>
  );
}
