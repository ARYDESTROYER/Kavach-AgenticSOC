import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { focusRing, modalOverlay, modalSurface } from '@/lib/ui-recipes';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(modalOverlay, className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Suppress the built-in top-right close (X). Use for surfaces whose own control
   *  sits in the top row (e.g. a command palette's search input) or that render a
   *  custom close, where the fixed X would overlap. */
  hideClose?: boolean;
  /**
   * Viewport point the dialog should grow out of — the centre of the control that opened
   * it (Apple spatial consistency: "if something disappears one way, we expect it to
   * emerge from where it came"). Radix anchors menus and popovers itself; a dialog
   * opened from STATE (a KPI tile, a row) has no Radix trigger, so the caller passes
   * the point, e.g. the centre of `tile.getBoundingClientRect()`. Omitted → its centre.
   */
  origin?: { x: number; y: number } | null;
}

/**
 * `transform-origin` that pins the zoom's fixed point to a viewport point, with no
 * measurement: the panel is centred (`left/top: 50%` and a −50% translate), so its
 * visual top-left is 50dvw − w/2, and the point sits at 50% + (x − 50dvw) of its own box.
 *
 * DYNAMIC viewport units, like the panel's own `max-h-[85dvh]`: the fixed panel is laid
 * out against the dynamic viewport, and on mobile `vh` is the LARGE viewport, so a `vh`
 * origin would sit half a toolbar's height away from the tile that opened the dialog.
 */
export function dialogTransformOrigin(point: { x: number; y: number }): string {
  return `calc(50% + ${Math.round(point.x)}px - 50dvw) calc(50% + ${Math.round(point.y)}px - 50dvh)`;
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, hideClose = false, origin, style, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(modalSurface, className)}
      style={
        origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)
          ? { transformOrigin: dialogTransformOrigin(origin), ...style }
          : style
      }
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close
          className={cn(
            'absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-md',
            'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            focusRing,
            'disabled:pointer-events-none',
          )}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  // `pr-8` reserves space for the absolute top-right close (X) so a long title/
  // description never renders underneath it.
  <div className={cn('flex flex-col gap-1.5 pr-8 text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none text-foreground', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
