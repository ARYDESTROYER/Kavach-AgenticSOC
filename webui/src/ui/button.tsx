import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  // Press feedback is INSTANT and on pointer-down (Apple "Response"): the button
  // settles to 97% in 100ms (`duration-press`) while the variant's `active:` fill
  // darkens. The scale is motion-safe only — under reduced motion the colour change
  // alone is the feedback. A link-styled button never scales (see `link` below), and
  // neither does a FULL-WIDTH button: a row-shaped control (the Settings section
  // picker, the mobile nav's Appearance row) visibly shrinks ~11px at 97%, so it only
  // darkens (ui-standard "Motion": rows darken on :active instead of scaling).
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ' +
    'ring-offset-background transition duration-press ease-out motion-safe:active:scale-[0.97] ' +
    '[&.w-full]:active:scale-100 ' +
    'focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none ' +
    'disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/85',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/70',
        outline:
          // border-input (≥3:1), not the decorative hairline --border: on a bg-card fill the
          // edge is the ONLY boundary cue, so it must clear the WCAG 1.4.11 non-text bar and
          // match the input/select/textarea/checkbox primitives (DESIGN_STANDARD §1.2).
          'border border-input bg-card text-foreground hover:bg-muted hover:text-foreground active:bg-muted/80',
        ghost: 'text-foreground hover:bg-muted hover:text-foreground active:bg-muted/80',
        destructive: 'bg-critical text-critical-foreground hover:bg-critical/90 active:bg-critical/85',
        link: 'text-primary underline-offset-4 hover:underline motion-safe:active:scale-100',
      },
      size: {
        sm: 'h-8 rounded-md px-3 text-xs',
        default: 'h-9 px-4 py-2',
        lg: 'h-10 rounded-md px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
