/**
 * Skip links (WCAG 2.4.1). The Console routes by the URL hash, so a plain fragment link
 * such as `href="#socMain"` hands the fragment to the router, which reads it as an unknown
 * page and opens Overview (an open case is lost). A skip link keeps its href, so it stays a
 * real link in the tab order, and moves focus to its target in code; the hash never changes.
 * The target is rendered by the same component as the link and carries `tabIndex={-1}`;
 * focusing it scrolls it into view.
 */
import type * as React from 'react';

export const skipToTarget = (event: React.MouseEvent<HTMLAnchorElement>): void => {
  event.preventDefault();
  (document.querySelector(event.currentTarget.hash) as HTMLElement).focus();
};
