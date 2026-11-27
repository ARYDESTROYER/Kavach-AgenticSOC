/**
 * RowActions: the actions at the end of a row (Round 14, SPEC §4.9.2; ui-standard
 * "Tables, filters and lists").
 *
 * One trailing action in view (the row's most useful one), the rest behind one "More
 * actions" menu. Every action is neutral at rest: a destructive action (Delete, Revoke,
 * Sign out) is never red on every row; it turns red only on hover and keyboard focus,
 * and the caller confirms it in a dialog, where the red button lives. An icon-only
 * action is named by its label (the accessible name and the tooltip); an action that
 * navigates is a link, never a button that changes the hash: a plain click on it goes
 * through the router, so a page's unsaved-changes guard is asked first, and only a safe
 * href becomes a link (`@/soc/route-link`; anything else renders a disabled action).
 *
 * Targets: 32px from 640px up, 44px on a phone, where the row's actions are its primary
 * controls (SPEC §3.3).
 *
 * Tooltips use the app's one root `TooltipProvider` (as `IconButton` does); render inside
 * it. Plain function components with no module-level calls, so the `@/design-system`
 * index that the entry imports stays tree-shakeable (SPEC §3.4). All labels are plain
 * text (#9).
 */
import * as React from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { safeRouteHref, useRouteLinkClick } from '@/soc/route-link';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

export interface RowAction {
  /** Stable id. */
  id: string;
  /** What the action does ("Edit rule", "Delete rule"): the accessible name, tooltip and menu text. */
  label: string;
  /** A 16px glyph. An inline action with an icon is icon-only (its label is the tooltip). */
  icon?: LucideIcon;
  /** Run the action. A destructive action opens the caller's confirm dialog here. */
  onSelect?: () => void;
  /**
   * Navigate instead (an `<a href>`): a hash route, a same-origin path or an http(s) URL.
   * Any other value renders the action disabled rather than as a link (#9).
   */
  href?: string;
  /** Neutral at rest, red only on hover and keyboard focus. */
  destructive?: boolean;
  disabled?: boolean;
}

export interface RowActionsProps {
  actions: RowAction[];
  /** How many actions stay in view; the rest go behind "More actions". Default 1. */
  inline?: number;
  /** The row the actions belong to, for the menu's name ("More actions for CASE-000048"). */
  subject?: string;
  className?: string;
}

/**
 * The shared icon target (24px minimum, WCAG 2.5.8): 44px on a phone, 32px from 640px up,
 * with the neutral, red-on-intent tone.
 */
function iconActionClass(destructive?: boolean) {
  return cn(
    'inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors sm:size-8',
    'hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4',
    destructive && 'hover:bg-critical/10 hover:text-critical-text focus-visible:text-critical-text',
    focusRing,
  );
}

function InlineAction({ action }: { action: RowAction }) {
  const Icon = action.icon;
  const href = action.disabled ? undefined : safeRouteHref(action.href);
  // An href that is not a safe target is not a link and not a button that would do
  // nothing: the action shows, disabled.
  const refused = Boolean(action.href) && !action.disabled && !href;
  const onLinkClick = useRouteLinkClick(href);
  if (!Icon) {
    // A text action: a quiet ghost button (or link) whose words are its name.
    const textClass = cn(
      'h-11 px-2.5 text-muted-foreground hover:text-foreground sm:h-8',
      action.destructive && 'hover:bg-critical/10 hover:text-critical-text focus-visible:text-critical-text',
    );
    return href ? (
      <Button asChild variant="ghost" size="sm" className={textClass}>
        <a href={href} onClick={onLinkClick}>
          {action.label}
        </a>
      </Button>
    ) : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={textClass}
        disabled={action.disabled || refused}
        onClick={action.onSelect}
      >
        {action.label}
      </Button>
    );
  }
  const glyph = <Icon aria-hidden="true" />;
  const control = href ? (
    <a href={href} onClick={onLinkClick} aria-label={action.label} className={iconActionClass(action.destructive)}>
      {glyph}
    </a>
  ) : (
    <button
      type="button"
      aria-label={action.label}
      disabled={action.disabled || refused}
      onClick={action.onSelect}
      className={iconActionClass(action.destructive)}
    >
      {glyph}
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent side="top">{action.label}</TooltipContent>
    </Tooltip>
  );
}

function MenuAction({ action, onNavigate }: { action: RowAction; onNavigate: () => void }) {
  const Icon = action.icon;
  const href = action.disabled ? undefined : safeRouteHref(action.href);
  const refused = Boolean(action.href) && !action.disabled && !href;
  const routeClick = useRouteLinkClick(href);
  const className = cn(
    action.destructive && 'focus:bg-critical/10 focus:text-critical-text [&:focus>svg]:text-critical-text',
  );
  const content = (
    <>
      {Icon ? <Icon aria-hidden="true" /> : null}
      {action.label}
    </>
  );
  if (href) {
    return (
      <DropdownMenuItem asChild className={className}>
        <a
          href={href}
          onClick={(event) => {
            routeClick(event);
            // The router took the click (the menu's own select step is skipped for a
            // handled click), so close the menu here.
            if (event.defaultPrevented) onNavigate();
          }}
        >
          {content}
        </a>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      className={className}
      disabled={action.disabled || refused}
      onSelect={() => action.onSelect?.()}
    >
      {content}
    </DropdownMenuItem>
  );
}

export function RowActions({ actions, inline = 1, subject, className }: RowActionsProps) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  if (actions.length === 0) return null;
  const shown = actions.slice(0, Math.max(0, inline));
  const rest = actions.slice(Math.max(0, inline));
  // In the menu, the destructive actions come last, after a separator.
  const safe = rest.filter((a) => !a.destructive);
  const destructive = rest.filter((a) => a.destructive);
  const menuName = subject ? `More actions for ${subject}` : 'More actions';
  const closeMenu = () => setMenuOpen(false);
  return (
    <div className={cn('flex shrink-0 items-center gap-0.5', className)} data-row-actions="">
      {shown.map((action) => (
        <InlineAction key={action.id} action={action} />
      ))}
      {rest.length > 0 ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={menuName} className={iconActionClass(false)}>
              <MoreHorizontal aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[11rem]">
            {safe.map((action) => (
              <MenuAction key={action.id} action={action} onNavigate={closeMenu} />
            ))}
            {safe.length > 0 && destructive.length > 0 ? <DropdownMenuSeparator /> : null}
            {destructive.map((action) => (
              <MenuAction key={action.id} action={action} onNavigate={closeMenu} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
