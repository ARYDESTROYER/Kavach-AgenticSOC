/**
 * `ChartCard`: a titled module wrapping a chart or list body, shared by the Analytics pages
 * and the dashboard widget bodies so they never re-roll their own chrome.
 *
 * Round 14 (SPEC §4.9.2, C7 option 1): it keeps its name and API but renders on the shared
 * `Panel`, the Overview's tinted borderless module: the panel's 14px title row, no header
 * rule and no icon chip. `icon` and `accentClass` are still accepted so no caller breaks;
 * they no longer draw anything (an icon beside every module title carried no information
 * the title did not, and it was the loudest mark on the page after the data).
 *
 * SECURITY (#9): `title` is caller-supplied text (a widget title may be operator-authored,
 * UNTRUSTED). It is rendered as PLAIN text, never `dangerouslySetInnerHTML`. Callers must
 * keep passing plain strings.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { Panel, type PanelHeadingLevel } from '@/design-system/panel';
import { cn } from '@/lib/cn';

export interface ChartCardProps {
  /** Section title: PLAIN text (#9), never markup. */
  title: string;
  /**
   * @deprecated Round 14: module titles carry no icon chip. Accepted so existing callers
   * compile; nothing is drawn.
   */
  icon?: LucideIcon;
  /** @deprecated Round 14: the icon chip is gone, so its colour is unused. */
  accentClass?: string;
  children: React.ReactNode;
  className?: string;
  /** Optional title-row action on the right (e.g. a sort toggle or export link). */
  action?: React.ReactNode;
  /** A muted caption on the title's baseline, typically the window ("last 24 hours"). */
  caption?: React.ReactNode;
  /**
   * When true the BODY scrolls internally instead of the caller clipping it: the panel
   * becomes a `min-h-0` flex column and the content area gets `min-h-0 flex-1
   * overflow-auto`, so a tall body (a long table, the MITRE heatmap) sitting in a
   * FIXED-height dashboard cell scrolls within the panel rather than being cut off. Off by
   * default, so a page that lets the module grow is unaffected. Pair with an
   * `overflow-hidden` outer wrapper (WidgetShell does) so the panel still clips to its
   * grid cell.
   */
  scrollBody?: boolean;
  /**
   * Heading level of the title. `2` (default): a module directly under the page `h1`, a
   * dashboard widget, or an Analytics module. `3`: a module inside a titled group (under a
   * section `h2`), so the heading outline keeps the group above its charts (WCAG 1.3.1).
   */
  level?: PanelHeadingLevel;
}

/**
 * A titled module on the tinted panel with an optional right-aligned action, wrapping a
 * flex-column body. Equal-height friendly (`flex flex-col` + a `flex-1` body) so it tiles
 * cleanly in a dashboard grid.
 */
export function ChartCard({ title, children, className, action, caption, scrollBody = false, level = 2 }: ChartCardProps) {
  return (
    <Panel
      title={title}
      caption={caption}
      actions={action}
      level={level}
      className={cn('flex h-full flex-col', scrollBody && 'min-h-0', className)}
      data-chart-card=""
    >
      <div className={cn('flex-1', scrollBody && 'min-h-0 overflow-auto')}>{children}</div>
    </Panel>
  );
}

/** Centered inline empty hint for a chart card (no data in the active window). */
export function ChartEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center px-2 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
