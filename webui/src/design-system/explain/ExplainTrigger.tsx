/**
 * The Explain trigger (Round 16 SPEC §4.3 WP01 stub; WP11 builds the kit).
 *
 * Wraps a number the Console shows. `interactive` (the default) will open the one-line
 * formula on hover or focus and the full arithmetic on click, Enter, Space or a tap;
 * `row-hover` is the mouse-only HoverCard used inside a queue row, with no focusable
 * content (the row's accessible name carries the number). Until WP11 lands it renders
 * its children unchanged, so a mounted trigger changes nothing.
 *
 * Imported from `@/design-system/explain` (a separate entry, never the barrel) and
 * only from lazy route chunks, so it never reaches the entry bundle.
 */
import * as React from 'react';
import type { Explanation } from '@/lib/explain/types';

export type ExplainTriggerMode = 'interactive' | 'row-hover';

export interface ExplainTriggerProps {
  /** The explanation to show; `null` renders the children alone. */
  explanation: Explanation | null;
  children: React.ReactNode;
  mode?: ExplainTriggerMode;
}

export const ExplainTrigger: React.FC<ExplainTriggerProps> = ({ children }) => <>{children}</>;
