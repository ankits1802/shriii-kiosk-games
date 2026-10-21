'use client';

import { ConstructionIcon, DatabaseIcon } from 'lucide-react';
import { PageHeader } from '@/components/data/page-header';
import { EmptyState } from '@/components/data/states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ALL_NAV_ITEMS } from '@/lib/nav';
import { useStudyScope } from '@/lib/study-scope';

export interface RoutePlaceholderProps {
  /** Nav registry href; title and description come from the registry. */
  readonly href: string;
  /** What this page will contain (from the spec / implementation plan). */
  readonly planned: readonly string[];
  /** API endpoints the page will read or write. */
  readonly endpoints: readonly string[];
  /** Plan feature ids implemented on this page. */
  readonly features?: readonly string[];
  /** Data layer note (five-layer model), when relevant. */
  readonly layer?: string;
  /** Whether the page follows the console's study selection. */
  readonly studyScoped?: boolean;
}

/**
 * Real page layout with an explicit empty state, used until a feature team fills the page. It shows
 * what the page is for, which plan features land here and which API endpoints back it.
 */
export function RoutePlaceholder({
  href,
  planned,
  endpoints,
  features,
  layer,
  studyScoped = true,
}: RoutePlaceholderProps) {
  const item = ALL_NAV_ITEMS.find((i) => i.href === href);
  const { study } = useStudyScope();
  return (
    <div className="space-y-6">
      <PageHeader
        title={item?.label ?? href}
        description={item?.description}
        meta={
          <div className="flex flex-wrap items-center gap-1.5">
            {studyScoped && (
              <Badge variant="outline">
                {study ? `${study.code} · ${study.name}` : 'All studies in scope'}
              </Badge>
            )}
            {layer && <Badge variant="info">{layer}</Badge>}
            {features?.map((f) => (
              <Badge key={f} variant="secondary" className="font-mono">
                {f}
              </Badge>
            ))}
          </div>
        }
      />
      <EmptyState
        icon={ConstructionIcon}
        title="This section is being built"
        description="Records will appear here once the feature lands. Nothing on this page is placeholder data."
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">What this page will hold</CardTitle>
            <CardDescription>From the agent implementation spec and plan.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {planned.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <DatabaseIcon className="size-4" aria-hidden="true" />
              API
            </CardTitle>
            <CardDescription>
              Typed client: <code className="text-xs">useApi()</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 font-mono text-xs">
              {endpoints.map((e) => (
                <li key={e} className="truncate" title={e}>
                  {e}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
