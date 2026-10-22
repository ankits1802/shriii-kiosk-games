import type { Metadata } from 'next';
import { loadSettingsInputs } from '@/features/admin/settings/load-settings.server';
import { AdminSettingsPage } from '@/features/admin/settings/settings-page';

export const metadata: Metadata = { title: 'Settings' };

/** Retention rules and catalogue languages are read from the repository when the page is built. */
export default function Page() {
  return <AdminSettingsPage inputs={loadSettingsInputs()} />;
}
