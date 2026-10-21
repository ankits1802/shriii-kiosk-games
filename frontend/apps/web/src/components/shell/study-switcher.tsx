'use client';

import { FlaskConicalIcon } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/lib/auth/auth-context';
import { hasPermission } from '@/lib/auth/principal';
import { useStudyScope } from '@/lib/study-scope';

const ALL = '__all__';

/** Focus the console on one study (only studies in the principal's scope are offered). */
export function StudySwitcher() {
  const { principal } = useAuth();
  const { studies, studyId, setStudyId, isLoading } = useStudyScope();
  if (!hasPermission(principal, 'studies.read')) return null;
  return (
    <Select
      value={studyId ?? ALL}
      onValueChange={(v) => setStudyId(v === ALL ? null : v)}
      disabled={isLoading}
    >
      <SelectTrigger size="sm" className="max-w-56" aria-label="Study">
        <FlaskConicalIcon className="text-muted-foreground" />
        <SelectValue placeholder={isLoading ? 'Loading studies…' : 'All studies'} />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value={ALL}>All studies in scope</SelectItem>
        {studies.map((s) => (
          <SelectItem key={s.study_id} value={s.study_id}>
            {s.code} · {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
