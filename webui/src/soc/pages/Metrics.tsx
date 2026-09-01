/**
 * Metrics — the consolidated analytics surface (Round 4 / #10 declutter). ONE tab
 * strip owns every reporting view so analytics is no longer split across pages:
 *
 *   - Operational : verdict/disposition mix, persona/playbook routing, cases-per-day,
 *                   feedback quality, and knowledge-base + memory health — the classic
 *                   windowed `/api/metrics` view (LLM cost moved to the Cost tab).
 *   - Performance : the REAL server-side lifecycle rollup from `/api/metrics/posture`
 *                   (MTTA/MTTR/dwell p50/p90 with honest labelled DASH), triage
 *                   QUALITY rates, and period-over-period delta tiles (▲/▼ delta%).
 *   - Posture     : aging buckets + SLA breach/at-risk + the MITRE ATT&CK coverage
 *                   heatmap (with the Navigator-layer export note). This is the SINGLE
 *                   home for lifecycle timing + SLA (Overview/Standup link here).
 *   - Effectiveness: aggregate-only observed outcome comparisons, evidence quality,
 *                   and safety guardrails. No synthetic score or learning claim.
 *   - Cost        : the LLM spend ledger — the SINGLE cost home. Every scattered cost
 *                   tile/view folds in here (the former standalone Cost page, hosted).
 *
 * The client-side 200-case derivations are GONE — Performance + Posture read the
 * deterministic server rollup. Built entirely from the shared SOC primitives + tokens.
 *
 * SECURITY (#9): every backend-derived label/value (verdict labels, case numbers,
 * technique names, analyst names, model ids) renders as PLAIN text — never markup.
 */
import * as React from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  BookOpen,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  Crosshair,
  Database,
  FileText,
  Gauge,
  Layers,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  Timer,
  TrendingUp,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { Metrics, MemoryResponse, RagStats } from '@/lib/types';
import {
  DASH,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  fmtTokens,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';

import { Card, CardContent } from '@/ui/card';
import { Button } from '@/ui/button';
import { Separator } from '@/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';

import { LoadingState } from '@/design-system';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { ControlBar } from '@/soc/components/ControlBar';
import { ChartCard, ChartEmpty } from '@/soc/components/ChartCard';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { KpiTile, type KpiAccent, type KpiGoodDirection } from '@/soc/components/KpiTile';
import { StatCard, type StatAccent } from '@/soc/components/StatCard';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { Stagger } from '@/soc/components/Stagger';
import { InlineCode } from '@/soc/components/CodeBlock';
import {
  DonutChart,
  MiniBars,
  type DonutSegment,
} from '@/soc/components/charts';
import { BurnDownChart, MitreHeatmap } from '@/soc/components/charts-soc';
import { semanticColor, token } from '@/soc/components/palette';
import { HealthDiagnostics } from '@/soc/components/HealthDiagnostics';

import type { Navigate } from '@/soc/router';
import {
  fetchMitreCoverage,
  fetchPosture,
  navigatorLayerUrl,
  type MitreCoverageResponse,
  type PostureResponse,
} from './Metrics.posture.api';
import { deltaView, humanizeMinutes as humanizeMins, ratioPct } from './posture.format';
import AgentEffectiveness from './AgentEffectiveness';
import Cost from './Cost';

// --------------------------------------------------------------------------- //
// Constants + helpers
// --------------------------------------------------------------------------- //
const WINDOWS = [
  { id: '24', label: '24h', hours: 24 },
  { id: '168', label: '7d', hours: 168 },
  { id: '720', label: '30d', hours: 720 },
] as const;

type WindowId = (typeof WINDOWS)[number]['id'];
type RankSort = 'count' | 'alpha';
type MetricsTab = 'operational' | 'performance' | 'posture' | 'effectiveness' | 'cost';

// ONE responsive column formula per grid archetype (G4 density): KPI strips widen
// by column COUNT up to 6 on ultrawide (`wide` container), and content-card grids
// climb 1→2→3→4 across breakpoints. Reused everywhere so the page has a single,
// consistent reflow rhythm instead of ad-hoc per-grid formulas.
const KPI_GRID =
  'grid grid-cols-2 border-y border-border/70 sm:grid-cols-3 xl:grid-cols-6 ' +
  // One ENABLE + one ROW-START RESET per mutually-exclusive column count, so the
  // reset wins on specificity instead of on Tailwind's emission order. The previous
  // overlapping layers were a (0,2,0) tie that re-lit cell 1 at 3 columns and stripped
  // cell 4's divider at 6; see the long note on the same strip in `Cases.tsx`.
  'max-sm:[&>*]:border-l max-sm:[&>*:nth-child(2n+1)]:border-l-0 ' +
  'sm:max-xl:[&>*]:border-l sm:max-xl:[&>*:nth-child(3n+1)]:border-l-0 ' +
  'xl:[&>*]:border-l xl:[&>*:nth-child(6n+1)]:border-l-0';
const KPI_ITEM = 'h-full min-w-0 border-l border-border/70';
const CARD_GRID = 'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4';

/** Humanize a minutes value to a compact "Xd Yh" / "Xh Ym" / "Xm" string. */
function humanizeMinutes(mins?: number | null): string {
  if (typeof mins !== 'number' || Number.isNaN(mins) || mins <= 0) return DASH;
  const m = Math.round(mins);
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  const rem = m % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}

/** Map a humanized verdict-legend label to a Cases status filter for drill-through. */
function verdictStatus(label: string): string | undefined {
  return label.toLowerCase().includes('needs human') ? 'needs_human' : undefined;
}

/** Turn a {label→count} record into colored bar-list items, ordered by count/alpha. */
function recordItems(
  rec: Record<string, number> | undefined,
  sort: RankSort = 'count',
): BarListItem[] {
  if (!rec) return [];
  const rows = Object.entries(rec).filter(([, v]) => typeof v === 'number' && v > 0);
  rows.sort((a, b) =>
    sort === 'alpha'
      ? humanizeToken(a[0]).localeCompare(humanizeToken(b[0]))
      : b[1] - a[1],
  );
  return rows.map(([k, v]) => ({ label: humanizeToken(k), value: v }));
}

/** Tidy a tactic id ("TA0002") into a readable column label using its rollup key. */
function tacticLabel(tacticId: string): string {
  // The backend keys by_tactic by the tactic id; show the id (plain) — it is the
  // stable, framework-canonical handle and is never attacker-controlled here.
  return tacticId;
}

// --------------------------------------------------------------------------- //
// Small section card with an icon + title — promoted to `soc/components/ChartCard`
// (Round 5 / G7) so the custom-dashboard widgets and Metrics share ONE card chrome.
// `ChartCard` + `ChartEmpty` are imported above; behaviour is byte-identical.
// --------------------------------------------------------------------------- //

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //
const METRICS_TABS: readonly MetricsTab[] = [
  'operational',
  'performance',
  'posture',
  'effectiveness',
  'cost',
];

/** Resolve a possibly-undefined route tab into a known MetricsTab (default operational). */
function coerceTab(v: string | undefined): MetricsTab {
  return (METRICS_TABS as readonly string[]).includes(v ?? '')
    ? (v as MetricsTab)
    : 'operational';
}

export interface MetricsProps {
  onNavigate?: Navigate;
  embedded?: boolean;
  /**
   * Active sub-tab from the route opts. The consolidated Analytics host passes
   * `NavOpts.tab` through so `#/metrics` (operational) and `#/cost` (cost) deep-links
   * land on the right view. Falls through to a local state fallback when absent.
   */
  tab?: string;
  /** Fires when the user switches tabs — the host mirrors it into the route opts. */
  onTabChange?: (tab: MetricsTab) => void;
}

export default function MetricsPage({
  onNavigate,
  embedded = false,
  tab: tabProp,
  onTabChange,
}: MetricsProps) {
  const [windowId, setWindowId] = React.useState<WindowId>('168');
  const [rankSort, setRankSort] = React.useState<RankSort>('count');
  // The tab is deep-link driven when the host supplies `tabProp`; otherwise a local
  // fallback keeps the strip interactive (e.g. the direct #/metrics standalone route).
  const [localTab, setLocalTab] = React.useState<MetricsTab>(() => coerceTab(tabProp));
  const tab = tabProp !== undefined ? coerceTab(tabProp) : localTab;
  const setTab = React.useCallback(
    (next: MetricsTab) => {
      setLocalTab(next);
      onTabChange?.(next);
    },
    [onTabChange],
  );

  const [data, setData] = React.useState<Metrics | null>(null);
  const [rag, setRag] = React.useState<RagStats | null>(null);
  const [memory, setMemory] = React.useState<MemoryResponse | null>(null);
  // Server-side posture + MITRE rollups (Round 3). Loaded alongside; non-fatal.
  const [posture, setPosture] = React.useState<PostureResponse | null>(null);
  const [mitre, setMitre] = React.useState<MitreCoverageResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const hours = React.useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.hours ?? 168,
    [windowId],
  );
  const windowLabel = React.useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.label ?? '7d',
    [windowId],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [m, ragStats, mem, post, mit] = await Promise.all([
        api.getMetrics(hours),
        api.ragStats().catch(() => null),
        api.getMemory().catch(() => null),
        fetchPosture(hours, 'prev').catch(() => null),
        // MITRE coverage spans ALL cases (window_hours=0) so the heatmap reflects the
        // whole observed technique footprint, independent of the operational window.
        fetchMitreCoverage(0).catch(() => null),
      ]);
      setData(m);
      setRag(ragStats);
      setMemory(mem);
      setPosture(post);
      setMitre(mit);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  const usesAgentEvidenceEndpoint = tab === 'effectiveness';
  const healthAvailable =
    typeof api.diagnosticsHealth === 'function' || typeof api.autoCloseHealth === 'function';
  React.useEffect(() => {
    // Effectiveness owns a distinct, aggregate-only endpoint and must not depend on
    // the generic metrics rollup succeeding. It loads itself only while its tab is
    // mounted; switching back starts the normal windowed analytics request.
    if (usesAgentEvidenceEndpoint) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, usesAgentEvidenceEndpoint]);

  // ---- derived series (operational) ------------------------------------- //
  const verdictSegments = React.useMemo<DonutSegment[]>(() => {
    const bv = data?.by_verdict;
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
  }, [data]);

  const dispositionSegments = React.useMemo<DonutSegment[]>(() => {
    const bd = data?.by_disposition;
    if (!bd) return [];
    return Object.entries(bd)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({
        label: humanizeToken(k),
        value: v,
        color:
          k === 'undetermined' || k === 'duplicate'
            ? token('muted-foreground')
            : semanticColor(k),
      }));
  }, [data]);

  const personaItems = React.useMemo(
    () => recordItems(data?.persona_usage, rankSort),
    [data, rankSort],
  );
  const playbookItems = React.useMemo(
    () => recordItems(data?.playbook_usage, rankSort),
    [data, rankSort],
  );

  const perDay = React.useMemo(
    () =>
      Array.isArray(data?.cases_per_day)
        ? data!.cases_per_day.map((d) => (typeof d.count === 'number' ? d.count : 0))
        : [],
    [data],
  );
  const perDayTotal = React.useMemo(() => perDay.reduce((s, x) => s + x, 0), [perDay]);

  const fb = data?.feedback;
  const retrievalHistory = data?.retrieval_history;
  const cost = data?.cost;
  const currency = (cost?.currency as string | undefined) || undefined;

  const outcomeItems = React.useMemo(() => recordItems(fb?.outcome_distribution), [fb]);

  // ---- knowledge base & memory (point-in-time) -------------------------- //
  const corpusItems = React.useMemo(
    () => recordItems(rag?.by_source, rankSort),
    [rag, rankSort],
  );
  const memoryEntries = React.useMemo(() => memory?.entries ?? [], [memory]);
  const activeMemoryCount = React.useMemo(
    () => memoryEntries.filter((e) => e.active).length,
    [memoryEntries],
  );
  const memorySegments = React.useMemo<DonutSegment[]>(() => {
    let human = 0;
    let agent = 0;
    let other = 0;
    for (const e of memoryEntries) {
      if (e.source === 'human') human += 1;
      else if (e.source === 'agent') agent += 1;
      else other += 1;
    }
    return [
      { label: 'Human', value: human, color: token('primary') },
      // W0-A A4: was token('accent') — `--accent` is the NEUTRAL hover/selected
      // surface, never a data-series color. Repoint to the CVD-safe chart ramp.
      { label: 'Agent', value: agent, color: token('chart-2') },
      { label: 'Other', value: other, color: token('muted-foreground') },
    ].filter((s) => s.value > 0);
  }, [memoryEntries]);

  const hasKnowledge = rag !== null || memory !== null;
  const hasAny = (data?.total_cases ?? 0) > 0;

  // ---- adaptive tab-row controls ---------------------------------------- //
  // The time window and reload are the primary commands, so they stay first when the
  // shared ControlBar wraps. Ranked-breakdown sorting is contextual and may wrap after
  // them on a narrow container. Cost owns a different endpoint/cadence.
  // Effectiveness retains the shared selector because Agent health is measured over
  // that operator-selected window; its panel owns the scoped refresh action.
  const windowControl = (
    <SegmentedControl<WindowId>
      aria-label="Time window"
      size="sm"
      value={windowId}
      onValueChange={setWindowId}
      options={WINDOWS.map((w) => ({ value: w.id, label: w.label }))}
    />
  );
  const tabPrimaryControls =
    tab === 'cost' ? null : tab === 'effectiveness' ? (
      windowControl
    ) : (
      <>
        {windowControl}
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      </>
    );
  const tabSecondaryControls = tab === 'operational' ? (
    <SegmentedControl<RankSort>
      aria-label="Sort ranked breakdowns"
      size="sm"
      value={rankSort}
      onValueChange={setRankSort}
      options={[
        { value: 'count', label: 'Count' },
        { value: 'alpha', label: 'A–Z' },
      ]}
    />
  ) : null;

  const header = embedded ? null : (
    <PageHeader
      variant="dense"
      breadcrumb={[{ label: 'Analytics' }, { label: 'Metrics' }]}
      icon={BarChart3}
      title="Metrics"
    />
  );

  // ---- knowledge base & memory section (operational tab footer) --------- //
  const knowledgeSection = hasKnowledge ? (
    <section className="space-y-6 pt-2">
      <Separator />
      <div className="flex items-start gap-3.5">
        <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
          <Database className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Knowledge base &amp; memory
          </h2>
          <p className="mt-0.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            RAG corpus and durable operator memory the agents draw on — current,
            independent of the time window above.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile label="RAG documents" value={fmtNumber(rag?.document_count)} icon={FileText} accent="primary" />
        <KpiTile label="RAG chunks" value={fmtNumber(rag?.total_chunks)} icon={Database} accent="info" />
        <KpiTile
          label="Embedding model"
          value={
            rag?.embedding_model ? (
              <InlineCode className="text-base">{rag.embedding_model}</InlineCode>
            ) : (
              DASH
            )
          }
          sub={typeof rag?.dim === 'number' ? `${fmtNumber(rag.dim)} dims` : undefined}
          icon={Sparkles}
          accent="info"
        />
        <KpiTile label="Memory facts" value={fmtNumber(memory?.count)} icon={Bot} accent="medium" />
        <KpiTile
          label="Active memory"
          value={memory ? fmtNumber(activeMemoryCount) : DASH}
          sub={memory ? `of ${fmtNumber(memory.count)}` : undefined}
          icon={CheckCircle2}
          accent="success"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Corpus by source" icon={Database}>
          {corpusItems.length ? (
            <BarList items={corpusItems} format={(n) => fmtNumber(n)} showPercent />
          ) : (
            <ChartEmpty>{rag ? 'No RAG corpus indexed yet.' : 'Corpus stats unavailable.'}</ChartEmpty>
          )}
        </ChartCard>

        <ChartCard title="Memory by author" icon={Users} accentClass="text-medium">
          {memorySegments.length ? (
            <DonutChart
              segments={memorySegments}
              format={(n) => fmtNumber(n)}
              ariaLabel="Memory facts by author"
              center={
                <>
                  <span className="text-2xl font-bold tabular-nums text-foreground">
                    {fmtNumber(memory?.count)}
                  </span>
                  <span className="text-xs text-muted-foreground">facts</span>
                </>
              }
            />
          ) : (
            <ChartEmpty>{memory ? 'No memory facts recorded yet.' : 'Memory stats unavailable.'}</ChartEmpty>
          )}
        </ChartCard>
      </div>
    </section>
  ) : null;

  // ---- KPI definitions (operational) ------------------------------------ //
  interface KpiDef {
    key: string;
    label: string;
    value: React.ReactNode;
    sub?: string;
    icon: LucideIcon;
    accent: KpiAccent;
    onClick?: () => void;
  }

  const kpis: KpiDef[] = data
    ? [
        {
          key: 'total',
          label: `Total cases (${windowLabel})`,
          value: fmtNumber(data.total_cases),
          icon: ShieldCheck,
          accent: 'primary',
          onClick: onNavigate ? () => onNavigate('cases') : undefined,
        },
        {
          key: 'needs_human',
          label: 'Needs human',
          value: fmtNumber(data.needs_human_cases),
          icon: Users,
          accent: 'high',
          onClick: onNavigate ? () => onNavigate('cases', { status: 'needs_human' }) : undefined,
        },
        {
          key: 'closed',
          label: 'Closed',
          value: fmtNumber(data.closed_cases),
          sub: `${fmtNumber(data.open_cases)} open`,
          icon: CheckCircle2,
          accent: 'success',
          onClick: onNavigate ? () => onNavigate('cases', { status: 'closed' }) : undefined,
        },
        {
          key: 'mttr',
          label: 'MTTR',
          value: humanizeMinutes(data.mttr_minutes),
          sub: `${fmtNumber(data.resolved_count)} resolved`,
          icon: Clock,
          accent: 'info',
        },
        {
          key: 'agreement',
          label: 'Agreement rate',
          value: fb && fb.graded_cases > 0 ? fmtPercent(fb.agreement_rate) : DASH,
          sub: fb ? `${fmtNumber(fb.graded_cases)} graded` : undefined,
          icon: ThumbsUp,
          accent: 'success',
        },
        {
          key: 'risk',
          label: 'Avg risk',
          value: typeof data.avg_risk_score === 'number' ? Math.round(data.avg_risk_score) : DASH,
          icon: Gauge,
          accent: 'critical',
        },
      ]
    : [];

  // ----- operational tab body -------------------------------------------- //
  const operationalBody =
    loading && !data ? (
      <LoadingState label="Loading operational metrics" layout="page" shape="page" />
    ) : error && !hasAny ? (
      // A load failure already renders the destructive Alert above; don't ALSO show the
      // misleading "No cases yet" empty state (the two contradict each other).
      null
    ) : !hasAny ? (
      <div className="space-y-6">
        <EmptyState
          icon={BarChart3}
          title="No cases yet"
          description={`Nothing has been triaged in the last ${windowLabel}. As the agent processes alerts, volume, verdicts and feedback analytics will appear here.`}
        />
        {knowledgeSection}
      </div>
    ) : (
      <div className="space-y-6">
        <Stagger
          className={KPI_GRID}
          step={40}
          itemClassName={KPI_ITEM}
          data-testid="analytics-kpi-strip"
        >
          {kpis.map((k) => (
            <KpiTile
              key={k.key}
              label={k.label}
              value={k.value}
              sub={k.sub}
              icon={k.icon}
              accent={k.accent}
              variant="strip"
              onClick={k.onClick}
            />
          ))}
        </Stagger>

        <Stagger className={CARD_GRID} step={40} itemClassName="h-full">
          <ChartCard title="Verdict mix" icon={BarChart3}>
            {verdictSegments.length ? (
              <div className="space-y-3">
                <DonutChart
                  segments={verdictSegments}
                  format={(n) => fmtNumber(n)}
                  ariaLabel="Verdict mix"
                  center={
                    <>
                      <span className="text-2xl font-bold tabular-nums text-foreground">
                        {fmtNumber(data?.total_cases)}
                      </span>
                      <span className="text-xs text-muted-foreground">cases</span>
                    </>
                  }
                />
                <ul className="flex flex-col divide-y divide-border border-t border-border">
                  {verdictSegments.map((s) => {
                    const status = verdictStatus(s.label);
                    const drillable = Boolean(status && onNavigate);
                    return (
                      <li key={s.label} className="flex items-center gap-2 py-1.5 text-xs">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: s.color }}
                          aria-hidden
                        />
                        {drillable ? (
                          <button
                            type="button"
                            onClick={() => onNavigate!('cases', { status: status! })}
                            className="truncate text-left text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`View ${s.label} cases`}
                          >
                            {s.label}
                          </button>
                        ) : (
                          <span className="truncate text-muted-foreground">{s.label}</span>
                        )}
                        <span className="ml-auto font-mono font-semibold tabular-nums text-foreground">
                          {fmtNumber(s.value)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <ChartEmpty>No verdicts recorded in this window.</ChartEmpty>
            )}
          </ChartCard>

          <ChartCard title="Disposition mix" icon={BarChart3}>
            {dispositionSegments.length ? (
              <div className="space-y-3">
                <DonutChart
                  segments={dispositionSegments}
                  format={(n) => fmtNumber(n)}
                  ariaLabel="Disposition mix"
                  center={
                    <>
                      <span className="text-2xl font-bold tabular-nums text-foreground">
                        {fmtNumber(data?.total_cases)}
                      </span>
                      <span className="text-xs text-muted-foreground">cases</span>
                    </>
                  }
                />
                <ul className="flex flex-col divide-y divide-border border-t border-border">
                  {dispositionSegments.map((s) => (
                    <li key={s.label} className="flex items-center gap-2 py-1.5 text-xs">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: s.color }}
                        aria-hidden
                      />
                      <span className="truncate text-muted-foreground">{s.label}</span>
                      <span className="ml-auto font-mono font-semibold tabular-nums text-foreground">
                        {fmtNumber(s.value)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <ChartEmpty>No dispositions recorded in this window.</ChartEmpty>
            )}
          </ChartCard>

          <ChartCard title="Persona usage" icon={Users} accentClass="text-primary">
            {personaItems.length ? (
              <BarList items={personaItems} format={(n) => fmtNumber(n)} showPercent />
            ) : (
              <ChartEmpty>No specialist routing recorded.</ChartEmpty>
            )}
          </ChartCard>

          <ChartCard title="Playbook usage" icon={FileText} accentClass="text-medium">
            {playbookItems.length ? (
              <BarList items={playbookItems} format={(n) => fmtNumber(n)} showPercent />
            ) : (
              <ChartEmpty>No playbooks selected in this window.</ChartEmpty>
            )}
          </ChartCard>

          <ChartCard
            title="Knowledge reference coverage"
            icon={BookOpen}
            accentClass="text-info"
          >
            {retrievalHistory?.available &&
            typeof retrievalHistory.reference_coverage === 'number' ? (
              <div className="space-y-3">
                <div className="text-3xl font-bold tabular-nums text-foreground">
                  {fmtPercent(retrievalHistory.reference_coverage)}
                </div>
                <p className="text-sm text-muted-foreground">
                  {fmtNumber(retrievalHistory.cases_with_references)} of{' '}
                  {fmtNumber(retrievalHistory.completed_attempt_cases)} fully observed cases
                  with a completed retrieval attempt recorded at least one reference.
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Case-level reference coverage only — not per-run hit rate or retrieval
                  quality.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <ChartEmpty>
                  {retrievalHistory?.reason ||
                    'Retrieval-history evidence is unavailable. Missing history is not counted as zero.'}
                </ChartEmpty>
                {retrievalHistory ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {fmtNumber(retrievalHistory.history_available_cases)} of{' '}
                    {fmtNumber(retrievalHistory.eligible_cases)} investigated cases have
                    complete lifetime retrieval instrumentation.
                  </p>
                ) : null}
              </div>
            )}
          </ChartCard>

          <ChartCard title="Cases per day" icon={TrendingUp} accentClass="text-success">
            {perDay.length > 1 ? (
              <div className="space-y-2">
                <MiniBars data={perDay} colorToken="success" height={140} ariaLabel="Cases per day" />
                <p className="text-xs text-muted-foreground">
                  {`${perDay.length} days · ${fmtNumber(perDayTotal)} cases`}
                </p>
              </div>
            ) : (
              <ChartEmpty>Not enough data points to chart a trend.</ChartEmpty>
            )}
          </ChartCard>
        </Stagger>

        {/* Analyst feedback quality — LLM cost moved to the dedicated Cost tab so
            spend lives in ONE place (the designated single cost home). A compact
            "LLM spend" pointer sits alongside for at-a-glance context + a jump. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <ChartCard
            title="Analyst feedback quality"
            icon={ThumbsUp}
            accentClass="text-success"
            className="lg:col-span-2"
          >
            {fb && fb.graded_cases > 0 ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <StatCard label="Agreement" value={fmtPercent(fb.agreement_rate)} accent="success" />
                  <StatCard
                    label="Time saved"
                    value={humanizeMinutes(fb.time_saved_minutes)}
                    accent="primary"
                  />
                </div>
                <BarList
                  items={[
                    { label: 'Accuracy', value: Math.round((fb.avg_accuracy || 0) * 100), color: 'bg-success' },
                    {
                      label: 'Reasoning quality',
                      value: Math.round((fb.avg_reasoning_quality || 0) * 100),
                      color: 'bg-primary',
                    },
                    {
                      label: 'Action appropriateness',
                      value: Math.round((fb.avg_action_appropriateness || 0) * 100),
                      color: 'bg-info',
                    },
                  ]}
                  format={(n) => `${n}%`}
                />
                {outcomeItems.length ? (
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Recorded outcomes
                    </p>
                    <BarList items={outcomeItems} format={(n) => fmtNumber(n)} />
                  </div>
                ) : null}
              </div>
            ) : (
              <ChartEmpty>
                No analyst feedback recorded yet. Grade closed cases to build accuracy,
                reasoning and time-saved metrics here.
              </ChartEmpty>
            )}
          </ChartCard>

          <ChartCard
            title={`LLM spend (${windowLabel})`}
            icon={CircleDollarSign}
            accentClass="text-medium"
            action={
              <button
                type="button"
                onClick={() => setTab('cost')}
                className="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cost tab →
              </button>
            }
          >
            <div className="space-y-4">
              <StatCard
                label="Total cost"
                value={fmtMoney(cost?.total_cost as number | undefined, currency)}
                accent="medium"
              />
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Tokens" value={fmtTokens(cost?.total_tokens as number | undefined)} accent="info" />
                <StatCard
                  label="LLM calls"
                  value={fmtNumber(cost?.call_count as number | undefined)}
                  accent="primary"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                The full spend ledger — trend, breakdowns by model/role/surface, and top
                drivers — lives in the Cost tab.
              </p>
            </div>
          </ChartCard>
        </div>

        {knowledgeSection}
      </div>
    );

  const content = (
    <>
      {header}

      {error && !usesAgentEvidenceEndpoint ? (
        <LoadError
          error={error}
          title="Could not load metrics"
          fallback="An unexpected error occurred while loading analytics."
          onRetry={() => void load()}
        />
      ) : null}

      <Tabs value={tab} onValueChange={(v) => setTab(v as MetricsTab)}>
        <ControlBar
          title={(
            <TabsList data-testid="metrics-tabs">
              <TabsTrigger value="operational" data-testid="metrics-tab-operational">
                <BarChart3 className="mr-1.5 h-4 w-4" aria-hidden />
                Operational
              </TabsTrigger>
              <TabsTrigger value="performance" data-testid="metrics-tab-performance">
                <Activity className="mr-1.5 h-4 w-4" aria-hidden />
                Performance
              </TabsTrigger>
              <TabsTrigger value="posture" data-testid="metrics-tab-posture">
                <Crosshair className="mr-1.5 h-4 w-4" aria-hidden />
                Posture
              </TabsTrigger>
              <TabsTrigger value="effectiveness" data-testid="metrics-tab-effectiveness">
                <TrendingUp className="mr-1.5 h-4 w-4" aria-hidden />
                Effectiveness
              </TabsTrigger>
              <TabsTrigger value="cost" data-testid="metrics-tab-cost">
                <CircleDollarSign className="mr-1.5 h-4 w-4" aria-hidden />
                Cost
              </TabsTrigger>
            </TabsList>
          )}
          controls={tabPrimaryControls}
          secondaryControls={tabSecondaryControls}
          label="Analytics controls"
        />

        <TabsContent value="operational">{operationalBody}</TabsContent>

        <TabsContent value="performance">
          <PerformanceTab
            posture={posture}
            loading={loading && !posture}
            windowLabel={windowLabel}
          />
        </TabsContent>

        <TabsContent value="posture">
          <PostureTab
            posture={posture}
            mitre={mitre}
            loading={loading && !posture && !mitre}
            windowLabel={windowLabel}
            onNavigate={onNavigate}
          />
        </TabsContent>

        <TabsContent value="effectiveness">
          <div className="space-y-6">
            {healthAvailable ? <HealthDiagnostics windowHours={hours} /> : null}
            <AgentEffectiveness />
          </div>
        </TabsContent>

        {/* Cost — the SINGLE cost home. The standalone Cost page renders embedded so
            it owns its own window/refresh controls + spend ledger; no page header. */}
        <TabsContent value="cost">
          <Cost embedded onNavigate={onNavigate} />
        </TabsContent>
      </Tabs>
    </>
  );

  return embedded ? (
    <div className="space-y-6">{content}</div>
  ) : (
    <PageContainer variant="wide" className="space-y-6">
      {content}
    </PageContainer>
  );
}

// =========================================================================== //
// Performance tab — lifecycle (server p50/p90 + honest DASH) + quality + deltas
// =========================================================================== //
interface PerfPostureProps {
  posture: PostureResponse | null;
  loading: boolean;
  windowLabel: string;
}

function PerformanceTab({ posture, loading, windowLabel }: PerfPostureProps) {
  if (loading) {
    return (
      <LoadingState label="Loading performance metrics" layout="panel" shape="panel" />
    );
  }
  if (!posture) {
    return (
      <EmptyState
        icon={Activity}
        title="Performance metrics unavailable"
        description="The posture rollup could not be loaded. Try refreshing; it computes lifecycle timing and triage-quality rates server-side."
      />
    );
  }

  const { lifecycle, quality, compare } = posture;

  // Period-over-period delta tiles (▲/▼ delta%). The compare block is present only
  // when the server computed a prior window (compare=prev + a positive window).
  // Only the CompareBlock-valued keys (NOT `mode`) drive a delta tile.
  type CmpKey = Exclude<keyof NonNullable<PostureResponse['compare']>, 'mode'>;
  const lifecycleTiles: Array<{
    key: string;
    label: string;
    block: ReturnType<typeof statBlockTile>;
    cmp?: CmpKey;
    icon: LucideIcon;
    accent: KpiAccent;
    /** All lifecycle timings are lower-is-better → a fall reads as an improvement. */
    goodDirection: KpiGoodDirection;
  }> = [
    { key: 'mtta', label: 'MTTA (p50)', block: statBlockTile(lifecycle.mtta_minutes), cmp: 'mtta_p50', icon: Clock, accent: 'info', goodDirection: 'down' },
    { key: 'mttr', label: 'MTTR (p50)', block: statBlockTile(lifecycle.mttr_minutes), cmp: 'mttr_p50', icon: Timer, accent: 'success', goodDirection: 'down' },
    { key: 'dwell', label: 'Dwell (p50)', block: statBlockTile(lifecycle.dwell_minutes), icon: Activity, accent: 'medium', goodDirection: 'down' },
  ];

  return (
    <div className="space-y-6">
      {/* Lifecycle p50 KPI tiles with deltas */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Lifecycle timing ({windowLabel})
        </h2>
        <Stagger className="grid grid-cols-1 gap-4 sm:grid-cols-3" step={40} itemClassName="h-full">
          {lifecycleTiles.map((t) => {
            const dv = t.cmp ? deltaView(compare?.[t.cmp]) : { show: false, label: '' };
            return (
              <KpiTile
                key={t.key}
                label={t.label}
                value={t.block.value}
                sub={t.block.sub}
                icon={t.icon}
                accent={t.accent}
                goodDirection={t.goodDirection}
                delta={
                  dv.show && typeof dv.value === 'number'
                    ? { value: dv.value, label: dv.label }
                    : undefined
                }
              />
            );
          })}
        </Stagger>
      </section>

      {/* Percentile detail (p50 / p90 / mean / max) */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Percentile distribution
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <PercentileCard title="Time to acknowledge" icon={Clock} block={lifecycle.mtta_minutes} />
          <PercentileCard title="Time to resolve" icon={Timer} block={lifecycle.mttr_minutes} />
          <PercentileCard title="Time to first response" icon={Activity} block={lifecycle.dwell_minutes} />
        </div>
      </section>

      {/* Quality rates */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Triage quality
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <QualityTile
            label="FP rate"
            value={ratioPct(quality.false_positive_rate)}
            sub={`${fmtNumber(quality.false_positive_cases)} of ${fmtNumber(quality.verdicted_cases)} verdicted`}
            delta={deltaView(compare?.false_positive_rate)}
            goodDirection="down"
            accent="success"
          />
          <QualityTile
            label="Incident yield"
            value={ratioPct(quality.alert_to_incident_ratio)}
            sub={`${fmtNumber(quality.true_positive_cases)} true positives`}
            delta={deltaView(compare?.alert_to_incident_ratio)}
            accent="critical"
          />
          <QualityTile
            label="Escalation rate"
            value={ratioPct(quality.escalation_rate)}
            sub={`${fmtNumber(quality.escalated_cases)} escalated`}
            delta={deltaView(compare?.escalation_rate)}
            goodDirection="down"
            accent="high"
          />
          <QualityTile
            label="Containment"
            value={ratioPct(quality.containment_rate)}
            sub={`${fmtNumber(quality.terminal_cases)} worked to close`}
            accent="info"
          />
          <QualityTile
            label="Automation rate"
            value={ratioPct(quality.automation_rate)}
            sub={`${fmtNumber(quality.auto_closed_cases)} agent-closed`}
            delta={deltaView(compare?.automation_rate)}
            accent="primary"
          />
        </div>
      </section>

      {compare ? (
        <p className="text-xs text-muted-foreground">
          Deltas compare the last {windowLabel} against the immediately-preceding equal
          window. A falling FP / escalation / time metric reads as an improvement (green).
        </p>
      ) : null}
    </div>
  );
}

/** Render-ready value/sub for a StatBlock-backed KPI tile (honest DASH). */
function statBlockTile(block: { p50: number | string; available: boolean; reason: string; count: number }): {
  value: string;
  sub: string;
} {
  if (!block.available) {
    return { value: DASH, sub: block.reason || 'no samples yet' };
  }
  return { value: humanizeMins(block.p50), sub: `${fmtNumber(block.count)} samples` };
}

interface PercentileCardProps {
  title: string;
  icon: LucideIcon;
  block: PostureResponse['lifecycle']['mttr_minutes'];
}

function PercentileCard({ title, icon: Icon, block }: PercentileCardProps) {
  return (
    <ChartCard title={title} icon={Icon}>
      {block.available ? (
        <dl className="grid grid-cols-2 gap-3">
          {(
            [
              ['p50', block.p50],
              ['p90', block.p90],
              ['mean', block.mean],
              ['max', block.max],
            ] as Array<[string, number | string]>
          ).map(([k, v]) => (
            <div key={k} className="rounded-md border border-border bg-surface px-3 py-2">
              <dt className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{k}</dt>
              <dd className="mt-1 font-mono text-base font-semibold tabular-nums text-foreground">
                {humanizeMins(v)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <ChartEmpty>{block.reason || 'No samples yet.'}</ChartEmpty>
      )}
    </ChartCard>
  );
}

interface QualityTileProps {
  label: string;
  value: string;
  sub?: string;
  delta?: ReturnType<typeof deltaView>;
  accent: KpiAccent;
  /** Which direction is an improvement (drives the delta COLOR; arrow follows the sign). */
  goodDirection?: KpiGoodDirection;
}

function QualityTile({ label, value, sub, delta, accent, goodDirection }: QualityTileProps) {
  return (
    <KpiTile
      label={label}
      value={value}
      sub={sub}
      accent={accent}
      goodDirection={goodDirection}
      delta={
        delta && delta.show && typeof delta.value === 'number'
          ? { value: delta.value, label: delta.label }
          : undefined
      }
    />
  );
}

// =========================================================================== //
// Posture tab — aging buckets + SLA breach/at-risk + MITRE coverage heatmap
// =========================================================================== //
interface PostureTabProps {
  posture: PostureResponse | null;
  mitre: MitreCoverageResponse | null;
  loading: boolean;
  windowLabel: string;
  onNavigate?: Navigate;
}

const AGE_ACCENT: Record<string, StatAccent> = {
  '<1h': 'success',
  '1-4h': 'info',
  '4-24h': 'medium',
  '1-3d': 'high',
  '3-7d': 'high',
  '>7d': 'critical',
};

function PostureTab({ posture, mitre, loading, windowLabel, onNavigate }: PostureTabProps) {
  if (loading) {
    return (
      <LoadingState label="Loading posture" layout="panel" shape="panel" />
    );
  }

  const aging = posture?.aging;
  const sla = posture?.sla;

  // Aging buckets → BurnDown-friendly + bar-list. We show buckets as bars; oldest as a
  // compact list with deep-links.
  const ageBars: BarListItem[] = (aging?.age_buckets ?? []).map((b) => ({
    label: b.bucket,
    value: b.count,
    color: ageBarColor(b.bucket),
  }));
  const maxAge = Math.max(1, ...ageBars.map((b) => b.value));

  // Closure-vs-arrival burn-down: a single comparison point is enough to read the
  // balance; we render it as a 2-point series for the BurnDownChart shape.
  const burndown =
    aging && (aging.arrivals > 0 || aging.closures > 0)
      ? [
          { x: 'start', open: aging.backlog + aging.closures, closed: 0 },
          { x: windowLabel, open: aging.backlog, closed: aging.closures },
        ]
      : [];

  // MITRE columns: each tactic is a column; cells are its covered techniques (top 8).
  const mitreColumns =
    mitre && mitre.covered_techniques > 0
      ? Object.values(mitre.by_tactic)
          .filter((t) => t.techniques.length > 0)
          .sort((a, b) => b.covered - a.covered)
          .map((t) => ({
            tactic: t.tactic,
            label: tacticLabel(t.tactic),
            cells: t.techniques.slice(0, 8).map((tech) => ({
              technique: tech.id,
              name: tech.name,
              value: tech.case_count,
            })),
          }))
      : [];

  return (
    <div className="space-y-6">
      {/* Aging + queue depth tiles */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Open-case aging
        </h2>
        {aging ? (
          <>
            <Stagger className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6" step={40} itemClassName="h-full">
              <StatCard label="Queue depth" value={fmtNumber(aging.queue_depth)} accent="info" />
              <StatCard label="Backlog" value={fmtNumber(aging.backlog)} accent="medium" />
              <StatCard label="Arrivals" value={fmtNumber(aging.arrivals)} accent="primary" />
              <StatCard label="Closures" value={fmtNumber(aging.closures)} accent="success" />
              <StatCard label="Close vs arrival" value={ratioPct(aging.closure_vs_arrival)} accent="success" />
              <StatCard
                label="Oldest open"
                value={aging.oldest[0] ? `${Math.round(aging.oldest[0].age_hours)}h` : DASH}
                accent="critical"
              />
            </Stagger>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ChartCard title="Age distribution" icon={Layers}>
                {ageBars.some((b) => b.value > 0) ? (
                  <BarList items={ageBars} format={(n) => fmtNumber(n)} showPercent />
                ) : (
                  <ChartEmpty>No open cases to age.</ChartEmpty>
                )}
                {/* keep maxAge referenced for clarity; bars scale internally */}
                <span className="sr-only">{`max ${maxAge}`}</span>
              </ChartCard>

              <ChartCard title="Closure vs arrival" icon={TrendingUp} accentClass="text-success">
                {burndown.length ? (
                  <BurnDownChart
                    data={burndown}
                    height={200}
                    openLabel="Open backlog"
                    closedLabel="Closed"
                    format={(n) => fmtNumber(n)}
                    ariaLabel="Open backlog vs closures over the window"
                  />
                ) : (
                  <ChartEmpty>No arrivals or closures in this window.</ChartEmpty>
                )}
              </ChartCard>
            </div>

            {aging.oldest.length ? (
              <ChartCard title="Oldest open cases" icon={Clock} accentClass="text-critical">
                <ul className="flex flex-col divide-y divide-border">
                  {aging.oldest.slice(0, 8).map((c) => (
                    <li key={c.case_id} className="flex items-center gap-3 py-2 text-sm">
                      {onNavigate ? (
                        <button
                          type="button"
                          onClick={() => onNavigate('cases', { status: c.status })}
                          className="truncate text-left font-mono text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`View cases in status ${c.status || 'open'}`}
                        >
                          {c.case_number || c.case_id}
                        </button>
                      ) : (
                        <span className="truncate font-mono text-foreground">
                          {c.case_number || c.case_id}
                        </span>
                      )}
                      <span className="truncate text-muted-foreground">{humanizeToken(c.status)}</span>
                      <span className="ml-auto font-mono tabular-nums text-foreground">
                        {Math.round(c.age_hours)}h
                      </span>
                    </li>
                  ))}
                </ul>
              </ChartCard>
            ) : null}
          </>
        ) : (
          <Card>
            <CardContent className="py-4">
              <EmptyState icon={Layers} title="Aging unavailable" description="The posture rollup could not be loaded." />
            </CardContent>
          </Card>
        )}
      </section>

      {/* SLA */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          SLA attainment
        </h2>
        {sla?.enabled ? (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard label="Attainment" value={ratioPct((sla.attainment_pct ?? 0) / 100)} accent="success" />
              <StatCard label="Evaluated" value={fmtNumber(sla.evaluated)} accent="info" />
              <StatCard label="Response breached" value={fmtNumber(sla.response_breached)} accent="critical" />
              <StatCard label="Resolve breached" value={fmtNumber(sla.resolve_breached)} accent="critical" />
              <StatCard
                label="At risk"
                value={fmtNumber((sla.response_at_risk ?? 0) + (sla.resolve_at_risk ?? 0))}
                accent="high"
              />
            </div>
            {sla.breaching && sla.breaching.length ? (
              <ChartCard title="Breaching / at-risk" icon={Gauge} accentClass="text-critical">
                <ul className="flex flex-col divide-y divide-border">
                  {sla.breaching.slice(0, 10).map((b) => (
                    <li key={`${b.case_id}-${b.clock}`} className="flex items-center gap-3 py-2 text-xs">
                      <span
                        className={cn(
                          'inline-flex shrink-0 rounded-sm px-1.5 py-0.5 text-2xs font-semibold uppercase',
                          b.state === 'breached'
                            ? 'bg-critical/10 text-critical-text'
                            : 'bg-high/10 text-high-text',
                        )}
                      >
                        {b.state === 'breached' ? 'Breached' : 'At risk'}
                      </span>
                      <span className="truncate font-mono text-foreground">{b.case_number || b.case_id}</span>
                      <span className="truncate text-muted-foreground">
                        {humanizeToken(b.clock)} · {b.priority || '—'}
                      </span>
                      {/* at-risk rows are still UNDER target → over_pct is negative; only
                          prefix '+' for genuine over-target breaches (never "+-12%"). */}
                      <span className="ml-auto font-mono tabular-nums text-foreground">
                        {b.over_pct >= 0 ? '+' : ''}
                        {Math.round(b.over_pct)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </ChartCard>
            ) : (
              <Card>
                <CardContent className="py-4">
                  <EmptyState
                    compact
                    icon={CheckCircle2}
                    title="No SLA breaches"
                    description="No evaluated case is currently breaching or at risk against its priority target."
                  />
                </CardContent>
              </Card>
            )}
          </>
        ) : (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                compact
                icon={Gauge}
                title="SLA tracking is off"
                description={sla?.reason || 'Enable an SLA policy with per-priority response/resolve targets in Settings to track attainment here.'}
              />
            </CardContent>
          </Card>
        )}
      </section>

      {/* MITRE ATT&CK coverage */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            MITRE ATT&CK coverage
          </h2>
          {mitre ? (
            <span className="text-xs text-muted-foreground">
              {fmtNumber(mitre.covered_techniques)} of {fmtNumber(mitre.total_techniques)} techniques ·{' '}
              {ratioPct((mitre.coverage_pct ?? 0) / 100)} · corpus {mitre.corpus_version}
            </span>
          ) : null}
        </div>
        {mitre && mitreColumns.length ? (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <MitreHeatmap
                columns={mitreColumns}
                ariaLabel="MITRE ATT&CK technique coverage by tactic"
              />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  Each cell is a covered technique; intensity scales with the number of cases
                  referencing it. Invalid / forged ids are dropped
                  {mitre.invalid_dropped > 0 ? ` (${fmtNumber(mitre.invalid_dropped)} dropped)` : ''}.
                </span>
                <a
                  href={navigatorLayerUrl(0)}
                  target="_blank"
                  rel="noopener noreferrer"
                  download="navigator.layer.json"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Crosshair className="h-3.5 w-3.5" aria-hidden />
                  Export ATT&CK Navigator layer
                </a>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                icon={Crosshair}
                title={mitre ? 'No technique coverage yet' : 'Coverage unavailable'}
                description={
                  mitre
                    ? 'No case has been labelled with a valid MITRE ATT&CK technique yet. As the agent attributes techniques, the coverage heatmap fills in here.'
                    : 'The MITRE coverage rollup could not be loaded. Try refreshing.'
                }
              />
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

/** Age-bucket → bar color token class (older → hotter). */
function ageBarColor(bucket: string): string {
  switch (AGE_ACCENT[bucket]) {
    case 'success':
      return 'bg-success';
    case 'info':
      return 'bg-info';
    case 'medium':
      return 'bg-medium';
    case 'high':
      return 'bg-high';
    case 'critical':
      return 'bg-critical';
    default:
      return 'bg-accent-bar';
  }
}
