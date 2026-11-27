/**
 * Source row rules shared by the Sources page and the setup wizard, so neither offers
 * more than the server honours.
 *
 * - B43: a Demo Mode overlay row is read-only. It shows `DEMO_MANAGED_REASON` and no
 *   actions, and the server answers `409 source_demo_readonly` for a write to its id.
 * - B46: the server keeps `is_primary` only for a pull source that is not a receiver
 *   (`upsert_source` in `backend/app/api/routes.py`) and answers 200 either way, so Make
 *   primary is offered only for a pull source and its success is read from the returned
 *   list, never assumed.
 *
 * The wizard is an entry module, so this file stays small.
 */
import type { ConnectorManifest, SourceInstance } from '@/lib/types';

/** What a Demo Mode overlay row shows in place of its actions. */
export const DEMO_MANAGED_REASON = 'Managed by Demo Mode';

/** The warning when a Make primary write did not make the source primary. */
export const PRIMARY_PULL_ONLY = 'Only a pull source can be the primary source.';

/**
 * True when Make primary may be offered for this source: its own ingest mode is pull.
 * The server always stores `ingest_mode`; only a row without one falls back to the
 * server's default, the connector's first ingest mode. A receiver's manifest never lists
 * pull. A Demo overlay row never qualifies.
 */
export function canBePrimary(source: SourceInstance, manifest?: ConnectorManifest): boolean {
  if (source.demo) return false;
  return (source.ingest_mode || manifest?.ingest_modes?.[0]) === 'pull';
}

/** True when the upsert's returned list holds this source as the primary source. */
export function primaryConfirmed(
  response: { sources?: SourceInstance[] } | null | undefined,
  sourceId: string,
): boolean {
  return Boolean(response?.sources?.some((s) => s.id === sourceId && s.is_primary === true));
}
