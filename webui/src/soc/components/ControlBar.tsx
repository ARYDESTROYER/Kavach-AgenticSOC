/**
 * ControlBar — the compact control-bar row of the three-zone dashboard
 * (DESIGN_STANDARD §4.3, IMPLEMENTATION Dash-B). ONE dense row: a title/eyebrow +
 * optional breadcrumb on the LEFT, and the controls (TimeRangePicker, filter
 * Selects, refresh, view actions) on the RIGHT. Reusable across Overview / Metrics /
 * any operational dashboard so the control row stays consistent.
 *
 * It is intentionally thin — a flex layout + a `flat`/`bordered` surface — and does
 * NOT own any state; the page composes `<TimeRangePicker>`, filters, etc. into the
 * `controls` slot. The primary and secondary slots wrap in DOM order. Simple
 * button-like secondary commands may use `overflowActions`: they stay inline while
 * the component has room and move into one labelled Radix menu below 48rem. Complex
 * fields, selects, and segmented controls must wrap instead of entering a menu.
 *
 * a11y: renders as a labelled `role="group"` region for the controls when a
 * `label` is given (NOT `role="toolbar"` — the children are independently tabbable
 * with no roving-tabindex/arrow navigation, which a toolbar would falsely advertise;
 * a labelled group carries no keyboard-navigation expectation and matches the actual
 * behavior). The title (if any) is a plain-text `<h2>`-ish eyebrow (never HTML). All
 * values passed in are the caller's responsibility to keep UNTRUSTED-safe.
 */
import * as React from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { materialBar } from '@/lib/ui-recipes';
import { useScrollEdgeRef } from '@/design-system/material';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

export interface ControlBarOverflowAction {
  /** Stable identity for React and test hooks. */
  id: string;
  /** Visible action label used by both the inline button and menu item. */
  label: string;
  /** Runs after pointer or keyboard selection. */
  onSelect: () => void;
  /** Optional leading icon. The visible text label remains mandatory in the menu. */
  icon?: LucideIcon;
  disabled?: boolean;
  /** Separates consequential commands visually without changing confirmation policy. */
  destructive?: boolean;
}

export interface ControlBarProps {
  /** Optional left-side title/eyebrow (plain text or a small node, e.g. a breadcrumb). */
  title?: React.ReactNode;
  /** Optional muted sub-line under/next to the title. */
  meta?: React.ReactNode;
  /** The controls, right-aligned (TimeRangePicker, filter Selects, buttons). */
  controls?: React.ReactNode;
  /** Lower-priority complex controls that wrap after `controls` and never enter a menu. */
  secondaryControls?: React.ReactNode;
  /**
   * Simple lower-priority commands. Inline at 48rem+ component width; otherwise
   * exposed through one focus-managed menu. Do not put form fields in this slot.
   */
  overflowActions?: readonly ControlBarOverflowAction[];
  /** Visible and accessible overflow trigger/menu label. */
  overflowLabel?: string;
  /** Accessible name for the controls group (recommended when `controls` is set). */
  label?: string;
  /**
   * Surface: `flat` (default) sits on the page with a bottom hairline; `bordered`
   * is a full bordered card row; `plain` is layout-only (no border/background).
   */
  variant?: 'flat' | 'bordered' | 'plain';
  /** Stick to the top of the scroll container (offset by --header-h). Default false. */
  sticky?: boolean;
  className?: string;
}

const SURFACE: Record<NonNullable<ControlBarProps['variant']>, string> = {
  flat: 'border-b border-border',
  bordered: 'rounded-md border border-border/80 bg-card px-3',
  plain: '',
};

export function ControlBar({
  title,
  meta,
  controls,
  secondaryControls,
  overflowActions = [],
  overflowLabel = 'More actions',
  label,
  variant = 'flat',
  sticky = false,
  className,
}: ControlBarProps) {
  // Sticky = floating chrome: the ONE Console material, with the scroll-edge fade shown
  // only while content is scrolled under the pinned bar (solid fallbacks in theme.css).
  const edgeRef = useScrollEdgeRef<HTMLDivElement>(undefined, sticky);
  return (
    <div
      ref={edgeRef}
      className={cn(
        '@container/controlbar flex flex-wrap items-center gap-x-3 gap-y-2 py-2',
        SURFACE[variant],
        sticky && cn('sticky z-20 top-[var(--header-h)]', materialBar),
        // The flat bar's hairline becomes the scroll-edge fade when it pins (a hard rule
        // returns under increased contrast, from the material's own fallback).
        sticky && variant === 'flat' && 'border-b-0',
        className,
      )}
    >
      {(title || meta) && (
        <div className="mr-auto flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {title ? (
            <div className="min-w-0 max-w-full overflow-x-auto text-sm font-semibold text-foreground">
              {title}
            </div>
          ) : null}
          {meta ? <div className="truncate text-xs text-muted-foreground">{meta}</div> : null}
        </div>
      )}
      {controls || secondaryControls || overflowActions.length > 0 ? (
        <div
          role={label ? 'group' : undefined}
          aria-label={label}
          className={cn(
            'flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2',
            // When there is no title, the controls should still push right.
            !title && !meta && 'ml-auto',
          )}
        >
          {controls ? (
            <div data-controlbar-slot="primary" className="flex min-w-0 flex-wrap items-center gap-2">
              {controls}
            </div>
          ) : null}

          {secondaryControls ? (
            <div data-controlbar-slot="secondary" className="flex min-w-0 flex-wrap items-center gap-2">
              {secondaryControls}
            </div>
          ) : null}

          {overflowActions.length > 0 ? (
            <>
              <div
                data-controlbar-slot="overflow-inline"
                className="hidden items-center gap-1 @3xl/controlbar:flex"
              >
                {overflowActions.map((action) => {
                  const Icon = action.icon;
                  return (
                    <Button
                      key={action.id}
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={action.disabled}
                      className={cn(action.destructive && 'text-critical-text hover:text-critical-text')}
                      onClick={action.onSelect}
                    >
                      {Icon ? <Icon aria-hidden /> : null}
                      {action.label}
                    </Button>
                  );
                })}
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="@3xl/controlbar:hidden"
                  >
                    <MoreHorizontal aria-hidden />
                    {overflowLabel}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuLabel>{overflowLabel}</DropdownMenuLabel>
                  {overflowActions.map((action) => {
                    const Icon = action.icon;
                    return (
                      <DropdownMenuItem
                        key={action.id}
                        disabled={action.disabled}
                        className={cn(action.destructive && 'text-critical-text focus:text-critical-text')}
                        onSelect={action.onSelect}
                      >
                        {Icon ? <Icon aria-hidden /> : null}
                        {action.label}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
ControlBar.displayName = 'ControlBar';
