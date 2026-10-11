/**
 * "Add to case" (Round 12 SYNTHESIS-chat P1-9): the snapshot of a Workspace answer an
 * analyst posts, after a preview, as THEIR OWN case-thread comment.
 *
 * Pure. The comment is plain text (the case thread renders bodies as text, #9) and is
 * exactly what the preview shows:
 *
 *   From Workspace chat · 11 Oct 2026, 14:03 UTC
 *   Question: How many critical false positives this week?
 *
 *   <the answer text>
 *
 * - An `@name` in the question or the answer is defanged to `＠name` (a full-width at
 *   sign): the case thread notifies every @mentioned user, and an answer may quote log
 *   values, so a pasted answer must never ping anyone. The analyst can still mention a
 *   colleague in a reply of their own.
 * - The thread keeps at most {@link CASE_COMMENT_MAX_CHARS} characters; a longer answer
 *   is cut at a line or word boundary and says so (the full answer stays in chat).
 * - Charts and tables are not part of the comment (the dialog says so).
 */
import { CASE_COMMENT_MAX_CHARS } from '../chat-api';

/** The line that ends a shortened snapshot. */
export const SNAPSHOT_SHORTENED = '[Shortened to fit the case thread. The full answer stays in chat.]';

/** Defang `@mentions` so a pasted answer notifies no one (see module note). */
export function defangMentions(text: string): string {
  return text.replace(/(^|[^\w@])@(?=[A-Za-z0-9])/g, '$1＠');
}

/** "11 Oct 2026, 14:03 UTC" (UTC, so the same snapshot reads the same for everyone). */
export function snapshotTime(ms: number): string {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${day}, ${time} UTC`;
}

export interface CaseSnapshot {
  /** The comment exactly as it will be posted. */
  body: string;
  /** The answer was cut to fit the thread. */
  shortened: boolean;
}

/** Cut `text` to at most `max` characters at a line, else a word, boundary. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const line = slice.lastIndexOf('\n');
  if (line > max * 0.6) return slice.slice(0, line).trimEnd();
  const space = slice.lastIndexOf(' ');
  return (space > max * 0.6 ? slice.slice(0, space) : slice).trimEnd();
}

export function caseSnapshot(input: { question?: string | null; answer: string; at: number }): CaseSnapshot {
  const header = [`From Workspace chat · ${snapshotTime(input.at)}`];
  const question = (input.question ?? '').replace(/\s+/g, ' ').trim();
  if (question) header.push(`Question: ${defangMentions(cut(question, 300))}`);
  const head = `${header.join('\n')}\n\n`;
  const answer = defangMentions(input.answer.trim());
  if (head.length + answer.length <= CASE_COMMENT_MAX_CHARS) return { body: head + answer, shortened: false };
  const room = CASE_COMMENT_MAX_CHARS - head.length - SNAPSHOT_SHORTENED.length - 2;
  return { body: `${head}${cut(answer, Math.max(0, room))}\n\n${SNAPSHOT_SHORTENED}`, shortened: true };
}
