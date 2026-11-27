/**
 * ActionsTakenField: "what did you do about it" on a close or resolve (Round 15, SPEC
 * D4.2). A row of toggle chips over the fixed vocabulary (`ACTIONS_TAKEN_OPTIONS`), at
 * most `ACTIONS_TAKEN_MAX`, optional. "No action needed" stands alone: choosing it clears
 * the others, and choosing any other clears it.
 *
 * The values are stored on the case's history entry and the audit row's `changes`, and
 * shown in the Collaboration tab's History and the case Markdown export. Plain data a
 * person chose: never model text, never read by `decide()` (#3). Every label is fixed copy.
 */
import * as React from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/lib/cn';

import { ACTIONS_TAKEN_MAX, ACTIONS_TAKEN_OPTIONS, type WireActionTaken } from './shared';

const EXCLUSIVE: WireActionTaken = 'no_action_needed';

/** The next selection after toggling `value` (pure; the exclusivity and cap rules). */
export function toggleActionTaken(current: readonly WireActionTaken[], value: WireActionTaken): WireActionTaken[] {
  if (current.includes(value)) return current.filter((item) => item !== value);
  if (value === EXCLUSIVE) return [EXCLUSIVE];
  const next = current.filter((item) => item !== EXCLUSIVE);
  if (next.length >= ACTIONS_TAKEN_MAX) return [...next];
  return [...next, value];
}

export interface ActionsTakenFieldProps {
  value: readonly WireActionTaken[];
  onChange: (next: WireActionTaken[]) => void;
  disabled?: boolean;
  idPrefix?: string;
  className?: string;
}

export const ActionsTakenField: React.FC<ActionsTakenFieldProps> = ({
  value,
  onChange,
  disabled = false,
  idPrefix = 'actions-taken',
  className,
}) => {
  const labelId = `${idPrefix}-label`;
  const helpId = `${idPrefix}-help`;
  const full = value.filter((item) => item !== EXCLUSIVE).length >= ACTIONS_TAKEN_MAX;
  return (
    <div className={cn('space-y-2', className)} data-testid="actions-taken-field">
      <span id={labelId} className="block text-xs font-medium text-foreground">
        Actions taken <span className="font-normal text-muted-foreground">(optional)</span>
      </span>
      <div role="group" aria-labelledby={labelId} aria-describedby={helpId} className="flex flex-wrap gap-1.5">
        {ACTIONS_TAKEN_OPTIONS.map((option) => {
          const pressed = value.includes(option.value);
          const blocked = !pressed && full && option.value !== EXCLUSIVE;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={pressed}
              disabled={disabled || blocked}
              onClick={() => onChange(toggleActionTaken(value, option.value))}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-sm border px-2 text-xs transition-colors duration-fast',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
                pressed
                  ? 'border-primary/50 bg-primary/10 font-medium text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {pressed ? <Check className="size-3 shrink-0 text-primary" aria-hidden /> : null}
              {option.text}
            </button>
          );
        })}
      </div>
      <p id={helpId} className="text-xs leading-relaxed text-muted-foreground">
        {full
          ? `You can record up to ${ACTIONS_TAKEN_MAX} actions.`
          : 'Recorded with your classification in the case history.'}
      </p>
    </div>
  );
};

export default ActionsTakenField;
