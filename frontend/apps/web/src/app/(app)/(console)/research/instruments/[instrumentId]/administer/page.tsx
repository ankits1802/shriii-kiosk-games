import type { Metadata } from 'next';
import { AdministerPage } from '@/features/research/instruments/administer-page';

export const metadata: Metadata = { title: 'Administer instrument' };

export default async function Page({
  params,
}: {
  readonly params: Promise<{ instrumentId: string }>;
}) {
  const { instrumentId } = await params;
  return <AdministerPage instrumentId={decodeURIComponent(instrumentId)} />;
}
