/**
 * Runbook progress chips (Round 14, SPEC §4.10.7): "4/11", "5/9 · 1 blocked", "4/11 · 1
 * waiting", on the Runbook tab trigger, the Case Manager queue rows and the facts rail.
 *
 * Done counts only steps marked Done; Not applicable is never counted as done. The chip's
 * fact is always in text (WCAG 1.4.1): blocked and waiting are words, the tint only
 * repeats them. Colours come from the theme tokens.
 */
import { ListChecks } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { RunbookProgress } from '@/lib/types-runbooks';
import { progressChipLabel, progressChipText } from '@/soc/runbooks/shared/progress';

function tone(p: RunbookProgress): string {
  if (p.blocked > 0) return 'border-critical/40 text-critical-text';
  if (p.waiting > 0) return 'border-warning/50 text-warning-text';
  if (p.total > 0 && p.required_open === 0) return 'border-success/40 text-success-text';
  return 'border-border text-secondary-foreground';
}

/**
 * The chip inside a queue row. The row's own accessible name carries the same fact
 * (`progressChipLabel`), so the chip itself is hidden from assistive technology there.
 */
export function RunbookProgressChip({
  progress,
  className,
  decorative = false,
}: {
  progress: RunbookProgress;
  className?: string;
  /** True inside a control whose accessible name already states the progress. */
  decorative?: boolean;
}) {
  return (
    <span
      data-runbook-progress=""
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : progressChipLabel(progress)}
      role={decorative ? undefined : 'img'}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-1 py-px text-xs font-medium leading-tight tabular-nums',
        tone(progress),
        className,
      )}
    >
      <ListChecks className="size-3 shrink-0" aria-hidden />
      {progressChipText(progress)}
    </span>
  );
}

/**
 * The count beside the Runbook tab's label: "4/11", "None" when no runbook is on the case,
 * or "Abandoned" when the only runs on it were abandoned (their steps are still in the
 * tab), with the full sentence for screen readers ("Runbook, 4 of 11 steps done").
 */
export function RunbookTabCount({ progress, abandoned = false }: { progress: RunbookProgress | null; abandoned?: boolean }) {
  if (!progress) {
    return (
      <span
        className="rounded-sm bg-muted px-1.5 text-2xs font-medium text-muted-foreground"
        data-runbook-tab-count={abandoned ? 'abandoned' : 'none'}
      >
        <span className="sr-only">, </span>
        {abandoned ? 'Abandoned' : 'None'}
      </span>
    );
  }
  const waiting = progress.waiting > 0 || progress.blocked > 0;
  return (
    <span
      data-runbook-tab-count=""
      className={cn(
        'rounded-sm px-1.5 text-2xs font-medium tabular-nums',
        progress.blocked > 0
          ? 'bg-critical/10 text-critical-text'
          : waiting
            ? 'bg-warning/10 text-warning-text'
            : 'bg-primary/10 text-foreground',
      )}
    >
      <span aria-hidden>{progressChipText(progress)}</span>
      <span className="sr-only">, {progressChipLabel(progress).replace(/^Runbook: /, '')}</span>
    </span>
  );
}
