/**
 * Dashboard data requests and board windows (Round 14, SPEC §4.4.1, §4.4.3).
 *
 * A widget does not fetch. It names the data it reads as {@link DashboardRequest}s (a
 * provider key, which window, and for `breakdown` the query), and the one
 * `DashboardDataProvider` fetches each DISTINCT request once per window and refresh and
 * shares the answer: two widgets with the same breakdown query share one read, two with
 * different `by` read twice. The request id is canonical, so equal requests always
 * collide on purpose.
 *
 * Windows: a board offers four relative presets only (no custom range), because every
 * windowed provider takes a trailing integer `window_hours` (24, 168, 720, 2,160). The
 * breakdown endpoint receives the same span as an hours token (`now-168h`, never
 * `now-7d`): its `now-7d` means "since midnight seven days ago" (whole local days, for
 * chat parity), while the hours token counts the same rolling population the posture
 * figures beside it count.
 *
 * Pure, no React, no network. Every request is a non-billing read of aggregates or case
 * rows (#6, #7): there is no key for the billing `GET /api/standup`.
 */
import { breakdownQueryKey } from '@/lib/api-dashboards';
import type { DashboardWindow, MetricsBreakdownQuery } from '@/lib/types-dashboards';

/**
 * The shared sources a dashboard draws from, one endpoint each:
 *
 * | key | endpoint |
 * |---|---|
 * | `metrics` | `GET /api/metrics?window_hours=` |
 * | `posture` | `GET /api/metrics/posture?window_hours=&compare=` |
 * | `mitre`, `coverage` | `GET /api/mitre/coverage?window_hours=` (`mitre` reads all time unless asked) |
 * | `sourcesHealth` | `GET /api/sources/health` |
 * | `cases` | `GET /api/cases?limit=` |
 * | `trends` | `GET /api/metrics/trends?window_hours=` (at most 720 hours) |
 * | `noise` | `GET /api/metrics/noise-reduction?window_hours=` |
 * | `shift` | `GET /api/standup/report?window_hours=` (deterministic; never `GET /api/standup`) |
 * | `autoClose` | `GET /api/metrics/auto-close-health/recorded?window_hours=&anchor=first` |
 * | `usage` | `GET /api/usage/summary?window_hours=` |
 * | `budget` | `GET /api/budget/status` |
 * | `campaigns` | `GET /api/campaigns` |
 * | `tuning` | `GET /api/tuning/recommendations` |
 * | `telemetry` | `GET /api/tuning/source-recommendations` |
 * | `agentImprovement` | `GET /api/metrics/agent-improvement` |
 * | `breakdown` | `GET /api/metrics/breakdown?<query>` |
 */
export type DashboardSourceKey =
  | 'metrics'
  | 'posture'
  | 'mitre'
  | 'sourcesHealth'
  | 'cases'
  | 'trends'
  | 'noise'
  | 'shift'
  | 'coverage'
  | 'autoClose'
  | 'usage'
  | 'budget'
  | 'campaigns'
  | 'tuning'
  | 'telemetry'
  | 'agentImprovement'
  | 'breakdown';

/** The keys that take a window. The others read state as it is now. */
const WINDOWED: ReadonlySet<DashboardSourceKey> = new Set<DashboardSourceKey>([
  'metrics',
  'posture',
  'mitre',
  'coverage',
  'trends',
  'noise',
  'shift',
  'autoClose',
  'usage',
  'breakdown',
]);

/** True when `key` reads a window (`window_hours`, or the breakdown token). */
export function isWindowedKey(key: DashboardSourceKey): boolean {
  return WINDOWED.has(key);
}

/**
 * The keys whose answers are computed from case rows (D16). While row-level data scope
 * is on (or not yet known) the provider never fetches them, whatever asks. Not case
 * derived: source health, the alert funnel's counters (`noise`, whose case stages the
 * funnel widget hides), model usage and budget, and rule tuning state.
 */
export const CASE_DERIVED_KEYS: ReadonlySet<DashboardSourceKey> = new Set<DashboardSourceKey>([
  'metrics',
  'posture',
  'mitre',
  'coverage',
  'cases',
  'trends',
  'shift',
  'autoClose',
  'campaigns',
  'agentImprovement',
  'breakdown',
]);

/** True when `key` reads case rows (see {@link CASE_DERIVED_KEYS}). */
export function isCaseDerivedKey(key: DashboardSourceKey): boolean {
  return CASE_DERIVED_KEYS.has(key);
}

/** A `resource:action` grant. */
export interface KeyGrant {
  resource: string;
  action: string;
}

/**
 * The grant a viewer needs before a key's DEFAULT request is read on a host that names
 * keys instead of widgets (`sourceKeys`): the display gate of the widgets that read it,
 * which is also the server's gate for the endpoint where it has one. A request the
 * viewer cannot read is never made, so a board never collects 403s it would then have
 * to explain. The widget path (`widgets`) gates through the registry instead.
 */
export const KEY_GRANTS: Readonly<Record<DashboardSourceKey, KeyGrant>> = {
  // `/api/metrics` only feeds the Active risk index, which needs `cases:read`.
  metrics: { resource: 'cases', action: 'read' },
  posture: { resource: 'metrics', action: 'view' },
  mitre: { resource: 'metrics', action: 'view' },
  coverage: { resource: 'metrics', action: 'view' },
  sourcesHealth: { resource: 'sources', action: 'read' },
  cases: { resource: 'cases', action: 'read' },
  trends: { resource: 'metrics', action: 'view' },
  noise: { resource: 'metrics', action: 'view' },
  shift: { resource: 'cases', action: 'read' },
  autoClose: { resource: 'metrics', action: 'view' },
  usage: { resource: 'cost', action: 'view' },
  budget: { resource: 'models', action: 'read' },
  campaigns: { resource: 'cases', action: 'read' },
  tuning: { resource: 'automation', action: 'read' },
  telemetry: { resource: 'cases', action: 'read' },
  agentImprovement: { resource: 'metrics', action: 'view' },
  breakdown: { resource: 'metrics', action: 'view' },
};

/** What a case panel says while the viewer's row-level scope could not be read. */
export const SCOPE_UNCONFIRMED_MESSAGE = 'Your data access could not be confirmed.';

/**
 * The answer a case-derived read gets while the viewer's scope is unconfirmed (the scope
 * read failed): nothing was fetched, and the panel offers Retry, which reads the scope
 * again. Never the scope sentence: nobody confirmed that scope is on.
 */
export class ScopeUnconfirmedError extends Error {
  constructor() {
    super(SCOPE_UNCONFIRMED_MESSAGE);
    this.name = 'ScopeUnconfirmedError';
  }
}

/** The server's refusal of a case breakdown while row-level scope applies (D16). */
export const SCOPE_REFUSAL_CODE = 'breakdown_scope_unsupported';

/**
 * True when `error` is the server refusing a case read because row-level data scope
 * applies to the viewer (`409 breakdown_scope_unsupported`). That is not a failure to
 * retry: the panel is hidden, exactly as the client gate would have hidden it.
 */
export function isScopeRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { status?: unknown; body?: unknown };
  if (e.status !== 409) return false;
  const detail = (e.body as { detail?: unknown } | null | undefined)?.detail;
  return Boolean(detail && typeof detail === 'object' && (detail as { code?: unknown }).code === SCOPE_REFUSAL_CODE);
}

/** `board`: the board's own window; `all`: all time (a stock measured now). */
export type RequestWindow = 'board' | 'all';

/** A breakdown query without its window (the request's `window` decides it). */
export type BreakdownRequestQuery = Omit<MetricsBreakdownQuery, 'window'>;

/** One piece of data a widget reads. */
export interface DashboardRequest {
  key: DashboardSourceKey;
  /** Default `board`, except `mitre`, whose legacy default is all time. */
  window?: RequestWindow;
  /** `breakdown` only. */
  query?: BreakdownRequestQuery;
}

/** A request with its window resolved against the board (what is actually fetched). */
export interface ResolvedRequest {
  id: string;
  key: DashboardSourceKey;
  /** `window_hours` to send; `0` is all time. Meaningless for unwindowed keys. */
  hours: number;
  /** `breakdown` only: the full query, window token included. */
  breakdown?: MetricsBreakdownQuery;
}

// --------------------------------------------------------------------------- //
// Board windows
// --------------------------------------------------------------------------- //

export interface BoardWindowInfo {
  window: DashboardWindow | null;
  hours: number;
  /** "Last 7 days": the picker's and the caption's name for it. */
  label: string;
  /** "last 7 days": the same words inside a sentence. */
  phrase: string;
  /** "7d": the comparison's short form ("vs prior 7d"). */
  short: string;
}

export const BOARD_WINDOWS: Readonly<Record<DashboardWindow, BoardWindowInfo>> = {
  'now-24h': { window: 'now-24h', hours: 24, label: 'Last 24 hours', phrase: 'last 24 hours', short: '24h' },
  'now-7d': { window: 'now-7d', hours: 168, label: 'Last 7 days', phrase: 'last 7 days', short: '7d' },
  'now-30d': { window: 'now-30d', hours: 720, label: 'Last 30 days', phrase: 'last 30 days', short: '30d' },
  'now-90d': { window: 'now-90d', hours: 2160, label: 'Last 90 days', phrase: 'last 90 days', short: '90d' },
};

/** The client default when a board names no window (SPEC §4.4.1). */
export const DEFAULT_BOARD_WINDOW: DashboardWindow = 'now-24h';

/**
 * Whether `value` is one of the four board windows. A window can come from stored data
 * (a board's `default_window`) or a URL, so a host checks it before trusting it.
 */
export function isDashboardWindow(value: unknown): value is DashboardWindow {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BOARD_WINDOWS, value);
}

/**
 * The window's names for a span in hours. The four presets read as the picker names
 * them; any other span (an older host that passes raw hours) reads in hours, never as a
 * preset it is not.
 */
export function boardWindowInfo(hours: number): BoardWindowInfo {
  const preset = (Object.values(BOARD_WINDOWS) as BoardWindowInfo[]).find((w) => w.hours === hours);
  if (preset) return preset;
  const h = Math.max(1, Math.round(Number.isFinite(hours) ? hours : 24));
  const unit = h === 1 ? 'hour' : 'hours';
  return { window: null, hours: h, label: `Last ${h} ${unit}`, phrase: `last ${h} ${unit}`, short: `${h}h` };
}

/** The breakdown window token for a span: an hours token, or `all`. */
export function breakdownWindowToken(hours: number): string {
  return hours > 0 ? `now-${Math.round(hours)}h` : 'all';
}

// --------------------------------------------------------------------------- //
// Resolution and identity
// --------------------------------------------------------------------------- //

function defaultWindow(key: DashboardSourceKey): RequestWindow {
  return key === 'mitre' ? 'all' : 'board';
}

/**
 * Resolve a request against the board's span. The id is canonical: the same key, the
 * same resolved window and (for breakdowns) the same query always give the same id,
 * whatever order the query fields were written in, so they share one fetch.
 */
export function resolveRequest(req: DashboardRequest, boardHours: number): ResolvedRequest {
  const windowed = isWindowedKey(req.key);
  const which = req.window ?? defaultWindow(req.key);
  const hours = windowed ? (which === 'all' ? 0 : Math.max(1, Math.round(boardHours))) : 0;
  if (req.key === 'breakdown') {
    const breakdown: MetricsBreakdownQuery = {
      ...(req.query ?? { by: 'severity' }),
      window: breakdownWindowToken(hours),
    };
    return { id: `breakdown?${breakdownQueryKey(breakdown)}`, key: 'breakdown', hours, breakdown };
  }
  return { id: windowed ? `${req.key}@${hours}` : req.key, key: req.key, hours };
}

/** The id of a request on a board of `boardHours` (see {@link resolveRequest}). */
export function requestId(req: DashboardRequest, boardHours: number): string {
  return resolveRequest(req, boardHours).id;
}

/** The distinct requests of a list, first occurrence kept, in a stable order. */
export function dedupeRequests(
  requests: readonly DashboardRequest[],
  boardHours: number,
): ResolvedRequest[] {
  const seen = new Map<string, ResolvedRequest>();
  for (const req of requests) {
    const resolved = resolveRequest(req, boardHours);
    if (!seen.has(resolved.id)) seen.set(resolved.id, resolved);
  }
  return [...seen.values()];
}
