/**
 * TokenMeter — the composer's "≈ 1.2k" next-request estimate, the context-window ring,
 * and their shared hover card (SPEC §8 item 1; Round 12 diagnosis/layout.md (f2)).
 *
 * The estimate is (system + history + draft) chars ÷ `chars_per_token` × calibration,
 * labelled "≈" because it is an estimate. The calibration is the server's actual ÷
 * estimate of the WHOLE first prompt of this conversation's last turn, so it applies
 * to every part (the server's system and history figures are plain chars ÷ 4), and
 * the card says so ("Calibrated ×1.5").
 *
 * The ring beside it is CONTEXT-WINDOW use: that same estimate ÷ `context_window`
 * from `/api/chat/context` ("12%", "<1%"). It used to be today's AI spend, which read
 * "0%" next to the estimate and looked like an empty context. In unlimited mode (SPEC D1)
 * the card explains that long conversations are summarised automatically near the limit
 * and that there is no hard cap; bounded mode keeps the per-question ceiling and the
 * whole-question projection ("up to ≈ M").
 *
 * The daily AI budget moved INTO the card (its own section with a bar): under SPEC D5 it
 * counts automatic investigations, and chat is metered but never paused by it. Money
 * appears only when the context carries it: the cost needs `rates` (`models:read`),
 * today's spend needs `spent_today` (`cost:view`). Per-turn amounts use the
 * transcript's grammar ("$0.002"), budget amounts two decimals ("$4.20 of $10.00").
 * Demo pricing is marked simulated.
 *
 * The card opens on mouse hover (over the estimate or the ring) and on click, tap or
 * Enter on the estimate button (a Popover: a Radix HoverCard cancels the tap on touch
 * screens). It never takes focus. Its content is supplementary: the button's accessible
 * name carries the estimate and the ring is its own meter.
 *
 * Round 13 (SPEC-chat T2, T13): at rest (an empty draft and under half the context
 * window used) the meter keeps its slot but is invisible and not focusable, so a new
 * chat shows no unexplained "≈ 4.1k" and "<1%"; typing, or a conversation past half
 * the window, shows it. Shown, it reads "≈ 4.1k tokens"; below 560 px of composer
 * (`compact`) only the ring shows, inside the button that names the estimate. The
 * card's history row counts the exchanges the next request replays: "History: none
 * yet" on a new chat (0 is a count, never "missing"), "History: 3 exchanges,
 * summarised near the limit" in unlimited mode, which has no exchange cap to name, and
 * "History: summary of earlier messages" when only the running summary is replayed
 * (after `/compact`).
 */
import * as React from 'react';
import type { ChatContextInfo } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { CHAT_HISTORY_EXCHANGES } from '../useChatEngine';
import { projectTurnMaxTokens } from '../display';
import { BudgetBar, ContextRing } from './BudgetRing';
import {
  budgetMeterValue,
  budgetNote,
  calibratedNextRequest,
  chatUnlimited,
  contextMeterValue,
  contextNote,
  contextValueText,
  formatContextPercent,
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
  /** Show the context ring (the compact Case Manager composer shows the estimate only). */
  showRing?: boolean;
  /** A narrow composer (below 560 px): the ring alone, inside the estimate button. */
  compact?: boolean;
  className?: string;
}

/** The meter shows at rest once the context window is at least this full (percent). */
export const METER_REST_PERCENT = 50;

/**
 * Whether the meter is at rest (invisible, keeping its slot): nothing typed and under
 * {@link METER_REST_PERCENT}% of the context window used (or no window known).
 */
export function meterAtRest(draft: string, contextPercent: number | null | undefined): boolean {
  const percent = typeof contextPercent === 'number' && Number.isFinite(contextPercent) ? contextPercent : 0;
  return draft.trim() === '' && percent < METER_REST_PERCENT;
}

/**
 * The card's history row: the exchanges the next request replays (`history_exchanges`,
 * 0 on a new chat). Unlimited mode never names an exchange cap. `historyTokens` is the
 * server's history figure: with no exchange replayed verbatim it can still be above 0
 * (unlimited mode replays the running conversation summary alone, as after `/compact`),
 * and that history is the summary, never "none yet".
 */
export function historyLabel(exchanges: number, unlimited: boolean, historyTokens = 0): string {
  const n = Number.isFinite(exchanges) && exchanges > 0 ? Math.floor(exchanges) : 0;
  if (n === 0) {
    const replayed = Number.isFinite(historyTokens) && historyTokens > 0;
    return replayed ? 'History: summary of earlier messages' : 'History: none yet';
  }
  const noun = `${n.toLocaleString('en-US')} ${n === 1 ? 'exchange' : 'exchanges'}`;
  return unlimited ? `History: ${noun}, summarised near the limit` : `History: last ${noun}`;
}

function Row({ label, value, sub }: { label: React.ReactNode; value: React.ReactNode; sub?: boolean }) {
  return (
    <>
      <dt className={cn('text-muted-foreground', sub && 'pl-3')}>{label}</dt>
      <dd className={cn('text-right tabular-nums', sub ? 'text-muted-foreground' : 'text-foreground')}>{value}</dd>
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-xs font-medium text-foreground">{children}</p>;
}

export function TokenMeter({
  context,
  draft,
  conversationTotals,
  showRing = true,
  compact = false,
  className,
}: TokenMeterProps) {
  const [open, setOpen] = React.useState(false);
  const cpt = context.chars_per_token;
  const unlimited = chatUnlimited(context);
  const next = calibratedNextRequest(context, draft);
  // Bounded mode only: unlimited questions have no whole-turn ceiling to project to.
  const turnMax = unlimited ? null : projectTurnMaxTokens(next.total, context.bounds, cpt);
  const cost = projectedCostRange(context, next.total, turnMax ?? next.total);
  const contextValue = contextMeterValue(context, next.total);
  const ring = showRing ? contextValue : null;
  // `??`, not `||`: 0 is a real count (a new chat), never "unknown" (SPEC-chat T2).
  const exchanges = context.history_exchanges ?? CHAT_HISTORY_EXCHANGES;
  const atRest = meterAtRest(draft, contextValue?.percent);
  const estimateText = `≈ ${formatTokenCount(next.total)} tokens`;
  const ringOnly = compact && ring !== null;
  const simulated = context.simulated === true;
  const spend = context.spent_today;
  const limit = context.budget?.enabled ? context.budget.daily_limit : null;
  const budgetValue = budgetMeterValue(context);
  const budgetLine = budgetNote(context);
  const showBudget = typeof spend === 'number' || budgetLine !== null;

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
  // An invisible meter never keeps its card open (the draft was sent or cleared).
  React.useEffect(() => {
    if (atRest) {
      clearTimers();
      setOpen(false);
    }
  }, [atRest]);
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
          className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', atRest && 'invisible', className)}
          data-meter-state={atRest ? 'rest' : 'shown'}
          aria-hidden={atRest || undefined}
          onPointerEnter={hoverIn}
          onPointerLeave={hoverOut}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              // Invisible at rest is also out of the tab order (visibility: hidden).
              tabIndex={atRest ? -1 : undefined}
              className={cn(
                'inline-flex h-6 items-center rounded-[3px] px-1 tabular-nums transition-colors hover:bg-muted hover:text-foreground',
                focusRing,
              )}
              aria-label={
                ringOnly && contextValue
                  ? `Estimated next request: ${estimateText}. ${contextValueText(contextValue)}`
                  : `Estimated next request: ${estimateText}`
              }
              onClick={(event) => {
                // A click on a card the mouse just opened keeps it open (no toggle-off).
                if (openedByHover.current && open) {
                  event.preventDefault();
                  openedByHover.current = false;
                  clearTimers();
                }
              }}
            >
              {ringOnly && ring ? <ContextRing value={ring} decorative /> : estimateText}
            </button>
          </PopoverTrigger>
          {ring && !ringOnly ? <ContextRing value={ring} /> : null}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="end"
        // The 16 px screen-edge gap every composer layer keeps (SPEC-chat T23, audit C8).
        collisionPadding={16}
        aria-labelledby={titleId}
        className="w-[min(20rem,calc(100vw-2rem))] p-3 text-xs"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
      >
        <p id={titleId} className="sr-only">
          Context and usage
        </p>

        {contextValue ? (
          <div role="group" aria-label="Context window" className="mb-3" data-testid="meter-context">
            <SectionTitle>Context window</SectionTitle>
            <p className="tabular-nums text-foreground">
              {formatContextPercent(contextValue.percent)} used
              <span className="text-muted-foreground">
                {` · ≈ ${formatTokenCount(contextValue.used)} of ${formatTokenCount(contextValue.window)} tokens`}
              </span>
            </p>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground" data-testid="meter-context-note">
              {contextNote(context)}
            </p>
          </div>
        ) : null}

        <SectionTitle>Next request</SectionTitle>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          <Row label="Estimate" value={`≈ ${formatExactTokens(next.total)}`} />
          <Row sub label="System and tools" value={formatExactTokens(next.system)} />
          <Row sub label={historyLabel(exchanges, unlimited, context.history_tokens)} value={formatExactTokens(next.history)} />
          <Row sub label="Your draft" value={formatExactTokens(next.draft)} />
          {next.factor !== 1 ? <Row sub label="Calibrated to this conversation" value={formatFactor(next.factor)} /> : null}
          {turnMax !== null ? <Row label="Whole question" value={`up to ≈ ${formatExactTokens(turnMax)}`} /> : null}
          {cost ? (
            turnMax !== null ? (
              <Row
                sub
                label={simulated ? 'Projected cost (simulated)' : 'Projected cost'}
                value={`≈ ${formatTurnCost(cost.low)}–${formatTurnCost(cost.high)}`}
              />
            ) : (
              <Row
                label={simulated ? 'Cost of the next step (simulated)' : 'Cost of the next step'}
                value={`≈ ${formatTurnCost(cost.low)}`}
              />
            )
          ) : null}
          {!unlimited ? <Row label="Per-question limit" value={formatExactTokens(context.bounds.turn_token_ceiling)} /> : null}
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
        </dl>
        {!contextValue ? <p className="mt-2 text-2xs text-muted-foreground">{contextNote(context)}</p> : null}

        {showBudget ? (
          <div role="group" aria-label="Daily AI budget" className="mt-3 border-t border-border pt-2.5" data-testid="meter-budget">
            <SectionTitle>Daily AI budget</SectionTitle>
            {typeof spend === 'number' ? (
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
                <Row
                  label={simulated ? 'Spent today (simulated)' : 'Spent today'}
                  value={typeof limit === 'number' && limit > 0 ? `${formatMoney(spend)} of ${formatMoney(limit)}` : formatMoney(spend)}
                />
              </dl>
            ) : null}
            {budgetValue ? <BudgetBar value={budgetValue} className="mt-1.5" /> : null}
            {budgetLine ? <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">{budgetLine}</p> : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
