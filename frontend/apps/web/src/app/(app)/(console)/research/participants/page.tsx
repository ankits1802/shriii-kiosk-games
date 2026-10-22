import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoadingState } from '@/components/data/states';
import { ParticipantsPage } from '@/features/research/participants/participants-page';

export const metadata: Metadata = { title: 'Participants' };

export default function Page() {
  return (
    <Suspense fallback={<LoadingState rows={6} />}>
      <ParticipantsPage />
    </Suspense>
  );
}
