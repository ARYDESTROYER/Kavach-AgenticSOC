/**
 * Co-located data layer for the forward-looking Standup / shift-handoff (Round 3,
 * Feature 11).
 *
 * Calls the NEW endpoints alongside the legacy `GET /api/standup` (which the page
 * still consumes for the prose summary). We use the low-level `api.get/post/put/del`
 * verbs from `@/lib/api` instead of adding methods to the shared client, so this
 * builder stays parallel-safe.
 *
 * SECURITY (#9): every title / note / assignee / entity / case title here is
 * operator-/log-derived. The consuming components render them as PLAIN text. The
 * types below describe the SHAPE only.
 */
import { api } from '@/lib/api';

/** One urgency-ranked attention-queue row (a COMPACT case projection, not the body). */
export interface AttentionRow {
  case_id: string;
  case_number: string;
  display_id: string;
  title: string;
  status: string;
  verdict: string;
  risk_score: number;
  severity_band: string;
  /**
   * Provenance of `severity_band`: `"source_asserted"` (the SIEM's own rating),
   * `"derived"` (no source rating — the band came from the deterministic risk total) or
   * `"source_out_of_range"` (the rating exceeded the source's declared ceiling, so the
   * projection saturated and the band is our arithmetic, not the source's claim).
   * Optional so an older backend degrades to no provenance tag.
   */
  severity_source?: string;
  priority_level: string;
  assignee: string;
  entity: string;
  age_minutes: number;
  urgency: number;
}

export interface SlaAgingRow {
  case_id: string;
  display_id: string;
  priority_level: string;
  age_minutes: number;
  target_minutes: number;
  overdue_minutes: number;
}

export interface SlaAgingTotals {
  open: number;
  breached: number;
  about_to_breach: number;
}

export interface SlaAging {
  enabled: boolean;
  warn_fraction: number;
  by_priority: Record<string, { open: number; breached: number; about_to_breach: number }>;
  totals: SlaAgingTotals;
  breached: SlaAgingRow[];
  about_to_breach: SlaAgingRow[];
}

export interface WorkloadRow {
  analyst: string;
  open: number;
  escalated: number;
  needs_human: number;
}

export interface DeltaCell {
  current: number;
  prior: number;
  delta: number;
}

/** metric-key → period-over-period delta cell. */
export type Deltas = Record<string, DeltaCell>;

export interface ActionItem {
  id: string;
  title: string;
  owner: string | null;
  status: string; // open | in_progress | done
  created_at: string;
  note: string;
}

export interface ShiftAck {
  user: string;
  window: string;
  at: string;
  note: string;
}

export interface StandupReport {
  enabled: boolean;
  window_hours: number;
  window: string;
  generated_at?: string;
  shift?: Record<string, unknown>;
  attention_queue: AttentionRow[];
  sla_aging: SlaAging;
  workload: WorkloadRow[];
  deltas: Deltas;
  action_items: ActionItem[];
  acknowledgements: ShiftAck[];
  degraded: boolean;
}

/** A safe empty SLA-aging block, for the disabled/degraded shapes that omit it. */
export const EMPTY_SLA_AGING: SlaAging = {
  enabled: false,
  warn_fraction: 0.75,
  by_priority: {},
  totals: { open: 0, breached: 0, about_to_breach: 0 },
  breached: [],
  about_to_breach: [],
};

/** GET /api/standup/report?window_hours= — always HTTP 200 with a renderable shape. */
export function fetchStandupReport(windowHours?: number): Promise<StandupReport> {
  // Defer through Promise.resolve so a synchronous failure (e.g. a stubbed client)
  // surfaces as a rejection rather than escaping a Promise.allSettled at the caller.
  return Promise.resolve()
    .then(() => api.get<Partial<StandupReport>>('standup/report', { window_hours: windowHours }))
    .then(normalizeReport);
}

/** Coerce a possibly-partial backend payload into a fully-shaped report. */
export function normalizeReport(raw: Partial<StandupReport> | null | undefined): StandupReport {
  const r = raw ?? {};
  const sla = (r.sla_aging as SlaAging | undefined) ?? EMPTY_SLA_AGING;
  return {
    enabled: r.enabled !== false,
    window_hours: typeof r.window_hours === 'number' ? r.window_hours : 24,
    window: typeof r.window === 'string' ? r.window : '',
    generated_at: r.generated_at,
    shift: r.shift,
    attention_queue: Array.isArray(r.attention_queue) ? r.attention_queue : [],
    sla_aging: {
      ...EMPTY_SLA_AGING,
      ...sla,
      totals: { ...EMPTY_SLA_AGING.totals, ...(sla.totals ?? {}) },
      breached: Array.isArray(sla.breached) ? sla.breached : [],
      about_to_breach: Array.isArray(sla.about_to_breach) ? sla.about_to_breach : [],
      by_priority: sla.by_priority ?? {},
    },
    workload: Array.isArray(r.workload) ? r.workload : [],
    deltas: (r.deltas as Deltas | undefined) ?? {},
    action_items: Array.isArray(r.action_items) ? r.action_items : [],
    acknowledgements: Array.isArray(r.acknowledgements) ? r.acknowledgements : [],
    degraded: r.degraded === true,
  };
}

// --------------------------------------------------------------------------- //
// Action items (the cross-shift living attention queue) — CRUD
//
// NOTE: there is no `listActionItems` read wrapper — the combined `/standup/report`
// payload already carries `action_items`; the page reads them from there.
// --------------------------------------------------------------------------- //
export function createActionItem(body: {
  title: string;
  owner?: string | null;
  note?: string;
  status?: string;
}): Promise<{ item: ActionItem }> {
  return api.post<{ item: ActionItem }>('standup/action-items', body);
}

export function updateActionItem(
  id: string,
  patch: { title?: string; owner?: string | null; note?: string; status?: string },
): Promise<{ item: ActionItem }> {
  return api.put<{ item: ActionItem }>(
    `standup/action-items/${encodeURIComponent(id)}`,
    patch,
  );
}

export function deleteActionItem(id: string): Promise<{ ok: boolean }> {
  return api.del<{ ok: boolean }>(`standup/action-items/${encodeURIComponent(id)}`);
}

// --------------------------------------------------------------------------- //
// Acknowledgements (append-only sign-off)
//
// NOTE: there is no `listAcknowledgements` read wrapper — the combined
// `/standup/report` payload already carries `acknowledgements`.
// --------------------------------------------------------------------------- //
export function acknowledgeHandoff(body: {
  window?: string;
  note?: string;
}): Promise<{ ack: ShiftAck }> {
  return api.post<{ ack: ShiftAck }>('standup/acknowledge', body);
}
