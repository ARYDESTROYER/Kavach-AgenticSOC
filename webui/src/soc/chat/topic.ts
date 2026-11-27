/**
 * The "Ask about this" topic grammar (chat revamp SPEC A7), mirroring `models.py`.
 *
 * - {@link CONSOLE_TOPIC_RE} is a `console_map` topic id (`_CONSOLE_LINK_ID_PATTERN`,
 *   e.g. `kpi:mttd`, `settings:detection`): what a link may navigate with
 *   (`NavOpts.topic`) and what `GET /api/chat/topics/{id}` accepts.
 * - {@link REQUEST_TOPIC_RE} is `CHAT_TOPIC_PATTERN`, the superset `ChatRequest.topic`
 *   accepts (≤ {@link CHAT_TOPIC_MAX_CHARS}, so the longest console id, 40 + 1 + 80,
 *   always fits). A value outside it would fail the turn with 422, so it is dropped
 *   from the request rather than sent.
 *
 * Dependency-free: the chat page, the engine and the client all import it, and a KPI
 * "Ask about this" link in an eager chunk must not pull chat code in for one pattern.
 */

/** `CHAT_TOPIC_MAX_CHARS`: the longest topic a turn may carry. */
export const CHAT_TOPIC_MAX_CHARS = 121;

/** A `console_map` topic id (navigation and topic lookup). */
export const CONSOLE_TOPIC_RE = /^[a-z0-9_]{1,40}:[a-z0-9_.-]{1,80}$/;

/** `ChatRequest.topic` (the server's `CHAT_TOPIC_PATTERN`). */
export const REQUEST_TOPIC_RE = /^[a-z0-9_:.-]{1,121}$/;

/** A well-formed `console_map` topic id, else `null`. */
export function consoleTopic(value: unknown): string | null {
  return typeof value === 'string' && CONSOLE_TOPIC_RE.test(value) ? value : null;
}
