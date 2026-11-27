/**
 * The case's investigation cost, as a button that opens every AI call behind it (Round 16
 * SPEC §4.5 WP14, research data-visibility R3). The popover reads
 * `GET /api/cases/{id}/usage` when it opens: one row per ledger call (time, role, model,
 * tier, input, output and cache tokens, latency, attempts, an "Estimated" mark, the build
 * that wrote it, the cost), each with the cost formula in its own numbers and where its
 * price came from, then the case chat spend and the runbook AI help spend on their own
 * lines (neither is part of the investigation cost) and whether the calls add up to the
 * case's recorded cost.
 *
 * The caller shows it only to a holder of `cost:view`, which the route requires too. A
 * model name is a text value (#9). Reads the ledger only; the gateway stays its only
 * writer (#6).
 */
import * as React from 'react';

import { getCaseUsage } from '@/lib/api-case-records';
import { errorMessage } from '@/lib/errorMessage';
import { fmtMoney, humanizeToken } from '@/lib/format';
import type { CaseUsagePage, CaseUsageRow } from '@/lib/types';

import { Badge } from '@/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

import { costFormula, exactMoney, priceBasisWords, recomputeCost, tokens, usageBuildText } from './usageFormula';
import { eventTime } from './time';

export interface CaseUsageButtonProps {
  caseId: string;
  totalCost: number | null | undefined;
  /** Injectable for tests. */
  load?: (caseId: string, signal?: AbortSignal) => Promise<CaseUsagePage>;
}

type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; page: CaseUsagePage };

/**
 * "Router", "Investigator", "Case chat", "Runbook AI help": what a ledger call was for. A
 * runbook step draft or suggestion uses the chat role on the `runbook` surface, so the
 * surface is read first.
 */
export function roleWords(row: Pick<CaseUsageRow, 'role' | 'surface'>): string {
  if (row.surface === 'runbook') return 'Runbook AI help';
  if (row.surface === 'chat' || row.role === 'chat') return 'Case chat';
  return row.role ? humanizeToken(row.role) : 'Model call';
}

/**
 * The tier a call ran on: Flex, Batch or the standard tier. The ledger's `batch` flag is
 * set for a Flex call too, so the recorded tier is read first.
 */
export function tierWords(row: Pick<CaseUsageRow, 'batch' | 'processing_tier'>): string {
  const tier = String(row.processing_tier || '').toLowerCase();
  if (tier === 'flex') return 'Flex';
  if (tier === 'batch' || row.batch) return 'Batch';
  if (!tier || tier === 'standard' || tier === 'default' || tier === 'auto') return 'Standard tier';
  return humanizeToken(tier);
}

/**
 * Whether a row's recorded rates do not lead to its recorded cost, so the formula never
 * stands beside a different amount without a word. One unit of the 8th decimal is allowed
 * for the two runtimes rounding a half differently.
 */
function costDiffers(row: CaseUsageRow): boolean {
  const recomputed = recomputeCost(row);
  return recomputed !== null && typeof row.cost === 'number' && Math.abs(recomputed - row.cost) > 1.5e-8;
}

const UsageRow: React.FC<{ row: CaseUsageRow }> = ({ row }) => {
  const formula = costFormula(row);
  const differs = costDiffers(row);
  const failed = row.outcome && row.outcome !== 'ok' && row.outcome !== 'success';
  const build = usageBuildText(row);
  return (
    <li className="space-y-0.5 py-2 first:pt-0 last:pb-0" data-testid="case-usage-row">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-xs font-medium text-foreground">{roleWords(row)}</span>
        {/* The model name is a text value (#9). */}
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={row.model}>
          {row.model || 'Model not recorded'}
        </span>
        {/* To the ledger's precision, like the formula below, so a cheap call never
            reads $0.0000 beside a formula that ends in its real cost. */}
        <span className="ml-auto shrink-0 text-xs tabular-nums text-foreground">
          {typeof row.cost === 'number' && Number.isFinite(row.cost) ? exactMoney(row.cost, row.currency) : fmtMoney(row.cost, row.currency)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-muted-foreground">
        <time dateTime={row.ts}>{eventTime(row.ts)}</time>
        <span aria-hidden>·</span>
        <span>{tierWords(row)}</span>
        {typeof row.latency_ms === 'number' && row.latency_ms > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{`${row.latency_ms.toLocaleString('en-US')} ms`}</span>
          </>
        ) : null}
        {row.attempts > 1 ? (
          <>
            <span aria-hidden>·</span>
            <span>{`${row.attempts.toLocaleString('en-US')} attempts`}</span>
          </>
        ) : null}
        {build ? (
          <>
            <span aria-hidden>·</span>
            <span data-testid="case-usage-build">{build}</span>
          </>
        ) : null}
        {row.usage_estimated ? (
          <Badge variant="outline" className="h-4 px-1 text-2xs" title="The provider reported no token counts, so they were estimated.">
            Estimated
          </Badge>
        ) : null}
        {failed ? (
          <Badge variant="warning" className="h-4 px-1 text-2xs">
            {row.failure_class ? `Failed: ${humanizeToken(row.failure_class).toLowerCase()}` : 'Failed'}
          </Badge>
        ) : null}
      </div>
      <p className="text-2xs tabular-nums text-muted-foreground">
        {`${tokens(row.prompt_tokens)} in, ${tokens(row.completion_tokens)} out, ${tokens(row.cache_read_tokens)} cache read, ${tokens(row.cache_write_tokens)} cache write`}
      </p>
      {formula ? (
        <>
          <p className="font-mono text-2xs text-foreground/90 [overflow-wrap:anywhere]" data-testid="case-usage-formula">
            {formula}
          </p>
          {differs ? (
            <p className="text-2xs text-muted-foreground" data-testid="case-usage-differs">
              {`The ledger records ${exactMoney(row.cost, row.currency)} for this call, not the amount its rates give.`}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-2xs text-muted-foreground">Rates not recorded for this call. The cost is shown as stored.</p>
      )}
      <p className="text-2xs text-muted-foreground">
        {priceBasisWords(row.price_basis, row.pricing_source)}
        {row.cache_write_tokens && row.cache_write_ttl ? `, cache kept for ${row.cache_write_ttl}` : ''}
      </p>
    </li>
  );
};

/**
 * The calls, in a list that scrolls past half the window. While it scrolls it is a named
 * region that takes focus, so a keyboard can scroll it (axe scrollable-region-focusable);
 * a short list adds no tab stop.
 */
const UsageList: React.FC<{ rows: CaseUsageRow[] }> = ({ rows }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setScrolls(el.scrollHeight > el.clientHeight);
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [rows]);
  return (
    <div
      ref={ref}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must take focus (axe scrollable-region-focusable)
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? 'region' : undefined}
      aria-label={scrolls ? 'AI calls' : undefined}
      data-testid="case-usage-list"
      className="max-h-[50vh] overflow-y-auto rounded-sm pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <ol className="divide-y divide-border/60">
        {rows.map((row, index) => (
          <UsageRow key={`${row.ts}-${row.idempotency_key ?? ''}-${index}`} row={row} />
        ))}
      </ol>
    </div>
  );
};

/** The popover body: the calls, the chat line and the reconciliation. */
export const CaseUsageDetails: React.FC<{ loaded: Loaded; totalCost: number }> = ({ loaded, totalCost }) => {
  if (loaded.state === 'loading') return <p className="text-xs text-muted-foreground">Loading the AI calls.</p>;
  if (loaded.state === 'error') {
    return (
      <p role="alert" className="text-xs text-critical-text">
        {loaded.message}
      </p>
    );
  }
  const { page } = loaded;
  const rows = page.rows ?? [];
  const currency = rows.find((row) => row.currency)?.currency;
  const atLeast = page.truncated ? 'at least ' : '';
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground" data-testid="case-usage-summary">
        {rows.length === 0
          ? 'No AI calls are recorded in the cost ledger for this case.'
          : page.truncated
            ? `The newest ${rows.length.toLocaleString('en-US')} calls, newest first. Older calls are not listed.`
            : `${rows.length.toLocaleString('en-US')} call${rows.length === 1 ? '' : 's'}, newest first.`}
      </p>
      {rows.length ? <UsageList rows={rows} /> : null}
      <div className="space-y-1 border-t border-border/60 pt-2 text-xs">
        <p className="flex justify-between gap-3">
          <span className="text-muted-foreground">Investigation calls</span>
          <span className="tabular-nums text-foreground">{fmtMoney(page.totals.pipeline, currency)}</span>
        </p>
        <p className="text-muted-foreground" data-testid="case-usage-chat">
          {`Case chat on this case: ${atLeast}${fmtMoney(page.totals.chat, currency)}. Not part of the investigation cost.`}
        </p>
        {/* Additive: a server before the runbook total sends none and counts that spend as chat. */}
        {typeof page.totals.runbook === 'number' && page.totals.runbook > 0 ? (
          <p className="text-muted-foreground" data-testid="case-usage-runbook">
            {`Runbook AI help on this case: ${atLeast}${fmtMoney(page.totals.runbook, currency)}. Not part of the investigation cost.`}
          </p>
        ) : null}
        {page.totals.other > 0 ? (
          <p className="text-muted-foreground">{`Other AI use on this case: ${atLeast}${fmtMoney(page.totals.other, currency)}.`}</p>
        ) : null}
        <p className="text-muted-foreground" data-testid="case-usage-reconcile">
          {page.reconciles === true
            ? "The investigation calls add up to the case's recorded cost."
            : page.reconciles === false
              ? `The investigation calls add up to ${fmtMoney(page.totals.pipeline, currency)}; the case records ${fmtMoney(
                  page.token_cost ?? totalCost,
                  currency,
                )}.`
              : 'The ledger could not total every investigation call of this case.'}
        </p>
      </div>
    </div>
  );
};

export const CaseUsageButton: React.FC<CaseUsageButtonProps> = ({ caseId, totalCost, load = getCaseUsage }) => {
  const [open, setOpen] = React.useState(false);
  const [loaded, setLoaded] = React.useState<Loaded>({ state: 'loading' });
  const titleId = React.useId();

  React.useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setLoaded({ state: 'loading' });
    let pending: Promise<CaseUsagePage>;
    try {
      pending = load(caseId, controller.signal);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending
      .then((page) => {
        if (!controller.signal.aborted) setLoaded({ state: 'ready', page });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoaded({ state: 'error', message: errorMessage(error, 'The AI calls could not be loaded.') });
        }
      });
    return () => controller.abort();
  }, [open, caseId, load]);

  if (totalCost == null) return null;
  const money = fmtMoney(totalCost);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${money}, show the AI calls behind it`}
          className="rounded-sm text-xs tabular-nums text-foreground underline decoration-dotted underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="case-usage-button"
        >
          {money}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-labelledby={titleId} className="w-[min(92vw,34rem)] space-y-2">
        <p id={titleId} className="text-sm font-semibold text-foreground">
          AI usage on this case
        </p>
        <CaseUsageDetails loaded={loaded} totalCost={totalCost} />
      </PopoverContent>
    </Popover>
  );
};
