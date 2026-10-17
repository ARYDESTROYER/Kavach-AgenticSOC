/**
 * CatchUpLine — "Since 09:12: 5 new cases (2 critical), 1 of your cases changed and
 * Wazuh quiet for 3 hours." (SPEC-chat §3.6, §5.2, §5.6).
 *
 * The server words every clause and keeps the whole line within 160 characters; this
 * renders it in exactly that shape: a `p` whose clauses are inline buttons, each named
 * by its clause text and described by the question it sends (a hidden description, so
 * the paragraph reads once). Clicking a clause sends that question as a starter
 * (`origin: "starter"`). Nothing here is a live region: a refresh is never announced.
 *
 * Two placements: the start screen's second line (`home`), and one quiet line above the
 * composer in an open conversation (`thread`), which adds a Hide button. All text is
 * server text rendered as React text only (#9). The descriptions sit outside the
 * paragraph (hidden), so copying the line copies only what it shows.
 */
import * as React from 'react';
import { X } from 'lucide-react';

import type { ChatCatchUp, ChatStarter } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export interface CatchUpLineProps {
  catchUp: ChatCatchUp;
  /** Send the clause's question (the host calls `engine.send(prompt, {origin: 'starter'})`). */
  onSend: (starter: ChatStarter) => void;
  /** A turn runs or a thread restores: the clauses are shown but not usable. */
  disabled?: boolean;
  variant?: 'home' | 'thread';
  /** `thread` only: the Hide button. */
  onHide?: () => void;
  className?: string;
}

/** "a", "a and b", "a, b and c" (the server's own join). */
function separator(index: number, count: number): string {
  if (index === 0) return '';
  return index === count - 1 ? ' and ' : ', ';
}

export function CatchUpLine({ catchUp, onSend, disabled = false, variant = 'home', onHide, className }: CatchUpLineProps) {
  const baseId = React.useId();
  const clauses = catchUp.clauses;
  if (!clauses.length) return null;
  const line = (
    <p
      className={cn(
        variant === 'home' ? 'text-base text-muted-foreground' : 'min-w-0 flex-1 text-sm text-muted-foreground',
        variant === 'home' && className,
      )}
      data-testid={variant === 'home' ? 'catch-up-line' : 'thread-catch-up-line'}
    >
      {`Since ${catchUp.since_label}: `}
      {clauses.map((clause, index) => {
        const describedBy = `${baseId}-c${index}`;
        return (
          <React.Fragment key={clause.starter.key ?? `${clause.starter.id}-${index}`}>
            {separator(index, clauses.length)}
            <button
              type="button"
              aria-disabled={disabled || undefined}
              aria-describedby={describedBy}
              data-starter={clause.starter.id}
              onClick={() => {
                if (!disabled) onSend(clause.starter);
              }}
              className={cn(
                'inline rounded-sm font-medium text-foreground underline-offset-4 hover:underline',
                'aria-disabled:cursor-not-allowed aria-disabled:no-underline aria-disabled:opacity-60',
                focusRing,
              )}
            >
              {clause.text}
            </button>
          </React.Fragment>
        );
      })}
      .
    </p>
  );
  // The question each clause sends, read as its description (never shown).
  const descriptions = (
    <div hidden>
      {clauses.map((clause, index) => (
        <span key={clause.starter.key ?? `${clause.starter.id}-${index}`} id={`${baseId}-c${index}`}>
          {clause.starter.prompt}
        </span>
      ))}
    </div>
  );
  if (variant === 'home') {
    return (
      <>
        {line}
        {descriptions}
      </>
    );
  }
  return (
    <div className={cn('flex items-start gap-2', className)} data-testid="thread-catch-up">
      {line}
      {descriptions}
      {onHide ? (
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide this summary"
          className={cn(
            '-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground',
            focusRing,
          )}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
