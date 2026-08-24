/**
 * Co-located data layer for the UNIFIED multi-telemetry logs view (Round 4 Wave 5,
 * request #3).
 *
 * Calls the NEW server-side scatter-gather endpoint `GET /api/logs`, which fans out
 * the SAME per-source read that `GET /api/sources/{id}/logs` does across EVERY
 * enabled, browse-capable source at once and merges the rows newest-first. Each row
 * carries a MANDATORY `source_id` + `source_name` provenance column, and the response
 * also returns a per-source status list so the UI can surface partial failure (one
 * slow/failing source degrades to a per-source error entry, never blocks the rest).
 *
 * We use the low-level `api.get` helper exported from `@/lib/api` rather than adding
 * methods to the shared client, so this builder stays parallel-safe (co-located
 * `*.api.ts` pattern, matching Metrics.posture.api / Models.api).
 *
 * SECURITY (#9): every field on every row is source-controlled and therefore
 * UNTRUSTED — the consuming component renders them as PLAIN text and `_raw` only in a
 * fenced code block, never as markup. The types below describe the SHAPE only; they
 * grant no trust. Secrets are never returned by the endpoint.
 */
import { api } from '@/lib/api';

/**
 * One merged log row from `GET /api/logs`.
 *
 * Superset of the single-source `SourceLogRow` shape (`_log_row` in the backend) plus
 * the MANDATORY provenance columns `source_id` + `source_name`. Every field is
 * source-controlled and UNTRUSTED.
 */
export interface UnifiedLogRow {
  id: string;
  ts: string;
  /** MANDATORY provenance — which source this row came from (id + human name). */
  source_id: string;
  source_name: string;
  source_ip: string | null;
  user: string | null;
  host: string | null;
  rule: string | null;
  severity: number;
  message: string;
  _raw: Record<string, unknown>;
}

/**
 * Per-source outcome for the scatter-gather. `ok:false` carries an honest `error`
 * string (e.g. "timeout") so the UI can render a per-source degraded note. The
 * `source_name` is operator-set text → render as plain text.
 */
export interface UnifiedLogSourceStatus {
  source_id: string;
  source_name: string;
  ok: boolean;
  count: number;
  error?: string;
  /**
   * How this source was read. `"search"` = a real backing query, so the time range and
   * search box applied to it. `"buffer"` = a push source's PROCESS-LOCAL, VOLATILE
   * in-memory live-tail ring: the server IGNORES from/to/query for it and nothing
   * survives a backend restart. Optional only so an older backend degrades to
   * "unknown" rather than mislabelling a ring read as a search.
   */
  mode?: 'buffer' | 'search' | string;
}

/**
 * The `GET /api/logs` envelope: merged rows + per-source status + partial flag.
 *
 * BOUNDED, NOT COMPLETE: the server clamps `limit` to 1..200, applies it per source AND
 * on the merge, and offers NO pagination/cursor. `logs` is always "the most recent
 * `count` rows" — say that in the UI. `truncated` is true when the merge was cut; false
 * does NOT prove completeness, because each source was itself read with the same cap.
 */
export interface UnifiedLogsResponse {
  logs: UnifiedLogRow[];
  count: number;
  sources: UnifiedLogSourceStatus[];
  /** True when at least one source failed/timed out (partial result served). */
  partial: boolean;
  /** Effective server-side row cap for this response (clamped to 1..200). */
  limit?: number;
  /** True when the merged set was larger than the cap. */
  truncated?: boolean;
}

/** Query params for `GET /api/logs` (all optional; the backend hard-caps limit). */
export interface UnifiedLogsQuery {
  limit?: number;
  query?: string;
  from?: string;
  to?: string;
  /**
   * OPTIONAL single-source scope. Omitted = every enabled, browse-capable source
   * (the default fan-out). An id the server cannot browse is rejected the same way
   * `GET /api/sources/{id}/logs` rejects it: 404 unknown, 501 not browsable.
   */
  source_id?: string;
  per_source_timeout?: number;
}

/**
 * GET /api/logs — browse recent logs merged across ALL enabled, browse-capable
 * sources at once. `buildQuery` (inside `api.get`) drops undefined/null/empty params,
 * so a blank search/time-range is simply omitted.
 */
export function fetchUnifiedLogs(params?: UnifiedLogsQuery): Promise<UnifiedLogsResponse> {
  // Defer through Promise.resolve so a synchronous failure (e.g. a stubbed client)
  // surfaces as a rejection the caller can catch.
  return Promise.resolve().then(() =>
    api.get<UnifiedLogsResponse>('logs', params as Record<string, unknown> | undefined),
  );
}
