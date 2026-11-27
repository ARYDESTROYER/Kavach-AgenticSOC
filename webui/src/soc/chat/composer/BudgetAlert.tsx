/**
 * BudgetAlert — the single composer-level budget notice (SPEC §8, §10.3 notice placement,
 * Round 12 SPEC D5): at most one notice above the composer, shown when `/chat/context`
 * says the AI budget (daily or monthly) is approaching or reached. The copy never names
 * the window: either one can be the limit that was hit.
 *
 * Under D5 the daily AI budget never limits chat: chat's spend is recorded in the cost
 * ledger but does not count against the budget, and the gateway exempts the chat
 * surface. The budget bounds AUTOMATIC INVESTIGATIONS, so the notice says what happens
 * to them and that chat keeps answering. It is information, never a stop sign:
 *
 * - every state is a warning, and dismissible for this session of the page (it returns
 *   if the state changes);
 * - Today's figures ("Today: $x of $y used.") appear only when the caller may see them
 *   AND the daily window alone explains the state; otherwise the monthly limit drove it
 *   and the figures are left out;
 * - reached + `on_exceed: block`: investigations pause until the budget resets and new
 *   cases wait for an analyst (an over-budget investigation routes to a human);
 * - reached + `warn`: investigations still run;
 * - reached, policy unknown (no `models:read`): investigations "may" pause.
 *
 * It is NOT a live region: the shell announcer speaks each threshold crossing once
 * (SPEC §10.9), so a re-render never re-announces.
 */
import * as React from 'react';
import { TriangleAlert, X } from 'lucide-react';
import type { ChatBudgetState, ChatContextInfo } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { useAnnouncer } from '@/soc/components/announcer';
import { budgetMeterValue, formatMoney, type BudgetMeterValue } from './format';

export interface BudgetAlertProps {
  context: ChatContextInfo | null;
  className?: string;
}

interface AlertCopy {
  tone: 'warning';
  title: string;
  body: string;
  dismissible: true;
}

/**
 * Today's spend explains the state when the daily window alone would set it: at or past
 * the soft-warn share for "approaching", at or past the limit for "reached". Mirrors the
 * gate's bands (engine/budget.py `_window_status`: the fraction rounded to 4 places, and
 * a soft-warn share of 0 read as 0.8).
 */
function todayExplains(state: ChatBudgetState, meter: BudgetMeterValue, softWarn: number | undefined): boolean {
  const fraction = Math.round((meter.spent / meter.limit) * 10_000) / 10_000;
  if (state === 'reached') return fraction >= 1;
  return fraction >= (softWarn || 0.8);
}

/** What the budget does NOT do (SPEC D5), the same sentence in every state. */
export const CHAT_KEEPS_ANSWERING = 'Chat keeps answering; its spend is still recorded.';

/** The notice's copy for a context, or null when no notice is due. */
export function budgetAlertCopy(context: ChatContextInfo | null): AlertCopy | null {
  const state = context?.budget_state;
  if (!context || !state || state === 'ok') return null;
  const meter = budgetMeterValue(context);
  // The meter's figures are today's spend against the daily limit, labelled "Today",
  // and shown only when they explain the state: the limit that was hit may be the
  // monthly one, and "used up … $2.00 of $10.00 used" would read as a contradiction.
  const lead = meter && todayExplains(state, meter, context.budget?.soft_warn_pct)
    ? `Today: ${formatMoney(meter.spent)} of ${formatMoney(meter.limit)} used${meter.simulated ? ' (simulated)' : ''}. `
    : '';
  const notice = (title: string, investigations: string): AlertCopy => ({
    tone: 'warning',
    title,
    body: `${lead}${investigations} ${CHAT_KEEPS_ANSWERING}`,
    dismissible: true,
  });
  if (state === 'approaching') {
    return notice('The AI budget is nearly used.', 'It limits automatic investigations, not chat.');
  }
  const onExceed = context.budget?.on_exceed;
  if (onExceed === 'block') {
    return notice(
      'The AI budget is used up.',
      'Automatic investigations are paused until it resets, so new cases wait for an analyst.',
    );
  }
  if (onExceed === 'warn') {
    return notice('The AI budget is used up.', 'Automatic investigations still run because the budget is set to warn only.');
  }
  return notice('The AI budget is used up.', 'Automatic investigations may be paused until it resets.');
}

export function BudgetAlert({ context, className }: BudgetAlertProps) {
  const announce = useAnnouncer();
  const copy = budgetAlertCopy(context);
  const state: ChatBudgetState | null = context?.budget_state ?? null;
  const [dismissed, setDismissed] = React.useState<ChatBudgetState | null>(null);
  const announced = React.useRef<ChatBudgetState | null>(null);

  // One announcement per threshold: speak when the state first becomes approaching or
  // reached, and again only after it went back to ok.
  React.useEffect(() => {
    if (!state || state === 'ok') {
      announced.current = null;
      return;
    }
    if (announced.current === state || !copy) return;
    announced.current = state;
    announce(`${copy.title} ${copy.body}`);
  }, [state, copy, announce]);

  if (!copy || dismissed === state) return null;
  return (
    <div
      data-budget-state={state ?? undefined}
      className={cn('flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-text', className)}
    >
      <TriangleAlert className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 leading-5">
        <span className="font-medium">{copy.title}</span> {copy.body}
      </p>
      <button
        type="button"
        className={cn('-my-1 -mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-muted', focusRing)}
        aria-label="Dismiss budget notice"
        onClick={() => setDismissed(state)}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
