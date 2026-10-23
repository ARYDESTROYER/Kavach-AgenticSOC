/**
 * Co-located data layer for the cross-case CAMPAIGN surface (Round 4 / Wave 4).
 *
 * READ-ONLY views over the running campaign list the deterministic clustering pass
 * (`backend/app/engine/campaigns.py`) produces, plus a manual re-correlate trigger.
 * Endpoints (all under `/api`):
 *   GET  /campaigns                — the running campaign list (newest first).
 *   GET  /campaigns/{id}           — one campaign (404 when absent).
 *   GET  /cases/{id}/campaign      — the campaign a case belongs to (or null).
 *   POST /campaigns/recorrelate    — trigger the deterministic pass ON DEMAND (admin).
 *
 * We use the low-level `api.get/post` verbs from `@/lib/api` rather than adding methods
 * to the shared client, so this builder stays parallel-safe.
 *
 * ⛔ ADVISORY ONLY (#3/#4): a campaign is a presentation/reporting grouping — it NEVER
 * force-merges cases, recomputes a `cluster_signature`, closes/escalates a member
 * case, or feeds the deterministic `decide()`. A NEEDS_HUMAN case that joins a campaign
 * stays NEEDS_HUMAN. Re-correlate is a read-time aggregator.
 *
 * SECURITY (#9): every entity `value` / MITRE id / campaign name is source-derived
 * PLAIN data — the consuming components render it escaped (plain text / CodeBlock) and
 * it is never interpolated into a prompt. The types below describe the SHAPE only.
 */
import { api } from '@/lib/api';

/** One entity that ties member cases together (mirrors backend `CampaignEntity`). */
export interface CampaignEntity {
  entity_type: string;
  /** Source-derived — UNTRUSTED plain data (#9). */
  value: string;
}

/** A cross-case campaign (mirrors the backend `_campaign_json` shape). */
export interface Campaign {
  id: string;
  name: string;
  /** "open" | "monitoring" | "resolved". */
  status: string;
  case_ids: string[];
  case_count: number;
  entities: CampaignEntity[];
  mitre: string[];
  severity_rollup: string | null;
  first_seen: string | null;
  last_seen: string | null;
  created_at: string;
}

/** GET /api/campaigns — the running list. */
export interface CampaignsResponse {
  campaigns: Campaign[];
  total: number;
  enabled: boolean;
}

/** GET /api/campaigns/{id}. */
export interface CampaignDetailResponse {
  campaign: Campaign;
  /** Member case id → display number (additive; absent on older servers). */
  case_numbers?: Record<string, string>;
}

/** POST /api/campaigns/recorrelate outcome. */
export interface RecorrelateResponse {
  ok: boolean;
  count: number;
  campaigns: Campaign[];
}

export const campaignsApi = {
  /** The running campaign list, newest first. */
  list: (params?: { status?: string; limit?: number; offset?: number }) =>
    api.get<CampaignsResponse>('campaigns', params as Record<string, unknown> | undefined),
  /**
   * One campaign by id (throws ApiError 404 when absent), with `case_numbers`: each
   * member case's display number ("CASE-000045") by its internal id (Round 13 polish;
   * a member without a number, or past the server's bound, is absent).
   */
  get: (id: string) =>
    api.get<CampaignDetailResponse>(`campaigns/${encodeURIComponent(id)}`),
  /** The campaign a case belongs to (campaign is null when uncampaigned). */
  forCase: (caseId: string) =>
    api.get<{ case_id: string; campaign: Campaign | null }>(
      `cases/${encodeURIComponent(caseId)}/campaign`,
    ),
  /** Trigger the deterministic clustering pass NOW (admin). */
  recorrelate: () => api.post<RecorrelateResponse>('campaigns/recorrelate'),
};

/** Human labels for the campaign status. */
export const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};
