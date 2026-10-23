/**
 * StarterCard — one "Right now" card on the new-chat start screen (SPEC-chat §5.2,
 * §5.6).
 *
 * A borderless `button` on a soft resting fill (`bg-muted/40`, hover `bg-hover`,
 * pressed `bg-accent`, the shared focus ring), at least 72 px tall. A 16 px family icon
 * sits left of the text; the QUESTION itself is the card text (for a `send` card it is
 * exactly what will be sent), wrapping freely and never truncated or clamped (a long id or
 * hash breaks where its line ends, never leaving a one or two character scrap on a line of
 * its own, and a case number or rule id never breaks at its hyphen: `softBreakLongTokens`;
 * `text-wrap: pretty` keeps a last word from standing alone on its line); under it
 * the muted reason line, after a decorative urgency dot (critical or attention; the
 * words carry the meaning). The accessible name is the question and the description the
 * reason line. Under `prefers-contrast: more` and forced colours the card gains a 1 px
 * border.
 *
 * The Hide button (24 px, "Hide for a day") sits in the top-right corner, shown on hover
 * and while the card has KEYBOARD focus (`:focus-visible` inside the card, so a card
 * focused by code after a mouse Hide does not keep showing it; opacity, never
 * `visibility`), always on a touch screen (no hover there, so it is never an invisible
 * target), and is out of the tab order: keyboard users press Delete or Backspace on the
 * card (the grid handles it), and Ctrl+Z (⌘Z) brings the card back while Undo is
 * offered. A paused card has no Hide button and declares no keys.
 *
 * Every string is server text rendered as React text only (#9): no HTML, no Markdown,
 * no link built from a value.
 */
import * as React from 'react';
import { X } from 'lucide-react';

import type { ChatStarter } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { ariaKeyShortcuts } from '../shortcuts/shortcut-list';
import { softBreakLongTokens } from './soft-breaks';
import { starterIcon } from './starter-icons';

/** The Hide button's tooltip and accessible name stem (§5.5). */
export const HIDE_FOR_A_DAY = 'Hide for a day';

/**
 * A hideable card's `aria-keyshortcuts`, from the shortcut sheet's own entries:
 * "Delete Backspace Control+Z Meta+Z".
 */
export const STARTER_CARD_KEYSHORTCUTS = ariaKeyShortcuts('hide-suggestion', 'undo-hide-suggestion');

/** The card's resting look (shared with the skeleton so both keep one height). */
export const STARTER_CARD_FRAME = 'min-h-[4.5rem] rounded-md bg-muted/40';

export interface StarterCardProps {
  starter: ChatStarter;
  /** Roving tab stop: 0 for the one card in the tab order, -1 for the rest. */
  tabIndex: 0 | -1;
  /** A turn runs, a thread restores or a promptbook runs: shown but not usable. */
  disabled?: boolean;
  onActivate: (starter: ChatStarter) => void;
  /** Hide this card for a day; omitted: no Hide button. */
  onHide?: (starter: ChatStarter) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onFocus?: () => void;
}

export const StarterCard = React.forwardRef<HTMLButtonElement, StarterCardProps>(function StarterCard(
  { starter, tabIndex, disabled = false, onActivate, onHide, onKeyDown, onFocus },
  ref,
) {
  const baseId = React.useId();
  const questionId = `${baseId}-q`;
  const reasonId = `${baseId}-r`;
  const Icon = starterIcon(starter.id);
  const reason = starter.reason || starter.description || '';
  const urgency = starter.urgency ?? 'none';
  return (
    <div className="group relative h-full">
      <button
        ref={ref}
        type="button"
        tabIndex={tabIndex}
        aria-labelledby={questionId}
        aria-describedby={reason ? reasonId : undefined}
        aria-disabled={disabled || undefined}
        // Delete or Backspace on the card hides it for a day, Ctrl+Z (⌘Z) undoes that
        // (the start stack handles the keys).
        aria-keyshortcuts={onHide && !disabled ? STARTER_CARD_KEYSHORTCUTS : undefined}
        data-starter={starter.id}
        data-starter-key={starter.key ?? undefined}
        onClick={() => {
          if (!disabled) onActivate(starter);
        }}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        className={cn(
          'flex h-full w-full items-start gap-3 px-3 py-3 text-left transition-colors',
          STARTER_CARD_FRAME,
          'hover:bg-hover active:bg-accent',
          'aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-muted/40',
          'contrast-more:border contrast-more:border-border-strong forced-colors:border forced-colors:border-[CanvasText]',
          onHide && 'pr-9',
          focusRing,
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/* Proportional numerals: the question and reason are prose (tabular ones set hyphens wide). */}
        <span className="min-w-0 flex-1 proportional-nums">
          <span id={questionId} className="block text-pretty break-words text-base font-medium text-foreground">
            {softBreakLongTokens(starter.prompt)}
          </span>
          {reason ? (
            <span id={reasonId} className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {urgency !== 'none' ? (
                <span
                  aria-hidden="true"
                  data-urgency={urgency}
                  className={cn('size-1.5 shrink-0 rounded-full', urgency === 'critical' ? 'bg-critical' : 'bg-warning')}
                />
              ) : null}
              <span className="min-w-0 break-words">{softBreakLongTokens(reason)}</span>
            </span>
          ) : null}
        </span>
      </button>
      {onHide && !disabled ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`${HIDE_FOR_A_DAY}: ${starter.prompt}`}
              onClick={() => onHide(starter)}
              className={cn(
                'absolute right-1.5 top-1.5 inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground',
                'opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 group-has-[:focus-visible]:opacity-100',
                'focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
                focusRing,
              )}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{HIDE_FOR_A_DAY}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
});
