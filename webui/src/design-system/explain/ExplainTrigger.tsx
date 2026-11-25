/**
 * The Explain trigger (Round 16 SPEC §4.5 WP11; research explainability §5.1).
 *
 * Wraps a number the Console shows.
 *
 * * `interactive` (the default): hover or keyboard focus shows the one-line formula with
 *   the real numbers in a hover card that meets WCAG 2.2 SC 1.4.13 (Escape dismisses it,
 *   the pointer can move onto it, and it stays until the pointer or focus leaves). A
 *   click, Enter, Space or a tap opens a popover with the full arithmetic and "Copy
 *   calculation"; closing it returns focus to the trigger. A touch never opens the hover
 *   card (a tooltip never opens on touch), so a tap goes straight to the panel.
 * * `row-hover`: the mouse-only hover card used inside a queue row. It has no focusable
 *   content and the trigger is the child itself, so nothing interactive nests inside the
 *   row's own control; the row's accessible name carries the number.
 *
 * With `explanation` null it renders its children unchanged.
 *
 * Imported from `@/design-system/explain` (a separate entry, never the barrel) and only
 * from lazy route chunks, so it never reaches the entry bundle. Every value renders as a
 * text node (#9).
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import type { Explanation } from '@/lib/explain/types';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

import { ExplainPanel } from './ExplainPanel';

export type ExplainTriggerMode = 'interactive' | 'row-hover';

export interface ExplainTriggerProps {
  /** The explanation to show; `null` renders the children alone. */
  explanation: Explanation | null;
  children: React.ReactNode;
  mode?: ExplainTriggerMode;
  /** A component's own content in the click panel, after the steps. */
  detail?: React.ReactNode;
  /** Told when the hover line or the panel opens or closes (to load data lazily). */
  onOpenChange?: (open: boolean) => void;
  /** Extra classes for the interactive trigger. */
  className?: string;
}

/** How long the pointer rests before the hover line opens, and lingers after it leaves. */
const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 150;

const HOVER_CARD = 'w-auto max-w-[min(26rem,calc(100vw-2rem))] px-3 py-2 text-xs leading-relaxed text-foreground';

function HoverLine({ explanation, hint }: { explanation: Explanation; hint: boolean }) {
  return (
    <div data-testid="explain-hover">
      <p className="tabular-nums">{explanation.summary}</p>
      {hint ? <p className="mt-1 text-muted-foreground">Select it for the full calculation.</p> : null}
    </div>
  );
}

/** The mouse-only hover card of a queue row: no focusable content at all. */
function RowHover({ explanation, children, onOpenChange }: Omit<ExplainTriggerProps, 'mode'> & { explanation: Explanation }) {
  const child = React.isValidElement(children) ? children : <span>{children}</span>;
  return (
    <HoverCard openDelay={OPEN_DELAY_MS} closeDelay={CLOSE_DELAY_MS} onOpenChange={onOpenChange}>
      <HoverCardTrigger asChild>{child}</HoverCardTrigger>
      <HoverCardContent side="top" align="start" className={HOVER_CARD} data-explain-mode="row-hover">
        <HoverLine explanation={explanation} hint={false} />
      </HoverCardContent>
    </HoverCard>
  );
}

export const ExplainTrigger: React.FC<ExplainTriggerProps> = ({
  explanation,
  children,
  mode = 'interactive',
  detail,
  onOpenChange,
  className,
}) => {
  const [hoverOpen, setHoverOpen] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(false);
  // After the panel closes, focus returns to the trigger: the hover line stays down until
  // the pointer or focus leaves, so closing the panel does not reopen a second surface.
  const quiet = React.useRef(false);
  const titleId = React.useId();
  const notify = React.useRef(onOpenChange);
  notify.current = onOpenChange;

  const onHover = React.useCallback(
    (open: boolean) => {
      if (open && (quiet.current || panelOpen)) return;
      setHoverOpen(open);
      notify.current?.(open || panelOpen);
    },
    [panelOpen],
  );
  const onPanel = React.useCallback((open: boolean) => {
    setPanelOpen(open);
    setHoverOpen(false);
    if (!open) quiet.current = true;
    notify.current?.(open);
  }, []);

  if (!explanation) return <>{children}</>;
  if (mode === 'row-hover') {
    return (
      <RowHover explanation={explanation} onOpenChange={onOpenChange}>
        {children}
      </RowHover>
    );
  }

  return (
    <Popover open={panelOpen} onOpenChange={onPanel}>
      <HoverCard open={hoverOpen && !panelOpen} onOpenChange={onHover} openDelay={OPEN_DELAY_MS} closeDelay={CLOSE_DELAY_MS}>
        <PopoverTrigger asChild>
          <HoverCardTrigger asChild>
            <button
              type="button"
              data-explain-trigger=""
              data-explain-metric={explanation.metric}
              onPointerLeave={() => {
                quiet.current = false;
              }}
              onBlur={() => {
                quiet.current = false;
              }}
              className={cn(
                'inline-flex min-w-0 max-w-full cursor-help items-center rounded-sm text-left',
                'underline decoration-transparent decoration-dotted underline-offset-4 transition-colors',
                'hover:decoration-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                className,
              )}
            >
              {children}
              <span className="sr-only">, explain</span>
            </button>
          </HoverCardTrigger>
        </PopoverTrigger>
        <HoverCardContent side="top" align="start" className={HOVER_CARD} data-explain-mode="hover">
          <HoverLine explanation={explanation} hint />
        </HoverCardContent>
      </HoverCard>
      <PopoverContent
        align="start"
        collisionPadding={16}
        aria-labelledby={titleId}
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto"
      >
        <ExplainPanel explanation={explanation} detail={detail} titleId={titleId} />
      </PopoverContent>
    </Popover>
  );
};
