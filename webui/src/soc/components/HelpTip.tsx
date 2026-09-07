/**
 * HelpTip — a small (?) affordance that reveals contextual help.
 *
 * Short help (no link / no code) renders as a Tooltip; longer help, a link, or a
 * code block renders as a Popover (more room, focusable). All help text is
 * operator/author-controlled (trusted) — but we still render it as plain text /
 * inside a code block, never as markup.
 *
 * No new deps: uses the existing Radix `ui/tooltip` + `ui/popover` primitives.
 */
import * as React from 'react';
import { HelpCircle } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { AuthField } from '@/lib/types';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@/ui/popover';

export interface HelpTipProps {
  /** The help text (plain). */
  text: string;
  /** Optional "learn more" link target (http/https). */
  link?: string;
  /** Optional example code/config shown in a code block. */
  code?: string;
  /** Accessible label for the trigger button. */
  label?: string;
  /**
   * Force the POPOVER presentation regardless of length.
   *
   * The default switch below is a LENGTH heuristic — short help gets a tooltip because it
   * needs no room. Reachability is a different question: a Radix tooltip opens on hover and
   * on focus, but never on TOUCH. So any help that carries text an operator must be able to
   * read on a tablet — in particular a disclosure RELOCATED out of always-visible copy —
   * has to be a popover (click / Enter / Space) however short it happens to be. Moving a
   * disclosure somewhere a touch or keyboard user cannot reach is a regression, not a
   * cleanup, and this flag is how a caller states that requirement instead of relying on
   * its sentence happening to exceed 80 characters.
   */
  alwaysPopover?: boolean;
  /**
   * Told when the POPOVER presentation opens or closes, so a host can stand other floating
   * surfaces down while it is up. Never fires for the tooltip presentation, which cannot
   * coexist with anything (it closes the moment the pointer leaves).
   */
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

const TriggerButton = React.forwardRef<
  HTMLButtonElement,
  { label: string; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ label, className, ...rest }, ref) => (
  <button
    ref={ref}
    type="button"
    aria-label={label}
    className={cn(
      // ≥24px hit target (WCAG 2.5.8 / DESIGN_STANDARD §6.2); the glyph stays 14px.
      'inline-flex min-h-6 min-w-6 items-center justify-center rounded-full text-muted-foreground transition-colors',
      'hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      className,
    )}
    {...rest}
  >
    <HelpCircle className="h-3.5 w-3.5" aria-hidden />
  </button>
));
TriggerButton.displayName = 'HelpTipTrigger';

export function HelpTip({
  text,
  link,
  code,
  label = 'More information',
  alwaysPopover = false,
  onOpenChange,
  className,
}: HelpTipProps) {
  const usePopover = Boolean(alwaysPopover || link || code || (text && text.length > 80));

  if (!usePopover) {
    // Self-contained TooltipProvider so HelpTip works anywhere (some Settings
    // surfaces are not wrapped in a page-level TooltipProvider).
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <TriggerButton label={label} className={className} />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs leading-relaxed">{text}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <TriggerButton label={label} className={className} />
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 text-xs leading-relaxed" align="start">
        <p className="text-muted-foreground">{text}</p>
        {code ? (
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] text-foreground">
            {code}
          </pre>
        ) : null}
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block font-medium text-primary underline-offset-2 hover:underline"
          >
            Learn more
          </a>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * ConnectorFieldHelp — a (?) affordance for one connector auth/config field,
 * sourced from the manifest's `help` / `help_link` / `help_code` (F9). Renders
 * nothing when the field carries no help at all.
 */
export function ConnectorFieldHelp({
  field,
  className,
}: {
  field: Pick<AuthField, 'label' | 'help' | 'help_link' | 'help_code'>;
  className?: string;
}) {
  const text = field.help || '';
  if (!text && !field.help_link && !field.help_code) return null;
  return (
    <HelpTip
      text={text || `More about ${field.label}.`}
      link={field.help_link || undefined}
      code={field.help_code || undefined}
      label={`Help for ${field.label}`}
      className={className}
    />
  );
}

export default HelpTip;
