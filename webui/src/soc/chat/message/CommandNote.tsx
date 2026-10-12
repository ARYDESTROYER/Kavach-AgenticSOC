/**
 * CommandNote — the reply to a chat command (`/compact`, Round 12 SPEC D4; final review)
 * shown as a quiet system note instead of an answer:
 *
 *   ≡  Summarised 2 earlier exchanges. The conversation continues from the summary.
 *      No model call · $0
 *
 * The first line is the server's own sentence (what was summarised, or why nothing
 * was). The second is what the command cost: "No model call · $0" when no model call
 * ran (Demo Mode, nothing to summarise, bounded chat, an unsaved conversation), or the
 * summary call's usage figure, which opens the usage card like an answer's (#6: the
 * spend stays visible). A reply without usage shows no figure, never "Usage not
 * recorded" (that wording is for legacy answers).
 *
 * A command reply read no source and is not an answer, so the note names no source and
 * offers no answer actions (rate, copy, add to case, add to report, ask again).
 */
import { ListCollapse } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { ChatCommand, ChatResponse } from '@/lib/types';
import { UsageCard } from './UsageCard';

/** What the note says when the reply carries no text (a Stop before anything ran). */
export const COMMAND_NOTE_EMPTY: Record<ChatCommand, string> = {
  compact: 'Nothing was summarised.',
};

/** The cost line when the command made no model call. */
export const COMMAND_NOTE_FREE = 'No model call · $0';

export interface CommandNoteProps {
  /** A settled reply whose `command` is set. */
  response: ChatResponse;
  className?: string;
}

export function CommandNote({ response, className }: CommandNoteProps) {
  const command = response.command ?? 'compact';
  const text = response.answer.trim() || COMMAND_NOTE_EMPTY[command];
  const usage = response.usage ?? null;
  const free = !!usage && usage.calls === 0 && usage.total_tokens === 0;
  return (
    <div
      role="note"
      className={cn('flex items-start gap-1.5 text-xs text-muted-foreground', className)}
      data-testid="answer-command-note"
      data-command={command}
    >
      <ListCollapse className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="text-pretty">{text}</p>
        {usage ? (
          <p className="tabular-nums" data-testid="command-note-usage">
            {free ? COMMAND_NOTE_FREE : <UsageCard usage={usage} />}
          </p>
        ) : null}
      </div>
    </div>
  );
}
