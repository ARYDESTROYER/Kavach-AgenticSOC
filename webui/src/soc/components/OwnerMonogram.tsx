/**
 * OwnerMonogram — the ONE assignee monogram (Cases list, Case Manager queue, case header).
 *
 * A 20px solid disk with the owner's initial, the Apple Contacts monogram: a neutral fill
 * with a light letter, so it reads as a person and never as a stray character beside the
 * row's status. Round 12 polish: the three call sites each drew their own chip on
 * `bg-surface-sunken`, which in dark mode IS the panel colour, so unselected queue rows
 * showed a bare "A" next to "Escalated" and the header a bare "S" before "sgupta".
 *
 * Colours are theme tokens, MEASURED in both themes (WCAG relative luminance):
 * - disk `--muted-foreground` against the card: 5.98:1 light, 6.72:1 dark (5.24:1 and
 *   5.58:1 on a selected queue row), so the shape is visible on every row state;
 * - letter `--background` on the disk: 5.98:1 light, 7.23:1 dark (AA for 11px text).
 * The border is the fill's own colour: invisible normally, and the ring that keeps the
 * disk visible under forced colours, where backgrounds are dropped.
 *
 * The owner name is case-derived (UNTRUSTED, #9): plain text only, here and in the label.
 * It is a named image ("Assigned to sgupta") unless the visible name sits right beside it,
 * where `decorative` hides it so a screen reader does not hear the name twice.
 */
import { cn } from '@/lib/cn';

/** The first letter or digit of a name, upper-cased ("asmith" → "A", "_svc" → "S"). */
export function ownerInitial(name: string): string {
  const t = name.trim();
  if (!t) return '';
  const first = Array.from(t).find((ch) => /[\p{L}\p{N}]/u.test(ch)) ?? Array.from(t)[0];
  return first.toLocaleUpperCase();
}

/** The accessible name and tooltip of an owner monogram. */
export function assignedToLabel(name: string): string {
  return `Assigned to ${name.trim()}`;
}

export interface OwnerMonogramProps {
  /** The assignee (case-derived, rendered as plain text). Empty renders nothing. */
  name: string;
  /** The visible name sits beside the disk: hide the disk from assistive tech. */
  decorative?: boolean;
  className?: string;
}

/** The class string of the disk, exported for the regression test. */
export const OWNER_MONOGRAM_CLASS =
  'inline-flex size-5 shrink-0 select-none items-center justify-center rounded-full ' +
  'border border-muted-foreground bg-muted-foreground text-2xs font-semibold leading-none text-background';

export function OwnerMonogram({ name, decorative = false, className }: OwnerMonogramProps) {
  const owner = name.trim();
  if (!owner) return null;
  const label = assignedToLabel(owner);
  return (
    <span
      data-testid="owner-monogram"
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      title={label}
      className={cn(OWNER_MONOGRAM_CLASS, className)}
    >
      {ownerInitial(owner)}
    </span>
  );
}

export default OwnerMonogram;
