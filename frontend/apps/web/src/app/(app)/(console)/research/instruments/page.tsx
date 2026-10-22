import type { Metadata } from 'next';
import { InstrumentsPage } from '@/features/research/instruments/instruments-page';

export const metadata: Metadata = { title: 'Instruments' };

export default function Page() {
  return <InstrumentsPage />;
}
