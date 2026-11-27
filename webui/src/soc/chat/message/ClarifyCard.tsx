/**
 * ClarifyCard — the assistant asks instead of guessing (Round 12 SPEC D10, SYNTHESIS-chat
 * P0-11): its question, up to four option chips and "Something else…" (free text).
 *
 *   - The question and the options are MODEL-authored and may echo log values (#9):
 *     they arrive display-sanitised (`normaliseClarify`) and render as text nodes only.
 *   - A pick sends the option with `origin: "clarify"` (the follow-up taint class), so a
 *     value the model suggested never counts as typed by the analyst. Text the analyst
 *     types after "Something else…" is theirs and goes out as `origin: "user"`.
 *   - Only the latest answer offers the chips ("Needs input"). Once the analyst has
 *     answered, the card keeps the question as a quiet line.
 */
import * as React from 'react';
import { CornerDownRight, MessageCircleQuestion, SendHorizontal } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import type { ChatClarify } from '@/lib/types';
import { Button } from '@/ui/button';
import { REVEAL_SCROLL_MARGIN, revealAndFocus } from './reveal';

export const CLARIFY_CUSTOM_LABEL = 'Something else…';
export const NEEDS_INPUT_LABEL = 'Needs input';

export interface ClarifyCardProps {
  clarify: ChatClarify;
  /** The latest answer: the chips and "Something else…" are offered. */
  active: boolean;
  /** An answer is being written in this thread (chips wait for it). */
  disabled?: boolean;
  /** Send an option (`origin: clarify`) or the analyst's own words (`origin: user`). */
  onPick: (text: string, own: boolean) => boolean;
  className?: string;
}

const CHIP =
  'inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-left text-xs text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none';

export function ClarifyCard({ clarify, active, disabled = false, onPick, className }: ClarifyCardProps) {
  const rawId = React.useId();
  const id = `clarify${rawId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const [custom, setCustom] = React.useState(false);
  const [text, setText] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const customButtonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    // The field opens at the bottom of the latest answer: bring the whole row (field,
    // Send, Cancel) clear of the transcript's bottom band, then focus the field.
    if (custom) revealAndFocus(formRef.current, inputRef.current);
  }, [custom]);

  if (!active) {
    return (
      <p className={cn('inline-flex items-start gap-1.5 text-xs text-muted-foreground', className)} data-testid="clarify-asked">
        <MessageCircleQuestion className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">Asked: {clarify.question}</span>
      </p>
    );
  }

  const sendCustom = () => {
    const value = text.trim();
    if (!value || disabled) return;
    if (onPick(value, true)) {
      setText('');
      setCustom(false);
    }
  };

  return (
    <div
      role="group"
      aria-labelledby={`${id}-q`}
      aria-describedby={`${id}-state`}
      className={cn('space-y-2 rounded-md border border-l-2 border-border border-l-warning bg-surface/50 px-3 py-2.5', className)}
      data-testid="clarify-card"
    >
      <p id={`${id}-state`} className="inline-flex items-center gap-1.5 text-2xs font-medium text-warning-text">
        <MessageCircleQuestion className="size-3.5" aria-hidden />
        {NEEDS_INPUT_LABEL}
      </p>
      <p id={`${id}-q`} className="break-words text-sm font-medium text-foreground">
        {clarify.question}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {clarify.options.map((option, index) => (
          <button
            key={`${index}-${option}`}
            type="button"
            disabled={disabled}
            onClick={() => onPick(option, false)}
            className={cn(CHIP, focusRing)}
          >
            <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 break-words">{option}</span>
          </button>
        ))}
        {clarify.allow_custom && !custom ? (
          <button
            ref={customButtonRef}
            type="button"
            disabled={disabled}
            onClick={() => setCustom(true)}
            className={cn(CHIP, 'border-dashed text-muted-foreground', focusRing)}
          >
            {CLARIFY_CUSTOM_LABEL}
          </button>
        ) : null}
      </div>
      {clarify.allow_custom && custom ? (
        <form
          ref={formRef}
          className={cn('flex min-w-0 items-center gap-1.5', REVEAL_SCROLL_MARGIN)}
          onSubmit={(event) => {
            event.preventDefault();
            sendCustom();
          }}
        >
          <label htmlFor={`${id}-own`} className="sr-only">
            Your answer to: {clarify.question}
          </label>
          <input
            id={`${id}-own`}
            ref={inputRef}
            value={text}
            maxLength={2000}
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setCustom(false);
                window.setTimeout(() => customButtonRef.current?.focus(), 0);
              }
            }}
            placeholder="Type your answer"
            className={cn(
              'h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground',
              focusRing,
            )}
          />
          <Button type="submit" size="sm" className="h-7" disabled={disabled || !text.trim()}>
            <SendHorizontal aria-hidden />
            Send
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => {
              setCustom(false);
              window.setTimeout(() => customButtonRef.current?.focus(), 0);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}
    </div>
  );
}
