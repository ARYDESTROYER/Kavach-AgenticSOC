/**
 * Round 15 (SPEC D6.6, D6.9, D6.11, D6.12): the auto-close review, in a side sheet over
 * the case. Start review (the primary action on a pending sample) and "Review this
 * auto-close" (Take action, on any other agent-closed case) both open it.
 *
 * The sheet is NON-blocking: the case stays readable and scrollable beside it while the
 * reviewer works, and a click on the case does not close it (only Close, Cancel or
 * Escape do), so evidence can be read between answering and comparing. The card itself
 * is its own lazy chunk; a new `session` remounts it, so the time it measures starts when
 * it opens. Focus lands on the sheet's title and returns to the control that opened it.
 * The card does not repeat the pending band's sentence: the band stays in view beside the
 * sheet, and the sheet's own description says what the review does.
 */
import * as React from 'react';

import type { Case } from '@/lib/types';
import type { ReviewResult } from '@/lib/types-reviews';
import { LoadingState } from '@/design-system';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet';

import { REVIEW_MENU_LABEL } from './review-plan';

/** The card's chunk, also used to warm it before the sheet opens. */
export const loadReviewCard = () => import('./ReviewCard');
const ReviewCard = React.lazy(loadReviewCard);

/** What the sheet says the review does (and does not do) to the case. */
export const REVIEW_SHEET_DESCRIPTION =
  'Your answer is kept as ground truth for tuning and precedent. It does not change the case unless you reopen it.';

export interface ReviewSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseData: Case | null;
  /** The viewer holds `cases:close` (Reopen after a disagreement). */
  canReopen: boolean;
  /** Remounts the card: a new review session, with its own elapsed time. */
  session: number;
  /** Where focus returns when the sheet closes (Start review or Take action). */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onRecorded: (result: ReviewResult) => void;
  onReopened: (updated: Case | null, escalated: boolean) => void;
}

export function ReviewSheet({
  open,
  onOpenChange,
  caseData,
  canReopen,
  session,
  returnFocusRef,
  onRecorded,
  onReopened,
}: ReviewSheetProps) {
  const titleRef = React.useRef<HTMLHeadingElement | null>(null);
  return (
    <Sheet open={open && Boolean(caseData)} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        size="default"
        className="overflow-y-auto p-5"
        data-testid="case-review-sheet"
        // Reading the case beside the sheet is part of the review: a click or focus on the
        // page never closes it.
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (target && target.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <div className="mb-5 space-y-1 pr-10">
          <SheetTitle
            ref={titleRef}
            tabIndex={-1}
            className="text-base font-semibold leading-8 text-foreground outline-none"
          >
            {REVIEW_MENU_LABEL}
          </SheetTitle>
          <SheetDescription className="text-xs leading-relaxed">{REVIEW_SHEET_DESCRIPTION}</SheetDescription>
        </div>
        {caseData ? (
          <React.Suspense
            fallback={<LoadingState label="Loading the review" layout="panel" shape="rows" shapeRows={3} />}
          >
            <ReviewCard
              key={`${caseData.case_id}:${session}`}
              caseData={caseData}
              canReopen={canReopen}
              onRecorded={onRecorded}
              onReopened={onReopened}
              onCancel={() => onOpenChange(false)}
            />
          </React.Suspense>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export default ReviewSheet;
