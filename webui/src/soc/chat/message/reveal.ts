/**
 * Revealing a control that opens at the bottom of the transcript (the feedback reason
 * panel, the clarify card's own-answer field, the "Jump to end" target).
 *
 * The transcript fades its bottom band behind the "Jump to latest" pill (a 2.5rem
 * pointer guard over a 4rem fade, `Transcript.tsx`). A plain `focus()` scrolls the target
 * only to the scroller's bottom edge, under that band, so the focused control is hidden
 * (WCAG 2.4.11), and the content that just opened makes the pill appear on top of it.
 * The whole region is scrolled into view first, with a bottom scroll margin taller than
 * the band, then the target is focused without a second scroll.
 */

/** A bottom scroll margin taller than the transcript's jump band (6rem > 4rem). */
export const REVEAL_SCROLL_MARGIN = 'scroll-mb-24';

/** Scroll `region` (carrying `REVEAL_SCROLL_MARGIN`) into view, then focus `target`. */
export function revealAndFocus(region: HTMLElement | null, target: HTMLElement | null): void {
  region?.scrollIntoView?.({ block: 'nearest' });
  target?.focus({ preventScroll: true });
}
