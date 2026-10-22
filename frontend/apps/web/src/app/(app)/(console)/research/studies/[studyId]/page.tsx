import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoadingState } from '@/components/data/states';
import { StudyDetailPage } from '@/features/research/studies/study-detail';

export const metadata: Metadata = { title: 'Study' };

export default async function Page({ params }: { readonly params: Promise<{ studyId: string }> }) {
  const { studyId } = await params;
  return (
    <Suspense fallback={<LoadingState rows={6} />}>
      <StudyDetailPage studyId={decodeURIComponent(studyId)} />
    </Suspense>
  );
}
