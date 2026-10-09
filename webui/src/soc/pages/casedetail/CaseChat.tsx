/**
 * The case-scoped chat body (chat revamp SPEC §4.6, §10.8; #5 one engine, two entry
 * points), loaded lazily by `CaseChatPanel` so opening a case downloads none of the
 * chat engine, context or message code until the Chat tab is opened.
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

import type { ChatStarter } from '@/lib/types';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { useAuth } from '@/soc/auth';
import { Composer, type ComposerHandle } from '@/soc/chat/composer/Composer';
import { withClientHistory } from '@/soc/chat/composer/format';
import { EmptyState } from '@/soc/chat/empty/EmptyState';
import { CONTENT_COL, LANE_GRID } from '@/soc/chat/message/lane';
import { Transcript } from '@/soc/chat/message/Transcript';
import { useTurnAnnouncer } from '@/soc/chat/message/useTurnAnnouncer';
import { useChatContext } from '@/soc/chat/useChatContext';
import { CONTINUE_PROMPT, useChatEngine } from '@/soc/chat/useChatEngine';
import { estimateNextRequest } from '@/soc/chat/display';

const STARTER_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  'Summarize Case': ClipboardList,
  'Check IOCs': FileSearch,
  'Suggest Remediation': ShieldCheck,
};

/**
 * The signed-in principal and the model-picker grant when an AuthProvider is mounted
 * (the app always has one; a standalone render does not). The principal keys the shared
 * `/chat/context` cache, so opening another case reuses a fresh context instead of
 * refetching; the model picker lists `/api/models`, which needs models:read. `useAuth`
 * reads the context before it throws, so the hook order is the same either way.
 */
function useOptionalAuth(): { principal: string | null; canChooseModel: boolean | undefined } {
  try {
    const auth = useAuth();
    return { principal: auth.username ?? null, canChooseModel: auth.hasPermission('models', 'read') };
  } catch {
    return { principal: null, canChooseModel: undefined };
  }
}

/** The case chat body: status, transcript, quick actions, compact composer. */
export interface CaseChatProps {
  caseId: string;
  /** Case Manager's embedded frame (its quick-action icons and presentation tag). */
  caseManager: boolean;
  /** The quick questions shown above the composer. */
  starters: readonly string[];
}

export function CaseChat({ caseId, caseManager, starters }: CaseChatProps) {
  const [model, setModel] = React.useState<string | null>(null);
  const [busyMirror, setBusyMirror] = React.useState(false);
  const { principal, canChooseModel } = useOptionalAuth();
  const context = useChatContext({ conversationId: null, model, caseId, principal, busy: busyMirror });
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
  const focusComposer = React.useCallback(() => composerRef.current?.focus(), []);
  // A quick action is disabled (and a starter replaced) while the turn runs: focus
  // moves to the composer instead of dropping to <body> (SPEC §10.9).
  // "Continue where this stopped (≈ +N tokens)": calibrated on every part, exactly
  // like the composer meter and Workspace Chat (SPEC §10.3).
  // The history part is the engine's own (case history travels with the request).
  const historySize = engine.historySize;
  const continueEstimate = React.useMemo(() => {
    if (!ctx) return null;
    const withHistory = withClientHistory(ctx, historySize);
    return estimateNextRequest({
      staticPromptTokens: withHistory.static_prompt_tokens,
      historyTokens: withHistory.history_tokens,
      draft: CONTINUE_PROMPT,
      charsPerToken: withHistory.chars_per_token,
      calibration: withHistory.calibration ?? null,
    }).total;
  }, [ctx, historySize]);
  const send = (prompt: string) => {
    if (engine.send(prompt, { origin: 'starter' })) focusComposer();
  };

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
        label={`Case ${caseId} messages`}
        onFocusComposer={focusComposer}
        continueEstimate={continueEstimate}
        empty={
          <EmptyState
            context={ctx}
            variant="case"
            disabled={busy}
            error={context.error}
            onRetry={context.refresh}
            onStarter={(starter: ChatStarter) => send(starter.prompt)}
          />
        }
      />

      {/* Same edges as the compact transcript above: its px-1 and its scrollbar gutter
          (reserved here by an overflow box with no overflow; popovers are portalled).
          The 2 px bottom inset keeps the composer's focus ring inside the frame. */}
      <div className="shrink-0 space-y-2 overflow-hidden px-1 pb-0.5 pt-2 [scrollbar-gutter:stable_both-edges]">
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
            <Composer
              ref={composerRef}
              engine={engine}
              context={ctx}
              variant="case"
              onComposerFocus={context.revalidate}
              contextError={context.error}
              onRetryContext={context.refresh}
              canChooseModel={canChooseModel}
              defaultModel={context.defaultModel}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default CaseChat;
