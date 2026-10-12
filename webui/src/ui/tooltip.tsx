import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/cn';

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        // Match the shared floating-portal surface (rounded-lg + shadow-overlay), like
        // Popover/HoverCard/DropdownMenu/Select — Tooltip is a detached portal, not a
        // resting tile (DESIGN_STANDARD §1.5). The data-[state=delayed-open]/instant-open
        // animation classes stay bespoke (Radix Tooltip emits those, not open/closed).
        'z-50 max-w-xs overflow-hidden rounded-lg border border-border bg-popover px-2.5 py-1.5 ' +
          'text-xs leading-snug text-popover-foreground shadow-overlay',
        'data-[state=delayed-open]:animate-in data-[state=instant-open]:animate-in',
        'data-[state=delayed-open]:fade-in-0 data-[state=instant-open]:fade-in-0',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        'data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1',
        'data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1',
        // Scales out of the element it describes (the popper origin rule in theme.css);
        // reduced motion keeps only the fade.
        'data-[state=delayed-open]:zoom-in-95 data-[state=instant-open]:zoom-in-95',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
