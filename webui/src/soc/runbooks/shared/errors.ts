/**
 * The runbook API's refusals, read once (Round 14, SPEC §4.10.15). Every runbook route
 * answers `{"detail": {"code", "message", ...extra}}`: `issues` for `runbook_invalid`,
 * `length` for `runbook_prompt_budget`, `revision` and `latest` for `runbook_conflict`
 * (and `exists` when a create names an id that is taken).
 * The page states branch on `code`; the message the server wrote is shown as plain text.
 * Every code the runbook routes answer is in {@link RunbookErrorCode} (`types-runbooks.ts`).
 */
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import type { RunbookDetail, RunbookErrorCode, RunbookIssue } from '@/lib/types-runbooks';

export interface RunbookApiFailure {
  /** HTTP status (0 when the backend could not be reached). */
  status: number;
  /**
   * The stable code, or `null` for an error without one. A code outside
   * {@link RunbookErrorCode} (a newer server, or a route outside the runbook family) is
   * kept as it came.
   */
  code: RunbookErrorCode | (string & {}) | null;
  /** A plain sentence to show. */
  message: string;
  /** `runbook_invalid`: the problems, each with its path. */
  issues: RunbookIssue[];
  /** `runbook_conflict`: the latest detail the server sent, when it sent one. */
  latest: RunbookDetail | null;
  /** `runbook_prompt_budget`: the measured guidance length. */
  length: number | null;
  /**
   * `runbook_conflict` on a create: a runbook with the requested id already exists. It is
   * not a stale revision, so the editor shows it on the Id field rather than offering Reload.
   */
  exists: boolean;
}

function isIssue(value: unknown): value is RunbookIssue {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.path === 'string' && typeof v.code === 'string' && typeof v.message === 'string';
}

function isDetail(value: unknown): value is RunbookDetail {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return !!v.summary && typeof v.summary === 'object' && typeof v.revision === 'number';
}

/** Read any thrown value as a runbook API failure. */
export function runbookFailure(error: unknown, fallback = 'Something went wrong. Try again.'): RunbookApiFailure {
  const status = error instanceof ApiError ? error.status : 0;
  let code: string | null = null;
  let issues: RunbookIssue[] = [];
  let latest: RunbookDetail | null = null;
  let length: number | null = null;
  let exists = false;
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const detail = (error.body as { detail?: unknown }).detail;
    const top = error.body as Record<string, unknown>;
    const source = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : top;
    if (typeof source.code === 'string') code = source.code;
    else if (typeof top.code === 'string') code = top.code;
    if (Array.isArray(source.issues)) issues = source.issues.filter(isIssue);
    if (isDetail(source.latest)) latest = source.latest;
    if (typeof source.length === 'number') length = source.length;
    exists = source.exists === true;
  }
  return { status, code, message: errorMessage(error, fallback), issues, latest, length, exists };
}

/** True for the "you cannot read cases" family: a 403, or row-level scope hiding case figures. */
export function isCaseFiguresHidden(failure: RunbookApiFailure): 'forbidden' | 'scope' | null {
  if (failure.code === 'runbook_scope_unsupported') return 'scope';
  if (failure.status === 403) return 'forbidden';
  return null;
}
