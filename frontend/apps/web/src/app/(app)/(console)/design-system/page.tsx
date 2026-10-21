import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Gallery } from './gallery';

export const metadata: Metadata = { title: 'Design system' };

/** Component gallery for feature teams. Dev builds always; production only when enabled. */
export default function DesignSystemPage() {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.NEXT_PUBLIC_ENABLE_UI_GALLERY !== 'true'
  ) {
    notFound();
  }
  return <Gallery />;
}
