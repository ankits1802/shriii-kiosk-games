import type { Metadata } from 'next';
import { AdminContentPage } from '@/features/admin/content/content-page';
import { loadContentSnapshot } from '@/features/admin/content/load-content.server';

export const metadata: Metadata = { title: 'Content' };

/**
 * The voice-line catalogue, translations, ITC workflow and audio QC thresholds are read from the
 * repository when the page is built (the API has no content-line endpoint yet).
 */
export default function Page() {
  return <AdminContentPage snapshot={loadContentSnapshot()} />;
}
