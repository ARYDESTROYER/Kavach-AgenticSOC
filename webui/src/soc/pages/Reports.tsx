/**
 * Reports — the Workspace's report library route (chat revamp SPEC §10.6), `#/reports`
 * and `#/reports?reportId=…`.
 *
 * A THIN shell on purpose: the library body (`chat/report/ReportsLibrary`) loads through
 * one more `import()`, so the entry chunk's preload table names only this shell and not
 * the report modules it shares with the chat's report panel (SPEC §10.10: the revamp may
 * add at most 1 kB to the entry). While the body loads, the page keeps the console's
 * page anatomy (container + header) with the shared loading state.
 */
import * as React from 'react';
import { FileText } from 'lucide-react';

import { LoadingState } from '@/design-system';
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
  const reportId = explicit ?? (route.page === 'reports' ? route.opts?.reportId : undefined);
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
