import type { Metadata } from 'next';
import { AdminKiosksPage } from '@/features/admin/kiosks/kiosks-page';

export const metadata: Metadata = { title: 'Kiosks' };

export default function Page() {
  return <AdminKiosksPage />;
}
