/**
 * The command palette's "Ask AI: <text>" hand-off (chat revamp SPEC §10.4a).
 *
 * The palette passes the analyst's own words to the chat page as `NavOpts.ask`; the page
 * PREFILLS a new chat's composer with them and focuses it, and never sends on its own
 * (the analyst reviews and presses Enter, so the turn's origin is honestly `user`).
 *
 * A dependency-free module: both the lazy palette chunk and the chat page import it, and
 * neither should pull the other's code in for one bound.
 */

/** The longest palette question carried to the composer (the saved-prompt text bound). */
export const ASK_MAX_CHARS = 2000;

/**
 * The text a palette ask carries, or `null` when there is nothing to ask.
 *
 * Trimmed, then cut to {@link ASK_MAX_CHARS} UTF-16 units without splitting a surrogate
 * pair (an emoji at the boundary is dropped whole rather than left as a lone half).
 */
export function clampAsk(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length <= ASK_MAX_CHARS) return text;
  let end = ASK_MAX_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd() || null;
}
