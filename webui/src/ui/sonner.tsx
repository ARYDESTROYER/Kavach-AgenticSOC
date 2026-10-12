import * as React from 'react';
import { Toaster as SonnerToaster } from 'sonner';

type ToasterProps = React.ComponentProps<typeof SonnerToaster>;

/**
 * Pre-themed sonner Toaster. Drives toast colors from our CSS-var tokens so it
 * matches both light and dark themes. sonner's own `theme` prop is NOT tied to our
 * `.dark` class — left as `system` it reads the OS `prefers-color-scheme` directly,
 * which diverges whenever the operator forces Light/Dark (or a branding default
 * overrides the OS). So the ThemeProvider mount passes the app's RESOLVED theme in;
 * `system` remains only as the standalone default. Import `toast` directly from
 * 'sonner' to fire toasts.
 */
function Toaster({ theme = 'system', ...props }: ToasterProps) {
  return (
    <SonnerToaster
      theme={theme}
      className="toaster group"
      // Toasts are 10px (`--radius`, set on `[data-sonner-toaster]` in theme.css), like
      // menus and popovers, with the detached-portal `shadow-overlay` elevation.
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground ' +
            'group-[.toaster]:border group-[.toaster]:border-border group-[.toaster]:shadow-overlay',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          error:
            'group-[.toaster]:!border-critical/40 group-[.toaster]:!text-critical-text',
          success:
            'group-[.toaster]:!border-success/40 group-[.toaster]:!text-success-text',
          warning:
            'group-[.toaster]:!border-warning/40 group-[.toaster]:!text-warning-text',
          info: 'group-[.toaster]:!border-info/40 group-[.toaster]:!text-info-text',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
