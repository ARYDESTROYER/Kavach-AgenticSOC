/**
 * Round 15 Team activity client (SPEC D3.10, D3.11). Lazy-only: imported by the Team
 * activity page, never by an entry module, so none of these calls ships at first paint
 * (SPEC §3.1). Every call goes through the shared request helper, which keeps the 401,
 * step-up re-authentication and error contract of every other call.
 */
import { request } from './api';
import type { TeamActivity, TeamEvents, TeamPeople } from './types-team';

/** `GET /api/team/activity?window=`: the window's counts, per person and per day. */
export function getTeamActivity(window: string, signal?: AbortSignal): Promise<TeamActivity> {
  return request<TeamActivity>('GET', 'team/activity', { query: { window }, signal });
}

/** `GET /api/team/people`: the roster (username, display name, role, active, kind). */
export function getTeamPeople(signal?: AbortSignal): Promise<TeamPeople> {
  return request<TeamPeople>('GET', 'team/people', { signal });
}

/** The most events one page holds. */
export const TEAM_EVENTS_PAGE = 50;

/**
 * `GET /api/team/people/{username}/events`: one person's counted events, newest first.
 * Pass the previous page's `next_cursor` as `cursor` for "Load more"; a cursor for
 * another window or a refreshed list answers `409 team_cursor_expired`.
 */
export function getTeamPersonEvents(
  username: string,
  window: string,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<TeamEvents> {
  return request<TeamEvents>('GET', `team/people/${encodeURIComponent(username)}/events`, {
    query: { window, limit: TEAM_EVENTS_PAGE, ...(cursor ? { cursor } : {}) },
    signal,
  });
}

/** The `{detail: {code}}` of a refused or failed call, when it has one. */
export function teamErrorCode(error: unknown): string | null {
  const body = (error as { body?: unknown } | null)?.body as { detail?: unknown } | undefined;
  const detail = body?.detail as { code?: unknown } | undefined;
  return typeof detail?.code === 'string' ? detail.code : null;
}

/** The server's plain message of a refused or failed call, when it has one. */
export function teamErrorMessage(error: unknown): string | null {
  const body = (error as { body?: unknown } | null)?.body as { detail?: unknown } | undefined;
  const detail = body?.detail as { message?: unknown } | undefined;
  return typeof detail?.message === 'string' ? detail.message : null;
}
