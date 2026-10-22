'use client';

import { usePermission } from '@/components/auth/can';
import { PageHeader } from '@/components/data/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AuditLogPanel } from './audit-log-panel';
import type { SettingsInputs } from './load-settings.server';
import { PolicyPanel } from './policy-panel';
import { RetentionPanel } from './retention-panel';
import { RolesPanel } from './roles-panel';
import { RuntimeSettingsPanel } from './runtime-settings-panel';

/** `/admin/settings`: users and roles, deployment policy, retention, runtime settings, audit log. */
export function AdminSettingsPage({ inputs }: { readonly inputs: SettingsInputs }) {
  const canAudit = usePermission({ all: ['audit.read'] });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Security and configuration: who can do what, the signed deployment policy with the plan's open-question defaults, data retention, runtime settings and the audit trail."
      />
      <Tabs defaultValue="policy">
        <TabsList className="flex-wrap">
          <TabsTrigger value="policy">Deployment policy</TabsTrigger>
          <TabsTrigger value="roles">Users and roles</TabsTrigger>
          <TabsTrigger value="retention">Retention</TabsTrigger>
          <TabsTrigger value="runtime">Runtime settings</TabsTrigger>
          {canAudit && <TabsTrigger value="audit">Audit log</TabsTrigger>}
        </TabsList>
        <TabsContent value="policy" className="pt-4">
          <PolicyPanel
            catalogueLanguages={inputs.catalogueLanguages}
            statementLines={inputs.statementLines}
          />
        </TabsContent>
        <TabsContent value="roles" className="pt-4">
          <RolesPanel />
        </TabsContent>
        <TabsContent value="retention" className="pt-4">
          <RetentionPanel retention={inputs.retention} />
        </TabsContent>
        <TabsContent value="runtime" className="pt-4">
          <RuntimeSettingsPanel />
        </TabsContent>
        {canAudit && (
          <TabsContent value="audit" className="pt-4">
            <AuditLogPanel />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
