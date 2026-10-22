/**
 * Route registry for the research and admin consoles (spec section 1, "Required routes").
 * One table drives the sidebar, breadcrumbs, the route guard and the role-navigation tests, so a
 * page is never reachable from the UI without the permission the API will demand for it.
 */
import type { Requirement } from '@/lib/auth/principal';
import { type Principal, satisfies } from '@/lib/auth/principal';

export type NavSectionId = 'research' | 'admin';

export type NavIconId =
  | 'overview'
  | 'studies'
  | 'participants'
  | 'instruments'
  | 'traits'
  | 'validation'
  | 'models'
  | 'analytics'
  | 'reports'
  | 'games'
  | 'content'
  | 'kiosks'
  | 'settings';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** One line shown under page titles and in the overview cards. */
  readonly description: string;
  readonly icon: NavIconId;
  readonly section: NavSectionId;
  readonly requires: Requirement;
}

export interface NavSection {
  readonly id: NavSectionId;
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const RESEARCH_NAV: readonly NavItem[] = [
  {
    href: '/research',
    label: 'Overview',
    description: 'Research overview and dashboards',
    icon: 'overview',
    section: 'research',
    requires: { any: ['studies.read', 'validation.read'] },
  },
  {
    href: '/research/studies',
    label: 'Studies',
    description: 'Studies, cohorts, recruitment',
    icon: 'studies',
    section: 'research',
    requires: { all: ['studies.read'] },
  },
  {
    href: '/research/participants',
    label: 'Participants',
    description: 'Pseudonymous participant records',
    icon: 'participants',
    section: 'research',
    requires: { all: ['participants.read'] },
  },
  {
    href: '/research/instruments',
    label: 'Instruments',
    description: 'Psychometric battery management',
    icon: 'instruments',
    section: 'research',
    requires: { all: ['instruments.read'] },
  },
  {
    href: '/research/traits',
    label: 'Traits',
    description: 'Trait definitions and indicator mappings',
    icon: 'traits',
    section: 'research',
    requires: { all: ['features.read'] },
  },
  {
    href: '/research/validation',
    label: 'Validation',
    description: 'Statistical validation workbench',
    icon: 'validation',
    section: 'research',
    requires: { all: ['validation.read'] },
  },
  {
    href: '/research/models',
    label: 'Models',
    description: 'Predictive models and experiments',
    icon: 'models',
    section: 'research',
    requires: { all: ['models.read'] },
  },
  {
    href: '/research/analytics',
    label: 'Analytics',
    description: 'Exploratory and longitudinal analytics',
    icon: 'analytics',
    section: 'research',
    requires: { all: ['features.read', 'datasets.read'] },
  },
  {
    href: '/research/reports',
    label: 'Reports',
    description: 'Scientific reports and exports',
    icon: 'reports',
    section: 'research',
    requires: { any: ['reports.read', 'validation.read'] },
  },
];

export const ADMIN_NAV: readonly NavItem[] = [
  {
    href: '/admin/games',
    label: 'Games',
    description: 'Game and trial configuration',
    icon: 'games',
    section: 'admin',
    requires: { all: ['games.write'] },
  },
  {
    href: '/admin/content',
    label: 'Content',
    description: 'Narratives, assets, translations',
    icon: 'content',
    section: 'admin',
    requires: { all: ['admin.content'] },
  },
  {
    href: '/admin/kiosks',
    label: 'Kiosks',
    description: 'Kiosk deployment and health',
    icon: 'kiosks',
    section: 'admin',
    requires: { all: ['admin.kiosks'] },
  },
  {
    href: '/admin/settings',
    label: 'Settings',
    description: 'Security, permissions, configuration',
    icon: 'settings',
    section: 'admin',
    requires: { all: ['admin.settings'] },
  },
];

export const NAV_SECTIONS: readonly NavSection[] = [
  { id: 'research', label: 'Research', items: RESEARCH_NAV },
  { id: 'admin', label: 'Admin', items: ADMIN_NAV },
];

export const ALL_NAV_ITEMS: readonly NavItem[] = [...RESEARCH_NAV, ...ADMIN_NAV];

/** Console routes that are not in the sidebar but still guarded. */
const EXTRA_ROUTES: readonly { readonly href: string; readonly requires: Requirement }[] = [
  // The admin landing redirects to the first admin page the principal can open.
  {
    href: '/admin',
    requires: { any: ['games.write', 'admin.content', 'admin.kiosks', 'admin.settings'] },
  },
  { href: '/design-system', requires: {} },
];

/**
 * Deeper pages that need more than the nav item owning them (checked before the nav table).
 * Researcher-administered mode writes battery responses, so read-only roles must not open it.
 */
const ROUTE_OVERRIDES: readonly { readonly pattern: RegExp; readonly requires: Requirement }[] = [
  {
    pattern: /^\/research\/instruments\/[^/]+\/administer\/?$/,
    requires: { all: ['instruments.read', 'responses.write'] },
  },
];

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The nav item owning `pathname` (longest matching prefix), e.g. `/research/studies/abc` ->
 * Studies. `/research` itself only matches exactly so sub-pages resolve to their own item.
 */
export function navItemFor(pathname: string): NavItem | null {
  let best: NavItem | null = null;
  for (const item of ALL_NAV_ITEMS) {
    const ok = item.href === '/research' ? pathname === '/research' : matches(pathname, item.href);
    if (ok && (!best || item.href.length > best.href.length)) best = item;
  }
  return best;
}

/** The requirement guarding `pathname`, or null when the path is not a known console route. */
export function routeRequirement(pathname: string): Requirement | null {
  const override = ROUTE_OVERRIDES.find((r) => r.pattern.test(pathname));
  if (override) return override.requires;
  const item = navItemFor(pathname);
  if (item) return item.requires;
  let best: { href: string; requires: Requirement } | null = null;
  for (const route of EXTRA_ROUTES) {
    if (matches(pathname, route.href) && (!best || route.href.length > best.href.length)) {
      best = route;
    }
  }
  return best?.requires ?? null;
}

export function canOpen(principal: Principal | null, pathname: string): boolean {
  const requirement = routeRequirement(pathname);
  return requirement === null ? principal !== null : satisfies(principal, requirement);
}

/** Sidebar sections filtered to what the principal may open (empty sections are dropped). */
export function visibleNav(principal: Principal | null): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => satisfies(principal, item.requires)),
  })).filter((section) => section.items.length > 0);
}

/** Where a principal lands after sign-in: the first page they can open. */
export function defaultLanding(principal: Principal | null): string {
  const first = visibleNav(principal)[0]?.items[0];
  return first?.href ?? '/no-access';
}

export interface Crumb {
  readonly href: string;
  readonly label: string;
}

/** Breadcrumbs: section, then nav item, then any deeper segments (shown verbatim). */
export function breadcrumbs(pathname: string): Crumb[] {
  const crumbs: Crumb[] = [];
  const item = navItemFor(pathname);
  const sectionId: NavSectionId | null = pathname.startsWith('/admin')
    ? 'admin'
    : pathname.startsWith('/research')
      ? 'research'
      : null;
  if (sectionId === 'research') crumbs.push({ href: '/research', label: 'Research' });
  if (sectionId === 'admin') crumbs.push({ href: '/admin', label: 'Admin' });
  if (item && item.href !== '/research') crumbs.push({ href: item.href, label: item.label });
  if (item) {
    const rest = pathname.slice(item.href.length).split('/').filter(Boolean);
    let href = item.href;
    for (const segment of rest) {
      href = `${href}/${segment}`;
      crumbs.push({ href, label: decodeURIComponent(segment) });
    }
  }
  return crumbs;
}
