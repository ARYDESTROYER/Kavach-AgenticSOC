/**
 * Workspace — the host for the agent's interactive surfaces (Chat, Investigate).
 *
 *   - Chat:        the conversational assistant (ONE chat engine — AGENTS.md).
 *   - Entity investigation: an ad-hoc, agentic investigation on an IP / user / host.
 *
 * The active sub-view is selected by the `tab` route opt (forced by the `chat` /
 * `investigate` routes and by `navigate('chat', { tab })`); the left-nav Workspace group
 * exposes both, so there is no in-page tab strip. Chat owns its full-height frame (it
 * bleeds the shell's vertical inset); Entity investigation keeps the wider operational
 * host below.
 *
 * Both tabs are LAZY (chat revamp SPEC §10.10): Investigate pulls in the case detail
 * views, and Chat must not download that chunk (nor Investigate the chat one).
 */
import * as React from 'react';
import { Search } from 'lucide-react';

import type { NavOpts } from '@/lib/types';
import { LoadingState } from '@/design-system/loading';
import { useNavigateOptional, type Navigate } from '@/soc/router';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';

const Chat = React.lazy(() => import('./Chat'));
const Investigate = React.lazy(() => import('./Investigate'));

export interface WorkspaceProps {
  onNavigate?: Navigate;
  /** Active sub-view from the route opts ('chat' | 'investigate'). */
  tab?: string;
  /** Optional case context preserved by a Case Chat → Workspace deep-link. */
  caseId?: string;
  /** The route's opts (chat deep links); Chat reads the router itself when absent. */
  opts?: NavOpts;
}

export default function Workspace({ onNavigate, tab, caseId, opts }: WorkspaceProps = {}) {
  // Coupling-A: resolve navigate once (an explicit prop wins for tests). Call the hook
  // UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const isInvestigate = tab === 'investigate';

  if (!isInvestigate) {
    // Chat owns its frame (rail, conversation, report panel); a PageContainer here would
    // add a second width authority and the shell's vertical inset it deliberately bleeds.
    return (
      <React.Suspense fallback={<LoadingState layout="page" label="Loading chat" />}>
        <Chat caseId={caseId} opts={opts} />
      </React.Suspense>
    );
  }

  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        icon={Search}
        eyebrow="Agent workspace"
        title="Entity investigation"
        description="Check one IP, user, or host across the selected log window. Matching evidence is correlated, investigated, and saved as a case."
      />
      <React.Suspense fallback={<LoadingState layout="panel" label="Loading investigation" />}>
        <Investigate embedded onNavigate={navigate} />
      </React.Suspense>
    </PageContainer>
  );
}
