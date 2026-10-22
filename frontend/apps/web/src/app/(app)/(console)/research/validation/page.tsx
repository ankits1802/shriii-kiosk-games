import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoadingState } from '@/components/data/states';
import { loadScienceConfig } from '@/features/research/load-science.server';
import { ValidationWorkbenchPage } from '@/features/research/validation/workbench-page';

export const metadata: Metadata = { title: 'Validation' };

export default function Page() {
  const science = loadScienceConfig();
  return (
    <Suspense fallback={<LoadingState rows={6} />}>
      <ValidationWorkbenchPage science={science} />
    </Suspense>
  );
}
