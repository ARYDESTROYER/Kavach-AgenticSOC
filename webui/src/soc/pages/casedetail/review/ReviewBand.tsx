/**
 * Round 15 (SPEC D6.12): the band under a pending sample's header. It says why the case
 * is here; the header's primary action, Start review, is what to do about it (D8.2), so
 * the band carries no second button. Shown only to a person who can record the review.
 */
import { ClipboardCheck } from 'lucide-react';

import { cn } from '@/lib/cn';

import { REVIEW_BAND_TEXT } from './review-plan';

export function ReviewBand({ className }: { className?: string }) {
  return (
    <div
      role="note"
      data-testid="case-review-band"
      className={cn(
        'flex items-start gap-2.5 rounded-md border border-primary/25 bg-primary/[0.06] px-3 py-2 text-sm text-foreground dark:bg-primary/[0.1]',
        className,
      )}
    >
      <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 leading-5">{REVIEW_BAND_TEXT}</p>
    </div>
  );
}

export default ReviewBand;
