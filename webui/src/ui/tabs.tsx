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

/**
 * Round 16 (SPEC §4.4 WP03): `compact` sets an underline trigger to 36px (`h-9`) instead
 * of 40px, for the case header, whose total height is budgeted. The labels, the rule and
 * the focus room do not change. A boxed list ignores it.
 */
export type TabsListDensity = 'default' | 'compact';

const TabsVariantContext = React.createContext<{ variant: TabsListVariant; density: TabsListDensity }>({
  variant: 'boxed',
  density: 'default',
});

/**
 * The selected state in forced colours (Windows contrast themes), where backgrounds become
 * Canvas and every border and label shares one text colour. System colour keywords are the
 * values a forced palette keeps, so the selected trigger uses `Highlight`, the system's
 * own selection colour: the underline rule, or an outline around a boxed trigger.
 */
const FORCED_ACTIVE_RULE = 'forced-colors:data-[state=active]:after:border-[Highlight]';
const FORCED_ACTIVE_BOX =
  'forced-colors:data-[state=active]:outline forced-colors:data-[state=active]:outline-2 forced-colors:data-[state=active]:-outline-offset-2 forced-colors:data-[state=active]:outline-[Highlight]';

/** The width of the fade at an edge of an underline list that scrolls. */
const EDGE_FADE_PX = 24;

/**
 * An underline list scrolls sideways when its tabs do not fit (a phone-width case
 * header). Two things keep the selected tab findable there: whenever the selection or the
 * list's size changes, the list's own `scrollLeft` moves just enough to bring the
 * selected trigger, clear of the fade, inside it (never `scrollIntoView`, which would also
 * scroll the page and any framed board around it); and each edge that has more tabs past
 * it fades out (a mask, so it works on any surface), marked `data-overflow` (`start`,
 * `end` or `both`). A list that fits is left exactly as it was.
 */
function useUnderlineOverflow(list: HTMLElement | null, enabled: boolean): void {
  React.useLayoutEffect(() => {
    if (!list || !enabled) return undefined;
    const paint = () => {
      const room = list.scrollWidth - list.clientWidth;
      const start = room > 1 && list.scrollLeft > 1;
      const end = room > 1 && list.scrollLeft < room - 1;
      const mark = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
      if (mark) list.setAttribute('data-overflow', mark);
      else list.removeAttribute('data-overflow');
      const mask = mark
        ? `linear-gradient(to right, transparent, black ${start ? EDGE_FADE_PX : 0}px, black calc(100% - ${end ? EDGE_FADE_PX : 0}px), transparent)`
        : '';
      list.style.setProperty('mask-image', mask);
      list.style.setProperty('-webkit-mask-image', mask);
    };
    const reveal = () => {
      const active = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      if (active && list.scrollWidth - list.clientWidth > 1) {
        const box = list.getBoundingClientRect();
        const tab = active.getBoundingClientRect();
        const left = tab.left - box.left;
        const right = tab.right - box.left;
        if (left < EDGE_FADE_PX) list.scrollLeft = Math.max(0, list.scrollLeft + left - EDGE_FADE_PX);
        else if (right > list.clientWidth - EDGE_FADE_PX) {
          list.scrollLeft += right - list.clientWidth + EDGE_FADE_PX;
        }
      }
      paint();
    };
    reveal();
    list.addEventListener('scroll', paint, { passive: true });
    // A new selection, or a tab whose label or count changed width.
    const selection = new MutationObserver(reveal);
    selection.observe(list, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    const size = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal);
    size?.observe(list);
    return () => {
      list.removeEventListener('scroll', paint);
      selection.disconnect();
      size?.disconnect();
      list.removeAttribute('data-overflow');
      list.style.removeProperty('mask-image');
      list.style.removeProperty('-webkit-mask-image');
    };
  }, [list, enabled]);
}

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: TabsListVariant; density?: TabsListDensity }
>(({ className, variant = 'boxed', density = 'default', ...props }, ref) => {
  const [list, setList] = React.useState<HTMLDivElement | null>(null);
  const setRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      setList(node);
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  useUnderlineOverflow(list, variant === 'underline');
  return (
    <TabsVariantContext.Provider value={React.useMemo(() => ({ variant, density }), [variant, density])}>
      <TabsPrimitive.List
        ref={setRef}
        data-variant={variant}
        data-density={density === 'compact' ? density : undefined}
        className={cn(
          variant === 'underline'
            ? '-mx-1.5 flex w-[calc(100%+0.75rem)] items-end justify-start gap-2 overflow-x-auto border-b border-border/70 text-muted-foreground'
            : 'inline-flex h-9 items-center justify-center gap-0.5 rounded-md border border-border/80 bg-transparent p-0.5 text-muted-foreground',
          className,
        )}
        {...props}
      />
    </TabsVariantContext.Provider>
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const { variant, density } = React.useContext(TabsVariantContext);
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
              'relative inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-sm px-1.5 text-sm font-medium transition-colors [&>svg]:hidden',
              density === 'compact' ? 'h-9' : 'h-10',
              'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              'disabled:pointer-events-none disabled:opacity-50',
              // The 2px rule spans the label (not the focus room), sits inside the trigger
              // directly on the list's hairline (overlapping the hairline would be clipped
              // by the list's horizontal scroll) and is a BORDER, so forced colours keep it.
              'data-[state=active]:text-foreground data-[state=active]:after:absolute data-[state=active]:after:inset-x-1.5 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0 data-[state=active]:after:rounded-full data-[state=active]:after:border-b-2 data-[state=active]:after:border-primary',
              // Forced colours paint the hairline and the rule in one text colour, so the
              // rule would merge into the hairline: it takes the system selection colour.
              FORCED_ACTIVE_RULE,
            )
          : cn(
              'inline-flex h-8 items-center justify-center whitespace-nowrap rounded-sm px-3 py-1 text-sm font-medium ring-offset-background transition-colors',
              'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'disabled:pointer-events-none disabled:opacity-50',
              'data-[state=active]:bg-accent/70 data-[state=active]:text-foreground',
              // Forced colours drop the tint: the selected trigger keeps a system outline.
              FORCED_ACTIVE_BOX,
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
      // Radix keeps every inactive panel in the DOM as an empty element with `hidden`. A
      // display utility from the caller (`grid`, `flex`) would override the attribute and
      // leave the panel's margin and gap in the layout, so `hidden` always wins here.
      '[&[hidden]]:hidden',
      animate && 'animate-fade-in',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
