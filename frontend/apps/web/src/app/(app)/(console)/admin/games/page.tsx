import type { Metadata } from 'next';
import { AdminGamesPage } from '@/features/admin/games/games-page';

export const metadata: Metadata = { title: 'Games' };

export default function Page() {
  return <AdminGamesPage />;
}
