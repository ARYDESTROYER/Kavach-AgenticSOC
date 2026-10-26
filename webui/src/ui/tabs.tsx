import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/cn';

const Tabs = TabsPrimitive.Root;

/**
 * Two tab grammars (Round 14, SPEC §4.9.2):
 *
 *  - `boxed` (the default, unchanged): the compact 8px rail with concentric 6px triggers,
 *    for an in-module view switch.
 *  - `underline`: page and record sections. A full-width hairline, 13px labels with no
 *    icons, and a 2px primary rule under the selected tab, so the selected state is the
 *    rule and the label colour together, never colour alone (WCAG 1.4.1). The rule is a
 *    border, not a background, so it survives forced colours, where backgrounds become
 *    Canvas and every label shares one text colour. The weight does not change: a bolder
 *    selected label would widen and nudge its neighbours on every switch. A view switch
 *    that is not page navigation stays a `SegmentedControl`.
 *
 *    Each trigger has 6px of inner room on both sides, so its inset focus ring never sits on
 *    the first or last glyph. The list reaches 6px past the column on each side, so the
 *    first and last trigger keep that room inside its scroll clip while the first label
 *    stays on the column edge; the gap is 8px, so labels stay 20px apart. `theme.css`
 *    insets the hairline by the same 6px (border-image), so it too starts and ends on the
 *    column edges.
 */
export type TabsListVariant = 'boxed' | 'underline';

const TabsVariantContext = React.createContext<TabsListVariant>('boxed');

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: TabsListVariant }
>(({ className, variant = 'boxed', ...props }, ref) => (
  <TabsVariantContext.Provider value={variant}>
    <TabsPrimitive.List
      ref={ref}
      data-variant={variant}
      className={cn(
        variant === 'underline'
          ? '-mx-1.5 flex w-[calc(100%+0.75rem)] items-end justify-start gap-2 overflow-x-auto border-b border-border/70 text-muted-foreground'
          : 'inline-flex h-9 items-center justify-center gap-0.5 rounded-md border border-border/80 bg-transparent p-0.5 text-muted-foreground',
        className,
      )}
      {...props}
    />
  </TabsVariantContext.Provider>
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const variant = React.useContext(TabsVariantContext);
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        variant === 'underline'
          ? cn(
              // 13px, no icons (a glyph beside every section name carried nothing the name
              // did not). 6px of inner room on each side, so the inset focus ring (inset:
              // the list scrolls and clips anything outside it) frames the label instead of
              // touching its first and last glyph.
              'relative inline-flex h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-1.5 text-sm font-medium transition-colors [&>svg]:hidden',
              'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              'disabled:pointer-events-none disabled:opacity-50',
              // The 2px rule spans the label (not the focus room), sits inside the trigger
              // directly on the list's hairline (overlapping the hairline would be clipped
              // by the list's horizontal scroll) and is a BORDER, so forced colours keep it.
              'data-[state=active]:text-foreground data-[state=active]:after:absolute data-[state=active]:after:inset-x-1.5 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0 data-[state=active]:after:rounded-full data-[state=active]:after:border-b-2 data-[state=active]:after:border-primary',
            )
          : cn(
              'inline-flex h-8 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1 text-sm font-medium ring-offset-background transition-colors',
              'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'disabled:pointer-events-none disabled:opacity-50',
              'data-[state=active]:bg-accent/70 data-[state=active]:text-foreground',
            ),
        className,
      )}
      {...props}
    />
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> & {
    /**
     * Round-7 W0.1 — fade the panel in on mount / tab-switch (Radix mounts only the
     * active panel, so this replays on each switch, not on every render). `true` by
     * default; pass `animate={false}` to opt a panel out (e.g. one that owns its own
     * enter animation). Reduced motion is neutralised globally by the theme.css reset.
     */
    animate?: boolean;
  }
>(({ className, animate = true, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-4 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      animate && 'animate-fade-in',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
