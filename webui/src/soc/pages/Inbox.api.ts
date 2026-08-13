/**
 * Co-located data layer for the in-app notification INBOX + per-user notification
 * preferences (Group 6 / Feature 8 / Round 3 Wave 2).
 *
 * These wrap the low-level `api.get/post/put` request helpers from `@/lib/api` so
 * this builder owns its own contracts WITHOUT touching the shared `lib/api.ts` or
 * `lib/types.ts` (parallel-safety). The backend routes live in
 * `backend/app/api/routes_inapp.py`:
 *
 *   GET  /api/notifications/inbox?unread_only=&limit=&offset=
 *   GET  /api/notifications/inbox/unread-count
 *   POST /api/notifications/inbox/{id}/read
 *   POST /api/notifications/inbox/read-all
 *   POST /api/notifications/inbox/{id}/dismiss
 *   GET  /api/notifications/prefs
 *   PUT  /api/notifications/prefs
 *
 * Security: every `title`/`body`/`category` string the inbox returns is render-
 * escaped plain data (#9) — the dispatcher already escaped every case/log value;
 * the UI renders it as PLAIN TEXT, never markup. No secrets are read or returned
 * (#10). The inbox is advisory (#3 — it never feeds `decide()`).
 */
import { api } from '@/lib/api';
import type {
  BackgroundJobProgress,
  BackgroundJobResult,
  BackgroundJobStatus,
} from '@/lib/types';

/* ---------------------------------------------------------------- types ----- */

/** Read lifecycle of one inbox item (mirrors `InAppNotification.state`). */
export type InboxState = 'unseen' | 'seen' | 'read' | 'archived';

/**
 * One in-app notification fanned out to the current user. Every text field is
 * UNTRUSTED, render-escaped plain data (#9). `category` is a
 * `NotificationCategory` value (case_new / case_escalated / case_resolved / mention
 * / assignment / approval / system / digest). `case_id` (when set) deep-links to
 * the referenced case; `url` is an OPTIONAL backend-supplied link that the UI must
 * NOT trust as an href (we always prefer the in-app `case_id` route).
 */
export interface InboxItem {
  id: string;
  recipient?: string;
  category: string;
  title: string;
  body: string;
  severity?: string | null;
  case_id?: string | null;
  url?: string | null;
  state: InboxState;
  created_at?: string;
  read_at?: string | null;
  ref?: Record<string, unknown>;
  job_id?: string | null;
  job_status?: BackgroundJobStatus | null;
  progress?: BackgroundJobProgress | null;
  result?: BackgroundJobResult | null;
}

/** Page of inbox items (newest first) + the total matching the active filter. */
export interface InboxResponse {
  items: InboxItem[];
  total: number;
  limit: number;
  offset: number;
  unread_only?: boolean;
}

/** Per-category × per-channel routing + optional quiet-hours / digest batching. */
export interface CategoryPref {
  /** Delivery channels for this category (in-app is ALWAYS on, not listed here). */
  channels?: string[];
  /** When false the category is muted entirely (in-app inbox still records it). */
  enabled?: boolean;
}

export interface QuietHours {
  /** 24h "HH:MM" local start. */
  start?: string;
  /** 24h "HH:MM" local end (may wrap past midnight). */
  end?: string;
  /** IANA tz name; blank → the operator's local tz. */
  tz?: string;
}

/** The current user's notification preferences (self-scoped server-side). */
export interface NotificationPrefs {
  user?: string;
  /** category value → { channels, enabled }. Absent category → in-app enabled. */
  categories: Record<string, CategoryPref>;
  quiet_hours?: QuietHours | null;
  /** off | hourly | daily — batch non-urgent fan-out into a digest. */
  digest?: string | null;
}

/** PUT body for the prefs route (the server forces `user` to the requester). */
export interface NotificationPrefsBody {
  categories: Record<string, CategoryPref>;
  quiet_hours?: QuietHours | null;
  digest?: string | null;
}

/* ----------------------------------------------------------- inbox calls ---- */

export interface InboxQuery {
  unread_only?: boolean;
  limit?: number;
  offset?: number;
}

export const inboxApi = {
  list: (params?: InboxQuery) =>
    api.get<InboxResponse>('notifications/inbox', params as Record<string, unknown> | undefined),

  unreadCount: () => api.get<{ unread: number }>('notifications/inbox/unread-count'),

  markRead: (id: string) =>
    api.post<{ ok: boolean; item?: InboxItem; detail?: string }>(
      `notifications/inbox/${encodeURIComponent(id)}/read`,
    ),

  markAllRead: () =>
    api.post<{ ok: boolean; marked: number }>('notifications/inbox/read-all'),

  dismiss: (id: string) =>
    api.post<{ ok: boolean; dismissed: boolean }>(
      `notifications/inbox/${encodeURIComponent(id)}/dismiss`,
    ),

  // ---- per-user notification preferences (self-scoped) ---------------------- //
  getPrefs: () => api.get<NotificationPrefs>('notifications/prefs'),
  putPrefs: (body: NotificationPrefsBody) =>
    api.put<NotificationPrefs>('notifications/prefs', body),
};

/* ------------------------------------------------------------- catalog ------ */

/**
 * The notification categories shown in the inbox grouping + the prefs matrix, in a
 * sensible display order. Mirrors `app.constants.NotificationCategory`. A category
 * the backend later adds still renders (it falls through to a humanised label) — we
 * only need this list for the deliberate ordering + friendly copy.
 */
export const NOTIFICATION_CATEGORIES: readonly string[] = [
  'case_new',
  'case_escalated',
  'case_resolved',
  'mention',
  'assignment',
  'approval',
  'system',
  'digest',
] as const;

/** Friendly label + one-line copy per known category (plain UI strings). */
export const CATEGORY_META: Record<string, { label: string; blurb: string }> = {
  case_new: { label: 'New cases', blurb: 'A new case was created from incoming alerts.' },
  case_escalated: { label: 'Escalations', blurb: 'A case was escalated for human attention.' },
  case_resolved: { label: 'Resolved', blurb: 'A case was closed or resolved.' },
  mention: { label: 'Mentions', blurb: 'You were mentioned in a case comment.' },
  assignment: { label: 'Assignments', blurb: 'A case was assigned to you.' },
  approval: { label: 'Approvals', blurb: 'A proposal is waiting for your approval.' },
  system: { label: 'System', blurb: 'Platform and configuration notices.' },
  digest: { label: 'Digests', blurb: 'Batched roll-up notifications.' },
};

/** Channels selectable in the prefs matrix (in-app is implicit + always on). */
export const NOTIFICATION_CHANNELS: readonly { id: string; label: string }[] = [
  { id: 'email', label: 'Email' },
  { id: 'slack', label: 'Slack' },
  { id: 'teams', label: 'Teams' },
  { id: 'webhook', label: 'Webhook' },
  { id: 'pagerduty', label: 'PagerDuty' },
  { id: 'telegram', label: 'Telegram' },
] as const;

export const DIGEST_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'off', label: 'Off — deliver immediately' },
  { value: 'hourly', label: 'Hourly digest' },
  { value: 'daily', label: 'Daily digest' },
] as const;
