/**
 * AlertDialog — a confirmation dialog (destructive-action guard).
 *
 * shadcn normally builds this on `@radix-ui/react-alert-dialog`, but to honour the
 * ZERO-new-deps rule we vendor it over the already-installed `@radix-ui/react-dialog`
 * (the same primitive `dialog.tsx` uses). The public surface mirrors shadcn's
 * AlertDialog (Trigger/Content/Header/Footer/Title/Description/Action/Cancel) so
 * call sites read identically; the only behavioural nuance is that, like a real
 * alert dialog, there is no top-right close affordance — the user must pick an
 * explicit Action or Cancel.
 *
 * `AlertDialogAction` is a `<button>` styled like the primary/destructive Button;
 * `AlertDialogCancel` is an outline button that closes the dialog. Both compose
 * `onClick` with the dialog's close so consumers can pass a handler directly.
 */
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/cn';
import { buttonVariants } from '@/ui/button';
import { modalOverlay, modalSurface } from '@/lib/ui-recipes';

const AlertDialog = DialogPrimitive.Root;
const AlertDialogTrigger = DialogPrimitive.Trigger;
const AlertDialogPortal = DialogPrimitive.Portal;

const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(modalOverlay, className)}
    {...props}
  />
));
AlertDialogOverlay.displayName = 'AlertDialogOverlay';

/**
 * `dismissible` (default `true`) keeps the shadcn behaviour where clicking the
 * overlay or pressing Escape closes the dialog. Pass `dismissible={false}` for a
 * DESTRUCTIVE gate (delete a role/user, factory reset, …) so the user must make
 * an explicit Action/Cancel choice — an errant click or stray Escape can't
 * dismiss the guard (DESIGN_STANDARD §5.2 / map §3.16). Caller-provided
 * `onPointerDownOutside`/`onEscapeKeyDown`/`onInteractOutside` handlers still run
 * first and can also `preventDefault()`.
 */
export interface AlertDialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  dismissible?: boolean;
}

const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  AlertDialogContentProps
>(
  (
    {
      className,
      dismissible = true,
      onPointerDownOutside,
      onEscapeKeyDown,
      onInteractOutside,
      ...props
    },
    ref,
  ) => (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        // role=alertdialog signals an assertive confirmation to AT.
        role="alertdialog"
        onPointerDownOutside={(e) => {
          onPointerDownOutside?.(e);
          if (!dismissible) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          onEscapeKeyDown?.(e);
          if (!dismissible) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          onInteractOutside?.(e);
          if (!dismissible) e.preventDefault();
        }}
        className={cn(
          // The same centred modal panel as dialog.tsx (one recipe): 14px radius, bounded
          // height, overlay elevation, a spring enter that zooms about the centre.
          modalSurface,
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  ),
);
AlertDialogContent.displayName = 'AlertDialogContent';

const AlertDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1.5 text-left', className)} {...props} />
);
AlertDialogHeader.displayName = 'AlertDialogHeader';

const AlertDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
    {...props}
  />
);
AlertDialogFooter.displayName = 'AlertDialogFooter';

const AlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none text-foreground', className)}
    {...props}
  />
));
AlertDialogTitle.displayName = 'AlertDialogTitle';

const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
AlertDialogDescription.displayName = 'AlertDialogDescription';

/**
 * The confirm button. Defaults to the primary Button look; pass
 * `variant="destructive"` for a dangerous action. Closes the dialog AND runs the
 * consumer's onClick.
 */
const AlertDialogAction = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'destructive';
  }
>(({ className, variant = 'default', ...props }, ref) => (
  <DialogPrimitive.Close asChild>
    <button
      ref={ref}
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  </DialogPrimitive.Close>
));
AlertDialogAction.displayName = 'AlertDialogAction';

/** The cancel button — outline look; closes the dialog. */
const AlertDialogCancel = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Close asChild>
    <button
      ref={ref}
      // The footer owns the stacked gutter via `gap-2`; a `mt-2` here would ADD to
      // that gap (flex margin + gap are cumulative), pushing the narrow-viewport
      // spacing off the 8px grid. So no extra margin — the footer spacing is enough.
      className={cn(buttonVariants({ variant: 'outline' }), className)}
      {...props}
    />
  </DialogPrimitive.Close>
));
AlertDialogCancel.displayName = 'AlertDialogCancel';

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
