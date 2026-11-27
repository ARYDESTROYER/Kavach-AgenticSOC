/**
 * The setup wizard's stage heading, shared by the stages that ship with first paint
 * (Wizard.tsx) and the two that load on demand (RuntimeReviewSteps.tsx).
 *
 * The stage's name is already the current item of the progress rail (and of the progress
 * strip on a phone), so there is no overline above the title. The title takes focus after
 * every transition: `outline-0` rather than `outline-none`, whose transparent outline
 * forced-colours mode paints as a box.
 */
import * as React from 'react';

export function StepHeading({
  headingRef,
  title,
  description,
}: {
  headingRef: React.RefObject<HTMLHeadingElement>;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-8 border-b border-border pb-6">
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-2xl font-semibold text-foreground outline-0 sm:text-3xl"
      >
        {title}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
        {description}
      </p>
    </div>
  );
}
