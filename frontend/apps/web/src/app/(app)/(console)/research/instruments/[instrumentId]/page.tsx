import type { Metadata } from 'next';
import { InstrumentDetailPage } from '@/features/research/instruments/instrument-detail';

export const metadata: Metadata = { title: 'Instrument' };

export default async function Page({
  params,
}: {
  readonly params: Promise<{ instrumentId: string }>;
}) {
  const { instrumentId } = await params;
  return <InstrumentDetailPage instrumentId={decodeURIComponent(instrumentId)} />;
}
