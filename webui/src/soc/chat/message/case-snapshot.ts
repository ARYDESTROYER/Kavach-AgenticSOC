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
 * - The answer's Markdown becomes plain text first (`plainAnswerText`): the thread shows
 *   a human comment as text, so `**bold**`, `` `code` ``, `#` headings, `- ` bullets and
 *   table pipes would otherwise be posted (and previewed) literally. Headings become
 *   plain lines, bullets "• ", table rows "a · b · c", links their text (plus the address
 *   for an absolute link), emphasis and code markers are dropped.
 * - An `@name` in the question or the answer is defanged to `＠name` (a full-width at
 *   sign): the case thread notifies every @mentioned user, and an answer may quote log
 *   values, so a pasted answer must never ping anyone. The analyst can still mention a
 *   colleague in a reply of their own.
 * - Citation markers (`[D1]`, `[C2]`, `[K3]`, `[M1]`, `[Q1]`) stay resolvable: a marker
 *   whose id the answer cites is kept and the comment ends with a "Sources:" list of the
 *   cited sources it mentions ("[D1] Help Center · Failed logins"); a marker the answer
 *   does not cite is dropped, so a colleague never meets a dangling "[D1]".
 * - The thread keeps at most {@link CASE_COMMENT_MAX_CHARS} characters; a longer answer
 *   is cut at a line or word boundary and says so (the full answer stays in chat).
 * - Chart and table BLOCKS are not part of the comment (the dialog says so); a table
 *   written in the answer's Markdown is posted as rows of text.
 */
import type { ChatCitation } from '@/lib/types';
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
  /** How many cited sources the comment lists at its end. */
  sources: number;
}

/** A citation marker outside code (`[D1]`, not a `[D1](link)`), with the space before it. */
const CITE_MARKER_RE = /([ \t]*)\[([A-Z][0-9]{1,3})\](?!\()/g;

// Private-use sentinels that hold code spans and escaped characters while the inline
// markers are stripped (so `a_b` inside code, or an escaped `\*`, is never touched).
const HOLD_OPEN = '\uE000';
const HOLD_CLOSE = '\uE001';
const HOLD_RE = /\uE000(\d+)\uE001/g;

/**
 * One line's inline Markdown as plain text. `cited`: the citation ids the answer cites;
 * a marker of another id is dropped (it would dangle), `undefined` keeps every marker.
 */
function plainInline(line: string, cited?: ReadonlySet<string>): string {
  const held: string[] = [];
  const hold = (text: string) => `${HOLD_OPEN}${held.push(text) - 1}${HOLD_CLOSE}`;
  let out = line
    // Inline code (any run of backticks), kept verbatim.
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) => hold(code.trim()))
    // Backslash escapes: the character itself.
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_m, char: string) => hold(char));
  out = out
    // Images: their alt text; links: their text (and the address when it is absolute).
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g, (_m, text: string, href: string) =>
      /^[a-z][a-z0-9+.-]*:/i.test(href) && href !== text ? `${text} (${href})` : text,
    )
    // Citation markers: kept when the answer cites the id (the Sources list resolves it).
    .replace(CITE_MARKER_RE, (marker, _space: string, citeId: string) => (!cited || cited.has(citeId) ? marker : ''))
    // Emphasis and strikethrough markers (never inside words: `user_name` stays).
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?![\w_])/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  return out.replace(HOLD_RE, (_m, index: string) => held[Number(index)] ?? '');
}

/** A table separator row (`| --- | :-: |`): cells of dashes with optional colons, piped. */
const TABLE_RULE_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The cells of a table row (`| a | b |`), split on unescaped pipes. */
function tableCells(line: string, cited?: ReadonlySet<string>): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !/^\|/.test(trimmed)) return null;
  const cells = trimmed.replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/);
  return cells.map((cell) => plainInline(cell.trim(), cited));
}

/**
 * An answer's Markdown as plain text for a text-only surface (the case thread): the same
 * words, without the syntax. Fenced code keeps its lines verbatim (fences dropped).
 * `cited`: the ids of the answer's citations; a citation marker of any other id is
 * dropped (`undefined` keeps every marker).
 */
export function plainAnswerText(markdown: string, cited?: ReadonlySet<string>): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      else out.push(raw);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    // A thematic break is a blank line; a table's separator row is dropped.
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push('');
      continue;
    }
    if (raw.includes('|') && TABLE_RULE_RE.test(raw)) continue;
    const cells = tableCells(raw, cited);
    if (cells) {
      out.push(cells.join(' · '));
      continue;
    }
    let line = raw.replace(/^\s{0,3}(>\s?)+/, '');
    const heading = /^\s{0,3}#{1,6}\s+(.*?)(\s+#+)?\s*$/.exec(line);
    if (heading) {
      out.push(plainInline(heading[1], cited));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${plainInline(bullet[2], cited)}`);
      continue;
    }
    line = plainInline(line, cited);
    out.push(line.replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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

const CITATION_KIND_LABEL: Record<ChatCitation['kind'], string> = {
  doc: 'Help Center',
  case: 'Case',
  knowledge: 'Knowledge',
  mitre: 'ATT&CK',
  query: 'Query',
};

/** The longest source title a "Sources:" line carries. */
const SOURCE_TITLE_CHARS = 120;
/** The most room the "Sources:" list may take; further sources stay in chat. */
const SOURCES_MAX_CHARS = 2400;

/** "[C2] Case case-0042 · Suspicious login" (as the answer's Sources list names it). */
export function sourceLine(citation: Pick<ChatCitation, 'id' | 'kind' | 'title' | 'case_id' | 'technique'>): string {
  const target = citation.kind === 'case' ? citation.case_id : citation.kind === 'mitre' ? citation.technique : null;
  const title = cut(citation.title.replace(/\s+/g, ' ').trim(), SOURCE_TITLE_CHARS);
  return `[${citation.id}] ${CITATION_KIND_LABEL[citation.kind] ?? 'Source'}${target ? ` ${target}` : ''} · ${title}`;
}

/** The ids of the citation markers `text` keeps (in the order the citations list them). */
function mentioned(text: string, citations: readonly ChatCitation[]): ChatCitation[] {
  const ids = new Set(Array.from(text.matchAll(CITE_MARKER_RE), (match) => match[2]));
  const seen = new Set<string>();
  return citations.filter((citation) => ids.has(citation.id) && !seen.has(citation.id) && seen.add(citation.id));
}

/** "\n\nSources:\n[D1] …" for the sources `text` mentions; "" when none, bounded. */
function sourcesBlock(text: string, citations: readonly ChatCitation[]): { block: string; count: number } {
  const listed = mentioned(text, citations);
  if (!listed.length) return { block: '', count: 0 };
  const lines: string[] = [];
  let size = 0;
  for (const citation of listed) {
    const line = sourceLine(citation);
    if (size + line.length + 1 > SOURCES_MAX_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  const rest = listed.length - lines.length;
  const more = rest > 0 ? `\n${rest} more ${rest === 1 ? 'source is' : 'sources are'} listed in chat.` : '';
  return { block: `\n\nSources:\n${lines.join('\n')}${more}`, count: lines.length };
}

export function caseSnapshot(input: {
  question?: string | null;
  answer: string;
  at: number;
  /** The answer's citations (`ChatResponse.citations`): resolves its `[D1]` markers. */
  citations?: readonly ChatCitation[] | null;
}): CaseSnapshot {
  const header = [`From Workspace chat · ${snapshotTime(input.at)}`];
  const question = (input.question ?? '').replace(/\s+/g, ' ').trim();
  if (question) header.push(`Question: ${defangMentions(cut(question, 300))}`);
  const head = `${header.join('\n')}\n\n`;
  const citations = input.citations ?? [];
  const answer = defangMentions(plainAnswerText(input.answer, new Set(citations.map((citation) => citation.id))));
  const full = sourcesBlock(answer, citations);
  const sources = { ...full, block: defangMentions(full.block) };
  if (head.length + answer.length + sources.block.length <= CASE_COMMENT_MAX_CHARS) {
    return { body: head + answer + sources.block, shortened: false, sources: sources.count };
  }
  // Room for the cut answer, the "shortened" line and (at most) the full Sources list;
  // the list is then rebuilt for the markers the cut answer still carries.
  const room = CASE_COMMENT_MAX_CHARS - head.length - SNAPSHOT_SHORTENED.length - 2 - sources.block.length;
  const kept = cut(answer, Math.max(0, room));
  const cutSources = sourcesBlock(kept, citations);
  return {
    body: `${head}${kept}\n\n${SNAPSHOT_SHORTENED}${defangMentions(cutSources.block)}`,
    shortened: true,
    sources: cutSources.count,
  };
}

/** The line under the comment preview: what the comment leaves out, and why. */
export function snapshotNote(snapshot: Pick<CaseSnapshot, 'shortened' | 'sources'>): string {
  return [
    'Charts and table blocks stay in chat.',
    snapshot.sources ? 'Cited sources are listed at the end.' : '',
    'Mentions in the answer do not notify anyone.',
    snapshot.shortened ? 'The answer was shortened to fit the case thread.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
