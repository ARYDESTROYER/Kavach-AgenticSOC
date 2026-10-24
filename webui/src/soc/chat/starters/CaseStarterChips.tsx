/**
 * CaseStarterChips — the Case Manager chat's three case-scoped questions (SPEC-chat
 * §3.1 `case`, §3.14), read from `GET /api/chat/starters?surface=case&case_id=`.
 *
 * The server picks them from the case state ("Why does this case need a person, and
 * what would settle it?", "Summarise this case for a handoff note.", …). They name no
 * value (the case is the turn's scope), so clicking one sends its question in THIS case
 * chat with `origin: "starter"`; it never reaches personal Workspace history (#5).
 * Ghost chips, 28 px tall, wrapping (the label wraps inside the chip, never truncated).
 * A failed read shows nothing extra: the case chat's quick actions and composer work
 * without it. Text is server text rendered as React text only (#9).
 */
import { CornerDownRight } from 'lucide-react';

import type { ChatStarter } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { softBreakLongTokens } from './soft-breaks';
import { useChatStarters, type ChatStartersController } from './useChatStarters';

/** At most three chips (§3.14). */
export const CASE_CHIP_COUNT = 3;

export interface CaseStarterChipsProps {
  caseId: string;
  principal?: string | null;
  /** A turn runs: the chips are shown but not usable. */
  disabled?: boolean;
  onSend: (starter: ChatStarter) => void;
  /**
   * The host's own read of this case's chips (the case chat reads them once, to keep its
   * quick actions out of the way while chips show); absent: the chips read them here.
   */
  starters?: ChatStartersController | null;
  className?: string;
}

export function CaseStarterChips({
  caseId,
  principal = null,
  disabled = false,
  onSend,
  starters: hosted = null,
  className,
}: CaseStarterChipsProps) {
  const own = useChatStarters({ surface: 'case', caseId, principal, enabled: !!caseId && !hosted });
  const starters = hosted ?? own;
  const chips = (starters.info?.starters ?? [])
    .filter((starter) => (starter.action ?? 'send') === 'send')
    .slice(0, CASE_CHIP_COUNT);
  if (!chips.length) {
    // The row keeps its height while the first read runs, so nothing jumps when it lands.
    return starters.loading ? <div aria-hidden="true" className={cn('min-h-7', className)} /> : null;
  }
  return (
    <ul aria-label="Suggested questions" className={cn('flex flex-wrap gap-1.5', className)} data-testid="case-starter-chips">
      {chips.map((starter) => (
        <li key={starter.key ?? starter.id} className="min-w-0 max-w-full">
          <button
            type="button"
            aria-disabled={disabled || undefined}
            data-starter={starter.id}
            onClick={() => {
              if (!disabled) onSend(starter);
            }}
            className={cn(
              // Proportional numerals: the chip is prose (tabular ones set hyphens wide).
              'inline-flex min-h-7 max-w-full items-start gap-1.5 rounded-sm px-2 py-1 text-left text-xs text-foreground proportional-nums transition-colors',
              'hover:bg-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent',
              focusRing,
            )}
          >
            <CornerDownRight className="mt-px size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 break-words">{softBreakLongTokens(starter.prompt, { fit: true })}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
