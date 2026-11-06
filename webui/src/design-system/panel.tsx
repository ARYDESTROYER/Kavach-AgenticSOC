/**
 * Panel and SectionTitle: the Overview's module grammar for every page (Round 14, SPEC
 * §4.9.1 and §4.9.2, operator choice C7 option 1).
 *
 * A Panel is one module: the tinted borderless `.surface-panel` (the `--panel` fill, a
 * 14px corner, no border, no resting shadow; `theme.css` owns the recipe and its
 * increased-contrast and forced-colours edges) with the Overview's padding (16px, 20px
 * from 1280px, 24px from 1920px) and the Overview's instrument title row: a 14px
 * semibold title, an optional muted count and caption on its baseline, and an aside or
 * actions on the right. `as="section"` (the default) makes it a labelled region named by
 * its own heading. `padding="none"` lets a table bleed to the panel edge while the title
 * row keeps the panel inset, so the first column lines up with the title.
 *
 * SectionTitle is the one title style for a module heading that sits ON the canvas above
 * a panel or a group (15px semibold, sentence case, an optional 13px caption and aside).
 * It replaces the tracked-capitals `h2`s.
 *
 * Nested cards are not part of the grammar: a `Card` inside a Panel fails the console
 * grammar guard test. All text is rendered as plain text nodes (#9); a title is a string,
 * never markup.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';

/** The panel inset (the Overview's `PANEL_PAD`): 16px, 20px from 1280px, 24px from 1920px. */
export const PANEL_PADDING = 'p-4 xl:p-5 3xl:p-6';
/** The same inset on the horizontal axis only (a title row over a full-bleed body). */
export const PANEL_PADDING_X = 'px-4 xl:px-5 3xl:px-6';
/**
 * The gutter between panels (and between modules on a page): it matches the panel
 * padding, 16px, 20px from 1280px, 24px from 1920px. Use it as the gap of a row or grid
 * of panels.
 */
export const PANEL_GAP = 'gap-4 xl:gap-5 3xl:gap-6';

export type PanelPadding = 'default' | 'none';
export type PanelHeadingLevel = 2 | 3;

export interface PanelProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  /** The module title (plain text, sentence case). It names the region. */
  title?: string;
  /**
   * A muted 13px caption on the title's baseline, typically the module's time span
   * ("last 24 hours", "all time", "open now"). It wraps rather than truncating: a cut
   * span is exactly the part a reader needs.
   */
  caption?: React.ReactNode;
  /** A muted count beside the title, formatted with thousands separators. */
  count?: number | string;
  /** Muted text on the right of the title row (a freshness stamp, a link). */
  aside?: React.ReactNode;
  /** Controls on the right of the title row (a button, a menu). */
  actions?: React.ReactNode;
  /** `section` (default) is a labelled region named by the title; `div` is plain. */
  as?: 'section' | 'div' | 'article';
  /**
   * `default` pads the whole panel; `none` pads only the title row, so a table or a
   * list bleeds to the panel edge and is clipped to its rounded corners.
   */
  padding?: PanelPadding;
  /** Heading level of the title: `2` under a page `h1` (default), `3` inside a titled group. */
  level?: PanelHeadingLevel;
  /** Id of the title heading (generated when omitted). */
  titleId?: string;
  children?: React.ReactNode;
}

function formatCount(count: number | string): string {
  if (typeof count === 'number') {
    return Number.isFinite(count) ? count.toLocaleString() : String(count);
  }
  return count;
}

/**
 * One module on the tinted panel. See the module comment for the grammar.
 *
 * `#__PURE__` and no `displayName` assignment (the named render function already names
 * it): this module is re-exported by the `@/design-system` index, which the entry imports,
 * so it must stay tree-shakeable or it would ship at first paint (SPEC §3.4).
 */
export const Panel = /*#__PURE__*/ React.forwardRef<HTMLElement, PanelProps>(function Panel(
  {
    title,
    caption,
    count,
    aside,
    actions,
    as: Comp = 'section',
    padding = 'default',
    level = 2,
    titleId: titleIdProp,
    className,
    children,
    ...rest
  },
  ref,
) {
  const generatedId = React.useId();
  const titleId = titleIdProp ?? `panel-title-${generatedId.replace(/:/g, '')}`;
  const hasTitle = typeof title === 'string' && title.trim().length > 0;
  const Heading = level === 3 ? 'h3' : 'h2';
  const bleed = padding === 'none';

  const titleRow =
    hasTitle || aside || actions ? (
      <div
        className={cn(
          'mb-3 flex flex-wrap items-center gap-x-4 gap-y-2',
          // A full-bleed body still gets an inset title, on the same edge as a padded one.
          bleed && cn(PANEL_PADDING_X, 'pt-4 xl:pt-5 3xl:pt-6'),
        )}
        data-panel-title-row=""
      >
        {hasTitle ? (
          <div className="mr-auto flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <Heading id={titleId} className="min-w-0 break-words text-base font-semibold text-foreground">
              {title}
            </Heading>
            {count != null && count !== '' ? (
              <span className="text-sm tabular-nums text-muted-foreground" data-panel-count="">
                {formatCount(count)}
              </span>
            ) : null}
            {caption ? (
              <span className="min-w-0 text-sm text-muted-foreground" data-panel-caption="">
                {caption}
              </span>
            ) : null}
          </div>
        ) : null}
        {aside || actions ? (
          <div className={cn('flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2', !hasTitle && 'ml-auto')}>
            {aside ? (
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                {aside}
              </div>
            ) : null}
            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
        ) : null}
      </div>
    ) : null;

  // A region is named by its own heading; without a title it stays unnamed (the caller can
  // still pass `aria-label`). `aria-labelledby` only ever points at a heading that exists.
  const labelledBy = Comp !== 'div' && hasTitle && !rest['aria-label'] ? titleId : undefined;

  return (
    <Comp
      ref={ref as React.Ref<HTMLElement & HTMLDivElement>}
      aria-labelledby={labelledBy}
      data-panel={padding}
      className={cn(
        'surface-panel min-w-0',
        bleed ? 'overflow-clip' : PANEL_PADDING,
        className,
      )}
      {...rest}
    >
      {titleRow}
      {children}
    </Comp>
  );
});

export interface SectionTitleProps {
  /** The title (plain text, sentence case). */
  title: string;
  /** Id of the heading, for a region that names itself by it (`aria-labelledby`). */
  id?: string;
  /** A muted 13px line under the title. */
  caption?: React.ReactNode;
  /** Muted content on the right (freshness, a link) or a small control. */
  aside?: React.ReactNode;
  /** Heading level: `2` under a page `h1` (default), `3` under a section. */
  level?: PanelHeadingLevel;
  className?: string;
}

/**
 * The module title on the canvas: 15px semibold, sentence case, with an optional 13px
 * caption under it and an aside on the right. It sets no outer margin; the container
 * that stacks it over its panel or group owns the rhythm.
 */
export function SectionTitle({ title, id, caption, aside, level = 2, className }: SectionTitleProps) {
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <div
      className={cn('flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-1', className)}
      data-section-title=""
    >
      <div className="min-w-0">
        <Heading id={id} className="break-words text-md font-semibold leading-5 text-foreground">
          {title}
        </Heading>
        {caption ? <p className="mt-0.5 text-sm text-muted-foreground">{caption}</p> : null}
      </div>
      {aside ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">{aside}</div>
      ) : null}
    </div>
  );
}
