/**
 * Figure widgets (Round 5 / G7; Round 14, SPEC §4.4.3):
 *
 * - `kpi.needs_human` "Awaiting a decision": open cases whose AI verdict is Needs human,
 *   counted by verdict over every open case (`breakdown?by=verdict&status_group=open
 *   &window=all`, group `NEEDS_HUMAN`), the same binding as the SOC operations strip.
 *   Never the legacy `needs_human` STATUS count, which read "0" while 20 were open (F4).
 * - `kpi.cost_budget` "AI spend": model spend in the board window, the part that chat
 *   spent outside the budget, the budget used (only for viewers who may read the budget,
 *   `models:read`), and the spend per investigated case (investigation spend divided by
 *   the cases the agent investigated; hidden while row-level scope is on).
 *
 * Every figure comes from the server; a value the server did not measure says so with
 * its reason, never 0, and a read that failed says that it could not be loaded. A panel
 * that keeps earlier figures because a refresh failed (or has not answered) says so over
 * every read it shows, with one Retry for all of them. Plain text only (#9); nothing
 * here decides anything (#3).
 */
import { fmtMoney, fmtNumber } from '@/lib/format';
import type { UsageSummary } from '@/lib/types';
import type { BudgetStatus } from '@/soc/pages/Models.api';

import { useDashboardData, useDashboardRequest, useDashboardRequests } from '../DashboardDataProvider';
import { bindingRequests, evaluateBinding } from './kpi-eval';
import { NEEDS_HUMAN_BINDING, SPEND_PER_CASE_BINDING } from './widget-requests';
import type { DashboardRequest } from './requests';
import {
  SCOPED_SENTENCE,
  SCOPE_UNCONFIRMED_MESSAGE,
  WidgetShell,
  moneyText,
  requestState,
  shareText,
  resolveTitle,
  staleOf,
  type WidgetProps,
  type WidgetState,
} from './common';

/** The request `kpi.needs_human` reads. */
export const NEEDS_HUMAN_REQUESTS: readonly DashboardRequest[] = bindingRequests(NEEDS_HUMAN_BINDING);

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="text-3xl font-semibold leading-none tabular-nums text-foreground" data-widget-figure="">
        {value}
      </div>
      <div className="mt-1.5 text-sm text-muted-foreground">{label}</div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Awaiting a decision (F4)
// --------------------------------------------------------------------------- //

export function NeedsHumanQueueWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Awaiting a decision');
  const { windowHours, retry } = useDashboardData();
  const read = useDashboardRequests(NEEDS_HUMAN_REQUESTS);
  const answer = read(NEEDS_HUMAN_REQUESTS[0]);
  const onRetry = () => retry(NEEDS_HUMAN_REQUESTS[0]);
  let state: WidgetState | null = requestState(answer, onRetry);
  const result = evaluateBinding(NEEDS_HUMAN_BINDING, read, { windowHours, nowMs: Date.now() });
  if (!state && result.status === 'not_measured') {
    state = { kind: 'unavailable', title: 'Not measured', description: result.reason ?? undefined };
  }
  const openTotal = (answer.data as { total?: unknown } | null)?.total;
  const label =
    typeof openTotal === 'number'
      ? `open cases whose AI verdict is Needs human, of ${fmtNumber(openTotal)} open`
      : 'open cases whose AI verdict is Needs human';
  return (
    <WidgetShell
      title={title}
      caption="Open now"
      exit={{ label: 'View queue', page: 'case_manager' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={result.qualifier ? `At least this many. ${result.reason ?? ''}`.trim() : undefined}
    >
      {result.status === 'value' ? (
        <Figure value={`${result.qualifier === 'at least' ? '≥' : ''}${result.text}`} label={label} />
      ) : null}
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// AI spend
// --------------------------------------------------------------------------- //

/** The surfaces whose spend sits outside the AI budget (chat, Round 12). */
const DEFAULT_EXEMPT_SURFACES: readonly string[] = ['chat'];

/** Spend of the budget-exempt surfaces in a usage summary. */
export function exemptSpend(usage: UsageSummary, exempt: readonly string[]): number {
  const set = new Set(exempt);
  return (usage.by_surface ?? []).reduce((a, row) => a + (set.has(row.key) && Number.isFinite(row.cost) ? row.cost : 0), 0);
}

/** "Budget used today $3.10 of $10.00 (31%)", from the period that has a cap. */
export function budgetLine(budget: BudgetStatus, currency: string): string {
  if (!budget.enabled) return 'No AI budget is set.';
  const pick = budget.monthly?.cap != null ? { w: budget.monthly, period: 'this month' } : budget.daily?.cap != null ? { w: budget.daily, period: 'today' } : null;
  if (!pick || pick.w.cap == null) return 'No AI budget cap is set.';
  const pct = typeof pick.w.fraction === 'number' && Number.isFinite(pick.w.fraction) ? ` (${shareText(pick.w.fraction)})` : '';
  return `${moneyText(pick.w.spent, currency)} of ${fmtMoney(pick.w.cap, currency)} ${pick.period}${pct}`;
}

const USAGE_REQ: DashboardRequest = { key: 'usage' };
const BUDGET_REQ: DashboardRequest = { key: 'budget' };

export function CostBudgetWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'AI spend');
  const { can, objectScoped, scopeError, windowHours, windowInfo, retry } = useDashboardData();
  const usageAnswer = useDashboardRequest({ key: 'usage' });
  const canBudget = can('models', 'read');
  const budgetAnswer = useDashboardRequest({ key: 'budget' }, { enabled: canBudget });
  const perCaseAllowed = can('metrics', 'view') && objectScoped === false;
  const perCaseReqs = bindingRequests(SPEND_PER_CASE_BINDING);
  const readPerCase = useDashboardRequests(perCaseReqs, perCaseReqs.map(() => perCaseAllowed));

  const usage = usageAnswer.data;
  const onRetry = () => retry(USAGE_REQ);
  const state = requestState(usageAnswer, onRetry);
  // The panel shows the usage read, the budget read and the per-case reads: held figures
  // from any of them say so, and Retry reads every one of them again.
  const shown = [
    usageAnswer,
    ...(canBudget ? [budgetAnswer] : []),
    ...(perCaseAllowed ? perCaseReqs.map(readPerCase) : []),
  ];
  const retryShown = () => {
    retry(USAGE_REQ);
    if (canBudget) retry(BUDGET_REQ);
    if (perCaseAllowed) for (const req of perCaseReqs) retry(req);
  };
  const currency = typeof usage?.currency === 'string' ? usage.currency : 'USD';
  const total = typeof usage?.total_cost === 'number' && Number.isFinite(usage.total_cost) ? usage.total_cost : null;
  const budget = budgetAnswer.data;
  const exempt = budget?.excluded_surfaces?.length ? budget.excluded_surfaces : DEFAULT_EXEMPT_SURFACES;
  const chat = usage ? exemptSpend(usage, exempt) : null;
  const perCase = perCaseAllowed ? evaluateBinding(SPEND_PER_CASE_BINDING, readPerCase, { windowHours, nowMs: Date.now() }) : null;

  const perCaseText = (() => {
    if (objectScoped === true) return SCOPED_SENTENCE;
    if (scopeError && can('metrics', 'view')) return `Not shown. ${SCOPE_UNCONFIRMED_MESSAGE}`;
    if (!perCase) return null;
    if (perCase.status === 'value') return perCase.text;
    if (perCase.status === 'loading') return 'Loading';
    // A read that failed is not a figure the server did not measure.
    if (perCase.status === 'error') return 'Could not be loaded';
    return `Not measured. ${perCase.reason ?? ''}`.trim();
  })();

  return (
    <WidgetShell
      title={title}
      caption={windowInfo.label}
      exit={{ label: 'View cost', page: 'cost' }}
      state={state}
      stale={staleOf(shown, retryShown)}
    >
      {usage ? (
        <>
          <Figure value={total == null ? 'Not measured' : moneyText(total, currency)} label={`model spend, ${fmtNumber(usage.call_count ?? 0)} ${(usage.call_count ?? 0) === 1 ? 'call' : 'calls'}`} />
          <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Of which chat, outside the budget</dt>
            <dd className="text-right tabular-nums text-foreground">{chat == null ? 'Not measured' : moneyText(chat, currency)}</dd>
            {canBudget ? (
              <>
                <dt className="text-muted-foreground">Budget used</dt>
                <dd className="text-right tabular-nums text-foreground">
                  {budget ? budgetLine(budget, budget.currency || currency) : budgetAnswer.error ? 'Could not be loaded' : 'Loading'}
                </dd>
              </>
            ) : null}
            {perCaseText != null ? (
              <>
                <dt className="text-muted-foreground">Per investigated case</dt>
                <dd className="text-right tabular-nums text-foreground">{perCaseText}</dd>
              </>
            ) : null}
          </dl>
        </>
      ) : null}
    </WidgetShell>
  );
}
