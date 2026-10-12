import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const alertVariants = cva(
  'relative w-full rounded-lg border px-4 py-3 text-sm ' +
    '[&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:size-4 ' +
    '[&>svg~*]:pl-7 [&>svg+div]:translate-y-[-2px]',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground border-border [&>svg]:text-foreground',
        destructive:
          'border-critical/50 bg-critical/10 text-critical-text [&>svg]:text-critical',
        warning: 'border-warning/50 bg-warning/10 text-warning-text [&>svg]:text-warning',
        success: 'border-success/50 bg-success/10 text-success-text [&>svg]:text-success',
        info: 'border-info/50 bg-info/10 text-info-text [&>svg]:text-info',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  /**
   * Optional explicit icon slot. Rendered as the leading `<svg>` (same absolute
   * position + variant color the `[&>svg]` child pattern uses), so callers can
   * pass `icon={<CheckCircle2 />}` instead of hand-placing a first-child svg.
   * The legacy first-child `<svg>` pattern still works unchanged.
   */
  icon?: React.ReactNode;
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, icon, role, children, ...props }, ref) => {
    // success/info are non-urgent confirmations/notes → role="status" (a POLITE live
    // region that doesn't interrupt the screen reader). destructive/warning/default stay
    // role="alert" (assertive), per WAI-ARIA. Callers can still override `role`.
    const resolvedRole = role ?? (variant === 'success' || variant === 'info' ? 'status' : 'alert');
    return (
      <div ref={ref} role={resolvedRole} className={cn(alertVariants({ variant }), className)} {...props}>
        {icon}
        {children}
      </div>
    );
  },
);
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, children, ...props }, ref) => {
  // Never emit an EMPTY heading (a11y: jsx-a11y/heading-has-content). Callers
  // always pass title text, so this is behavior-identical for real consumers.
  if (children == null || children === false || children === '') return null;
  return (
    <h5
      ref={ref}
      className={cn('mb-1 font-medium leading-none', className)}
      {...props}
    >
      {children}
    </h5>
  );
});
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    // Was `opacity-90` (a blanket dim that muddied the variant text color and
    // hurt AA); the variant already carries the correct text token, so the body
    // simply inherits it (DESIGN_STANDARD §5.2).
    className={cn('text-sm [&_p]:leading-relaxed', className)}
    {...props}
  />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
