/**
 * BudgetAlert — the single composer-level budget alert (SPEC §8, §10.3 notice
 * placement): at most one alert above the composer, shown before sending when
 * `/chat/context` says the AI budget (daily or monthly) is approaching or reached.
 * The copy never names the window: either one can be the limit that was hit.
 *
 * - approaching: a calm warning with the numbers when the caller may see them;
 *   dismissible for this session of the page (it returns if the state changes).
 * - reached + `on_exceed: block`: not dismissible. Send stays enabled
 *   ({@link budgetPausesAnswers}): AI answers are paused until the budget resets, and
 *   product questions are still answered from the Help Center at no cost.
 * - reached + `warn`: honest copy, questions still run.
 * - reached, policy unknown (no `models:read`): the same Help Center promise, and
 *   "may be paused" because the viewer cannot see whether the budget blocks.
 *
 * It is NOT a live region: the shell announcer speaks each threshold crossing once
 * (SPEC §10.9), so a re-render never re-announces.
 */
import * as React from 'react';
import { OctagonAlert, TriangleAlert, X } from 'lucide-react';
import type { ChatBudgetState, ChatContextInfo } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { useAnnouncer } from '@/soc/components/announcer';
import { budgetMeterValue, budgetPausesAnswers, formatMoney } from './format';

export { budgetPausesAnswers } from './format';

export interface BudgetAlertProps {
  context: ChatContextInfo | null;
  className?: string;
}

interface AlertCopy {
  tone: 'warning' | 'critical';
  title: string;
  body: string;
  dismissible: boolean;
}

/** The alert's copy for a context, or null when no alert is due. */
export function budgetAlertCopy(context: ChatContextInfo | null): AlertCopy | null {
  const state = context?.budget_state;
  if (!context || !state || state === 'ok') return null;
  const meter = budgetMeterValue(context);
  const sim = meter?.simulated ? ' (simulated)' : '';
  // The ring's figures are today's spend against the daily limit: say so, since the
  // limit that was hit may be the monthly one.
  const numbers = meter ? ` Today: ${formatMoney(meter.spent)} of ${formatMoney(meter.limit)} used${sim}.` : '';
  const shared = 'Chat shares this budget with automatic investigations.';
  const help = 'Questions about this app are still answered from the Help Center at no cost.';
  const lead = numbers ? `${numbers.trim()} ` : '';
  if (state === 'approaching') {
    return {
      tone: 'warning',
      title: 'The AI budget is nearly used.',
      body: `${lead}${shared}`,
      dismissible: true,
    };
  }
  if (budgetPausesAnswers(context)) {
    return {
      tone: 'critical',
      title: 'The AI budget is used up.',
      body: `${lead}AI answers are paused until the budget resets or an administrator raises it. ${help} New investigations route to Needs human.`,
      dismissible: false,
    };
  }
  if (context.budget?.on_exceed === 'warn') {
    return {
      tone: 'warning',
      title: 'The AI budget is used up.',
      body: `${lead}Questions still run because the budget is set to warn only.`,
      dismissible: true,
    };
  }
  return {
    tone: 'critical',
    title: 'The AI budget is used up.',
    body: `AI answers may be paused until the budget resets. ${help}`,
    dismissible: false,
  };
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

  if (!copy || (copy.dismissible && dismissed === state)) return null;
  const Icon = copy.tone === 'critical' ? OctagonAlert : TriangleAlert;
  return (
    <div
      data-budget-state={state ?? undefined}
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
        copy.tone === 'critical'
          ? 'border-critical/40 bg-critical/10 text-critical-text'
          : 'border-warning/40 bg-warning/10 text-warning-text',
        className,
      )}
    >
      <Icon className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 leading-5">
        <span className="font-medium">{copy.title}</span> {copy.body}
      </p>
      {copy.dismissible ? (
        <button
          type="button"
          className={cn('-my-1 -mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-muted', focusRing)}
          aria-label="Dismiss budget notice"
          onClick={() => setDismissed(state)}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
