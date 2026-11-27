/**
 * True while an element is narrower than `px` (measured with a ResizeObserver), so a run
 * view renders ONE variant (the one-line strip, the short progress line) rather than two
 * copies hidden by CSS, which would double ids and tab stops.
 *
 * It returns a callback ref and follows whatever element that ref is given: a caller that
 * swaps its root element (a skeleton, then the run) is measured again on the new node
 * instead of watching a detached one. A zero width is an unlaid-out node (jsdom, a hidden
 * tab, a node on its way out) and never changes the answer. Without a ResizeObserver (old
 * browsers) the element is measured once.
 */
import * as React from 'react';

export function useNarrow(px = 640): [boolean, (el: HTMLElement | null) => void] {
  const [el, setEl] = React.useState<HTMLElement | null>(null);
  const [narrow, setNarrow] = React.useState(false);
  React.useLayoutEffect(() => {
    if (!el) return undefined;
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setNarrow(width < px);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, px]);
  return [narrow, setEl];
}
