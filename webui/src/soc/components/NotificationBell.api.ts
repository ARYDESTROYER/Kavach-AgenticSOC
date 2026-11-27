/**
 * Co-located data layer for the top-bar NotificationBell (Round-3 Stage 2, Group 1).
 *
 * Kept OUT of the shared `@/lib/api` to avoid edit contention with the other webui
 * builders. These thin wrappers use the low-level `api.get`/`api.post` request
 * helper exported by `@/lib/api`, so they ride the same auth-cookie + error-handling
 * path as every other call.
 *
 * SECURITY (#9): `title`/`body`/`url` originate from cases/sources/operator text and
 * are UNTRUSTED. The bell renders title + body as PLAIN text only and NEVER follows
 * `url` blindly — the bell intentionally does not navigate to `url`; it routes to the
 * in-app Inbox page (a known PageId) instead. The fields below are typed but a
 * consumer must treat the strings as plain data.
 *
 * SSE seam (Wave 4): the bell polls today. When server-sent events land, replace the
 * interval in the hook with an EventSource subscription that calls the same setters;
 * this module's shape is unchanged.
 */
import { api } from '@/lib/api';
import type {
  BackgroundJobProgress,
  BackgroundJobResult,
  BackgroundJobStatus,
} from '@/lib/types';
import { isActiveJobStatus } from '@/soc/jobs/jobs';

/** The read lifecycle of an inbox item (mirrors the backend `InAppNotification.state`). */
export type InboxItemState = 'unseen' | 'seen' | 'read' | 'archived';

/**
 * One in-app notification (GET /api/notifications/inbox). Every string field is
 * operator-/log-derived UNTRUSTED data → render PLAIN.
 */
export interface InboxItem {
  id: string;
  recipient?: string;
  category?: string;
  title?: string;
  body?: string;
  severity?: string | null;
  case_id?: string | null;
  /** Source-controlled; the bell does NOT navigate to this — it is informational only. */
  url?: string | null;
  state?: InboxItemState;
  created_at?: string;
  read_at?: string | null;
  ref?: Record<string, unknown>;
  job_id?: string | null;
  job_status?: BackgroundJobStatus | null;
  progress?: BackgroundJobProgress | null;
  result?: BackgroundJobResult | null;
}

/** GET /api/notifications/inbox response. */
export interface InboxResponse {
  items: InboxItem[];
  total: number;
  limit: number;
  offset: number;
  unread_only?: boolean;
}

/** GET /api/notifications/inbox/unread-count response. */
export interface UnreadCountResponse {
  unread: number;
}

/** The recent inbox window the bell dropdown shows (newest first, bounded). */
export function fetchInbox(limit = 8): Promise<InboxResponse> {
  return api.get<InboxResponse>('notifications/inbox', { limit });
}

/** The unread badge count (state in {unseen, seen}). */
export function fetchUnreadCount(): Promise<UnreadCountResponse> {
  return api.get<UnreadCountResponse>('notifications/inbox/unread-count');
}

/** Active personal work is independent of notification read/unread state. */
export async function fetchActiveJobCount(): Promise<number> {
  const response = await api.jobs.list({ limit: 100, offset: 0 });
  const personal = (response.jobs ?? []).filter((job) => isActiveJobStatus(job.status)).length;
  const related = (response.related?.llm_batches ?? []).filter((job) =>
    ['submitted', 'polling', 'retrieving'].includes(job.state),
  ).length;
  return personal + related;
}

/** Mark every not-yet-read item in the caller's inbox read. */
export function markAllRead(): Promise<{ ok: boolean; marked: number }> {
  return api.post<{ ok: boolean; marked: number }>('notifications/inbox/read-all');
}

/** Mark ONE inbox item read (self-scoped). */
export function markRead(id: string): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>(
    `notifications/inbox/${encodeURIComponent(id)}/read`,
  );
}
