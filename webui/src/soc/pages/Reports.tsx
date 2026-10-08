/**
 * Reports — the Workspace's report library route (chat revamp SPEC §10.6), `#/reports`
 * and `#/reports?reportId=…`.
 *
 * A THIN shell on purpose: the library body (`chat/report/ReportsLibrary`) loads through
 * one more `import()`, so the entry chunk's preload table names only this shell and not
 * the report modules it shares with the chat's report panel (SPEC §10.10: the revamp may
 * add at most 1 kB to the entry). While the body loads, the page keeps the console's
 * page anatomy (container + header) with the shared loading state.
 *
 * Every `/api/reports` route needs `cases:read`, and so does the rail/palette entry
 * (its registry `perm`). A role without it can still reach `#/reports` by a typed or
 * shared link, so it gets a plain explanation here instead of a 403 error state.
 */
import * as React from 'react';
import { FileText } from 'lucide-react';

import { LoadingState } from '@/design-system';
import { useAuth } from '@/soc/auth';
import { EmptyState } from '@/soc/components/EmptyState';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { useRoute } from '@/soc/router';

const ReportsLibrary = React.lazy(() => import('@/soc/chat/report/ReportsLibrary'));

export interface ReportsPageProps {
  /**
   * The report to open instead of the router's `#/reports?reportId=…` (an embed or a
   * test). The route itself passes nothing: the page reads the router.
   */
  reportId?: string;
}

export default function Reports({ reportId: explicit }: ReportsPageProps = {}) {
  const route = useRoute();
  const { hasPermission } = useAuth();
  const reportId = explicit ?? (route.page === 'reports' ? route.opts?.reportId : undefined);
  if (!hasPermission('cases', 'read')) {
    return (
      <PageContainer variant="wide" className="space-y-6">
        <PageHeader icon={FileText} eyebrow="Workspace" title="Reports" />
        <EmptyState
          state="unavailable"
          title="Reports need access to cases"
          description="Your role cannot read cases, so it cannot open or build reports. An administrator can grant the Cases read permission."
        />
      </PageContainer>
    );
  }
  return (
    <React.Suspense
      fallback={
        <PageContainer variant="wide" className="space-y-6">
          <PageHeader icon={FileText} eyebrow="Workspace" title="Reports" />
          <LoadingState label="Loading reports" layout="page" />
        </PageContainer>
      }
    >
      <ReportsLibrary reportId={reportId ?? null} />
    </React.Suspense>
  );
}
