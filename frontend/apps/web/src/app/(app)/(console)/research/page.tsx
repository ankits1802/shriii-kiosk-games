import type { Metadata } from 'next';
import { ResearchOverviewPage } from '@/features/research/overview/overview-page';

export const metadata: Metadata = { title: 'Research' };

export default function ResearchPage() {
  return <ResearchOverviewPage />;
}
