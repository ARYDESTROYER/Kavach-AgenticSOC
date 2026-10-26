/**
 * Navigation type contracts for the SOC shell router.
 *
 * `NavOpts` lived in `lib/types.ts` historically; it is a UI-only navigation
 * contract (not a backend data mirror), so Round-5 moves it here next to the
 * router/shell that owns it. `lib/types.ts` keeps a re-export shim so existing
 * `import type { NavOpts } from '@/lib/types'` sites keep working unchanged.
 */

/**
 * Navigation options threaded through `Navigate` (router.tsx / App.tsx) so
 * deep-links / drill-throughs can pre-seed a destination page's filters/tab.
 * All fields are optional and additive. Most are carried in memory only; `caseId`
 * is serialized for Cases / Case Manager so an exact selected-case handoff survives
 * refresh and browser history.
 *
 * `section`/`anchor` (Round-5 Sett-C) are also serialized: for the `settings` page they
 * are serialized into the URL hash (`#/settings?s=<section>&a=<anchor>`) so a Cmd-K
 * jump / card-level deep-link survives a full hashchange. They are ignored for every
 * other page.
 */
export type NavOpts = {
  caseId?: string;
  status?: string;
  /** Exact assignee value as useful result context; it is not a stored job-ID cohort. */
  assignee?: string;
  /** Exact tag value as useful result context; it is not a stored job-ID cohort. */
  tag?: string;
  /**
   * Severity-band drill-through (Round-6 #38): a coarse band the destination Cases view
   * seeds its severity filter from — one of `critical | high | medium | low | info`
   * (matching the Cases severity dropdown + `severityBand`). Lets the Overview
   * Critical/High KPI + the open-by-severity rows deep-link to a severity-filtered list.
   * On Logs (Round 14, SPEC §4.6.6) it is a durable hash key: "Severity is High".
   */
  severity?: string;
  /** Exact Noise Reduction outcome cohort used by the dashboard drill-through. */
  noiseOutcome?: 'auto_cleared' | 'escalated' | 'closed';
  window?: number;
  tab?: string;
  /** Settings section id — serialized to `#/settings?s=<section>`. */
  section?: string;
  /** In-section card anchor — serialized to `&a=<anchor>` for a scroll+highlight. */
  anchor?: string;
  /*
   * Chat revamp deep links (SPEC §10.7). Additive and validated: the router
   * serialises only the durable ones for their own page (fail closed on anything
   * else), and every consumer re-validates what it reads.
   */
  /** Chat: a REQUESTED saved conversation (`#/chat?conversationId=…`); never forced. */
  conversationId?: string;
  /** Chat: the message to scroll to and highlight; serialised only with `conversationId`. */
  messageId?: string;
  /** Chat: open on a fresh New-chat draft (in memory only, so a refresh never repeats it). */
  newChat?: boolean;
  /** Chat: a `console_map` topic id ("Ask about this"); never free text, in memory only. */
  topic?: string;
  /**
   * Chat: the command palette's "Ask AI: <text>" — the analyst's own words, prefilled
   * into a new chat's composer (never sent automatically; at most 2,000 characters).
   * In memory only: the router never writes it to the hash, so a refresh or a shared
   * link never carries free text.
   */
  ask?: string;
  /**
   * Chat (Round 12 WP-ASK): an "Ask AI" chip's TYPED reference to one entity value. The
   * page resolves it to the server's question (`POST /api/chat/entity-question`) and
   * sends that with `origin: "starter"` in a new chat; never free text, never prefilled.
   * In memory only: the router never writes it to the hash.
   */
  entity?: { kind: string; value: string };
  /**
   * Chat (Round 12): "Ask again" from the toast of a NEW chat whose answer could not be
   * completed or saved, for a question the analyst did NOT type (an Ask AI or "Ask about
   * this" question, a starter, a follow-up). The page sends the exact question again in
   * a new chat with the SAME origin and topic, like Ask again in a transcript; it is
   * never prefilled, so it never becomes the analyst's own words (#9). Only this tab's
   * own turn runner hands it over; in memory only, the router never writes it to the hash.
   */
  resend?: { message: string; origin: string; topic?: string | null };
  /** Reports library: the report to open (`#/reports?reportId=…`). */
  reportId?: string;
  /** Logs: an exact query to pre-fill (untrusted text, bounded, control/bidi-free). */
  logQuery?: string;
  /** Logs: window bounds — `now`, `now-<n>[mhdw]` or an ISO-8601 timestamp. */
  from?: string;
  to?: string;
  /** Logs: the source to browse. */
  sourceId?: string;
  /*
   * Round 14 deep links (SPEC §2.2, §4.5.1, §4.6.6, §4.8.2, §4.10.12). Each is a durable
   * hash key of ONE page, validated by the router (`DEEP_LINK_KEYS` / `hashKeys` in
   * router.tsx); a bad value drops the whole query. Pages re-validate what they read.
   */
  /** Dashboards: the board to open (`builtin:<id>`, a personal id, `u:<sha8>` or `new`). */
  board?: string;
  /** Logs and Cases: an exact detection rule value ("Rule is"). */
  rule?: string;
  /** Logs: "Severity High or above" (one of `info | low | medium | high | critical`). */
  severity_gte?: string;
  /** Case Manager: the queue's "Closed by" filter (`agent`, `analyst`, `analyst_policy`, `system`). */
  closedBy?: string;
  /** Runbooks: the runbook the editor opens, or `new`. */
  id?: string;
  /** Audit log: the scope (`people`, `agent` or `all`). */
  scope?: string;
  /** Audit log: the server-side search text (untrusted, bounded, control-free). */
  q?: string;
  /** Audit log: an action (`user.role_changed`) or an event category id. */
  event?: string;
  /** Audit log: an exact actor. */
  actor?: string;
  /** Audit log: an actor substring. */
  actor_contains?: string;
  /** Audit log: the outcome (`success`, `failure`, `denied`, `partial`, `unknown`). */
  outcome?: string;
  /** Audit log: rows for one case. */
  case?: string;
  /** Audit log: rows for one target id. */
  target?: string;
  /** Audit log: rows from one client IP address. */
  ip?: string;
  /** Audit log: the record the inspector opens (an opaque store-prefixed id). */
  record?: string;
};
