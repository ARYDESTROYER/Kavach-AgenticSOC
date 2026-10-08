/**
 * EmptyState — the new-chat start surface (SPEC §10.5).
 *
 * Top-aligned in the 48rem lane: one capability line, then a 2×3 grid of starters
 * (one column below 560 px of lane width, each card ≤ 64 px tall), then the "What can
 * the assistant access?" link that opens the access popover. A starter card is shown
 * only when every tool it needs is allowed for this user, so a restricted role never
 * sees a card that would end in "Denied". Starter text is server-built from live
 * context (a case id, a source name) and renders as text (#9); clicking a card hands
 * the starter to the host, which sends its prompt with `origin: "starter"`.
 *
 * The Case Manager variant is a single compact line (no grid): its quick actions
 * belong to the case panel.
 *
 * States are explicit (UI standard): skeleton cards while `/chat/context` loads; one
 * honest line with Retry when it cannot be read (`error` with no context), instead of
 * skeletons that never resolve; nothing but the capability line when no starter is
 * allowed for this role.
 */
import type { ChatContextInfo, ChatStarter } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { AccessPopover, ContextUnavailable } from '../composer/AccessPopover';
import { toolsAllowed } from '../composer/commands';
import { starterIcon } from './starter-icons';

export interface EmptyStateProps {
  context: ChatContextInfo | null;
  /** Send the starter's prompt (the host calls engine.send(prompt, {origin: 'starter'})). */
  onStarter: (starter: ChatStarter) => void;
  /** 'case' renders the compact Case Manager variant (no starter grid). */
  variant?: 'workspace' | 'case';
  /** Starters cannot be sent right now (a thread is restoring, a turn is running). */
  disabled?: boolean;
  className?: string;
  /** `/chat/context` failed and nothing is cached (`useChatContext().error`). */
  error?: string | null;
  /** Retry the context read (`useChatContext().refresh`). */
  onRetry?: () => void;
}

/** SPEC §10.5 capability line. */
export const CAPABILITY_LINE =
  'Ask about your data, build a quick report, or learn how this console works. Read-only.';
const CASE_CAPABILITY_LINE = 'Ask about this case: what happened, the evidence and the decision. Read-only.';
const ACCESS_LINK = 'What can the assistant access?';
const MAX_STARTERS = 6;

/** The starters this user can run: every tool allowed, at most six, server order. */
export function visibleStarters(context: ChatContextInfo | null): ChatStarter[] {
  if (!context) return [];
  return (context.starters ?? []).filter((s) => s.tools.length === 0 || toolsAllowed(context, s.tools)).slice(0, MAX_STARTERS);
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
}: EmptyStateProps) {
  if (variant === 'case') {
    return (
      <div className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2', className)}>
        <p className="text-sm text-muted-foreground">{CASE_CAPABILITY_LINE}</p>
        <AccessLink context={context} error={error} onRetry={onRetry} />
      </div>
    );
  }

  const starters = visibleStarters(context);
  // A failed read with nothing cached is an error, not a load that never ends.
  const failed = context === null && Boolean(error);
  const loading = context === null && !failed;

  return (
    <section aria-label="Start a conversation" className={cn('@container w-full max-w-3xl pt-2', className)}>
      <p className="text-sm text-muted-foreground">{CAPABILITY_LINE}</p>
      {failed ? (
        <ContextUnavailable onRetry={onRetry} className="mt-4" />
      ) : loading ? (
        <div aria-hidden="true" className="mt-4 grid grid-cols-1 gap-2 @[560px]:grid-cols-2">
          {Array.from({ length: MAX_STARTERS }, (_, index) => (
            <div key={index} className="h-14 rounded-md border border-border/60 bg-muted/30" />
          ))}
        </div>
      ) : starters.length ? (
        <ul aria-label="Suggested questions" className="mt-4 grid grid-cols-1 gap-2 @[560px]:grid-cols-2">
          {starters.map((starter) => {
            const Icon = starterIcon(starter.id);
            return (
              <li key={starter.id} className="min-w-0">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onStarter(starter)}
                  data-starter={starter.id}
                  className={cn(
                    'group flex h-full max-h-16 w-full items-start gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-left',
                    'transition-colors hover:border-border-strong hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-50',
                    focusRing,
                  )}
                >
                  <Icon
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium leading-5 text-foreground">{starter.label}</span>
                    {starter.description ? (
                      <span className="block truncate text-xs leading-4 text-muted-foreground" title={starter.description}>
                        {starter.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {failed ? null : (
        <div className="mt-3">
          <AccessLink context={context} error={error} onRetry={onRetry} />
        </div>
      )}
    </section>
  );
}
