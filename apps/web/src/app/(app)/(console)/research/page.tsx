import type { Metadata } from 'next';
import { ResearchOverview } from './overview';

export const metadata: Metadata = { title: 'Research' };

export default function ResearchPage() {
  return <ResearchOverview />;
}
