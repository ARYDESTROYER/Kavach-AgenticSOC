/**
 * `DashboardDataProvider`: the ONE fetch context for a dashboard (Round 5 / G7 CD2,
 * rebuilt in Round 14, SPEC §4.4.3 and §4.4.5).
 *
 * WHY: a dashboard renders many widgets, but they read a small set of shared server
 * rollups. Each widget names what it reads as a {@link DashboardRequest} (a provider key,
 * the window, and for `breakdown` the query); the provider fetches each DISTINCT request
 * once per (window, refresh, Demo identity) and hands the answer to every widget through
 * context. Two widgets with the same breakdown query share one read; two with different
 * `by` read twice.
 *
 * WHAT IT FETCHES:
 *   - `widgets` (the placed widgets) names the requests up front, through the registry,
 *     so every read starts while the lazy widget bodies are still loading. Requests a
 *     viewer's role cannot read, and case-derived requests while row-level data scope is
 *     on (D16), are never made.
 *   - A widget body also registers its own requests on mount ({@link useDashboardRequest}),
 *     so a host that names no widgets still works; a request already named is shared.
 *   - Legacy hosts: `sourceKeys` (or nothing at all) fetch the default request of the
 *     five Round 5 keys (`metrics`, `posture`, `mitre`, `sourcesHealth`, `cases`), each
 *     only when the viewer's role holds its grant (`KEY_GRANTS`), and
 *     {@link useDashboardSource} reads one of them without registering it (an
 *     un-requested key reads settled, never a stuck skeleton).
 *
 * ROW-LEVEL SCOPE (D16): read from `GET /api/auth/me` per viewer and role, on mount and
 * on every refresh; a failed read never claims scope is on (see `useObjectScope`), and a
 * `409 breakdown_scope_unsupported` from the server hides every case panel at once.
 *
 * WINDOW: `window` is the board's `TimeRangePicker` value (`now-24h`, `now-7d`,
 * `now-30d`, `now-90d`; default `now-24h`). Windowed keys get it as `window_hours` and
 * the breakdown endpoint as the hours token (`now-168h`), so every cell counts the same
 * rolling population. Changing it refetches every windowed request.
 *
 * REFRESH: the refresh control, `reloadNonce` and the visible-tab tick re-read every active
 * request; a widget's Retry re-reads one. A panel keeps its last good answer while it
 * refreshes, and an answer whose refresh failed stays marked failed while it is read
 * again, until a read succeeds, so held figures are never shown as current. A refresh
 * that arrives while a read for the same request is still running joins that read
 * rather than aborting it (a read slower than the interval still lands, and a backend
 * that hangs is not hit again on every tick). A read still running after one refresh
 * interval marks its request overdue, so a backend that hangs instead of failing is
 * shown as stale too.
 *
 * DEMO MODE: the cache is keyed on the confirmed Demo identity (PR 132). Entering,
 * leaving or resetting Demo drops every held answer and reads afresh, so real figures
 * never show under the Demo badge or the reverse.
 *
 * BILLING (#6/#7): every key is a READ-ONLY, NON-billing rollup of aggregates or case
 * rows. There is no `standup` key: `GET /api/standup` runs the model, and surfacing a
 * dashboard must never trigger it (audit H3). The shift widgets read the deterministic
 * `GET /api/standup/report`.
 *
 * SECURITY: this provider only READS. It never writes a case, never bills a model, and a
 * layout NEVER feeds `case_manager.decide()` (#3). Every label it forwards is plain data
 * (#9); rendering it as text is the widget's job.
 */
import * as React from 'react';

import { api } from '@/lib/api';
import { getMetricsBreakdown } from '@/lib/api-dashboards';
import { DASH } from '@/lib/format';
import type { CasesResponse, DashboardWidget, Metrics, MetricsTrends, NoiseReduction, UsageSummary } from '@/lib/types';
import type { AgentImprovementEvidence, RecordedAutoCloseHealth } from '@/lib/types';
import type { DashboardWindow, MetricsBreakdown } from '@/lib/types-dashboards';
import { useOptionalAuth } from '@/soc/auth';
import { useChatDemoIdentity } from '@/soc/chat/demo-identity';
import {
  fetchPosture,
  fetchMitreCoverage,
  type PostureResponse,
  type MitreCoverageResponse,
  type StatBlock,
} from '@/soc/pages/Metrics.posture.api';
import type { StandupReport } from '@/soc/pages/Standup.report.api';
import type { CampaignsResponse } from '@/soc/pages/Campaigns.api';
import type { TelemetryRecommendationsResponse, TuningRecommendationsResponse } from '@/soc/pages/Tuning.api';
import type { BudgetStatus } from '@/soc/pages/Models.api';

import { ALLOW_ALL, dashboardRequestsFor, type PermissionCheck } from './registry';
import {
  BOARD_WINDOWS,
  DEFAULT_BOARD_WINDOW,
  boardWindowInfo,
  dedupeRequests,
  isCaseDerivedKey,
  isDashboardWindow,
  isScopeRefusal,
  KEY_GRANTS,
  resolveRequest,
  ScopeUnconfirmedError,
  type BoardWindowInfo,
  type DashboardRequest,
  type DashboardSourceKey,
  type ResolvedRequest,
} from './widgets/requests';

export type { DashboardRequest, DashboardSourceKey } from './widgets/requests';

// --------------------------------------------------------------------------- //
// Payload types
// --------------------------------------------------------------------------- //

/** A per-source health row from `GET /api/sources/health` (never carries secrets). */
export interface SourceHealthRow {
  source_id: string;
  source_name: string;
  source_type: string;
  enabled: boolean;
  is_primary: boolean;
  ingest_mode: string;
  kind: 'push' | 'pull' | 'unknown' | string;
  can_browse: boolean;
  buffer_depth: number;
  last_poll_millis: number;
  /** When the source last sent an event (epoch ms; 0 or absent when never). */
  last_event_millis?: number;
  /** Mean events per minute the poller measured recently. */
  events_per_min?: number;
  /** Flagged by the silent-source detector. */
  silent?: boolean;
  healthy?: boolean;
  [key: string]: unknown;
}

export interface SourcesHealthResponse {
  sources: SourceHealthRow[];
}

/** Discriminated payload shape per source key (widgets narrow on the key). */
export interface DashboardSourcePayloads {
  metrics: Metrics;
  posture: PostureResponse;
  mitre: MitreCoverageResponse;
  coverage: MitreCoverageResponse;
  sourcesHealth: SourcesHealthResponse;
  cases: CasesResponse;
  trends: MetricsTrends;
  noise: NoiseReduction;
  /** The raw report: KPI bindings read its dotted fields; widgets normalise it. */
  shift: Partial<StandupReport> & Record<string, unknown>;
  autoClose: RecordedAutoCloseHealth;
  usage: UsageSummary;
  budget: BudgetStatus & { excluded_surfaces?: string[]; excluded_today?: number };
  campaigns: CampaignsResponse;
  tuning: TuningRecommendationsResponse;
  telemetry: TelemetryRecommendationsResponse;
  agentImprovement: AgentImprovementEvidence;
  breakdown: MetricsBreakdown;
}

/** Fetch context for one request. */
interface FetchContext {
  /** How many recent cases the `cases` source pulls. */
  caseLimit: number;
  signal: AbortSignal;
}

type Fetcher = (req: ResolvedRequest, ctx: FetchContext) => Promise<unknown>;

/**
 * The one table of reads. Adding a source = one key here and in `requests.ts`; a widget
 * never fetches on its own. `Promise.resolve().then` turns a synchronous throw (a
 * stubbed client) into a rejection the batch handles like any failed read.
 */
const FETCHERS: Readonly<Record<DashboardSourceKey, Fetcher>> = {
  metrics: (r) => api.getMetrics(r.hours),
  // `compare=prev` on the board window gives the period-over-period deltas the strips
  // show; an all-time read has nothing to compare against.
  posture: (r, ctx) => fetchPosture(r.hours, r.hours > 0 ? 'prev' : '', ctx.signal),
  mitre: (r) => fetchMitreCoverage(r.hours),
  coverage: (r) => fetchMitreCoverage(r.hours),
  sourcesHealth: () => api.get<SourcesHealthResponse>('sources/health'),
  cases: (_r, ctx) => api.listCases({ limit: ctx.caseLimit }),
  trends: (r, ctx) => api.metricsTrends(r.hours, ctx.signal),
  noise: (r) => api.noiseReduction(r.hours),
  shift: (r, ctx) => api.get('standup/report', { window_hours: r.hours }, ctx.signal),
  autoClose: (r, ctx) =>
    api.get('metrics/auto-close-health/recorded', { window_hours: r.hours, anchor: 'first' }, ctx.signal),
  usage: (r) => api.usageSummary(r.hours),
  budget: (_r, ctx) => api.get('budget/status', undefined, ctx.signal),
  campaigns: (_r, ctx) => api.get('campaigns', undefined, ctx.signal),
  tuning: (_r, ctx) => api.get('tuning/recommendations', undefined, ctx.signal),
  telemetry: (_r, ctx) => api.get('tuning/source-recommendations', undefined, ctx.signal),
  agentImprovement: () => api.getAgentImprovement(),
  breakdown: (r, ctx) => getMetricsBreakdown(r.breakdown ?? { by: 'severity' }, ctx.signal),
};

/** The five Round 5 keys a host that names nothing fetches (their default requests). */
export const LEGACY_SOURCE_KEYS: readonly DashboardSourceKey[] = [
  'metrics',
  'posture',
  'mitre',
  'sourcesHealth',
  'cases',
];

/**
 * Kept for older imports: the keys an un-narrowed provider fetches. The new keys are
 * fetched only when a placed widget asks for them.
 */
export const DASHBOARD_SOURCE_KEYS: readonly DashboardSourceKey[] = LEGACY_SOURCE_KEYS;

/**
 * The visible-tab refresh cadence (ms) a host hands the provider so a board left open
 * re-syncs instead of freezing on its first answer. It pauses while the tab is hidden and
 * refreshes once when the tab is shown again. Every source is a non-billing read (#6/#7).
 */
export const DASHBOARD_AUTO_REFRESH_MS = 60_000;

// --------------------------------------------------------------------------- //
// State
// --------------------------------------------------------------------------- //

/** What a widget sees for one request. */
export interface DashboardSourceState<K extends DashboardSourceKey = DashboardSourceKey> {
  /** A read for this request is in flight (the first one, a refresh or a Retry). */
  loading: boolean;
  /** The last successful answer (null until the first success). */
  data: DashboardSourcePayloads[K] | null;
  /**
   * The last failed read's error, null when healthy. It is kept while the request is read
   * again (a Retry, the refresh control, the auto-refresh tick) and only a read that
   * succeeds clears it, so a panel never passes held figures off as current just because
   * another read has started. One failing read never breaks the board.
   */
  error: unknown;
  /**
   * When `data` was read (epoch ms), so a panel that keeps it through a failed refresh
   * can say how old it is. Absent until the first success.
   */
  loadedAt?: number;
  /**
   * The read in flight has run for longer than one refresh interval without an answer (a
   * backend that hangs instead of failing). Held figures are then not current either; it
   * clears when that read lands or fails.
   */
  overdue?: boolean;
}

const SETTLED_EMPTY: DashboardSourceState = { loading: false, data: null, error: null };
const PENDING: DashboardSourceState = { loading: true, data: null, error: null };

/** A case-derived read not made while the viewer's scope is unconfirmed (retryable). */
const SCOPE_UNCONFIRMED: DashboardSourceState = {
  loading: false,
  data: null,
  error: new ScopeUnconfirmedError(),
};

type LegacySourceMap = { [K in DashboardSourceKey]: DashboardSourceState<K> };

export interface DashboardDataContextValue {
  /**
   * Each key's DEFAULT request (the board window; `mitre` all time), for the Round 5
   * widgets. A key nobody requested reads settled with no data.
   */
  sources: LegacySourceMap;
  /** Every request's state, by request id. */
  requests: Readonly<Record<string, DashboardSourceState>>;
  /** True while any active request is still loading its first answer. */
  loading: boolean;
  /** The board window (`null` when an older host passed raw hours). */
  window: DashboardWindow | null;
  /** The board window in hours. */
  windowHours: number;
  /** Its names ("Last 7 days", "last 7 days", "7d"). */
  windowInfo: BoardWindowInfo;
  /** The viewer's permission check (what the widgets gate on). */
  can: PermissionCheck;
  /**
   * Whether row-level data scope applies to this viewer's case reads: `true` hides every
   * case-derived widget, `false` shows them, `undefined` while not yet known (they wait).
   */
  objectScoped: boolean | undefined;
  /**
   * The scope read failed and nothing is confirmed for this viewer: case-derived panels
   * fetch nothing and say their access could not be confirmed, with Retry
   * ({@link DashboardDataContextValue.retryScope}). Never shown as the scope sentence.
   */
  scopeError: boolean;
  /** Read the viewer's row-level scope again. */
  retryScope: () => void;
  /** Re-fetch every active request (the refresh control and the auto-refresh tick). */
  refresh: () => void;
  /** Re-fetch one request (a widget's Retry); also re-reads an unconfirmed scope. */
  retry: (req: DashboardRequest) => void;
  /** Bumped on each refresh. */
  refreshToken: number;
  /** Register a request a widget reads; returns its release. */
  register: (req: DashboardRequest) => () => void;
}

const DashboardDataContext = React.createContext<DashboardDataContextValue | null>(null);

// --------------------------------------------------------------------------- //
// Row-level scope (D16)
// --------------------------------------------------------------------------- //

/** What the provider knows about row-level scope for the viewer. */
interface ObjectScope {
  /** `true` hides case-derived panels, `false` shows them, `undefined` while not known. */
  objectScoped: boolean | undefined;
  /** The scope read failed and nothing is confirmed for this viewer yet. */
  scopeError: boolean;
  /** Read the scope again (a panel's Retry). */
  retryScope: () => void;
  /** The server refused a case read for row-level scope: hide every case panel now. */
  markScopeRefused: () => void;
}

/**
 * Whether row-level scope applies to the viewer.
 *
 * - With sign-in off there is no viewer role and so no scope (`false`).
 * - Otherwise it is read from `GET /api/auth/me` (`object_scoped`) when the board
 *   mounts, again on every refresh (the 60 s tick, the refresh control, `reloadNonce`)
 *   and whenever the viewer or their role changes. Each read belongs to one viewer
 *   (`username|role`): an answer read for another viewer is never used.
 * - Until the first answer for this viewer lands, it is `undefined` and case-derived
 *   reads wait (fail closed). A failed first read is NOT taken as an answer: it stays
 *   `undefined` (nothing case-derived is fetched) with `scopeError` set, so the panels
 *   say the access could not be confirmed and offer Retry instead of claiming that
 *   scope is on. A failure is never remembered: the next refresh reads again.
 * - A failed RE-read keeps the answer already confirmed for this viewer, the same
 *   stale-but-shown rule the data reads follow; the next refresh reads again.
 * - The server is authoritative: a case read refused with `409
 *   breakdown_scope_unsupported` makes scope `true` for this viewer at once (whatever
 *   the host or the last read said), until a later `/auth/me` answer differs from the one
 *   held when the server refused, which means an administrator changed the scope.
 *
 * `override` is a host that already knows the answer.
 */
function useObjectScope(override: boolean | undefined, refreshSignal: string): ObjectScope {
  const auth = useOptionalAuth();
  const signedIn = Boolean(auth?.authEnabled && auth?.isAuthenticated);
  const viewer = signedIn ? `${auth?.username ?? ''}|${auth?.role ?? ''}` : '';
  const needsRead = override === undefined && signedIn;

  const [confirmed, setConfirmed] = React.useState<{ viewer: string; scoped: boolean } | null>(null);
  const [failedFor, setFailedFor] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [refusal, setRefusal] = React.useState<{ viewer: string; me: boolean | null } | null>(null);

  React.useEffect(() => {
    if (!needsRead) return undefined;
    let alive = true;
    void Promise.resolve()
      .then(() => api.auth.me())
      .then(
        (me) => {
          if (!alive) return;
          const scoped = me?.object_scoped === true;
          setConfirmed({ viewer, scoped });
          setFailedFor(null);
          // A refusal holds until the server's own answer changes from the one held
          // when it refused (an administrator turned scope on or off since).
          setRefusal((r) => (r && (r.viewer !== viewer || r.me !== scoped) ? null : r));
        },
        () => {
          if (alive) setFailedFor(viewer);
        },
      );
    return () => {
      alive = false;
    };
  }, [needsRead, viewer, attempt, refreshSignal]);

  const confirmedScoped = confirmed && confirmed.viewer === viewer ? confirmed.scoped : undefined;
  let objectScoped: boolean | undefined;
  if (refusal && refusal.viewer === viewer) objectScoped = true;
  else if (override !== undefined) objectScoped = override;
  else if (!signedIn) objectScoped = false;
  else objectScoped = confirmedScoped;

  const retryScope = React.useCallback(() => {
    setFailedFor(null);
    setAttempt((n) => n + 1);
  }, []);
  const confirmedRef = React.useRef(confirmedScoped);
  confirmedRef.current = confirmedScoped;
  const markScopeRefused = React.useCallback(() => {
    setRefusal((r) => (r && r.viewer === viewer ? r : { viewer, me: confirmedRef.current ?? null }));
  }, [viewer]);

  return {
    objectScoped,
    scopeError: objectScoped === undefined && failedFor === viewer,
    retryScope,
    markScopeRefused,
  };
}

// --------------------------------------------------------------------------- //
// Provider
// --------------------------------------------------------------------------- //

export interface DashboardDataProviderProps {
  /** The board window (default `now-24h`). Wins over `windowHours`. */
  window?: DashboardWindow;
  /** Older hosts: the window in hours (default 24). */
  windowHours?: number;
  /** Recent-case page size for the `cases` source (bounded; default 25). */
  caseLimit?: number;
  /**
   * The placed widgets. Their requests are named up front through the registry (gated
   * by `can` and by row-level scope), so the reads start before the bodies load.
   */
  widgets?: readonly DashboardWidget[];
  /**
   * Older hosts: fetch the default request of these keys (default: the five Round 5
   * keys). `breakdown` has no default and is left to the widgets that register a query.
   */
  sourceKeys?: readonly DashboardSourceKey[];
  /** The viewer's permission check (default: the signed-in viewer's, else allow all). */
  can?: PermissionCheck;
  /** Row-level scope, when the host already knows it (else read from `/api/auth/me`). */
  objectScoped?: boolean;
  /** Bump to re-fetch every active request from outside the provider. */
  reloadNonce?: number;
  /** Visible-tab refresh cadence in ms; 0 or absent is off. */
  refreshIntervalMs?: number;
  children: React.ReactNode;
}

interface RequestEntry {
  state: DashboardSourceState;
  /** The generation this answer (or the read in flight) belongs to. */
  generation: string;
  /** The Demo identity the held answer was read under. */
  identity: string;
}

/** A read in flight for one request. */
interface InflightRead {
  /**
   * The newest generation this read answers. A refresh that arrives while it runs joins
   * it (moving this forward) instead of aborting it, so a read slower than the refresh
   * interval still lands.
   */
  generation: string;
  /** The Demo identity it reads under (a different one aborts it). */
  identity: string;
  controller: AbortController;
  /** Marks the request overdue when the read runs past one refresh interval. */
  overdueTimer: ReturnType<typeof setTimeout> | null;
}

/** Longest delay a browser timer honours (a larger one fires at once). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The refresh cadence in ms, or `null` when auto refresh is off. Only a finite positive
 * value counts (an infinite or oversized one would fire a timer at once), capped at the
 * longest delay a browser timer honours.
 */
function refreshCadence(ms: number | undefined): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, MAX_TIMER_MS);
}

/** Stop one read: abort it and clear its overdue timer. */
function stopRead(read: InflightRead): void {
  if (read.overdueTimer != null) clearTimeout(read.overdueTimer);
  read.overdueTimer = null;
  read.controller.abort();
}

/**
 * Fetch-once dashboard data context; see the module comment. A failing read degrades to
 * `{error}` for its widgets only, keeping the last good answer for a refresh that fails
 * and the failure itself until a later read succeeds.
 */
export function DashboardDataProvider({
  window: windowProp,
  windowHours: windowHoursProp,
  caseLimit = 25,
  widgets,
  sourceKeys,
  can: canProp,
  objectScoped: objectScopedProp,
  reloadNonce = 0,
  refreshIntervalMs = 0,
  children,
}: DashboardDataProviderProps) {
  const auth = useOptionalAuth();
  const can: PermissionCheck = canProp ?? auth?.hasPermission ?? ALLOW_ALL;
  const demoIdentity = useChatDemoIdentity();
  const [refreshToken, setRefreshToken] = React.useState(0);
  const { objectScoped, scopeError, retryScope, markScopeRefused } = useObjectScope(
    objectScopedProp,
    `${refreshToken}|${reloadNonce}`,
  );

  // A window can come from stored data (a board's default) or a URL: anything but the
  // four presets falls back rather than taking the board down.
  const windowHours =
    windowProp && isDashboardWindow(windowProp)
      ? BOARD_WINDOWS[windowProp].hours
      : typeof windowHoursProp === 'number' && Number.isFinite(windowHoursProp) && windowHoursProp > 0
        ? Math.round(windowHoursProp)
        : BOARD_WINDOWS[DEFAULT_BOARD_WINDOW].hours;
  const windowInfo = React.useMemo(() => boardWindowInfo(windowHours), [windowHours]);

  // ---- what to fetch ---------------------------------------------------- //
  const named = React.useMemo<DashboardRequest[]>(() => {
    if (widgets) return dashboardRequestsFor(widgets, { can, objectScoped, windowHours });
    const keys = sourceKeys ?? LEGACY_SOURCE_KEYS;
    // A breakdown has no default query: the widget that reads one registers it itself.
    // A key the viewer's role cannot read is never requested (no 403s to explain).
    return keys
      .filter((key) => key !== 'breakdown' && can(KEY_GRANTS[key].resource, KEY_GRANTS[key].action))
      .map((key) => ({ key }));
  }, [widgets, sourceKeys, can, objectScoped, windowHours]);

  const [registered, setRegistered] = React.useState<ReadonlyMap<string, { req: DashboardRequest; count: number }>>(
    () => new Map(),
  );

  const active = React.useMemo(() => {
    const all = [...named, ...[...registered.values()].map((r) => r.req)];
    return dedupeRequests(all, windowHours);
  }, [named, registered, windowHours]);
  // Row-level scope (D16), enforced here as well as in the registry: a case-derived read
  // is fetched only once scope is known to be off, whichever widget asks for it.
  const fetchable = React.useMemo(
    () => (objectScoped === false ? active : active.filter((r) => !isCaseDerivedKey(r.key))),
    [active, objectScoped],
  );
  const activeSig = fetchable.map((r) => r.id).join('\n');

  // ---- generations ------------------------------------------------------- //
  const generation = `${demoIdentity}|${refreshToken}|${reloadNonce}`;
  const [entries, setEntries] = React.useState<Readonly<Record<string, RequestEntry>>>({});
  const [retries, setRetries] = React.useState<Readonly<Record<string, number>>>({});

  const refresh = React.useCallback(() => setRefreshToken((n) => n + 1), []);
  const retry = React.useCallback(
    (req: DashboardRequest) => {
      // A case read that waits on an unconfirmed scope is retried by checking it again.
      if (scopeError && isCaseDerivedKey(req.key)) retryScope();
      const id = resolveRequest(req, windowHours).id;
      setRetries((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
    },
    [windowHours, scopeError, retryScope],
  );

  const register = React.useCallback((req: DashboardRequest) => {
    // Registered by the request's own identity (window resolved at fetch time), so a
    // widget that stays mounted across a window change keeps one registration.
    const key = JSON.stringify([req.key, req.window ?? null, req.query ?? null]);
    setRegistered((prev) => {
      const next = new Map(prev);
      const cur = next.get(key);
      next.set(key, { req, count: (cur?.count ?? 0) + 1 });
      return next;
    });
    return () => {
      setRegistered((prev) => {
        const cur = prev.get(key);
        if (!cur) return prev;
        const next = new Map(prev);
        if (cur.count <= 1) next.delete(key);
        else next.set(key, { req: cur.req, count: cur.count - 1 });
        return next;
      });
    };
  }, []);

  // ---- the reads ---------------------------------------------------------- //
  const inflight = React.useRef(new Map<string, InflightRead>());
  const caseLimitRef = React.useRef(caseLimit);
  caseLimitRef.current = caseLimit;
  const markRefusedRef = React.useRef(markScopeRefused);
  markRefusedRef.current = markScopeRefused;
  // A read still running after one refresh interval is overdue (60 s when the host sets
  // no interval): with the tick that started it, the held figures are then about two
  // intervals old, and the panel says so instead of showing them as current.
  const intervalMs = refreshCadence(refreshIntervalMs);
  const overdueAfterRef = React.useRef(DASHBOARD_AUTO_REFRESH_MS);
  overdueAfterRef.current = intervalMs ?? DASHBOARD_AUTO_REFRESH_MS;

  React.useEffect(() => {
    const identity = demoIdentity;
    const due: Array<{ req: ResolvedRequest; gen: string }> = [];
    const activeIds = new Set(fetchable.map((r) => r.id));
    for (const req of fetchable) {
      const gen = `${generation}|${retries[req.id] ?? 0}`;
      const current = entries[req.id];
      if (current?.generation === gen) continue;
      const running = inflight.current.get(req.id);
      if (running?.identity === identity) {
        // A read for this request is still running: it answers this refresh too. It is
        // never aborted to start another one, so a read slower than the refresh interval
        // still lands (and a backend that hangs is not hit again on every tick).
        running.generation = gen;
        continue;
      }
      due.push({ req, gen });
    }
    // A read for a request no longer on the board is not needed: abort it.
    for (const [id, running] of inflight.current) {
      if (!activeIds.has(id)) {
        stopRead(running);
        inflight.current.delete(id);
      }
    }
    if (due.length === 0) return;

    setEntries((prev) => {
      const next = { ...prev };
      for (const { req } of due) {
        const cur = prev[req.id];
        // Keep the last good answer while it refreshes (stale-but-shown beats a blank
        // panel), and the last failure with it: only a read that succeeds clears it, so
        // a panel still says its figures are held while it reads again. A first read
        // starts loading.
        const sameIdentity = cur?.identity === identity;
        next[req.id] = {
          generation: sameIdentity ? cur.generation : '',
          identity,
          state: {
            loading: true,
            data: sameIdentity ? cur.state.data : null,
            error: sameIdentity ? cur.state.error : null,
            loadedAt: sameIdentity ? cur.state.loadedAt : undefined,
            overdue: false,
          },
        };
      }
      return next;
    });

    for (const { req, gen } of due) {
      // Only a read under another Demo identity can still be running here.
      const previous = inflight.current.get(req.id);
      if (previous) stopRead(previous);
      const controller = new AbortController();
      const read: InflightRead = { generation: gen, identity, controller, overdueTimer: null };
      inflight.current.set(req.id, read);
      read.overdueTimer = setTimeout(() => {
        read.overdueTimer = null;
        if (inflight.current.get(req.id) !== read || controller.signal.aborted) return;
        setEntries((prev) => {
          const cur = prev[req.id];
          if (!cur || cur.identity !== identity || !cur.state.loading || cur.state.overdue) return prev;
          return { ...prev, [req.id]: { ...cur, state: { ...cur.state, overdue: true } } };
        });
      }, overdueAfterRef.current);
      const fetcher = FETCHERS[req.key];
      void Promise.resolve()
        .then(() => fetcher(req, { caseLimit: caseLimitRef.current, signal: controller.signal }))
        .then(
          (data) => ({ data, error: null as unknown }),
          (error: unknown) => ({ data: null, error }),
        )
        .then(({ data, error }) => {
          // Only the newest read for this request may land (a slow answer for an old
          // window or an earlier Demo identity is dropped).
          if (inflight.current.get(req.id) !== read || controller.signal.aborted) return;
          inflight.current.delete(req.id);
          if (read.overdueTimer != null) clearTimeout(read.overdueTimer);
          read.overdueTimer = null;
          // The newest refresh this read answered (one that arrived while it ran joined it).
          const answered = read.generation;
          // The server refused a case read for row-level scope: every case-derived panel
          // hides at once, not only the one that asked.
          if (error && isScopeRefusal(error)) markRefusedRef.current();
          setEntries((prev) => {
            const cur = prev[req.id];
            const same = cur && cur.identity === identity;
            // A failed refresh keeps the last good answer and the time it was read, so
            // the panel can say the figures are from then (never pass them off as now).
            const kept = same ? cur.state.data : null;
            const keptAt = same ? cur.state.loadedAt : undefined;
            return {
              ...prev,
              [req.id]: {
                generation: answered,
                identity,
                state: {
                  loading: false,
                  data: (error ? kept : data) as DashboardSourceState['data'],
                  error,
                  loadedAt: error ? keptAt : Date.now(),
                  overdue: false,
                },
              },
            };
          });
        });
    }
    // `entries` is read for the generation check only; a landing answer must not
    // re-run this effect for other requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSig, generation, retries]);

  // Abort every read in flight (and its overdue timer) when the board goes away.
  React.useEffect(() => {
    const running = inflight.current;
    return () => {
      for (const read of running.values()) stopRead(read);
      running.clear();
    };
  }, []);

  // ---- visible-tab auto refresh ----------------------------------------- //
  React.useEffect(() => {
    if (intervalMs == null) return undefined;
    if (typeof window === 'undefined') return undefined;
    const tick = () => {
      if (typeof document === 'undefined' || !document.hidden) refresh();
    };
    const id = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) refresh();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, refresh]);

  // ---- the context value ------------------------------------------------- //
  const requests = React.useMemo(() => {
    const out: Record<string, DashboardSourceState> = {};
    for (const req of active) {
      if (objectScoped !== false && isCaseDerivedKey(req.key)) {
        // Scoped: nothing is read (settled, the widget shows the scope sentence). Not
        // yet known: it waits, or fails with a retryable error when the scope read
        // failed (never the scope sentence, which would be a claim nobody confirmed).
        out[req.id] = objectScoped === true ? SETTLED_EMPTY : scopeError ? SCOPE_UNCONFIRMED : PENDING;
        continue;
      }
      const entry = entries[req.id];
      // An answer read under another Demo identity is never shown, even for the moment
      // before its re-read lands: real figures never appear under the Demo badge, or
      // Demo figures after leaving it.
      out[req.id] = entry && entry.identity === demoIdentity ? entry.state : PENDING;
    }
    return out;
  }, [active, entries, demoIdentity, objectScoped, scopeError]);

  const sources = React.useMemo(() => {
    const out = {} as Record<DashboardSourceKey, DashboardSourceState>;
    for (const key of Object.keys(FETCHERS) as DashboardSourceKey[]) {
      const id = resolveRequest({ key }, windowHours).id;
      out[key] = requests[id] ?? SETTLED_EMPTY;
    }
    return out as LegacySourceMap;
  }, [requests, windowHours]);

  const loading = React.useMemo(() => Object.values(requests).some((s) => s.loading), [requests]);

  const value = React.useMemo<DashboardDataContextValue>(
    () => ({
      sources,
      requests,
      loading,
      window: windowInfo.window,
      windowHours,
      windowInfo,
      can,
      objectScoped,
      scopeError,
      retryScope,
      refresh,
      retry,
      refreshToken,
      register,
    }),
    [
      sources,
      requests,
      loading,
      windowInfo,
      windowHours,
      can,
      objectScoped,
      scopeError,
      retryScope,
      refresh,
      retry,
      refreshToken,
      register,
    ],
  );

  return <DashboardDataContext.Provider value={value}>{children}</DashboardDataContext.Provider>;
}

// --------------------------------------------------------------------------- //
// Hooks
// --------------------------------------------------------------------------- //

/** The whole dashboard data context. Throws if used outside the provider. */
export function useDashboardData(): DashboardDataContextValue {
  const ctx = React.useContext(DashboardDataContext);
  if (!ctx) {
    throw new Error('useDashboardData must be used within a <DashboardDataProvider>');
  }
  return ctx;
}

/** The dashboard data context, or `null` outside a provider (a frame that only gates). */
export function useOptionalDashboardData(): DashboardDataContextValue | null {
  return React.useContext(DashboardDataContext);
}

/**
 * Read one key's DEFAULT request (Round 5 widgets). It never registers or fetches: a key
 * the host did not request reads settled with no data.
 */
export function useDashboardSource<K extends DashboardSourceKey>(key: K): DashboardSourceState<K> {
  const { sources } = useDashboardData();
  return sources[key] as DashboardSourceState<K>;
}

/**
 * Read one request, registering it while the widget is mounted so it is fetched even
 * when the host named no widgets. `enabled: false` (a denied grant, row-level scope)
 * neither registers nor fetches, and reads settled with no data. Equal requests from
 * many widgets share one read.
 */
export function useDashboardRequest<K extends DashboardSourceKey>(
  req: DashboardRequest & { key: K },
  options: { enabled?: boolean } = {},
): DashboardSourceState<K> {
  const ctx = useDashboardData();
  const enabled = options.enabled !== false;
  const sig = JSON.stringify([req.key, req.window ?? null, req.query ?? null]);
  const { register } = ctx;
  React.useEffect(() => {
    if (!enabled) return undefined;
    return register(req);
    // `sig` stands for the request's content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sig, register]);
  if (!enabled) return SETTLED_EMPTY as DashboardSourceState<K>;
  const id = resolveRequest(req, ctx.windowHours).id;
  return (ctx.requests[id] ?? PENDING) as DashboardSourceState<K>;
}

/** Reads the answer of one of the requests registered by {@link useDashboardRequests}. */
export type DashboardReader = (req: DashboardRequest) => DashboardSourceState;

/**
 * Read several requests at once (a KPI strip's cells, a chart that joins two sources),
 * registering each while the widget is mounted. `enabled[i] === false` leaves request i
 * out: it is neither registered nor fetched and reads settled with no data.
 */
export function useDashboardRequests(
  reqs: readonly DashboardRequest[],
  enabled?: readonly boolean[],
): DashboardReader {
  const ctx = useDashboardData();
  const wanted = reqs.filter((_, i) => enabled?.[i] !== false);
  const sig = JSON.stringify(wanted.map((r) => [r.key, r.window ?? null, r.query ?? null]));
  const { register } = ctx;
  React.useEffect(() => {
    const parsed = JSON.parse(sig) as Array<[DashboardSourceKey, DashboardRequest['window'] | null, DashboardRequest['query'] | null]>;
    const releases = parsed.map(([key, window, query]) =>
      register({ key, ...(window ? { window } : {}), ...(query ? { query } : {}) }),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [sig, register]);
  const wantedIds = new Set(wanted.map((r) => resolveRequest(r, ctx.windowHours).id));
  const { requests, windowHours } = ctx;
  return React.useCallback(
    (req: DashboardRequest) => {
      const id = resolveRequest(req, windowHours).id;
      if (!wantedIds.has(id)) return SETTLED_EMPTY;
      return requests[id] ?? PENDING;
    },
    // `wantedIds` is derived from `sig` and the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requests, windowHours, sig],
  );
}

// --------------------------------------------------------------------------- //
// Sentinel helpers: never render the dash as a number
// --------------------------------------------------------------------------- //

/**
 * True when a posture `StatBlock` carries a real value. The server sends
 * `available:false` and dash-string fields when it has no samples.
 */
export function isAvailable(block: StatBlock | null | undefined): boolean {
  return Boolean(block && block.available);
}

/**
 * A possibly-sentinel numeric field as a real number, or `null` when it is unavailable,
 * so a widget never treats the dash string as a numeric zero.
 */
export function statNumber(v: number | string | null | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== DASH && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
