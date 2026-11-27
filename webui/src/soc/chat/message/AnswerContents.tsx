/**
 * Long-answer ergonomics (Round 12 SYNTHESIS-chat P1-6): an automatic mini table of
 * contents for an answer with four or more headings, and a "Jump to end" anchor for a
 * long answer.
 *
 *   - The headings are read from the RENDERED answer (the prose's own `h4`–`h6`, in
 *     document order), so the contents always match what is on screen, whatever the
 *     Markdown nesting. Their text is the model's: it is copied as text, never markup.
 *   - Entries are buttons that scroll to and focus the heading; never `#fragment` links
 *     (the console router owns `location.hash`). Reduced motion: no smooth scrolling.
 *     An empty heading (`## ` alone) is not listed, and the jump looks the entry up in
 *     the same filtered list, so an entry always lands on its own heading.
 *   - "Jump to end" scrolls to an IN-FLOW end marker (never an absolutely positioned
 *     `sr-only` one, whose static position in the answer's grid is the article's first
 *     line) with a bottom scroll margin taller than the transcript's jump band.
 *   - A labelled `role="group"`, not a `<nav>`: a transcript of long answers would flood
 *     the landmark list.
 */
import * as React from 'react';
import { ArrowDownToLine } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { usePrefersReducedMotion } from '@/soc/hooks/usePrefersReducedMotion';
import { REVEAL_SCROLL_MARGIN } from './reveal';

/** Headings that earn a table of contents. */
export const TOC_MIN_HEADINGS = 4;
/** Characters that make an answer long enough for "Jump to end" on its own. */
export const LONG_ANSWER_CHARS = 3000;
/** The selector of the answer prose's headings (ChatMarkdown renders h4–h6 under an h3). */
const HEADING_SELECTOR = 'h4, h5, h6';

export interface AnswerHeading {
  text: string;
  level: number;
}

function headingText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The listed heading ELEMENTS of an answer container: non-empty, in document order. */
export function headingElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR)).filter((el) => headingText(el).length > 0);
}

/** The rendered headings of an answer container, in document order (empty ones skipped). */
export function readHeadings(container: HTMLElement | null): AnswerHeading[] {
  return headingElements(container).map((el) => ({ text: headingText(el), level: Number(el.tagName.slice(1)) || 4 }));
}

/**
 * The headings of the answer in `ref` once it is settled (`settled` false while it
 * streams: the contents would jump about as text arrives).
 */
export function useAnswerHeadings(ref: React.RefObject<HTMLElement>, text: string, settled: boolean): AnswerHeading[] {
  const [headings, setHeadings] = React.useState<AnswerHeading[]>([]);
  React.useLayoutEffect(() => {
    if (!settled) {
      setHeadings((prev) => (prev.length ? [] : prev));
      return;
    }
    const next = readHeadings(ref.current);
    setHeadings((prev) =>
      prev.length === next.length && prev.every((h, i) => h.text === next[i].text && h.level === next[i].level) ? prev : next,
    );
  }, [ref, text, settled]);
  return headings;
}

export interface AnswerContentsProps {
  headings: readonly AnswerHeading[];
  /** The rendered answer (the headings are looked up in it when an entry is chosen). */
  answerRef: React.RefObject<HTMLElement>;
  /** Offer "Jump to end" (a long answer). */
  showJump: boolean;
  /** The element "Jump to end" scrolls to and focuses. */
  endRef: React.RefObject<HTMLElement>;
  className?: string;
}

/**
 * The end marker "Jump to end" lands on: an in-flow, zero-height line (so it sits where
 * the answer ends, not at the grid's start), focusable, with a bottom scroll margin
 * taller than the transcript's jump band. Its text is for screen readers only.
 */
export const AnswerEnd = React.forwardRef<HTMLParagraphElement, { className?: string }>(function AnswerEnd({ className }, ref) {
  return (
    <p
      ref={ref}
      tabIndex={-1}
      className={cn('h-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring', REVEAL_SCROLL_MARGIN, className)}
      data-testid="answer-end"
    >
      <span className="sr-only">End of answer</span>
    </p>
  );
});

export function AnswerContents({ headings, answerRef, showJump, endRef, className }: AnswerContentsProps) {
  const reduceMotion = usePrefersReducedMotion();
  const showToc = headings.length >= TOC_MIN_HEADINGS;
  if (!showToc && !showJump) return null;
  const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';

  const goTo = (index: number) => {
    // The same filtered list the entries were built from (an empty heading is skipped).
    const el = headingElements(answerRef.current)[index];
    if (!el) return;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.scrollIntoView?.({ block: 'start', behavior });
    el.focus({ preventScroll: true });
  };
  const jumpToEnd = () => {
    const el = endRef.current;
    if (!el) return;
    el.scrollIntoView?.({ block: 'end', behavior });
    el.focus({ preventScroll: true });
  };

  return (
    <div
      role="group"
      aria-label="Answer contents"
      className={cn('flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs text-muted-foreground', className)}
      data-testid="answer-contents"
    >
      {showToc ? (
        <>
          <span className="font-medium text-foreground">Contents</span>
          <ol className="contents">
            {headings.map((heading, index) => (
              <li key={`${index}-${heading.text}`} className="inline-flex items-baseline gap-1.5">
                {index > 0 ? (
                  <span className="text-muted-foreground/60" aria-hidden>
                    ·
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => goTo(index)}
                  className={cn('max-w-[16rem] truncate rounded-sm text-primary underline-offset-2 hover:underline', heading.level > 4 && 'text-primary/80', focusRing)}
                >
                  {heading.text}
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {showJump ? (
        <button
          type="button"
          onClick={jumpToEnd}
          className={cn('inline-flex items-center gap-1 rounded-sm text-primary underline-offset-2 hover:underline', showToc && 'ml-2', focusRing)}
        >
          <ArrowDownToLine className="size-3.5" aria-hidden />
          Jump to end
        </button>
      ) : null}
    </div>
  );
}
