import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium leading-tight ' +
    'ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-ring focus-visible:ring-offset-2 ' +
    'whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-border bg-muted text-muted-foreground',
        outline: 'border-border text-foreground',
        // The `destructive` variant NAME is a public contract; it resolves to
        // --critical (the dead --destructive token was removed in W0-A §1.2).
        destructive: 'border-transparent bg-critical text-critical-foreground',
        // Wash-style semantic badges: `/10` fill + the AA-tuned `-text` standalone
        // color (W0-A §1.3) — the plain `text-{axis}` tints failed 4.5:1 as text.
        success: 'border-success/20 bg-success/10 text-success-text',
        warning: 'border-warning/20 bg-warning/10 text-warning-text',
        info: 'border-info/20 bg-info/10 text-info-text',
        critical: 'border-critical/20 bg-critical/10 text-critical-text',
        high: 'border-high/20 bg-high/10 text-high-text',
        medium: 'border-medium/20 bg-medium/10 text-medium-text',
        low: 'border-low/20 bg-low/10 text-low-text',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  ),
);
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
