import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { focusRing, modalOverlay } from '@/lib/ui-recipes';

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    ref={ref}
    className={cn(modalOverlay, className)}
    {...props}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

const sheetVariants = cva(
  cn(
    // Opaque (a sheet holds evidence and forms, never a material), overlay elevation.
    'fixed z-50 flex flex-col gap-4 bg-card text-foreground shadow-overlay border-border',
    'data-[state=open]:animate-in data-[state=closed]:animate-out',
    // Enter on the pane spring (SPRING_PANE, 350ms, critically damped); exit along the
    // SAME edge it came from, as a short tween. Reduced motion: a cross-fade in place.
    'data-[state=open]:duration-pane data-[state=open]:ease-spring data-[state=closed]:duration-base',
  ),
  {
    variants: {
      side: {
        // Side panes round 14px on the LEADING edge only (the edge that faces the page);
        // the edge that meets the viewport stays square. From `sm` up — a phone-width
        // sheet is the whole screen. (`rounded-tr-xl rounded-br-xl`, not `rounded-r-xl`,
        // which collides with the `r-xl` radius token key.) Full-width top/bottom
        // sheets have no leading edge to round.
        //
        // `overflow-hidden` CLIPS to that radius: a full-bleed child with its own fill
        // (the report panel's `bg-background` root in a `p-0` sheet) would otherwise paint
        // square corners over the 14px curve. A consumer that scrolls the sheet itself
        // passes `overflow-y-auto`, which tailwind-merge keeps beside this and which also
        // clips to the radius; everything else scrolls an inner region.
        top: 'inset-x-0 top-0 border-b data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top',
        bottom:
          'inset-x-0 bottom-0 border-t data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
        left: 'inset-y-0 left-0 h-dvh overflow-hidden border-r sm:rounded-tr-xl sm:rounded-br-xl data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
        right:
          'inset-y-0 right-0 h-dvh overflow-hidden border-l sm:rounded-l-xl data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
      },
      size: {
        sm: '',
        default: '',
        lg: '',
        xl: '',
        full: '',
      },
    },
    compoundVariants: [
      // horizontal panels (left/right) → width-bound
      { side: 'right', size: 'sm', class: 'w-full max-w-sm' },
      { side: 'right', size: 'default', class: 'w-full max-w-md' },
      { side: 'right', size: 'lg', class: 'w-full max-w-2xl' },
      { side: 'right', size: 'xl', class: 'w-full max-w-[56rem]' },
      // `full` spans the viewport, so its leading edge meets the screen edge and is
      // squared in SheetContent — unless a consumer caps the width (see there).
      { side: 'right', size: 'full', class: 'w-full max-w-full' },
      { side: 'left', size: 'sm', class: 'w-full max-w-sm' },
      { side: 'left', size: 'default', class: 'w-full max-w-md' },
      { side: 'left', size: 'lg', class: 'w-full max-w-2xl' },
      { side: 'left', size: 'xl', class: 'w-full max-w-[56rem]' },
      { side: 'left', size: 'full', class: 'w-full max-w-full' },
      // vertical panels (top/bottom) → height-bound
      { side: 'top', size: 'sm', class: 'max-h-[25dvh]' },
      { side: 'top', size: 'default', class: 'max-h-[40dvh]' },
      { side: 'top', size: 'lg', class: 'max-h-[60dvh]' },
      { side: 'top', size: 'xl', class: 'max-h-[80dvh]' },
      { side: 'top', size: 'full', class: 'h-dvh max-h-dvh' },
      { side: 'bottom', size: 'sm', class: 'max-h-[25dvh]' },
      { side: 'bottom', size: 'default', class: 'max-h-[40dvh]' },
      { side: 'bottom', size: 'lg', class: 'max-h-[60dvh]' },
      { side: 'bottom', size: 'xl', class: 'max-h-[80dvh]' },
      { side: 'bottom', size: 'full', class: 'h-dvh max-h-dvh' },
    ],
    defaultVariants: {
      side: 'right',
      size: 'default',
    },
  },
);

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = 'right', size = 'default', className, children, ...props }, ref) => {
  const classes = cn(sheetVariants({ side, size }), className);
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={ref}
        className={
          // A `full` side sheet squares its leading edge only while it really spans the
          // viewport. A consumer `max-w-[…]` cap (the case-detail and expanded-block
          // sheets) replaces `max-w-full` in the merge; the leading edge then faces the
          // page and keeps its 14px radius like every other side sheet.
          size === 'full' && classes.split(' ').includes('max-w-full')
            ? cn(classes, 'sm:rounded-none')
            : classes
        }
        {...props}
      >
        {children}
        {/* Round 14 (F1): `z-30` keeps the close button above any sticky header a sheet's
            content pins (the case detail header is `z-10`, a sticky page band `z-20`).
            Without it the header, positioned and later in the stacking order, painted over
            the button and swallowed its clicks. It also comes AFTER the children in the
            DOM, so it is the last stop in the sheet's tab order and never hides behind
            content that renders later. Five bytes in the entry chunk (sheet.tsx ships at
            first paint through the shell). */}
        <SheetPrimitive.Close
          aria-label="Close"
          className={cn(
            'absolute right-4 top-4 z-30 inline-flex h-7 w-7 items-center justify-center rounded-md',
            'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            focusRing,
            'disabled:pointer-events-none',
          )}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPortal>
  );
});
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    // `pr-14` reserves room for the built-in close (X) pinned at `right-4` (28px box)
    // so a long title never slides underneath it — no per-consumer `pr-8`/`truncate`.
    className={cn('flex flex-col gap-1.5 border-b border-border p-6 pr-14 text-left', className)}
    {...props}
  />
);
SheetHeader.displayName = 'SheetHeader';

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse gap-2 border-t border-border p-6 sm:flex-row sm:justify-end',
      className,
    )}
    {...props}
  />
);
SheetFooter.displayName = 'SheetFooter';

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold text-foreground', className)}
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  sheetVariants,
};
