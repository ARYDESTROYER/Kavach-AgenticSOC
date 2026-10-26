/**
 * RefreshButton: the canonical manual-reload action for Console pages, and the ONE
 * refresh spinner (Round 14, SPEC §4.9.2): a hand-rolled spinning `RefreshCw` anywhere
 * else fails the console grammar guard.
 *
 * The glyph and label remain mounted while a request is in flight, so entering the
 * busy state cannot resize a toolbar or shift neighbouring controls.  `aria-busy`
 * communicates progress, and disabling the button prevents accidental duplicate
 * requests while preserving the page's last usable data.
 *
 * `display="icon"` is the page header's refresh (the controls slot beside the title,
 * next to the `TimeRangePicker`): a quiet 32px icon button, neutral at rest, whose label
 * stays in the DOM for assistive technology and shows in the shared tooltip on hover and
 * keyboard focus (never the native `title`, which waits for the OS delay, never shows on
 * focus and some screen readers read twice). It brings its own `TooltipProvider` (with the
 * app's delay) so it also works outside the app root. It spins only
 * while a load is in flight; a live page says it is live through the time-range pill,
 * never through a spinning refresh. `display="label"` (the default) keeps the visible
 * word for a section's own refresh (Users, Sessions).
 */
import * as React from 'react';
import { RefreshCw } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button, type ButtonProps } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';

export interface RefreshButtonProps
  extends Omit<ButtonProps, 'asChild' | 'children' | 'type'> {
  /** True while the reload request is in flight. */
  refreshing?: boolean;
  /** Visible (or, for `display="icon"`, accessible) action name. */
  label?: string;
  /** `label` (default): glyph and word. `icon`: the page header's icon button. */
  display?: 'label' | 'icon';
}

export const RefreshButton = React.forwardRef<HTMLButtonElement, RefreshButtonProps>(
  (
    {
      refreshing = false,
      label = 'Refresh',
      display = 'label',
      disabled = false,
      variant = 'outline',
      size,
      className,
      title,
      ...props
    },
    ref,
  ) => {
    const iconOnly = display === 'icon';
    const button = (
      <Button
        {...props}
        ref={ref}
        type="button"
        variant={variant}
        size={size ?? (iconOnly ? 'icon' : 'sm')}
        aria-busy={refreshing}
        disabled={disabled || refreshing}
        title={title}
        data-refresh-display={display}
        className={cn(
          iconOnly &&
            // The Overview header's quiet chrome: 8px radius like every control, a hairline
            // edge, muted at rest and ink on hover.
            'h-8 w-8 rounded-md border-border/70 bg-transparent text-muted-foreground shadow-none hover:border-border-strong hover:bg-hover hover:text-foreground',
          className,
        )}
      >
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <RefreshCw
            className={cn(
              'size-4',
              refreshing && 'animate-spin motion-reduce:animate-none',
            )}
          />
        </span>
        <span className={cn(iconOnly && 'sr-only')}>{label}</span>
      </Button>
    );
    if (!iconOnly) return button;
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  },
);
RefreshButton.displayName = 'RefreshButton';
