/**
 * Round 14 runbooks client (SPEC §4.10.15). Lazy-only: imported by the Runbooks page,
 * the editor and the case Runbook tab, never by an entry module (§3.4). Every call
 * goes through the shared request helper (401, step-up and error contract).
 *
 * These are the only runbook calls in the Console (the pre-Round 14 `api.getRunbooks`,
 * `api.getPlaybooks` and their writes are gone). The server still answers the old read
 * shapes for API clients for one release (`GET /api/playbooks`, `?shape=v1`), and an
 * old-shape write answers `410 runbooks_moved`.
 */
import { requestResponse, request, type BlobDownload } from './api';
import type {
  CaseRunbooks,
  LookupResult,
  MatchPreview,
  RunbookAttachBody,
  RunbookAttachResult,
  RunbookCandidates,
  RunbookDetail,
  RunbookDiscardResult,
  RunbookDraftBody,
  RunbookLibrary,
  RunbookLibraryQuery,
  RunbookLookupTestBody,
  RunbookMetrics,
  RunbookProgressMap,
  RunbookPublishBody,
  RunbookRejectBody,
  RunbookRevisionBody,
  RunbookRunUpdate,
  RunbookSourceBody,
  RunbookStepDraftResult,
  RunbookStepUpdate,
  RunbookSuggestion,
  RunbookValidation,
  RunbookVersionBody,
  RunbookVersionDoc,
  StepApprovalBody,
  StepDraftConfirmBody,
} from './types-runbooks';

const id = (value: string) => encodeURIComponent(value);
const runPath = (caseId: string, runId: string) => `cases/${id(caseId)}/runbooks/${id(runId)}`;
const stepPath = (caseId: string, runId: string, stepId: string) =>
  `${runPath(caseId, runId)}/steps/${id(stepId)}`;

// ---- Library (`runbooks:read`; writes `runbooks:manage` or `runbooks:publish`) ---- //

/** `GET /api/runbooks`: built-ins and operator runbooks (there is no empty library). */
export function listRunbookLibrary(
  query: RunbookLibraryQuery = {},
  signal?: AbortSignal,
): Promise<RunbookLibrary> {
  return request<RunbookLibrary>('GET', 'runbooks', {
    query: query as unknown as Record<string, unknown>,
    signal,
  });
}

/** `GET /api/runbooks/{id}`: draft and in-review versions only for `manage` or `publish`. */
export function getRunbookDetail(runbookId: string, signal?: AbortSignal): Promise<RunbookDetail> {
  return request<RunbookDetail>('GET', `runbooks/${id(runbookId)}`, { signal });
}

/** `GET /api/runbooks/{id}/versions/{n}`: one version with its Markdown source. */
export function getRunbookVersion(
  runbookId: string,
  version: number,
  signal?: AbortSignal,
): Promise<RunbookVersionDoc> {
  return request<RunbookVersionDoc>('GET', `runbooks/${id(runbookId)}/versions/${version}`, { signal });
}

/** `POST /api/runbooks`: create a draft from a definition or Markdown source. */
export function createRunbook(body: RunbookSourceBody): Promise<RunbookDetail> {
  return request<RunbookDetail>('POST', 'runbooks', { body });
}

/** `PUT /api/runbooks/{id}/draft`: a stale revision answers `409 runbook_conflict`. */
export function saveRunbookDraft(runbookId: string, body: RunbookDraftBody): Promise<RunbookDetail> {
  return request<RunbookDetail>('PUT', `runbooks/${id(runbookId)}/draft`, { body });
}

/**
 * `DELETE /api/runbooks/{id}/draft`: a never-published runbook disappears. Pass the
 * detail's `revision` as `expectedRevision` so a draft someone else changed since it
 * was opened is never discarded unseen (`409 runbook_conflict`).
 */
export function discardRunbookDraft(runbookId: string, expectedRevision?: number): Promise<RunbookDiscardResult> {
  return request<RunbookDiscardResult>('DELETE', `runbooks/${id(runbookId)}/draft`, {
    query: { expected_revision: expectedRevision },
  });
}

/** `POST /api/runbooks/{id}/duplicate`: a built-in or operator runbook to a new draft. */
export function duplicateRunbook(runbookId: string, body: RunbookRevisionBody = {}): Promise<RunbookDetail> {
  return request<RunbookDetail>('POST', `runbooks/${id(runbookId)}/duplicate`, { body });
}

/** `POST /api/runbooks/{id}/submit`: draft to in review. */
export function submitRunbookForReview(runbookId: string, body: RunbookVersionBody): Promise<RunbookDetail> {
  return request<RunbookDetail>('POST', `runbooks/${id(runbookId)}/submit`, { body });
}

/**
 * `POST /api/runbooks/{id}/publish` (`runbooks:publish`): makes the version live. The
 * body names the revision (and the version's `content_hash`) the publisher reviewed,
 * so text changed since the review is never published unseen (`409 runbook_conflict`).
 */
export function publishRunbook(runbookId: string, body: RunbookPublishBody): Promise<RunbookDetail> {
  return request<RunbookDetail>('POST', `runbooks/${id(runbookId)}/publish`, { body });
}

/** `POST /api/runbooks/{id}/reject` (`runbooks:publish`): back to draft with a reason. */
export function rejectRunbook(runbookId: string, body: RunbookRejectBody): Promise<RunbookDetail> {
  return request<RunbookDetail>('POST', `runbooks/${id(runbookId)}/reject`, { body });
}

/** `POST /api/runbooks/{id}/retire`: the runbook stops matching; runs keep working. */
export function retireRunbook(runbookId: string, body: RunbookRevisionBody = {}): Promise<RunbookDetail> {
  return request<RunbookDetail>('POST', `runbooks/${id(runbookId)}/retire`, { body });
}

/** `POST /api/runbooks/{id}/restore` (`runbooks:publish`): republishes the last live version. */
export function restoreRunbook(runbookId: string, body: RunbookRevisionBody = {}): Promise<RunbookDetail> {
  return request<RunbookDetail>('POST', `runbooks/${id(runbookId)}/restore`, { body });
}

/** `POST /api/runbooks/{id}/reviewed` (`runbooks:publish`): Mark reviewed, no new version. */
export function markRunbookReviewed(runbookId: string, body: RunbookRevisionBody = {}): Promise<RunbookDetail> {
  return request<RunbookDetail>('POST', `runbooks/${id(runbookId)}/reviewed`, { body });
}

/** `POST /api/runbooks/{id}/versions/{n}/restore`: a new draft from version n. */
export function restoreRunbookVersionAsDraft(
  runbookId: string,
  version: number,
  body: RunbookRevisionBody = {},
): Promise<RunbookDetail> {
  return request<RunbookDetail>('POST', `runbooks/${id(runbookId)}/versions/${version}/restore`, { body });
}

/** `POST /api/runbooks/validate`: issues and the guidance length; writes nothing. */
export function validateRunbook(body: RunbookSourceBody, signal?: AbortSignal): Promise<RunbookValidation> {
  return request<RunbookValidation>('POST', 'runbooks/validate', { body, signal });
}

/** `POST /api/runbooks/match-preview` (`runbooks:read` and `cases:read`); writes nothing. */
export function previewRunbookMatch(body: RunbookSourceBody, signal?: AbortSignal): Promise<MatchPreview> {
  return request<MatchPreview>('POST', 'runbooks/match-preview', { body, signal });
}

/** `POST /api/runbooks/import`: Markdown source, always landing as a draft. */
export function importRunbook(source: string): Promise<RunbookDetail> {
  return request<RunbookDetail>('POST', 'runbooks/import', { body: { source } });
}

/**
 * `GET /api/runbooks/{id}/export`: the `text/markdown` attachment of the version the
 * caller would open (the live one, or the draft for an editor). The export is recorded
 * in the audit log before the file is sent (`503 audit_unavailable` refuses it).
 */
export function exportRunbookMarkdown(runbookId: string, signal?: AbortSignal): Promise<BlobDownload> {
  return exportRunbookVersionMarkdown(runbookId, undefined, signal);
}

/**
 * `GET /api/runbooks/{id}/export?version=n`: one exact version as Markdown, for
 * example the version a case's run pinned. A version the caller cannot see answers
 * `404 runbook_version_not_found`; without `version` it is {@link exportRunbookMarkdown}.
 */
export async function exportRunbookVersionMarkdown(
  runbookId: string,
  version?: number,
  signal?: AbortSignal,
): Promise<BlobDownload> {
  const res = await requestResponse('GET', `runbooks/${id(runbookId)}/export`, {
    query: { version },
    signal,
  });
  return {
    blob: await res.blob(),
    contentDisposition: res.headers.get('content-disposition'),
    contentType: res.headers.get('content-type'),
  };
}

/** `GET /api/runbooks/metrics` (`runbooks:read` and `cases:read`); default window `now-30d`. */
export function getRunbookMetrics(window?: string, signal?: AbortSignal): Promise<RunbookMetrics> {
  return request<RunbookMetrics>('GET', 'runbooks/metrics', { query: { window }, signal });
}

/**
 * `POST /api/runbooks/lookup-test` (`runbooks:manage`, `sources:read`, `cases:read`
 * and the tool's grant): runs a draft lookup against one case; nothing is stored.
 */
export function testRunbookLookup(body: RunbookLookupTestBody, signal?: AbortSignal): Promise<LookupResult> {
  return request<LookupResult>('POST', 'runbooks/lookup-test', { body, signal });
}

// ---- Case runs (`runbooks:read` and `cases:read`; writes `runbooks:run`) ---- //

/** `GET /api/cases/{case_id}/runbooks`: runs with evidence redacted for this viewer. */
export function getCaseRunbooks(caseId: string, signal?: AbortSignal): Promise<CaseRunbooks> {
  return request<CaseRunbooks>('GET', `cases/${id(caseId)}/runbooks`, { signal });
}

/** `GET /api/cases/{case_id}/runbooks/candidates`: the Start runbook picker list. */
export function getRunbookCandidates(caseId: string, q?: string, signal?: AbortSignal): Promise<RunbookCandidates> {
  return request<RunbookCandidates>('GET', `cases/${id(caseId)}/runbooks/candidates`, {
    query: { q },
    signal,
  });
}

/** `POST /api/cases/{case_id}/runbooks`: idempotent; an existing run answers `already_attached`. */
export function attachRunbook(caseId: string, body: RunbookAttachBody): Promise<RunbookAttachResult> {
  return request<RunbookAttachResult>('POST', `cases/${id(caseId)}/runbooks`, { body });
}

/** `POST /api/cases/{case_id}/runbooks/suggest`: one gateway call, never attaches; `dryRun` estimates. */
export function suggestRunbook(caseId: string, opts: { dryRun?: boolean } = {}): Promise<RunbookSuggestion> {
  return request<RunbookSuggestion>('POST', `cases/${id(caseId)}/runbooks/suggest`, {
    query: { dry_run: opts.dryRun ? 'true' : undefined },
  });
}

/** `PATCH .../steps/{step_id}`: a stale revision answers `409 runbook_conflict`, never retried. */
export function updateRunbookStep(
  caseId: string,
  runId: string,
  stepId: string,
  body: RunbookStepUpdate,
): Promise<RunbookRunUpdate> {
  return request<RunbookRunUpdate>('PATCH', stepPath(caseId, runId, stepId), { body });
}

/** `POST .../steps/{step_id}/lookup`: runs the lookup now, replacing the automatic result. */
export function runRunbookLookup(caseId: string, runId: string, stepId: string): Promise<RunbookRunUpdate> {
  return request<RunbookRunUpdate>('POST', `${stepPath(caseId, runId, stepId)}/lookup`);
}

/** `POST .../steps/{step_id}/approval`: the recorder can never approve. */
export function decideRunbookApproval(
  caseId: string,
  runId: string,
  stepId: string,
  body: StepApprovalBody,
): Promise<RunbookRunUpdate> {
  return request<RunbookRunUpdate>('POST', `${stepPath(caseId, runId, stepId)}/approval`, { body });
}

/** `POST .../steps/{step_id}/draft`: an AI draft (one gateway call); `dryRun` estimates. */
export function draftRunbookStep(
  caseId: string,
  runId: string,
  stepId: string,
  opts: { dryRun?: boolean } = {},
): Promise<RunbookStepDraftResult> {
  return request<RunbookStepDraftResult>('POST', `${stepPath(caseId, runId, stepId)}/draft`, {
    query: { dry_run: opts.dryRun ? 'true' : undefined },
  });
}

/** `POST .../steps/{step_id}/draft/confirm`: the draft as the person edited it becomes the note. */
export function confirmRunbookStepDraft(
  caseId: string,
  runId: string,
  stepId: string,
  body: StepDraftConfirmBody,
): Promise<RunbookRunUpdate> {
  return request<RunbookRunUpdate>('POST', `${stepPath(caseId, runId, stepId)}/draft/confirm`, { body });
}

/** `POST .../runbooks/{run_id}/switch-version`: carries over steps whose ids exist in both. */
export function switchRunbookRunVersion(caseId: string, runId: string, version: number): Promise<RunbookRunUpdate> {
  return request<RunbookRunUpdate>('POST', `${runPath(caseId, runId)}/switch-version`, { body: { version } });
}

/** `POST .../runbooks/{run_id}/abandon`: never changes the case. */
export function abandonRunbookRun(caseId: string, runId: string, reason: string): Promise<RunbookRunUpdate> {
  return request<RunbookRunUpdate>('POST', `${runPath(caseId, runId)}/abandon`, { body: { reason } });
}

/** The server reads at most this many cases per progress request. */
export const RUNBOOK_PROGRESS_BATCH = 100;

/** The longest case id the progress request accepts (an id becomes part of a store key). */
export const RUNBOOK_PROGRESS_CASE_ID_MAX = 128;

/**
 * `POST /api/runbooks/progress` (`cases:read`): progress per case. The server takes at
 * most 100 ids per request, so a longer list is sent in batches of 100, one after
 * another, and merged. A case with no run is absent from the map. An id the server
 * would refuse (empty, or longer than 128 characters) cannot hold a run, so it is left
 * out rather than failing the whole batch with a `422`.
 */
export async function getRunbookProgress(
  caseIds: string[],
  signal?: AbortSignal,
): Promise<RunbookProgressMap> {
  const unique = Array.from(
    new Set(caseIds.filter((caseId) => caseId.length > 0 && caseId.length <= RUNBOOK_PROGRESS_CASE_ID_MAX)),
  );
  const merged: RunbookProgressMap = {};
  for (let start = 0; start < unique.length; start += RUNBOOK_PROGRESS_BATCH) {
    const batch = unique.slice(start, start + RUNBOOK_PROGRESS_BATCH);
    const part = await request<RunbookProgressMap>('POST', 'runbooks/progress', {
      body: { case_ids: batch },
      signal,
    });
    Object.assign(merged, part);
  }
  return merged;
}
