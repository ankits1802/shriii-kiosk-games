import type { Metadata } from 'next';
import { StudiesPage } from '@/features/research/studies/studies-page';

export const metadata: Metadata = { title: 'Studies' };

export default function Page() {
  return <StudiesPage />;
}
