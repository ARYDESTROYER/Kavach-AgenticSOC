/**
 * Card — the ONE card grammar (DESIGN_STANDARD §3.2 / §5.2).
 *
 * Additive props follow the Console's border-first surface contract:
 *  - `padding`  'sm' | 'md' | 'lg'  → the sanctioned 8px rhythm (p-4 / p-6 / p-8).
 *               `sm` (16) for dense/nested cards; `md` (24) for top-level page /
 *               KPI cards. When set on <Card>, it cascades to CardHeader/CardContent/
 *               CardFooter via context so the whole card shares one rhythm. When UNSET
 *               the default is the on-grid 'md' rhythm (px-6 py-4) — the off-grid
 *               `px-5` (20) the overhaul set out to kill (§3.2).
 *  - `density`  'default' | 'compact'  → compact tightens header/content/footer for
 *               dense surfaces (only meaningful together with `padding`).
 *  - `elevation` 'none' | 'sm'  → 'none' is the default command-surface treatment;
 *               'sm' is an explicit opt-in for a genuinely detached surface.
 *  - `variant`  'default' | 'flat'  → 'flat' = no border + transparent surface
 *               (filter bars / toolbars that sit on the page, not a raised tile).
 *
 * `CardTitle` renders an `<h3>` and `CardDescription` a `<p>` (was `<div>`) so the
 * card is a real heading/paragraph pair (a11y). Both still accept `className`.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';

type CardPadding = 'sm' | 'md' | 'lg';
type CardDensity = 'default' | 'compact';

/** The x/y padding utilities each sub-slot uses for a given padding scale. */
const PADDING_X: Record<CardPadding, string> = { sm: 'px-4', md: 'px-6', lg: 'px-8' };

interface CardContextValue {
  padding?: CardPadding;
  density: CardDensity;
}
const CardContext = React.createContext<CardContextValue>({ padding: undefined, density: 'default' });

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
  density?: CardDensity;
  elevation?: 'none' | 'sm';
  variant?: 'default' | 'flat';
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, padding, density = 'default', elevation = 'none', variant = 'default', ...props }, ref) => (
    <CardContext.Provider value={{ padding, density }}>
      <div
        ref={ref}
        className={cn(
          'rounded-md text-card-foreground transition-colors',
          variant === 'flat' ? 'border-0 bg-transparent' : 'border border-border/80 bg-card',
          variant === 'default' && elevation === 'sm' && 'shadow-elev1',
          className,
        )}
        {...props}
      />
    </CardContext.Provider>
  ),
);
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { padding, density } = React.useContext(CardContext);
    // Default (padding unset) is the on-grid 'md' rhythm (px-6 py-4) — the off-grid
    // px-5 (20px) the overhaul set out to kill (DESIGN_STANDARD §3.2). `padding='sm'`
    // still opts down to px-4 for dense/nested cards.
    const cls = padding
      ? cn(PADDING_X[padding], density === 'compact' ? 'py-3' : 'py-4')
      : 'px-6 py-4';
    return (
      <div ref={ref} className={cn('flex flex-col space-y-1', cls, className)} {...props} />
    );
  },
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, children, ...props }, ref) => {
    // Never emit an EMPTY heading (a11y: jsx-a11y/heading-has-content — an empty
    // <h3> is announced as a blank heading and clutters the AT heading list).
    // When there are no children the title collapses to nothing; callers always
    // pass a title, so this is behavior-identical for every real consumer.
    if (children == null || children === false || children === '') return null;
    return (
      <h3
        ref={ref}
        // text-lg (16/24 — the standard's card-title step, §2.4) not text-base (14, =body).
        // No leading-tight: inherit the type step's on-grid 24px line-height.
        className={cn('text-lg font-semibold text-foreground', className)}
        {...props}
      >
        {children}
      </h3>
    );
  },
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { padding, density } = React.useContext(CardContext);
    const cls = padding
      ? cn(PADDING_X[padding], density === 'compact' ? 'pb-4' : 'pb-6', 'pt-0')
      : 'px-6 pb-6 pt-0';
    return <div ref={ref} className={cn(cls, className)} {...props} />;
  },
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { padding, density } = React.useContext(CardContext);
    const cls = padding
      ? cn(PADDING_X[padding], density === 'compact' ? 'pb-4' : 'pb-6', 'pt-0')
      : 'px-6 pb-6 pt-0';
    return <div ref={ref} className={cn('flex items-center', cls, className)} {...props} />;
  },
);
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
