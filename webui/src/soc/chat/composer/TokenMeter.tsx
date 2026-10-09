/**
 * TokenMeter — the composer's "≈ 1.2k" next-request estimate, the budget ring, and
 * their shared hover card (SPEC §8 item 1).
 *
 * The estimate is (system + history + draft) chars ÷ `chars_per_token` × calibration,
 * labelled "≈" because it is an estimate. The calibration is the server's actual ÷
 * estimate of the WHOLE first prompt of this conversation's last turn, so it applies
 * to every part (the server's system and history figures are plain chars ÷ 4), and
 * the card says so ("Calibrated ×1.5"). The card breaks the figure down and projects
 * the whole turn ("up to ≈ M" = min(ceiling, N × max_model_calls + max_tool_calls ×
 * observation_chars ÷ cpt)). Money appears only when the context carries it: the
 * projected cost range needs `rates` (`models:read`), today's spend needs
 * `spent_today` (`cost:view`). Per-turn amounts use the transcript's grammar
 * ("$0.002"), budget amounts two decimals ("$4.20 of $10.00"). Demo pricing is
 * marked simulated.
 *
 * The card opens on mouse hover and on click, tap or Enter on the estimate button (a
 * Popover: a Radix HoverCard cancels the tap on touch screens). It never takes focus.
 * Its content is supplementary: the button's accessible name already carries the
 * estimate, and the ring is its own meter.
 */
import * as React from 'react';
import type { ChatContextInfo } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { CHAT_HISTORY_EXCHANGES } from '../useChatEngine';
import { projectTurnMaxTokens } from '../display';
import { BudgetRing } from './BudgetRing';
import {
  budgetMeterValue,
  calibratedNextRequest,
  formatExactTokens,
  formatFactor,
  formatMoney,
  formatTokenCount,
  formatTurnCost,
  projectedCostRange,
} from './format';

export interface ConversationTotals {
  tokens: number | null;
  cost: number | null;
}

export interface TokenMeterProps {
  context: ChatContextInfo;
  draft: string;
  /** This conversation's recorded totals (thread summary), when the host knows them. */
  conversationTotals?: ConversationTotals | null;
  /** Show the budget ring (the compact Case Manager composer shows the estimate only). */
  showRing?: boolean;
  className?: string;
}

function Row({ label, value, sub }: { label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <>
      <dt className={cn('text-muted-foreground', sub && 'pl-3')}>{label}</dt>
      <dd className={cn('text-right tabular-nums', sub ? 'text-muted-foreground' : 'text-foreground')}>{value}</dd>
    </>
  );
}

export function TokenMeter({ context, draft, conversationTotals, showRing = true, className }: TokenMeterProps) {
  const [open, setOpen] = React.useState(false);
  const cpt = context.chars_per_token;
  const next = calibratedNextRequest(context, draft);
  const turnMax = projectTurnMaxTokens(next.total, context.bounds, cpt);
  const cost = projectedCostRange(context, next.total, turnMax);
  const ring = showRing ? budgetMeterValue(context) : null;
  const contextWindow = context.context_window;
  const windowShare = contextWindow && contextWindow > 0 ? next.total / contextWindow : null;
  const exchanges = context.history_exchanges || CHAT_HISTORY_EXCHANGES;
  const simulated = context.simulated === true;
  const spend = context.spent_today;
  const limit = context.budget?.enabled ? context.budget.daily_limit : null;

  const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedByHover = React.useRef(false);
  const titleId = React.useId();
  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  React.useEffect(() => clearTimers, []);
  // Mouse hover opens and closes the card after a short delay; touch and keyboard use
  // the button (a Radix HoverCard would cancel the tap on touch screens).
  const hoverIn = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clearTimers();
    openTimer.current = setTimeout(() => {
      openedByHover.current = true;
      setOpen(true);
    }, 250);
  };
  const hoverOut = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clearTimers();
    closeTimer.current = setTimeout(() => {
      if (openedByHover.current) setOpen(false);
    }, 150);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clearTimers();
        openedByHover.current = false;
        setOpen(next);
      }}
    >
      <PopoverAnchor asChild>
        <div
          className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}
          onPointerEnter={hoverIn}
          onPointerLeave={hoverOut}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex h-6 items-center rounded-[3px] px-1 tabular-nums transition-colors hover:bg-muted hover:text-foreground',
                focusRing,
              )}
              aria-label={`Estimated next request: ≈ ${formatTokenCount(next.total)} tokens`}
              onClick={(event) => {
                // A click on a card the mouse just opened keeps it open (no toggle-off).
                if (openedByHover.current && open) {
                  event.preventDefault();
                  openedByHover.current = false;
                  clearTimers();
                }
              }}
            >
              ≈ {formatTokenCount(next.total)}
            </button>
          </PopoverTrigger>
          {ring ? <BudgetRing value={ring} /> : null}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="end"
        aria-labelledby={titleId}
        className="w-80 p-3 text-xs"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
      >
        <p id={titleId} className="mb-2 font-medium text-foreground">
          Token estimate
        </p>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          <Row label="Next request" value={`≈ ${formatExactTokens(next.total)}`} />
          <Row sub label="System and tools" value={formatExactTokens(next.system)} />
          <Row sub label={`History · last ${exchanges} exchanges`} value={formatExactTokens(next.history)} />
          <Row sub label="Your draft" value={formatExactTokens(next.draft)} />
          {next.factor !== 1 ? (
            <Row sub label="Calibrated to this conversation" value={formatFactor(next.factor)} />
          ) : null}
          <Row label="Whole question" value={`up to ≈ ${formatExactTokens(turnMax)}`} />
          {cost ? (
            <Row
              sub
              label={simulated ? 'Projected cost (simulated)' : 'Projected cost'}
              value={`≈ ${formatTurnCost(cost.low)}–${formatTurnCost(cost.high)}`}
            />
          ) : null}
          {contextWindow ? (
            <Row
              label="Context window"
              value={
                windowShare !== null && windowShare >= 0.5
                  ? `${Math.round(windowShare * 100)}% of ${formatTokenCount(contextWindow)}`
                  : formatTokenCount(contextWindow)
              }
            />
          ) : null}
          <Row label="Per-question limit" value={formatExactTokens(context.bounds.turn_token_ceiling)} />
          {conversationTotals && (conversationTotals.tokens !== null || conversationTotals.cost !== null) ? (
            <Row
              label="This conversation"
              value={[
                conversationTotals.tokens !== null ? `${formatTokenCount(conversationTotals.tokens)} tokens` : null,
                conversationTotals.cost !== null ? formatTurnCost(conversationTotals.cost) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          ) : null}
          {typeof spend === 'number' ? (
            <Row
              label={simulated ? "Today's AI spend (simulated)" : "Today's AI spend"}
              value={typeof limit === 'number' && limit > 0 ? `${formatMoney(spend)} of ${formatMoney(limit)}` : formatMoney(spend)}
            />
          ) : null}
        </dl>
        <p className="mt-2 text-2xs text-muted-foreground">Older exchanges are not sent.</p>
        {context.budget?.enabled || typeof spend === 'number' || context.budget_state ? (
          <p className="mt-1 text-2xs text-muted-foreground">
            Chat shares this budget with automatic investigations; at the limit new investigations route to Needs
            human.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
