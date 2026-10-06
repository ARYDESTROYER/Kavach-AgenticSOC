/**
 * DashboardGroup — the "named widget group" band of the three-zone dashboard
 * (DESIGN_STANDARD §4.3, IMPLEMENTATION Dash-B). A collapsible section with a title,
 * an optional count badge, and an optional right-aligned actions slot. Wrap each
 * cluster of dashboard widgets in one so the operator can fold a whole band
 * (narrative order: general → specific, top-left = critical).
 *
 * Built on the shared Radix Collapsible (W0 `ui/collapsible`) so open/close motion,
 * the reduced-motion drop, and the mid-toggle overflow clip are all inherited — we do
 * NOT re-roll them. The trigger is a real `<button>` carrying `aria-expanded` +
 * `aria-controls` for the region, and the whole group is a labelled `<section>`.
 *
 * Controlled or uncontrolled: pass `open`/`onOpenChange` to persist the state (e.g.
 * to `UserPrefsStore`), or `defaultOpen` for local-only toggling.
 *
 * Security: `title` is app-authored plain text (rendered as text, never HTML) — safe
 * for the UNTRUSTED-fencing invariant (#9) even if a future caller passes a
 * source-derived group name.
 */
import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';
import { Heading } from '@/ui/typography';

export interface DashboardGroupProps {
  /** Group heading (plain text). */
  title: string;
  /** Optional count shown as a muted pill beside the title (e.g. widget/case count). */
  count?: number;
  /** Optional sub-line under the title (plain text, single line). */
  description?: string;
  /** Right-aligned controls (buttons/menus) — click does not toggle the group. */
  actions?: React.ReactNode;
  /** Controlled open state. Pair with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Uncontrolled initial open state (ignored when `open` is provided). Default true. */
  defaultOpen?: boolean;
  /** Heading level for the group title. Default 2. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}

let idSeq = 0;
function useGroupId(): string {
  // A stable id per instance for aria-controls; React 18's useId is fine but this
  // stays dep-light and readable in the DOM.
  const ref = React.useRef<string>();
  if (!ref.current) ref.current = `dashgroup-${++idSeq}`;
  return ref.current;
}

export function DashboardGroup({
  title,
  count,
  description,
  actions,
  open,
  onOpenChange,
  defaultOpen = true,
  headingLevel = 2,
  className,
  contentClassName,
  children,
}: DashboardGroupProps) {
  // Support both controlled and uncontrolled without leaking internal state when
  // controlled (Radix Collapsible handles the state; we only need the id + heading).
  const controlled = open !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isOpen = controlled ? (open as boolean) : internalOpen;

  const regionId = useGroupId();

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn('w-full', className)}
      asChild
    >
      <section aria-label={title}>
        <div className="flex items-center gap-2">
          {/* The heading WRAPS the button (WAI disclosure pattern): a <button> may
              not contain h2-h6 (flow content), and a heading nested inside a button
              is swallowed by the button's name-from-contents, breaking heading-jump
              (NVDA/JAWS 'H'). Keeping the heading OUTSIDE the button preserves both a
              valid button and the document outline. */}
          {/* Shared typography <Heading> for the document-outline node; its visual
              scale is inert here because the visible label/count/description are the
              explicitly-sized spans inside the trigger button. */}
          <Heading level={headingLevel} className="m-0 min-w-0 flex-1">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={regionId}
                className={cn(
                  'group/dg flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left transition-colors',
                  'hover:text-foreground',
                  focusRing,
                )}
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                    isOpen ? 'rotate-0' : '-rotate-90',
                  )}
                />
                {/* The TITLE never truncates; the description beside it gives way first. At
                    phone width "Deeper analytics" used to ellipsize to "Deeper an…" while
                    the less important description kept its room. */}
                <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-foreground">
                  {title}
                </span>
                {count != null ? (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                    {count}
                  </span>
                ) : null}
                {description ? (
                  <span className="min-w-0 truncate text-xs font-normal normal-case tracking-normal text-muted-foreground">
                    {description}
                  </span>
                ) : null}
              </button>
            </CollapsibleTrigger>
          </Heading>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </div>

        <CollapsibleContent id={regionId} className={cn('pt-3', contentClassName)}>
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
DashboardGroup.displayName = 'DashboardGroup';
