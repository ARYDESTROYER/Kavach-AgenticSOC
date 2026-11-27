/**
 * The pieces the navigation (`NavSidebar.tsx`, first paint) and its lazily loaded rail
 * layer (`nav-rail-interactions.tsx`) share: the viewer's destination shape, the chat
 * activity text, and the in-app link rule. Entry-safe and dependency-light.
 */
import type * as React from 'react';
import type { ChatActivitySummary } from '../chat-activity/store';
import type { NavChild, NavItem, PageId } from '../nav';

/** A visible top-level destination: the row, the page it opens and its visible pages. */
export interface Destination {
  item: NavItem;
  /** The page the row opens (`navTarget`). */
  target: PageId;
  /** The group's pages; empty for a plain destination (no chevron, no flyout). */
  pages: NavChild[];
}

/** Nav item id → its chat activity (`chat`: Workspace chat; `case_manager`: case chat). */
export type NavActivity = Partial<Record<string, ChatActivitySummary>>;

/** The visible state line: with reduced motion the ring stands still, so say "Working". */
export function activityText(activity: ChatActivitySummary | undefined, reducedMotion: boolean): string {
  if (!activity?.text) return '';
  return reducedMotion && activity.status === 'running' ? `Working. ${activity.text}` : activity.text;
}

/** The id of the hidden description a destination points at (`aria-describedby`). */
export const describedBy = (id: string, activity: ChatActivitySummary | undefined) =>
  activity?.text ? `nav-activity-${id}` : undefined;

/** A plain left click navigates in-app; a modified click keeps the browser's own behaviour. */
export function followLink(event: React.MouseEvent<HTMLAnchorElement>, go: () => void): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  go();
}

export const hrefOf = (page: PageId) => `#/${page}`;
