/**
 * CaseDetail — the case-scoped chat (chat revamp SPEC §4.6, §10.8; #5 one engine, two
 * entry points).
 *
 * The SAME `useChatEngine` as Workspace Chat with `caseId`: every turn carries the case
 * id (the case tools default to it), the final answer is appended to the case thread,
 * and nothing enters personal Workspace history or can be added to a report (no rail,
 * no report panel, no Add to report). The transcript, run log and meta row are the
 * shared message components in their compact presentation; the composer is the
 * compact `case` variant. Case Manager keeps its one-line status and its quick actions.
 *
 * #9: every model- or log-derived string renders as text (shared components).
 * #3: chat is advisory; it never decides or mutates the case.
 */
import * as React from 'react';
import { ClipboardList, FileSearch, MessageSquare, ShieldCheck } from 'lucide-react';

import type { Case, ChatStarter } from '@/lib/types';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import type { Navigate } from '@/soc/router';
import { Composer, type ComposerHandle } from '@/soc/chat/composer/Composer';
import { EmptyState } from '@/soc/chat/empty/EmptyState';
import { CONTENT_COL, LANE_GRID } from '@/soc/chat/message/lane';
import { Transcript } from '@/soc/chat/message/Transcript';
import { useTurnAnnouncer } from '@/soc/chat/message/useTurnAnnouncer';
import { useChatContext } from '@/soc/chat/useChatContext';
import { useChatEngine } from '@/soc/chat/useChatEngine';

import { CASE_MANAGER_PANEL_PADDING, PanelCard, SectionHeading } from './shared';
import type { CasePanelPresentation } from './shared';

/** Case-scoped quick questions in the Case Detail sheet. */
const CASE_CHAT_STARTERS = ['Summarize this case', 'Why was this flagged?', 'What should I check next?'];

/** Case Manager's analyst quick actions. */
const CASE_MANAGER_CHAT_STARTERS = ['Summarize Case', 'Check IOCs', 'Suggest Remediation'];

const STARTER_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  'Summarize Case': ClipboardList,
  'Check IOCs': FileSearch,
  'Suggest Remediation': ShieldCheck,
};

/** The case chat body: status, transcript, quick actions, compact composer. */
function CaseChat({ caseId, caseManager, starters }: { caseId: string; caseManager: boolean; starters: readonly string[] }) {
  const [model, setModel] = React.useState<string | null>(null);
  const [busyMirror, setBusyMirror] = React.useState(false);
  const context = useChatContext({ conversationId: null, model, caseId, busy: busyMirror });
  const ctx = context.context;
  const engine = useChatEngine({
    caseId,
    onBusyChange: setBusyMirror,
    textStreamingAvailable: ctx?.text_streaming.available ?? true,
    orgDefaultStreamMode: ctx?.bounds.default_stream_mode ?? null,
    turnBounds: ctx?.bounds ?? null,
  });
  React.useEffect(() => setModel(engine.model), [engine.model]);
  useTurnAnnouncer(engine, ctx?.bounds.max_tool_calls ?? null);
  const composerRef = React.useRef<ComposerHandle>(null);
  const busy = engine.busy;
  const send = (prompt: string) => engine.send(prompt, { origin: 'starter' });

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      data-chat-presentation={caseManager ? 'case-manager' : 'case'}
    >
      {/* Status without a live region: the shell announcer speaks progress (SPEC §10.9). */}
      <div
        role="group"
        aria-label="AI analyst status"
        className="flex min-h-7 shrink-0 items-center gap-2 border-b border-border pb-2 text-xs text-muted-foreground"
      >
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', busy ? 'bg-primary' : 'bg-success')} aria-hidden />
        <span className="min-w-0 truncate">
          Scoped to <span className="font-mono text-foreground">{caseId}</span>
        </span>
        <span className="ml-auto shrink-0">{busy ? 'Working…' : 'Ready'}</span>
      </div>

      <Transcript
        engine={engine}
        compact
        label={`Case ${caseId} conversation`}
        empty={
          <EmptyState
            context={ctx}
            variant="case"
            disabled={busy}
            onStarter={(starter: ChatStarter) => engine.send(starter.prompt, { origin: 'starter' })}
          />
        }
      />

      <div className="shrink-0 space-y-2 pt-2">
        <div className={LANE_GRID}>
          <div className={cn(CONTENT_COL, 'space-y-2')}>
            <div
              role="group"
              aria-label="Analyst quick actions"
              className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto overscroll-x-contain"
            >
              {starters.map((prompt) => {
                const Icon = STARTER_ICON[prompt] ?? MessageSquare;
                return (
                  <Button
                    key={prompt}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
                    onClick={() => send(prompt)}
                    disabled={busy}
                  >
                    <Icon aria-hidden />
                    {prompt}
                  </Button>
                );
              })}
            </div>
            <Composer ref={composerRef} engine={engine} context={ctx} variant="case" onComposerFocus={context.revalidate} />
          </div>
        </div>
      </div>
    </div>
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
        <CaseChat key={c.case_id} caseId={c.case_id} caseManager starters={CASE_MANAGER_CHAT_STARTERS} />
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
          <CaseChat key={c.case_id} caseId={c.case_id} caseManager={false} starters={CASE_CHAT_STARTERS} />
        </div>
      </PanelCard>
    </div>
  );
};

export default ChatTab;
