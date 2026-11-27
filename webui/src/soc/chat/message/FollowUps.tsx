/**
 * FollowUps — the suggested next questions under the LATEST answer only (chat revamp SPEC
 * §10.3; Round 13 SPEC-chat §4.2). A chip sends its text with `origin: "follow_up"`, so
 * the model-suggested wording never counts as user-authored for the indicator taint rule
 * (SPEC §4.8.2). Chips never touch the composer draft.
 *
 * Round 13: quiet GHOST chips in one wrapping row in the reading column (no border, a
 * leading ↳ glyph, the label wrapping inside the chip when it must, never truncated); the
 * zero-result chips join the same row after them (`ZeroResultChips`), so the answer ends
 * on ONE row of suggestions instead of up to five rows of outlined chips. The host passes
 * at most `limit` items (the back-off, `follow-up-backoff.ts`).
 */
import { CornerDownRight } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

/** The ghost chip every answer suggestion shares (follow-ups and zero-result chips). */
export const SUGGESTION_CHIP = cn(
  // Proportional numerals: chip labels are prose (tabular ones set hyphens wide).
  'inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs text-foreground proportional-nums transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none',
  focusRing,
);

/** One ghost chip: the ↳ glyph and a label that wraps inside the chip (never cut). */
export function SuggestionChip({
  label,
  onClick,
  disabled = false,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} title={title} className={SUGGESTION_CHIP}>
      <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 break-words">{label}</span>
    </button>
  );
}

export interface FollowUpsProps {
  items: readonly string[];
  onPick: (text: string) => void;
  /** How many chips to offer (3, or 1 after the back-off). */
  limit?: number;
  disabled?: boolean;
  className?: string;
}

export function FollowUps({ items, onPick, limit = 3, disabled = false, className }: FollowUpsProps) {
  const shown = items.slice(0, Math.max(0, Math.min(3, limit)));
  if (!shown.length) return null;
  return (
    <div role="group" aria-label="Suggested follow-ups" className={cn('flex max-w-full flex-wrap items-center gap-1', className)}>
      {shown.map((text, index) => (
        <SuggestionChip key={`${index}-${text}`} label={text} disabled={disabled} onClick={() => onPick(text)} />
      ))}
    </div>
  );
}
