/**
 * FollowUps — up to three suggested next questions under the LATEST answer only
 * (chat revamp SPEC §10.3). A chip sends its text with `origin: "follow_up"`, so the
 * model-suggested wording never counts as user-authored for the indicator taint rule
 * (SPEC §4.8.2). Chips never touch the composer draft.
 */
import { CornerDownRight } from 'lucide-react';

import { cn } from '@/lib/cn';

export interface FollowUpsProps {
  items: readonly string[];
  onPick: (text: string) => void;
  disabled?: boolean;
  className?: string;
}

export function FollowUps({ items, onPick, disabled = false, className }: FollowUpsProps) {
  if (!items.length) return null;
  return (
    <div role="group" aria-label="Suggested follow-ups" className={cn('flex flex-wrap gap-1.5', className)}>
      {items.slice(0, 3).map((text, index) => (
        <button
          key={`${index}-${text}`}
          type="button"
          disabled={disabled}
          onClick={() => onPick(text)}
          className="inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-left text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
        >
          <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0">{text}</span>
        </button>
      ))}
    </div>
  );
}
