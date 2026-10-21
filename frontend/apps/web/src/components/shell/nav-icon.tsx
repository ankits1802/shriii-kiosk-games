import {
  BookOpenCheckIcon,
  BrainCircuitIcon,
  ClipboardListIcon,
  FileTextIcon,
  FlaskConicalIcon,
  Gamepad2Icon,
  LanguagesIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  MonitorSmartphoneIcon,
  NetworkIcon,
  SettingsIcon,
  SigmaIcon,
  UsersIcon,
} from 'lucide-react';
import type { NavIconId } from '@/lib/nav';

const ICONS: Record<NavIconId, LucideIcon> = {
  overview: LayoutDashboardIcon,
  studies: FlaskConicalIcon,
  participants: UsersIcon,
  instruments: ClipboardListIcon,
  traits: NetworkIcon,
  validation: SigmaIcon,
  models: BrainCircuitIcon,
  analytics: BookOpenCheckIcon,
  reports: FileTextIcon,
  games: Gamepad2Icon,
  content: LanguagesIcon,
  kiosks: MonitorSmartphoneIcon,
  settings: SettingsIcon,
};

export function NavIcon({
  id,
  className,
}: {
  readonly id: NavIconId;
  readonly className?: string;
}) {
  const Icon = ICONS[id];
  return <Icon className={className} aria-hidden="true" />;
}
