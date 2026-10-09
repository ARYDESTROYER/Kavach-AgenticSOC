/**
 * CaseDetail — the Chat tab's shell (chat revamp SPEC §4.6, §10.8, §10.10).
 *
 * Only the frame lives here: the Case Detail card with "Open full chat", or Case
 * Manager's padded rail. The chat itself (`./CaseChat`: the shared engine, context,
 * transcript and composer) is a `React.lazy` boundary, so opening a case — from the
 * dashboard, Case Manager or Scans — never downloads the chat chunks unless the
 * analyst opens this tab. Radix Tabs unmounts inactive panels, so the import starts
 * on the first visit to the tab and is cached afterwards.
 *
 * #9: every model- or log-derived string renders as text (shared components).
 * #3: chat is advisory; it never decides or mutates the case.
 */
import * as React from 'react';
import { MessageSquare } from 'lucide-react';

import type { Case } from '@/lib/types';
import { LoadingState } from '@/design-system';
import { Button } from '@/ui/button';
import type { Navigate } from '@/soc/router';

import { CASE_MANAGER_PANEL_PADDING, PanelCard, SectionHeading } from './shared';
import type { CasePanelPresentation } from './shared';

/** Case-scoped quick questions in the Case Detail sheet. */
const CASE_CHAT_STARTERS = ['Summarize this case', 'Why was this flagged?', 'What should I check next?'];

/** Case Manager's analyst quick actions. */
const CASE_MANAGER_CHAT_STARTERS = ['Summarize Case', 'Check IOCs', 'Suggest Remediation'];

const CaseChat = React.lazy(() => import('./CaseChat'));

/** The lazy chat body with the console's one blocking-load grammar while it arrives. */
function LazyCaseChat(props: { caseId: string; caseManager: boolean; starters: readonly string[] }) {
  return (
    <React.Suspense fallback={<LoadingState layout="panel" label="Loading chat" className="h-full w-full" />}>
      <CaseChat {...props} />
    </React.Suspense>
  );
}

export const ChatTab: React.FC<{
  c: Case;
  onNavigate?: Navigate;
  onClose: () => void;
  presentation?: CasePanelPresentation;
}> = ({ c, onNavigate, onClose, presentation = 'default' }) => {
  if (presentation === 'case-manager') {
    return (
      <div
        className={`flex h-full min-h-0 overflow-hidden ${CASE_MANAGER_PANEL_PADDING}`}
        data-case-panel="chat"
        data-presentation="case-manager"
      >
        {/* Keyed per case: case A's transcript never shows under case B. */}
        <LazyCaseChat key={c.case_id} caseId={c.case_id} caseManager starters={CASE_MANAGER_CHAT_STARTERS} />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <PanelCard>
        <SectionHeading
          icon={MessageSquare}
          actions={
            onNavigate ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onClose();
                  onNavigate('chat', { caseId: c.case_id });
                }}
              >
                <MessageSquare className="h-4 w-4" /> Open full chat
              </Button>
            ) : null
          }
        >
          Case chat
        </SectionHeading>

        {/* A definite height gives the transcript its own scroll lane and keeps the
            composer docked at the bottom of the card. */}
        <div className="h-[60dvh] min-h-[24rem]">
          <LazyCaseChat key={c.case_id} caseId={c.case_id} caseManager={false} starters={CASE_CHAT_STARTERS} />
        </div>
      </PanelCard>
    </div>
  );
};

export default ChatTab;
