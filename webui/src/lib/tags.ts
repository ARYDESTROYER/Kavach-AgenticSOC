/**
 * Tag length rules shared by every tag field.
 *
 * A value over a field's limit is refused where it is typed, with a message. It is
 * never cut to fit: a shorter tag is a different tag from the one the person meant.
 *
 * Case tags mirror the server: `CASE_TAG_MAX_CHARS` and `CASE_TAG_MAX_COUNT` in
 * `backend/app/engine/case_tags.py`, the rules every case tag writer keeps (the `/tags`
 * route and a lifecycle action's tags answer 422 for a longer new tag or for new tags
 * past the count; the bulk tag job's params model carries the length bound too).
 */

/** The longest case tag, in characters (code points, as the server counts them). */
export const CASE_TAG_MAX_CHARS = 40;

/** The most tags one case holds. */
export const CASE_TAG_MAX_COUNT = 25;

/** Characters as the server counts them (code points, not UTF-16 units), trimmed. */
export function tagCharCount(text: string): number {
  return Array.from(text.trim()).length;
}

/** The refusal for a value longer than `maxLength`, or null when it fits. */
export function tagTooLongMessage(text: string, maxLength: number): string | null {
  return tagCharCount(text) > maxLength
    ? `This is longer than ${maxLength} characters. Shorten it to add it.`
    : null;
}

/** The inline refusal for a case tag that is too long, or null when it fits. */
export function caseTagError(tag: string): string | null {
  return tagTooLongMessage(tag, CASE_TAG_MAX_CHARS);
}
