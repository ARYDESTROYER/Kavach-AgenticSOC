/**
 * Metrics: the case analytics page (`#/metrics`, Analytics > Metrics).
 *
 * Round 14 (SPEC §4.9, ask 8): the Overview's grammar. The page header is the title, a help
 * tip, the time range and one refresh beside the title, and the freshness stamp on the
 * right. Below it, three underline tabs, each a stack of modules on the tinted panel, one
 * panel gutter apart:
 *
 *   - Operational : one KPI strip, then verdict and disposition mix, persona and runbook
 *                   usage, knowledge reference coverage, cases per day, analyst feedback
 *                   and the LLM spend of the selected range, then the knowledge base and
 *                   memory (as they are now).
 *   - Performance : lifecycle timing (MTTA, MTTR, Dwell at p50 with period deltas), the
 *                   percentile table, triage quality rates.
 *   - Posture     : open-case aging, SLA attainment and the cases breaching it, MITRE
 *                   ATT&CK coverage with the Navigator layer export.
 *
 * Agent effectiveness and Cost are their own pages (the navigation switches them, one
 * name per page, D25); this page links to them where a module points there.
 *
 * Every module names its window after its title. The Operational counts come from
 * `GET /api/metrics`, whose case figures cover EVERY case (exact store-wide counts; the
 * rest over the newest cases the server analysed, said so when truncated), so they read
 * "all time"; only its LLM spend follows the selected range. Performance and Posture read
 * the server's windowed posture rollup.
 *
 * SECURITY (#9): every backend-derived label or value (verdict labels, case numbers,
 * technique ids, runbook titles and ids, model ids) renders as plain text, never markup.
 */
import * as React from 'react';
import { BarChart3, CheckCircle2, Crosshair, Gauge, Layers } from 'lucide-react';

import { api } from '@/lib/api';
import { getMetricsBreakdown } from '@/lib/api-dashboards';
import { listRunbookLibrary } from '@/lib/api-runbooks';
import type { Metrics, MemoryResponse, RagStats } from '@/lib/types';
import type { MetricsBreakdown, MetricsBreakdownQuery } from '@/lib/types-dashboards';
import {
  DASH,
  caseLabel,
  fmtDuration,
  fmtMoney,
  fmtNumber,
  fmtOverage,
  fmtPercent,
  fmtTokens,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { Badge } from '@/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';

import { LoadingState, Panel, PANEL_GAP } from '@/design-system';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { ChartCard, ChartEmpty } from '@/soc/components/ChartCard';
import { KpiTile, type KpiGoodDirection } from '@/soc/components/KpiTile';
import { KpiStrip } from '@/soc/components/KpiStrip';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { DonutChart, MiniBars, type DonutSegment } from '@/soc/components/charts';
import { MitreHeatmap } from '@/soc/components/charts-soc';
import { semanticColor, token } from '@/soc/components/palette';
import { useCan } from '@/soc/components/Can';
import { isSafeCaseId } from '@/soc/case-result-route';

import type { Navigate } from '@/soc/router';
import {
  fetchMitreCoverage,
  fetchPosture,
  navigatorLayerUrl,
  type MitreCoverageResponse,
  type PostureResponse,
  type SlaBreachRow,
} from './Metrics.posture.api';
import { deltaView, ratioPct } from './posture.format';
import {
  AnalyticsWindowPicker,
  RouteTextLink,
  shareOfTotal,
  ShowAllToggle,
  SortToggle,
  StripPanel,
  tokenLabel,
  UpdatedStamp,
  useAnalyticsWindow,
  useCappedRows,
  windowCaption,
  type RankSort,
} from './analytics-shared';

// --------------------------------------------------------------------------- //
// Constants + helpers
// --------------------------------------------------------------------------- //

/** The page title: the navigation label of `#/metrics` (one name per page, D25). */
const PAGE_TITLE = 'Metrics';

/** The header help tip (the page explains itself there, never in a line, C8). */
const PAGE_HELP =
  'Case volume, verdicts, routing, response times, SLA and ATT&CK coverage. Operational ' +
  'counts cover every case; the time range sets the window for LLM spend and for the ' +
  'Performance and Posture tabs.';

export type MetricsTab = 'operational' | 'performance' | 'posture';

const METRICS_TABS: readonly MetricsTab[] = ['operational', 'performance', 'posture'];

/** Statuses that end a case's lifecycle (the Cases page's terminal set). */
const TERMINAL_STATUSES = new Set(['closed', 'resolved']);

/** The panel grid of a tab: one gutter between modules, rows stretch to one height. */
const MODULE_GRID = cn('grid grid-cols-1 items-stretch md:grid-cols-2 xl:grid-cols-3', PANEL_GAP);

/**
 * One tab's panel, one gutter under the tab list. It carries no display utility: Radix
 * keeps the inactive panels in the DOM with `hidden`, and a `flex` class would override
 * that and leave their margins in the layout.
 */
const TAB_BODY = 'mt-4 xl:mt-5 3xl:mt-6';

/** The column of one tab's modules, one gutter apart. */
const TAB_STACK = cn('flex flex-col', PANEL_GAP);

/** `GET /api/metrics` with the Round 14 runbook usage (the client type predates it). */
type MetricsPayload = Metrics & { runbook_usage?: Record<string, number> };

/** The open cases by AI verdict: the "Needs human" binding of Standup and the dashboards. */
const OPEN_BY_VERDICT: MetricsBreakdownQuery = { by: 'verdict', status_group: 'open', window: 'all' };

/** One committed read of the page: every figure and the range it was read for. */
interface MetricsSnapshot {
  hours: number;
  data: MetricsPayload;
  rag: RagStats | null;
  memory: MemoryResponse | null;
  posture: PostureResponse | null;
  mitre: MitreCoverageResponse | null;
  openByVerdict: MetricsBreakdown | null;
  updatedAt: string;
}

/**
 * The open cases whose AI verdict is Needs human, from the open-by-verdict breakdown (the
 * figure Standup and the dashboards show under the same label). A case an analyst closed
 * no longer waits for a person, so it is not counted. `value` is `null` when it cannot be
 * known (no answer, or the group was cut from it); `partial` when the server could not
 * count every case.
 */
export function openNeedsHuman(breakdown: MetricsBreakdown | null | undefined): {
  value: number | null;
  partial: boolean;
} {
  if (!breakdown || !Array.isArray(breakdown.groups)) return { value: null, partial: false };
  const partial = breakdown.partial === true || breakdown.exact === false;
  const group = breakdown.groups.find((g) => g.key === 'NEEDS_HUMAN');
  if (group) {
    return typeof group.count === 'number' && Number.isFinite(group.count)
      ? { value: group.count, partial }
      : { value: null, partial };
  }
  // Absent because `top` cut it: it exists, but its size is unknown here.
  if ((breakdown.other?.count ?? 0) > 0) return { value: null, partial };
  return { value: 0, partial };
}

/**
 * The honest sub-line under "Total cases" (Round 12).
 *
 * The bound is tied to the TOTAL itself, not to `counts_exact`: that flag goes false when
 * ANY breakdown (status × verdict, or disposition) could not be counted, while the total
 * is still the store's own exact COUNT (`store_total`). So:
 *
 *   - the total is a floor only when it is demonstrably below the store's count, or, on a
 *     server that does not report one, when it is exactly the number of cases analysed
 *     out of a truncated read;
 *   - an exact total beside a partial breakdown says "Exact" and names the breakdown that
 *     is partial, from the server's own `counts_note`;
 *   - a total whose exactness cannot be checked at all keeps the cautious wording.
 */
export function totalCasesSub(data: Metrics): string | undefined {
  const total = data.total_cases;
  const storeTotal =
    typeof data.store_total === 'number' && Number.isFinite(data.store_total)
      ? data.store_total
      : undefined;
  const fetched =
    typeof data.fetched === 'number' && Number.isFinite(data.fetched) ? data.fetched : undefined;
  const belowStore = typeof total === 'number' && storeTotal !== undefined && total < storeTotal;
  const floorOfRead =
    storeTotal === undefined && data.truncated === true && fetched !== undefined && total === fetched;
  if (belowStore || floorOfRead) {
    return fetched !== undefined && storeTotal !== undefined
      ? `Lower bound · counted from the newest ${fmtNumber(fetched)} of ${fmtNumber(storeTotal)}`
      : 'Lower bound · not every case could be counted';
  }
  if (data.counts_exact === false) {
    const exactTotal = storeTotal !== undefined && total === storeTotal;
    const note = (data.counts_note || '').toLowerCase();
    const statusPartial = note.includes('status');
    const dispositionPartial = note.includes('disposition');
    const partial =
      statusPartial && dispositionPartial
        ? 'status, verdict and disposition breakdowns partial'
        : statusPartial
          ? 'status and verdict breakdowns partial'
          : dispositionPartial
            ? 'disposition breakdown partial'
            : 'some breakdowns partial';
    return exactTotal ? `Exact · ${partial}` : `Not every breakdown could be counted · ${partial}`;
  }
  return data.counts_exact === true ? 'Every case in the store' : undefined;
}

/**
 * The window caption of a figure computed over the analysed case population (average risk,
 * MTTR, usage, feedback): "all time" when the server analysed every case, else the honest
 * "newest N of M cases".
 */
export function populationCaption(data: Metrics): string {
  const fetched = typeof data.fetched === 'number' && Number.isFinite(data.fetched) ? data.fetched : undefined;
  const storeTotal =
    typeof data.store_total === 'number' && Number.isFinite(data.store_total) ? data.store_total : undefined;
  if (data.truncated === true && fetched !== undefined) {
    return storeTotal !== undefined
      ? `newest ${fmtNumber(fetched)} of ${fmtNumber(storeTotal)} cases`
      : `newest ${fmtNumber(fetched)} cases`;
  }
  return 'all time';
}

/**
 * The state split the server counted: cases resolved or closed against those still
 * active, from the exact `by_status` breakdown (never the total minus a count). `null`
 * when the server reported no status breakdown.
 */
export function statusSplit(data: Metrics): { terminal: number; active: number } | null {
  const byStatus = data.by_status;
  if (!byStatus || typeof byStatus !== 'object') return null;
  const entries = Object.entries(byStatus).filter(
    ([, count]) => typeof count === 'number' && Number.isFinite(count) && count >= 0,
  );
  if (!entries.length) return null;
  let terminal = 0;
  let active = 0;
  for (const [status, count] of entries) {
    if (TERMINAL_STATUSES.has(status.toLowerCase())) terminal += count;
    else active += count;
  }
  return { terminal, active };
}

/** Friendly names of the knowledge corpus sources (the rest are humanised as they come). */
const CORPUS_SOURCE_LABELS: Readonly<Record<string, string>> = {
  runbook: 'Runbook',
  mitre: 'MITRE ATT&CK',
  suppression: 'Suppression',
  resolved_case: 'Resolved case',
  threat_context: 'Threat context',
  imported: 'Imported',
};

/** The label of one corpus source ("mitre" reads "MITRE ATT&CK", never "Mitre"). */
export function corpusSourceLabel(source: string): string {
  return CORPUS_SOURCE_LABELS[source.toLowerCase()] ?? tokenLabel(source);
}

/** Turn a {label → count} record into ranked bar-list rows, each with its share of the total. */
function rankedItems(
  rec: Record<string, number> | undefined,
  sort: RankSort,
  label: (key: string) => string = humanizeToken,
): BarListItem[] {
  if (!rec) return [];
  const rows = Object.entries(rec).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const total = rows.reduce((sum, [, v]) => sum + v, 0);
  rows.sort((a, b) =>
    sort === 'alpha' ? label(a[0]).localeCompare(label(b[0])) : b[1] - a[1] || label(a[0]).localeCompare(label(b[0])),
  );
  return rows.map(([key, value]) => ({ label: label(key), value, sub: shareOfTotal(value, total) }));
}

/** Resolve a possibly-undefined route tab into a Metrics tab (default Operational). */
function coerceTab(v: string | undefined): MetricsTab {
  return (METRICS_TABS as readonly string[]).includes(v ?? '') ? (v as MetricsTab) : 'operational';
}

/** A case number that opens the case in Case Manager when its id is a safe route value. */
function CaseNumberLink({
  caseId,
  label,
  onNavigate,
}: {
  caseId: string;
  label: string;
  onNavigate?: Navigate;
}) {
  if (!caseId || !isSafeCaseId(caseId)) {
    return <span className="truncate font-mono text-sm text-foreground">{label}</span>;
  }
  return (
    <RouteTextLink
      page="case_manager"
      opts={{ caseId }}
      onNavigate={onNavigate}
      aria-label={`Open ${label}`}
      className="truncate font-mono text-sm"
    >
      {label}
    </RouteTextLink>
  );
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //

export interface MetricsProps {
  onNavigate?: Navigate;
  /** The active tab from the route opts (`operational`, `performance` or `posture`). */
  tab?: string;
  /** Fires when the user switches tabs; the host mirrors it into the route opts. */
  onTabChange?: (tab: MetricsTab) => void;
}

export default function MetricsPage({ onNavigate, tab: tabProp, onTabChange }: MetricsProps) {
  const [hours, setHours] = useAnalyticsWindow();
  // The tab is route-driven when the host supplies `tabProp`; otherwise a local value keeps
  // the tabs working on their own.
  const [localTab, setLocalTab] = React.useState<MetricsTab>(() => coerceTab(tabProp));
  const tab = tabProp !== undefined ? coerceTab(tabProp) : localTab;
  const setTab = React.useCallback(
    (next: MetricsTab) => {
      setLocalTab(next);
      onTabChange?.(next);
    },
    [onTabChange],
  );

  // One committed read: the figures AND the range they were read for, so every caption
  // names the window of the figures on screen, never the range picked since (a failed or
  // in-flight read keeps the previous snapshot under its own captions).
  const [snapshot, setSnapshot] = React.useState<MetricsSnapshot | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  // A window change (or a refresh) issues a new read; only the latest may commit, so a
  // slow earlier window can never overwrite the current one.
  const requestRef = React.useRef(0);
  const load = React.useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const [m, ragStats, mem, post, mit, verdicts] = await Promise.all([
        api.getMetrics(hours),
        api.ragStats().catch(() => null),
        api.getMemory().catch(() => null),
        fetchPosture(hours, 'prev').catch(() => null),
        // MITRE coverage spans ALL cases (window_hours=0) so the heatmap reflects the
        // whole observed technique footprint, independent of the selected range.
        fetchMitreCoverage(0).catch(() => null),
        // The open cases by AI verdict, the read the Standup and dashboard "Needs human"
        // figures use. Best effort: a refusal (a row-level scope answers 409) is a dash.
        getMetricsBreakdown(OPEN_BY_VERDICT).catch(() => null),
      ]);
      if (request !== requestRef.current) return;
      setSnapshot({
        hours,
        data: m as MetricsPayload,
        rag: ragStats,
        memory: mem,
        posture: post,
        mitre: mit,
        openByVerdict: verdicts,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      if (request === requestRef.current) setError(e);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [hours]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const data = snapshot?.data ?? null;
  const posture = snapshot?.posture ?? null;
  const mitre = snapshot?.mitre ?? null;
  // The range the figures on screen were read for (the picked range before the first read).
  const shownHours = snapshot?.hours ?? hours;
  const stale = snapshot !== null && snapshot.hours !== hours;

  const header = (
    <PageHeader
      title={PAGE_TITLE}
      help={PAGE_HELP}
      controls={
        <>
          <AnalyticsWindowPicker hours={hours} onChange={setHours} />
          <RefreshButton
            display="icon"
            label="Refresh metrics"
            refreshing={loading && data !== null}
            disabled={loading}
            onClick={() => void load()}
          />
        </>
      }
      actions={<UpdatedStamp at={snapshot?.updatedAt} />}
    />
  );

  return (
    <PageContainer variant="wide">
      {header}

      {error ? (
        <LoadError
          error={error}
          title={
            stale
              ? `Could not load the ${windowCaption(hours)}; showing the ${windowCaption(shownHours)}`
              : 'Could not load metrics'
          }
          fallback="An unexpected error occurred while loading analytics."
          onRetry={() => void load()}
        />
      ) : null}

      <Tabs value={tab} onValueChange={(v) => setTab(coerceTab(v))}>
        <TabsList variant="underline" aria-label="Metrics views" data-testid="metrics-tabs">
          <TabsTrigger value="operational" data-testid="metrics-tab-operational">
            Operational
          </TabsTrigger>
          <TabsTrigger value="performance" data-testid="metrics-tab-performance">
            Performance
          </TabsTrigger>
          <TabsTrigger value="posture" data-testid="metrics-tab-posture">
            Posture
          </TabsTrigger>
        </TabsList>

        <TabsContent value="operational" className={TAB_BODY}>
          <div className={TAB_STACK}>
            <OperationalTab
              data={data}
              rag={snapshot?.rag ?? null}
              memory={snapshot?.memory ?? null}
              openByVerdict={snapshot?.openByVerdict ?? null}
              loading={loading && !data}
              failed={Boolean(error) && !data}
              hours={shownHours}
              onNavigate={onNavigate}
            />
          </div>
        </TabsContent>

        <TabsContent value="performance" className={TAB_BODY}>
          <div className={TAB_STACK}>
            <PerformanceTab posture={posture} loading={loading && !snapshot} hours={shownHours} />
          </div>
        </TabsContent>

        <TabsContent value="posture" className={TAB_BODY}>
          <div className={TAB_STACK}>
            <PostureTab
              posture={posture}
              mitre={mitre}
              loading={loading && !snapshot}
              hours={shownHours}
              onNavigate={onNavigate}
            />
          </div>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

// =========================================================================== //
// Operational tab
// =========================================================================== //

interface OperationalTabProps {
  data: MetricsPayload | null;
  rag: RagStats | null;
  memory: MemoryResponse | null;
  /** The open cases by AI verdict (the "Needs human" tile); `null` when not readable. */
  openByVerdict: MetricsBreakdown | null;
  loading: boolean;
  /** The metrics read failed and there is no earlier snapshot (the error shows above). */
  failed: boolean;
  hours: number;
  onNavigate?: Navigate;
}

function OperationalTab({ data, rag, memory, openByVerdict, loading, failed, hours, onNavigate }: OperationalTabProps) {
  const [personaSort, setPersonaSort] = React.useState<RankSort>('count');
  const [runbookSort, setRunbookSort] = React.useState<RankSort>('count');
  const runbookTitles = useRunbookTitles(data?.runbook_usage);

  if (loading) {
    return <LoadingState label="Loading operational metrics" layout="page" shape="page" />;
  }
  // A load failure already renders the error above; an empty state would contradict it.
  if (failed || !data) return null;

  const knowledge = <KnowledgeSection rag={rag} memory={memory} />;

  if (!(data.total_cases > 0)) {
    return (
      <>
        <Panel title="Cases" caption="all time">
          <EmptyState
            compact
            state="no-data"
            icon={BarChart3}
            title="No cases yet"
            description="Nothing has been triaged yet. As the agent processes alerts, verdicts, routing and analyst feedback appear here."
          />
        </Panel>
        {knowledge}
      </>
    );
  }

  const population = populationCaption(data);
  const split = statusSplit(data);
  const note = (data.counts_note || '').toLowerCase();
  const statusPartial = data.counts_exact === false && note.includes('status');
  const fb = data.feedback;
  const cost = data.cost;
  const currency = (cost?.currency as string | undefined) || undefined;
  const needsHuman = openNeedsHuman(openByVerdict);

  return (
    <>
      <KpiStrip label="Operational summary" data-testid="analytics-kpi-strip">
        <KpiTile
          label="Total cases"
          value={fmtNumber(data.total_cases)}
          context={totalCasesSub(data) ?? 'all time'}
          testId="total"
        />
        <KpiTile
          label="Needs human"
          value={needsHuman.value === null ? DASH : fmtNumber(needsHuman.value)}
          context={
            needsHuman.value === null
              ? 'open now, not available'
              : `open now, AI verdict${needsHuman.partial ? ', at least' : ''}`
          }
          help="Open cases whose AI verdict is Needs human. A case an analyst closed no longer waits for a person, so it is not counted."
          testId="needs_human"
        />
        <KpiTile
          label="Resolved or closed"
          value={split ? fmtNumber(split.terminal) : DASH}
          context={
            split
              ? `${fmtNumber(split.active)} active, all time${statusPartial ? ', partial count' : ''}`
              : 'status split not reported'
          }
          testId="closed"
        />
        <KpiTile
          label="MTTR"
          value={data.resolved_count > 0 ? fmtDuration(data.mttr_minutes) : DASH}
          context={`${fmtNumber(data.resolved_count)} closed, ${population}`}
          help="Mean time from a case's creation to its last update, over closed cases."
          testId="mttr"
        />
        <KpiTile
          label="Agreement rate"
          value={fb && fb.graded_cases > 0 ? fmtPercent(fb.agreement_rate) : DASH}
          context={fb ? `${fmtNumber(fb.graded_cases)} graded, ${population}` : population}
          testId="agreement"
        />
        <KpiTile
          label="Average risk"
          value={typeof data.avg_risk_score === 'number' ? String(Math.round(data.avg_risk_score)) : DASH}
          context={`0 to 100, ${population}`}
          testId="risk"
        />
      </KpiStrip>

      <div className={MODULE_GRID}>
        <MixPanel
          title="Verdict mix"
          caption="all time"
          total={data.total_cases}
          segments={verdictSegments(data)}
          empty="No verdicts recorded yet."
        />
        <MixPanel
          title="Disposition mix"
          caption="all time"
          total={data.total_cases}
          segments={dispositionSegments(data)}
          empty="No dispositions recorded yet."
        />
        <ChartCard
          title="Persona usage"
          caption={population}
          action={<SortToggle label="Sort persona usage" value={personaSort} onChange={setPersonaSort} />}
        >
          {(() => {
            const items = rankedItems(data.persona_usage, personaSort);
            return items.length ? (
              <BarList items={items} format={(n) => fmtNumber(n)} />
            ) : (
              <ChartEmpty>No specialist routing recorded.</ChartEmpty>
            );
          })()}
        </ChartCard>

        <RunbookUsagePanel
          usage={data.runbook_usage}
          titles={runbookTitles}
          sort={runbookSort}
          onSort={setRunbookSort}
          caption={population}
        />

        <ChartCard title="Knowledge reference coverage" caption={population}>
          <ReferenceCoverage history={data.retrieval_history} />
        </ChartCard>

        <CasesPerDay data={data} />
      </div>

      <div className={cn('grid grid-cols-1 items-stretch lg:grid-cols-3', PANEL_GAP)}>
        <ChartCard title="Analyst feedback quality" caption={population} className="lg:col-span-2">
          <FeedbackQuality feedback={fb} />
        </ChartCard>

        <ChartCard
          title="LLM spend"
          caption={windowCaption(hours)}
          action={
            <RouteTextLink page="cost" onNavigate={onNavigate} className="text-sm">
              Open Cost
            </RouteTextLink>
          }
        >
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4" data-testid="analytics-spend">
            <div className="col-span-2">
              <dt className="text-sm text-muted-foreground">Total cost</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                {fmtMoney(cost?.total_cost as number | undefined, currency)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Tokens</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                {fmtTokens(cost?.total_tokens as number | undefined)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">LLM calls</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
                {fmtNumber(cost?.call_count as number | undefined)}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-muted-foreground">
            The spend ledger, by model, role and surface, is on the Cost page.
          </p>
        </ChartCard>
      </div>

      {knowledge}
    </>
  );
}

/** Verdict mix as donut segments (Unverdicted for cases with no verdict yet). */
function verdictSegments(data: Metrics): DonutSegment[] {
  const bv = data.by_verdict;
  if (!bv) return [];
  const entries: Array<[string, number]> = [
    ['TRUE_POSITIVE', bv.TRUE_POSITIVE ?? 0],
    ['FALSE_POSITIVE', bv.FALSE_POSITIVE ?? 0],
    ['NEEDS_HUMAN', bv.NEEDS_HUMAN ?? 0],
    ['none', bv.none ?? 0],
  ];
  return entries
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({
      label: k === 'none' ? 'Unverdicted' : humanizeToken(k),
      value: v,
      color: k === 'none' ? token('muted-foreground') : semanticColor(k),
    }));
}

/** Disposition mix as donut segments, largest first. */
function dispositionSegments(data: Metrics): DonutSegment[] {
  const bd = data.by_disposition;
  if (!bd) return [];
  return Object.entries(bd)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({
      label: humanizeToken(k),
      value: v,
      color: k === 'undetermined' || k === 'duplicate' ? token('muted-foreground') : semanticColor(k),
    }));
}

/** A donut with its legend: each row a colour mark, the label, the count and its share. */
function MixPanel({
  title,
  caption,
  total,
  segments,
  empty,
}: {
  title: string;
  caption: string;
  total: number;
  segments: DonutSegment[];
  empty: string;
}) {
  const sum = segments.reduce((s, x) => s + x.value, 0);
  return (
    <ChartCard title={title} caption={caption}>
      {segments.length ? (
        <div className="space-y-3">
          <DonutChart
            segments={segments}
            format={(n) => fmtNumber(n)}
            ariaLabel={title}
            center={
              <>
                <span className="text-2xl font-semibold tabular-nums text-foreground">{fmtNumber(total)}</span>
                <span className="text-xs text-muted-foreground">cases</span>
              </>
            }
          />
          <ul className="flex flex-col divide-y divide-border/70 border-t border-border/70">
            {segments.map((s) => (
              <li key={s.label} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                <span className="min-w-0 truncate text-muted-foreground">{s.label}</span>
                <span className="ml-auto shrink-0 font-semibold tabular-nums text-foreground">{fmtNumber(s.value)}</span>
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {sum > 0 ? `${Math.round((s.value / sum) * 100)}%` : DASH}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ChartEmpty>{empty}</ChartEmpty>
      )}
    </ChartCard>
  );
}

/**
 * The titles of the runbooks the usage names, read best-effort from the runbook library
 * (`runbooks:read`). A read that fails, or a viewer without the grant, keeps the ids.
 */
function useRunbookTitles(usage: Record<string, number> | undefined): ReadonlyMap<string, string> {
  const canRead = useCan('runbooks', 'read');
  const [titles, setTitles] = React.useState<ReadonlyMap<string, string>>(() => new Map());
  const wanted = React.useMemo(
    () => Object.keys(usage ?? {}).filter((id) => id && id !== 'none').sort().join('\n'),
    [usage],
  );
  React.useEffect(() => {
    if (!canRead || !wanted) return undefined;
    const controller = new AbortController();
    listRunbookLibrary({ show_replaced: true }, controller.signal)
      .then((library) => {
        const next = new Map<string, string>();
        for (const runbook of library?.runbooks ?? []) {
          if (runbook?.id && typeof runbook.title === 'string' && runbook.title.trim()) {
            next.set(runbook.id, runbook.title.trim());
          }
        }
        setTitles(next);
      })
      .catch(() => {
        /* Titles are a nicety: the ids stay readable. */
      });
    return () => controller.abort();
  }, [canRead, wanted]);
  return titles;
}

/**
 * Runbook usage (Round 14, SPEC §4.10.18): which Published runbook guided each case's
 * investigation, "No runbook" when none reached the investigator. Usage only: it does not
 * say a runbook made a case faster or slower.
 */
function RunbookUsagePanel({
  usage,
  titles,
  sort,
  onSort,
  caption,
}: {
  usage: Record<string, number> | undefined;
  titles: ReadonlyMap<string, string>;
  sort: RankSort;
  onSort: (sort: RankSort) => void;
  caption: string;
}) {
  const label = (id: string) => (id === 'none' ? 'No runbook' : titles.get(id) ?? id);
  const items = rankedItems(usage, sort, label);
  return (
    <ChartCard
      title="Runbook usage"
      caption={caption}
      action={<SortToggle label="Sort runbook usage" value={sort} onChange={onSort} />}
    >
      {usage === undefined ? (
        <ChartEmpty>This server does not report runbook usage.</ChartEmpty>
      ) : items.length ? (
        <BarList items={items} format={(n) => fmtNumber(n)} />
      ) : (
        <ChartEmpty>No runbook guided an investigation yet.</ChartEmpty>
      )}
    </ChartCard>
  );
}

/** Case-level knowledge reference coverage, or why it cannot be measured (never a fake 0%). */
function ReferenceCoverage({ history }: { history: Metrics['retrieval_history'] }) {
  if (history?.available && typeof history.reference_coverage === 'number') {
    return (
      <div className="space-y-3">
        <div className="text-3xl font-semibold tabular-nums text-foreground">
          {fmtPercent(history.reference_coverage)}
        </div>
        <p className="text-sm text-muted-foreground">
          {fmtNumber(history.cases_with_references)} of {fmtNumber(history.completed_attempt_cases)} fully
          observed cases with a completed retrieval attempt recorded at least one reference.
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Case-level reference coverage only, not per-run hit rate or retrieval quality.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <ChartEmpty>
        {history?.reason ||
          'Retrieval history is not available. Missing history is not counted as zero.'}
      </ChartEmpty>
      {history ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {fmtNumber(history.history_available_cases)} of {fmtNumber(history.eligible_cases)} investigated
          cases have complete lifetime retrieval instrumentation.
        </p>
      ) : null}
    </div>
  );
}

/** Cases created per UTC day over the server's trend window. */
function CasesPerDay({ data }: { data: Metrics }) {
  const perDay = Array.isArray(data.cases_per_day)
    ? data.cases_per_day.map((d) => (typeof d.count === 'number' ? d.count : 0))
    : [];
  const total = perDay.reduce((s, x) => s + x, 0);
  return (
    <ChartCard
      title="Cases per day"
      caption={perDay.length > 1 ? `last ${fmtNumber(perDay.length)} days with cases` : undefined}
    >
      {perDay.length > 1 ? (
        <div className="space-y-2">
          <MiniBars data={perDay} colorToken="success" height={140} ariaLabel="Cases per day" />
          <p className="text-sm tabular-nums text-muted-foreground">
            {`${fmtNumber(perDay.length)} days, ${fmtNumber(total)} cases, times in UTC`}
          </p>
        </div>
      ) : (
        <ChartEmpty>Not enough days with cases to chart a trend.</ChartEmpty>
      )}
    </ChartCard>
  );
}

/** Analyst feedback: agreement and time saved as figures, then the quality scores. */
function FeedbackQuality({ feedback: fb }: { feedback: Metrics['feedback'] | undefined }) {
  if (!fb || !(fb.graded_cases > 0)) {
    return (
      <ChartEmpty>
        No analyst feedback recorded yet. Grade closed cases to build accuracy, reasoning and
        time-saved figures here.
      </ChartEmpty>
    );
  }
  const outcomes = rankedItems(fb.outcome_distribution, 'count');
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:max-w-md">
        <div>
          <dt className="text-sm text-muted-foreground">Agreement</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{fmtPercent(fb.agreement_rate)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Time saved</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {fb.time_saved_minutes > 0 ? fmtDuration(fb.time_saved_minutes) : DASH}
          </dd>
        </div>
      </dl>
      <BarList
        items={[
          { label: 'Accuracy', value: Math.round((fb.avg_accuracy || 0) * 100) },
          { label: 'Reasoning quality', value: Math.round((fb.avg_reasoning_quality || 0) * 100) },
          { label: 'Action appropriateness', value: Math.round((fb.avg_action_appropriateness || 0) * 100) },
        ]}
        format={(n) => `${n}%`}
      />
      {outcomes.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Recorded outcomes</h3>
          <BarList items={outcomes} format={(n) => fmtNumber(n)} />
        </div>
      ) : null}
    </div>
  );
}

/** The knowledge base and the operator memory the agents draw on, as they are now. */
function KnowledgeSection({ rag, memory }: { rag: RagStats | null; memory: MemoryResponse | null }) {
  const [corpusSort, setCorpusSort] = React.useState<RankSort>('count');
  if (rag === null && memory === null) return null;
  const entries = memory?.entries ?? [];
  const active = entries.filter((e) => e.active).length;
  let human = 0;
  let agent = 0;
  let other = 0;
  for (const e of entries) {
    if (e.source === 'human') human += 1;
    else if (e.source === 'agent') agent += 1;
    else other += 1;
  }
  const memorySegments: DonutSegment[] = [
    { label: 'Human', value: human, color: token('primary') },
    { label: 'Agent', value: agent, color: token('chart-2') },
    { label: 'Other', value: other, color: token('muted-foreground') },
  ].filter((s) => s.value > 0);
  const corpus = rankedItems(rag?.by_source, corpusSort, corpusSourceLabel);

  return (
    <>
      {/* The strip grammar inside a module (one KPI strip per page; this is a titled
          strip panel), then the two breakdowns as modules of their own. */}
      <StripPanel
        title="Knowledge base and memory"
        caption="now"
        data-testid="analytics-knowledge-strip"
      >
        <KpiTile label="Documents" value={fmtNumber(rag?.document_count)} context="in the corpus" />
        <KpiTile label="Chunks" value={fmtNumber(rag?.total_chunks)} context="searchable passages" />
        <KpiTile
          label="Embedding dimensions"
          value={typeof rag?.dim === 'number' ? fmtNumber(rag.dim) : DASH}
          // The model id is an identifier, not a numeral: it is the context line, never a
          // value that breaks mid-word in the numeral slot (AN8).
          context={rag?.embedding_model ? rag.embedding_model : 'model not reported'}
          testId="embedding-model"
        />
        <KpiTile label="Memory facts" value={fmtNumber(memory?.count)} context="approved and pending" />
        <KpiTile
          label="Active memory"
          value={memory ? fmtNumber(active) : DASH}
          context={memory ? `of ${fmtNumber(memory.count)} facts` : 'not reported'}
        />
      </StripPanel>
      <div className={cn('grid grid-cols-1 items-stretch lg:grid-cols-2', PANEL_GAP)}>
        <ChartCard
          title="Corpus by source"
          caption="now"
          action={<SortToggle label="Sort corpus by source" value={corpusSort} onChange={setCorpusSort} />}
        >
          {corpus.length ? (
            <BarList items={corpus} format={(n) => fmtNumber(n)} />
          ) : (
            <ChartEmpty>{rag ? 'No documents indexed yet.' : 'Corpus figures are not available.'}</ChartEmpty>
          )}
        </ChartCard>
        <ChartCard title="Memory by author" caption="now">
          {memorySegments.length ? (
            <DonutChart
              segments={memorySegments}
              format={(n) => fmtNumber(n)}
              ariaLabel="Memory facts by author"
              center={
                <>
                  <span className="text-2xl font-semibold tabular-nums text-foreground">{fmtNumber(memory?.count)}</span>
                  <span className="text-xs text-muted-foreground">facts</span>
                </>
              }
            />
          ) : (
            <ChartEmpty>{memory ? 'No memory facts recorded yet.' : 'Memory figures are not available.'}</ChartEmpty>
          )}
        </ChartCard>
      </div>
    </>
  );
}

// =========================================================================== //
// Performance tab: lifecycle (server p50/p90 + honest dash) + quality + deltas
// =========================================================================== //

type StatBlockShape = PostureResponse['lifecycle']['mttr_minutes'];

/** A StatBlock value as a duration; the backend's dash string stays a dash. */
function blockDuration(value: number | string): string {
  return typeof value === 'number' ? fmtDuration(value) : DASH;
}

/** Render-ready value and context for a StatBlock-backed tile (an honest dash when unmeasured). */
function statBlockTile(block: StatBlockShape, caption: string): { value: string; context: string } {
  if (!block.available) return { value: DASH, context: block.reason || 'no samples yet' };
  return { value: blockDuration(block.p50), context: `${fmtNumber(block.count)} samples, ${caption}` };
}

function PerformanceTab({
  posture,
  loading,
  hours,
}: {
  posture: PostureResponse | null;
  loading: boolean;
  hours: number;
}) {
  if (loading) {
    return <LoadingState label="Loading performance metrics" layout="panel" shape="panel" />;
  }
  if (!posture) {
    return (
      <Panel title="Performance" caption={windowCaption(hours)}>
        <EmptyState
          compact
          state="unavailable"
          title="Performance figures are not available"
          description="The posture rollup could not be loaded. Refresh to try again; it computes lifecycle timing and triage quality on the server."
        />
      </Panel>
    );
  }

  const { lifecycle, quality, compare } = posture;
  const caption = windowCaption(hours);
  type CmpKey = Exclude<keyof NonNullable<PostureResponse['compare']>, 'mode'>;
  const timing: Array<{ key: string; label: string; block: StatBlockShape; cmp?: CmpKey; help: string }> = [
    {
      key: 'mtta',
      label: 'MTTA (p50)',
      block: lifecycle.mtta_minutes,
      cmp: 'mtta_p50',
      help: 'Median time from case creation to the first analyst acknowledgement.',
    },
    {
      key: 'mttr',
      label: 'MTTR (p50)',
      block: lifecycle.mttr_minutes,
      cmp: 'mttr_p50',
      help: 'Median time from case creation to the first resolved or closed state.',
    },
    {
      key: 'dwell',
      label: 'Dwell (p50)',
      block: lifecycle.dwell_minutes,
      help: 'Median time from case creation to the first response. It is time to first response, not time to detect.',
    },
  ];

  return (
    <>
      <KpiStrip label="Lifecycle timing" data-testid="performance-timing-strip">
        {timing.map((t) => {
          const tile = statBlockTile(t.block, caption);
          const dv = t.cmp ? deltaView(compare?.[t.cmp]) : { show: false, label: '' };
          return (
            <KpiTile
              key={t.key}
              label={t.label}
              value={tile.value}
              context={tile.context}
              help={t.help}
              goodDirection="down"
              delta={dv.show && typeof dv.value === 'number' ? { value: dv.value, label: dv.label, period: 'vs the previous window' } : undefined}
              testId={`timing-${t.key}`}
            />
          );
        })}
      </KpiStrip>

      <Panel title="Percentile distribution" caption={caption} padding="none" data-testid="performance-percentiles">
        <Table aria-label="Lifecycle timing percentiles" containerClassName="pb-2">
            <TableHeader>
              <TableRow>
                <TableHead density="compact" className="pl-4 xl:pl-5 3xl:pl-6">Interval</TableHead>
                <TableHead density="compact" className="text-right">p50</TableHead>
                <TableHead density="compact" className="text-right">p90</TableHead>
                <TableHead density="compact" className="text-right">Mean</TableHead>
                <TableHead density="compact" className="text-right">Max</TableHead>
                <TableHead density="compact" className="pr-4 text-right xl:pr-5 3xl:pr-6">Samples</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(
                [
                  ['Time to acknowledge', lifecycle.mtta_minutes],
                  ['Time to resolve', lifecycle.mttr_minutes],
                  ['Time to first response', lifecycle.dwell_minutes],
                ] as Array<[string, StatBlockShape]>
              ).map(([label, block]) => (
                <TableRow key={label}>
                  <TableCell density="compact" className="pl-4 font-medium text-foreground xl:pl-5 3xl:pl-6">
                    {label}
                    {!block.available && block.reason ? (
                      <span className="block text-xs font-normal text-muted-foreground">{block.reason}</span>
                    ) : null}
                  </TableCell>
                  <TableCell density="compact" numeric className="text-right">{block.available ? blockDuration(block.p50) : DASH}</TableCell>
                  <TableCell density="compact" numeric className="text-right">{block.available ? blockDuration(block.p90) : DASH}</TableCell>
                  <TableCell density="compact" numeric className="text-right">{block.available ? blockDuration(block.mean) : DASH}</TableCell>
                  <TableCell density="compact" numeric className="text-right">{block.available ? blockDuration(block.max) : DASH}</TableCell>
                  <TableCell density="compact" numeric className="pr-4 text-right xl:pr-5 3xl:pr-6">{fmtNumber(block.count)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
        </Table>
      </Panel>

      <StripPanel title="Triage quality" caption={caption} data-testid="performance-quality">
        <QualityTile
          label="FP rate"
          value={ratioPct(quality.false_positive_rate)}
          context={`${fmtNumber(quality.false_positive_cases)} of ${fmtNumber(quality.verdicted_cases)} verdicted`}
          delta={deltaView(compare?.false_positive_rate)}
          goodDirection="down"
        />
        <QualityTile
          label="Incident yield"
          value={ratioPct(quality.alert_to_incident_ratio)}
          context={`${fmtNumber(quality.true_positive_cases)} true positives`}
          delta={deltaView(compare?.alert_to_incident_ratio)}
          goodDirection="none"
        />
        <QualityTile
          label="Escalation rate"
          value={ratioPct(quality.escalation_rate)}
          context={`${fmtNumber(quality.escalated_cases)} escalated`}
          delta={deltaView(compare?.escalation_rate)}
          goodDirection="down"
        />
        <QualityTile
          label="Containment"
          value={ratioPct(quality.containment_rate)}
          context={`${fmtNumber(quality.terminal_cases)} worked to close`}
        />
        <QualityTile
          label="Automation rate"
          value={ratioPct(quality.automation_rate)}
          context={`${fmtNumber(quality.auto_closed_cases)} closed by the agent`}
          delta={deltaView(compare?.automation_rate)}
        />
      </StripPanel>

      {compare ? (
        <p className="text-sm text-muted-foreground">
          Changes compare the {caption} with the window just before it. A falling FP rate,
          escalation rate or response time reads as an improvement.
        </p>
      ) : null}
    </>
  );
}

function QualityTile({
  label,
  value,
  context,
  delta,
  goodDirection,
}: {
  label: string;
  value: string;
  context?: string;
  delta?: ReturnType<typeof deltaView>;
  /** Which direction is an improvement (drives the delta colour; the arrow follows the sign). */
  goodDirection?: KpiGoodDirection;
}) {
  return (
    <KpiTile
      label={label}
      value={value}
      context={context}
      goodDirection={goodDirection}
      delta={delta && delta.show && typeof delta.value === 'number' ? { value: delta.value, label: delta.label } : undefined}
    />
  );
}

// =========================================================================== //
// Posture tab: aging + SLA attainment + MITRE coverage heatmap
// =========================================================================== //

const AGE_BAR: Record<string, string> = {
  '<1h': 'bg-success',
  '1-4h': 'bg-info',
  '4-24h': 'bg-medium',
  '1-3d': 'bg-high',
  '3-7d': 'bg-high',
  '>7d': 'bg-critical',
};

/** Readable age-bucket labels ("1-4h" reads "1 to 4 hours"). */
const AGE_LABEL: Record<string, string> = {
  '<1h': 'Under 1 hour',
  '1-4h': '1 to 4 hours',
  '4-24h': '4 to 24 hours',
  '1-3d': '1 to 3 days',
  '3-7d': '3 to 7 days',
  '>7d': 'Over 7 days',
};

/** How far a breaching row is past its target, or how long an at-risk row has left. */
export function slaRowTiming(row: Pick<SlaBreachRow, 'elapsed_minutes' | 'target_minutes'>): string {
  const elapsed = Number(row.elapsed_minutes);
  const target = Number(row.target_minutes);
  if (!Number.isFinite(elapsed) || !Number.isFinite(target)) return DASH;
  const over = elapsed - target;
  if (over > 0) return fmtOverage(over);
  return `${fmtDuration(Math.max(0, -over))} left`;
}

/** How many rows a Posture list shows before "Show all". */
const OLDEST_PREVIEW = 8;
const BREACHING_PREVIEW = 10;

/**
 * The oldest open cases of the window. The server sends the oldest ten of the queue, so
 * when the queue is deeper the panel says which part it lists.
 */
function OldestOpenPanel({
  rows,
  queueDepth,
  caption,
  onNavigate,
}: {
  rows: PostureResponse['aging']['oldest'];
  queueDepth: number;
  caption: string;
  onNavigate?: Navigate;
}) {
  const list = useCappedRows(rows, OLDEST_PREVIEW);
  const complete = queueDepth <= rows.length;
  // While folded, the hidden count is measured against the whole queue, not only the
  // rows the server sent, so it never contradicts the header count.
  const folded = list.capped && !list.expanded;
  const notShown = Math.max(0, (complete ? rows.length : queueDepth) - list.shown.length);
  return (
    <Panel
      title="Oldest open cases"
      count={queueDepth}
      caption={caption}
      actions={
        list.capped ? (
          <ShowAllToggle
            total={rows.length}
            hidden={list.hidden}
            expanded={list.expanded}
            controls={list.listId}
            onToggle={list.toggle}
            complete={complete}
          />
        ) : undefined
      }
      data-testid="posture-oldest"
    >
      {rows.length ? (
        <>
          <ul id={list.listId} className="flex flex-col divide-y divide-border/70" aria-label="Oldest open cases">
            {list.shown.map((c) => (
              <li key={c.case_id} className="flex min-h-10 items-center gap-3 py-2 text-sm">
                <CaseNumberLink caseId={c.case_id} label={caseLabel(c)} onNavigate={onNavigate} />
                <span className="min-w-0 truncate text-muted-foreground">{humanizeToken(c.status)}</span>
                <span className="ml-auto shrink-0 tabular-nums text-foreground">{fmtDuration(c.age_hours * 60)}</span>
              </li>
            ))}
          </ul>
          {folded ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {fmtNumber(notShown)} more {notShown === 1 ? 'case' : 'cases'} not shown
              {complete ? '.' : `; this list holds the ${fmtNumber(rows.length)} oldest.`}
            </p>
          ) : !complete ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Listing the {fmtNumber(rows.length)} oldest of {fmtNumber(queueDepth)} open cases.
            </p>
          ) : null}
        </>
      ) : (
        <ChartEmpty>No open case in this window.</ChartEmpty>
      )}
    </Panel>
  );
}

/**
 * The cases past or close to an SLA target, furthest past first. The server lists at most
 * the 25 furthest; when more rows exist the panel says how many it lists.
 */
function BreachingPanel({
  sla,
  caption,
  onNavigate,
}: {
  sla: PostureResponse['sla'];
  caption: string;
  onNavigate?: Navigate;
}) {
  const rows = sla.breaching ?? [];
  const list = useCappedRows(rows, BREACHING_PREVIEW);
  const total =
    (sla.response_breached ?? 0) +
    (sla.response_at_risk ?? 0) +
    (sla.resolve_breached ?? 0) +
    (sla.resolve_at_risk ?? 0);
  const complete = total <= rows.length;
  // As for the oldest open cases: the folded count is against the full total.
  const folded = list.capped && !list.expanded;
  const notShown = Math.max(0, (complete ? rows.length : total) - list.shown.length);
  return (
    <Panel
      title="Breaching or at risk"
      count={rows.length ? Math.max(total, rows.length) : undefined}
      caption={caption}
      actions={
        list.capped ? (
          <ShowAllToggle
            total={rows.length}
            hidden={list.hidden}
            expanded={list.expanded}
            controls={list.listId}
            onToggle={list.toggle}
            complete={complete}
          />
        ) : undefined
      }
      data-testid="posture-breaching"
    >
      {rows.length ? (
        <>
          <ul id={list.listId} className="flex flex-col divide-y divide-border/70" aria-label="Cases breaching or at risk">
            {list.shown.map((b) => (
              <li key={`${b.case_id}-${b.clock}`} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <Badge variant={b.state === 'breached' ? 'critical' : 'high'}>
                  {b.state === 'breached' ? 'Breached' : 'At risk'}
                </Badge>
                <CaseNumberLink caseId={b.case_id} label={caseLabel(b)} onNavigate={onNavigate} />
                <span className="min-w-0 truncate text-muted-foreground">
                  {`${humanizeToken(b.clock)} target${b.priority ? `, ${b.priority}` : ''}`}
                </span>
                <span
                  className={cn(
                    'ml-auto shrink-0 whitespace-nowrap tabular-nums',
                    b.state === 'breached' ? 'text-critical-text' : 'text-foreground',
                  )}
                >
                  {slaRowTiming(b)}
                </span>
              </li>
            ))}
          </ul>
          {folded ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {fmtNumber(notShown)} more not shown
              {complete ? '.' : `; this list holds the ${fmtNumber(rows.length)} furthest past the target.`}
            </p>
          ) : !complete ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Listing {fmtNumber(rows.length)} of {fmtNumber(total)}, furthest past the target first.
            </p>
          ) : null}
        </>
      ) : (
        <EmptyState
          compact
          state="success"
          icon={CheckCircle2}
          title="No SLA breaches"
          description="No evaluated case is breaching or close to its priority target."
        />
      )}
    </Panel>
  );
}

function PostureTab({
  posture,
  mitre,
  loading,
  hours,
  onNavigate,
}: {
  posture: PostureResponse | null;
  mitre: MitreCoverageResponse | null;
  loading: boolean;
  hours: number;
  onNavigate?: Navigate;
}) {
  if (loading) {
    return <LoadingState label="Loading posture" layout="panel" shape="panel" />;
  }
  const caption = windowCaption(hours);
  const aging = posture?.aging;
  const sla = posture?.sla;

  const ageTotal = (aging?.age_buckets ?? []).reduce((s, b) => s + (b.count || 0), 0);
  const ageBars: BarListItem[] = (aging?.age_buckets ?? []).map((b) => ({
    label: AGE_LABEL[b.bucket] ?? b.bucket,
    value: b.count,
    color: AGE_BAR[b.bucket] ?? 'bg-accent-bar',
    sub: shareOfTotal(b.count, ageTotal),
  }));

  // MITRE columns: each tactic is a column; cells are its covered techniques (top 8).
  const mitreColumns =
    mitre && mitre.covered_techniques > 0
      ? Object.values(mitre.by_tactic)
          .filter((t) => t.techniques.length > 0)
          .sort((a, b) => b.covered - a.covered)
          .map((t) => ({
            tactic: t.tactic,
            label: t.tactic,
            cells: t.techniques.slice(0, 8).map((tech) => ({
              technique: tech.id,
              name: tech.name,
              value: tech.case_count,
            })),
          }))
      : [];

  const oldestOpen = aging?.oldest[0];

  return (
    <>
      {aging ? (
        <>
          <StripPanel title="Open-case aging" caption={`cases opened in the ${caption}`} data-testid="posture-aging">
            <KpiTile label="Queue depth" value={fmtNumber(aging.queue_depth)} context="still open" />
            <KpiTile label="Arrivals" value={fmtNumber(aging.arrivals)} context="cases opened" />
            <KpiTile label="Closures" value={fmtNumber(aging.closures)} context="now closed or resolved" />
            <KpiTile
              label="Closed against arrived"
              value={ratioPct(aging.closure_vs_arrival)}
              context={`${fmtNumber(aging.closures)} of ${fmtNumber(aging.arrivals)}`}
            />
            <KpiTile
              label="Oldest open"
              value={oldestOpen ? fmtDuration(oldestOpen.age_hours * 60) : DASH}
              context={oldestOpen ? caseLabel(oldestOpen) : 'no open case'}
            />
          </StripPanel>

          <div className={cn('grid grid-cols-1 items-stretch lg:grid-cols-2', PANEL_GAP)}>
            <ChartCard title="Age distribution" caption={`open cases opened in the ${caption}`}>
              {ageBars.some((b) => b.value > 0) ? (
                <BarList items={ageBars} format={(n) => fmtNumber(n)} />
              ) : (
                <ChartEmpty>No open cases to age.</ChartEmpty>
              )}
            </ChartCard>

            <OldestOpenPanel
              rows={aging.oldest}
              queueDepth={aging.queue_depth}
              caption={`open cases opened in the ${caption}`}
              onNavigate={onNavigate}
            />
          </div>
        </>
      ) : (
        <Panel title="Open-case aging" caption={caption}>
          <EmptyState
            compact
            state="unavailable"
            icon={Layers}
            title="Aging is not available"
            description="The posture rollup could not be loaded. Refresh to try again."
          />
        </Panel>
      )}

      {!posture ? (
        // A failed read is not a setting: never say "tracking is off" for it.
        <Panel title="SLA attainment" caption={caption}>
          <EmptyState
            compact
            state="unavailable"
            icon={Gauge}
            title="SLA attainment is not available"
            description="The posture rollup could not be loaded. Refresh to try again."
          />
        </Panel>
      ) : sla?.enabled ? (
        <>
          <StripPanel title="SLA attainment" caption={caption} data-testid="posture-sla">
            <KpiTile
              label="Attainment"
              // null = nothing in the window could be scored: a dash, never "0%".
              value={ratioPct(typeof sla.attainment_pct === 'number' ? sla.attainment_pct / 100 : null)}
              context={typeof sla.attainment_pct === 'number' ? 'met their target' : sla.attainment_reason || 'not measured'}
            />
            <KpiTile label="Evaluated" value={fmtNumber(sla.evaluated)} context="cases with a target" />
            <KpiTile
              label="Response breached"
              value={fmtNumber(sla.response_breached)}
              countTo={sla.response_breached ?? 0}
              format={fmtNumber}
              accent="critical"
              context="past the response target"
            />
            <KpiTile
              label="Resolve breached"
              value={fmtNumber(sla.resolve_breached)}
              countTo={sla.resolve_breached ?? 0}
              format={fmtNumber}
              accent="critical"
              context="past the resolve target"
            />
            <KpiTile
              label="At risk"
              value={fmtNumber((sla.response_at_risk ?? 0) + (sla.resolve_at_risk ?? 0))}
              context="close to a target"
            />
          </StripPanel>
          <BreachingPanel sla={sla} caption={caption} onNavigate={onNavigate} />
        </>
      ) : (
        <Panel title="SLA attainment" caption={caption}>
          <EmptyState
            compact
            state="unavailable"
            icon={Gauge}
            title="SLA tracking is off"
            description={
              sla?.reason ||
              'Turn on an SLA policy with response and resolve targets per priority in Settings to track attainment here.'
            }
          />
        </Panel>
      )}

      <Panel
        title="MITRE ATT&CK coverage"
        caption="all cases"
        aside={
          mitre ? (
            <span className="tabular-nums">
              {fmtNumber(mitre.covered_techniques)} of {fmtNumber(mitre.total_techniques)} techniques,{' '}
              {ratioPct((mitre.coverage_pct ?? 0) / 100)}, corpus {mitre.corpus_version}
            </span>
          ) : undefined
        }
        actions={
          mitre && mitreColumns.length ? (
            <a
              href={navigatorLayerUrl(0)}
              target="_blank"
              rel="noopener noreferrer"
              download="navigator.layer.json"
              className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
            >
              <Crosshair className="size-3.5" aria-hidden />
              Export ATT&CK Navigator layer
            </a>
          ) : undefined
        }
        data-testid="posture-mitre"
      >
        {mitre && mitreColumns.length ? (
          // `relative`: the heatmap's screen-reader table is absolutely positioned and as
          // wide as its content; anchored here it is clipped with the page instead of
          // widening the document on a phone.
          <div className="relative space-y-3">
            <MitreHeatmap columns={mitreColumns} ariaLabel="MITRE ATT&CK technique coverage by tactic" />
            <p className="text-sm text-muted-foreground">
              Each cell is a covered technique; its shade grows with the number of cases that
              reference it. Unknown or forged ids are dropped
              {mitre.invalid_dropped > 0 ? ` (${fmtNumber(mitre.invalid_dropped)} dropped)` : ''}.
            </p>
          </div>
        ) : (
          <EmptyState
            compact
            state={mitre ? 'no-data' : 'unavailable'}
            icon={Crosshair}
            title={mitre ? 'No technique coverage yet' : 'Coverage is not available'}
            description={
              mitre
                ? 'No case carries a valid MITRE ATT&CK technique yet. As the agent attributes techniques, the coverage grid fills in here.'
                : 'The MITRE coverage rollup could not be loaded. Refresh to try again.'
            }
          />
        )}
      </Panel>
    </>
  );
}
