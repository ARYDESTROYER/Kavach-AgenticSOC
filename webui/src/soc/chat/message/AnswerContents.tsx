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
 *   - A labelled `role="group"`, not a `<nav>`: a transcript of long answers would flood
 *     the landmark list.
 */
import * as React from 'react';
import { ArrowDownToLine } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { usePrefersReducedMotion } from '@/soc/hooks/usePrefersReducedMotion';

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

/** The rendered headings of an answer container, in document order. */
export function readHeadings(container: HTMLElement | null): AnswerHeading[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(HEADING_SELECTOR))
    .map((el) => ({ text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(), level: Number(el.tagName.slice(1)) || 4 }))
    .filter((heading) => heading.text.length > 0);
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

export function AnswerContents({ headings, answerRef, showJump, endRef, className }: AnswerContentsProps) {
  const reduceMotion = usePrefersReducedMotion();
  const showToc = headings.length >= TOC_MIN_HEADINGS;
  if (!showToc && !showJump) return null;
  const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';

  const goTo = (index: number) => {
    const el = answerRef.current?.querySelectorAll<HTMLElement>(HEADING_SELECTOR)[index];
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
