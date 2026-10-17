/**
 * EmptyState — what a conversation shows before its first message (SPEC-chat §3.1,
 * §3.11, §3.14, §5.2; replaces the chat revamp's §10.5 starter grid).
 *
 * - **Workspace** (`variant="workspace"`): the Round 13 start stack
 *   ({@link StartScreen}): a greeting, the "since you were last here" line or the
 *   capability line, 3 or 4 dynamic "Right now" cards read from
 *   `GET /api/chat/starters` (the host owns that read through `useChatStarters`, so it
 *   can also record the `viewed` event on the first send), and the prompt library's
 *   category pills. The host sends a card's question with `origin: "starter"`, opens a
 *   conversation, or runs a saved prompt, by the card's action.
 * - **Case** (`variant="case"`, Case Manager chat and a case-scoped Chat page): one
 *   compact capability line with the access popover link, plus the three case-scoped
 *   chips of `GET /api/chat/starters?surface=case`, sent in the case chat with
 *   `origin: "starter"`. Case chips stay case-scoped and never reach personal
 *   Workspace history (#5).
 *
 * Every server string renders as React text only (#9).
 */
import type { ChatContextInfo, ChatStarter } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { AccessPopover } from '../composer/AccessPopover';
import { CaseStarterChips } from '../starters/CaseStarterChips';
import { StartScreen } from '../starters/StartScreen';
import type { ChatStartersController } from '../starters/useChatStarters';

export { CAPABILITY_LINE } from '../starters/StartScreen';

export const CASE_CAPABILITY_LINE = 'Ask about this case: what happened, the evidence and the decision. Read-only.';
export const ACCESS_LINK = 'What can the assistant access?';

export interface EmptyStateProps {
  /** The tool catalogue (`/chat/context`): the category pills and the access popover. */
  context: ChatContextInfo | null;
  /**
   * A card, catch-up clause or case chip was chosen. Workspace: the host dispatches on
   * `starter.action`; case: the host sends `starter.prompt` with `origin: "starter"`.
   */
  onStarter: (starter: ChatStarter) => void;
  /** 'case' renders the compact Case Manager variant with its case chips. */
  variant?: 'workspace' | 'case';
  /** Starters cannot be used right now (a thread is restoring, a turn is running). */
  disabled?: boolean;
  className?: string;
  /** `/chat/context` failed and nothing is cached (the case variant's access popover). */
  error?: string | null;
  /** Retry the context read (`useChatContext().refresh`). */
  onRetry?: () => void;
  /**
   * Workspace: the home starters; null or absent when the viewer switched them off.
   * Case: the host's read of the case chips (absent: the chips read them themselves).
   */
  starters?: ChatStartersController | null;
  /** The signed-in username (greeting, and the per-principal suggestion cache). */
  principal?: string | null;
  /** Workspace: the keys of the cards on screen (for the `viewed` event). */
  onShownKeysChange?: (keys: string[]) => void;
  /** Case: the case its chips are read for. */
  caseId?: string | null;
}

function AccessLink({
  context,
  error,
  onRetry,
}: {
  context: ChatContextInfo | null;
  error: string | null;
  onRetry?: () => void;
}) {
  return (
    <AccessPopover context={context} error={error} onRetry={onRetry} side="bottom" align="start">
      <button
        type="button"
        className={cn(
          'rounded-sm text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline',
          focusRing,
        )}
      >
        {ACCESS_LINK}
      </button>
    </AccessPopover>
  );
}

export function EmptyState({
  context,
  onStarter,
  variant = 'workspace',
  disabled = false,
  className,
  error = null,
  onRetry,
  starters = null,
  principal = null,
  onShownKeysChange,
  caseId = null,
}: EmptyStateProps) {
  if (variant === 'case') {
    return (
      <div className={cn('space-y-2 py-2', className)} data-testid="case-chat-start">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-sm text-muted-foreground">{CASE_CAPABILITY_LINE}</p>
          <AccessLink context={context} error={error} onRetry={onRetry} />
        </div>
        {caseId ? (
          <CaseStarterChips caseId={caseId} principal={principal} disabled={disabled} onSend={onStarter} starters={starters} />
        ) : null}
      </div>
    );
  }
  return (
    <StartScreen
      context={context}
      starters={starters}
      principal={principal}
      disabled={disabled}
      onActivate={onStarter}
      onShownKeysChange={onShownKeysChange}
      className={className}
    />
  );
}
