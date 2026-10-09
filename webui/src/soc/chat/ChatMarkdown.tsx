/**
 * ChatMarkdown — the answer-prose renderer (BLOCKS.md amendment 5, SPEC §7.1 G1/G2/G7).
 *
 * Model prose is UNTRUSTED. It is parsed into a FIXED AST ({@link parseChatMarkdown})
 * and rendered as React nodes only — no HTML string, no `dangerouslySetInnerHTML`, no
 * attribute built from model text except one validated same-origin Help Center link:
 *
 *  - blocks: paragraphs (single line breaks kept), headings (rendered BELOW the
 *    message heading and rank-normalised per answer: the shallowest heading present
 *    becomes h4 under the hidden h3 by default, deeper ones follow without skipping a
 *    level), lists (nested by indentation), blockquotes, rules, fenced code (through
 *    `CodeBlock`), GFM tables;
 *  - inline: bold, italic, strikethrough, inline code, line breaks;
 *  - links: kept ONLY when the target matches `/docs/<major.minor>/…` (BLOCKS.md
 *    amendment 5). In-app navigation never comes from model text (it comes from
 *    `console_links` ids), so `/cases`, `#/settings`, `app:…`, `javascript:` and every
 *    other target stay literal text;
 *  - an external URL (a link target or bare in prose) renders DEFANGED
 *    (`hxxps://evil[.]example/…`) with a copy button — never as a link;
 *  - images, raw HTML, autolinks and reference links render as literal text;
 *  - invisible, bidi and control characters are stripped first (`displayText`).
 *
 * The AST is exported so the report exporters serialise the same sanitised tree.
 * Rendering is memoised per top-level block, so a streaming answer re-renders only
 * its growing last block.
 */
import * as React from 'react';
import { Check, Copy } from 'lucide-react';

import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { defangUrl, isDocLink, splitBareUrls } from './display';
import { displayText } from './stream-events';

/* -------------------------------------------------------------------------- */
/* AST.                                                                        */
/* -------------------------------------------------------------------------- */

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: MdInline[] }
  /** A validated same-origin Help Center link (the only link a model may write). */
  | { t: 'doc'; href: string; c: MdInline[] }
  /** An external URL: shown defanged with a copy button, never linked. */
  | { t: 'url'; url: string; defanged: string }
  /** A citation marker such as `[D1]`; the host decides whether it is interactive. */
  | { t: 'cite'; id: string }
  | { t: 'br' };

export type MdAlign = 'left' | 'center' | 'right' | null;

export interface MdListItem {
  blocks: MdBlock[];
}

/**
 * One top-level (or nested) block. `source` is its exact text, the memo key.
 *
 * A heading keeps its Markdown `level` (1–6, for a Markdown round trip) and carries its
 * outline `rank` within the whole answer (1 = the shallowest heading present; a rank
 * never exceeds the previous heading's rank + 1). Renderers and exporters nest by
 * `rank`, so an answer that starts at `##` never skips a heading level.
 */
export type MdBlock =
  | { type: 'heading'; level: number; rank: number; inline: MdInline[]; source: string }
  | { type: 'paragraph'; inline: MdInline[]; source: string }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[]; source: string }
  | { type: 'blockquote'; blocks: MdBlock[]; source: string }
  | { type: 'rule'; source: string }
  | { type: 'code'; lang: string | null; code: string; source: string }
  | { type: 'table'; align: MdAlign[]; header: MdInline[][]; rows: MdInline[][][]; source: string };

/* -------------------------------------------------------------------------- */
/* Bounds.                                                                     */
/* -------------------------------------------------------------------------- */

/** Longest prose parsed (characters); the rest is dropped with an ellipsis. */
export const MAX_MARKDOWN_CHARS = 50_000;
const MAX_BLOCK_DEPTH = 4;
const MAX_INLINE_DEPTH = 6;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 200;
const MAX_LINK_LABEL = 300;
const MAX_LINK_TARGET = 1000;

/* -------------------------------------------------------------------------- */
/* Block parser.                                                               */
/* -------------------------------------------------------------------------- */

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}>[ ]?(.*)$/;
const LIST_RE = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const DELIM_CELL_RE = /^\s*:?-+:?\s*$/;
const LANG_RE = /^[A-Za-z0-9_+.#-]{1,20}$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Split a table row on unescaped pipes, dropping the optional outer pipes. */
function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (ch === '\\' && row[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function delimiterAligns(line: string): MdAlign[] | null {
  if (!line.includes('-')) return null;
  const cells = splitRow(line);
  if (!cells.length || !cells.every((c) => DELIM_CELL_RE.test(c))) return null;
  return cells.map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
}

function isTableStart(lines: string[], i: number): boolean {
  if (!lines[i]?.includes('|') || i + 1 >= lines.length) return false;
  const aligns = delimiterAligns(lines[i + 1]);
  return aligns !== null && aligns.length === splitRow(lines[i]).length;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    RULE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    isTableStart(lines, i)
  );
}

function listMarker(match: RegExpExecArray): { ordered: boolean; kind: string } {
  const marker = match[2];
  const ordered = /\d/.test(marker[0]);
  return { ordered, kind: ordered ? marker.slice(-1) : marker };
}

function parseList(lines: string[], start: number, depth: number): { block: MdBlock; next: number } {
  const first = LIST_RE.exec(lines[start]) as RegExpExecArray;
  const { ordered, kind } = listMarker(first);
  const baseIndent = first[1].length;
  // Forgiving nesting: anything indented two or more columns past the marker column
  // belongs to the item (models nest with 2 or 3 spaces under "1." alike).
  const contentIndent = baseIndent + 2;
  const startNumber = ordered ? Math.min(Number.parseInt(first[2], 10) || 1, 1_000_000) : 1;
  const items: MdListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_RE.exec(lines[i]);
    if (!match || match[1].length >= contentIndent) break;
    const marker = listMarker(match);
    if (marker.ordered !== ordered || marker.kind !== kind) break;
    const itemLines = [match[3] ?? ''];
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let k = i + 1;
        while (k < lines.length && !lines[k].trim()) k += 1;
        if (k < lines.length && indentOf(lines[k]) >= contentIndent) {
          itemLines.push('');
          i += 1;
          continue;
        }
        break;
      }
      const indent = indentOf(line);
      if (indent >= contentIndent) {
        itemLines.push(line.slice(contentIndent));
        i += 1;
        continue;
      }
      if (startsBlock(lines, i)) break;
      // A lazy continuation line of the item's paragraph.
      itemLines.push(line.trim());
      i += 1;
    }
    items.push({
      blocks:
        depth < MAX_BLOCK_DEPTH
          ? parseBlockLines(itemLines, depth + 1)
          : [{ type: 'paragraph', inline: parseInline(itemLines.join(' ').trim()), source: itemLines.join('\n') }],
    });
    // Blank lines between two items of the same list keep the list going.
    let k = i;
    while (k < lines.length && !lines[k].trim()) k += 1;
    if (k > i && k < lines.length) {
      const next = LIST_RE.exec(lines[k]);
      if (next && next[1].length < contentIndent) {
        const nextMarker = listMarker(next);
        if (nextMarker.ordered === ordered && nextMarker.kind === kind) {
          i = k;
          continue;
        }
      }
      break;
    }
  }
  return {
    block: { type: 'list', ordered, start: startNumber, items, source: lines.slice(start, i).join('\n') },
    next: i,
  };
}

function parseBlockLines(lines: string[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const marker = fence[2];
      const closer = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j += 1) {
        if (closer.test(lines[j])) {
          closed = true;
          break;
        }
        const raw = lines[j];
        body.push(raw.slice(Math.min(indent, indentOf(raw))));
      }
      const info = fence[3].trim().split(/\s+/)[0] ?? '';
      // An unterminated fence (a streaming answer) still renders as code so far.
      blocks.push({
        type: 'code',
        lang: LANG_RE.test(info) ? info : null,
        code: body.join('\n'),
        source: lines.slice(i, closed ? j + 1 : j).join('\n'),
      });
      i = closed ? j + 1 : j;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      // `rank` is assigned over the whole answer once parsing is done (rankHeadings).
      blocks.push({ type: 'heading', level: heading[1].length, rank: 1, inline: parseInline(heading[2]), source: line });
      i += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ type: 'rule', source: line });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      let j = i;
      for (; j < lines.length; j += 1) {
        const quoted = QUOTE_RE.exec(lines[j]);
        if (!quoted) break;
        inner.push(quoted[1]);
      }
      blocks.push({
        type: 'blockquote',
        blocks:
          depth < MAX_BLOCK_DEPTH
            ? parseBlockLines(inner, depth + 1)
            : [{ type: 'paragraph', inline: parseInline(inner.join('\n')), source: inner.join('\n') }],
        source: lines.slice(i, j).join('\n'),
      });
      i = j;
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(line).slice(0, MAX_TABLE_COLUMNS);
      const aligns = (delimiterAligns(lines[i + 1]) as MdAlign[]).slice(0, header.length);
      const rows: MdInline[][][] = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].trim() && lines[j].includes('|'); j += 1) {
        if (rows.length >= MAX_TABLE_ROWS) continue;
        const cells = splitRow(lines[j]);
        rows.push(header.map((_, c) => parseInline(cells[c] ?? '')));
      }
      blocks.push({
        type: 'table',
        align: aligns,
        header: header.map((cell) => parseInline(cell)),
        rows,
        source: lines.slice(i, j).join('\n'),
      });
      i = j;
      continue;
    }

    if (LIST_RE.test(line)) {
      const { block, next } = parseList(lines, i, depth);
      blocks.push(block);
      i = next;
      continue;
    }

    const para: string[] = [line.trim()];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      if (!lines[j].trim() || startsBlock(lines, j)) break;
      para.push(lines[j].trim());
    }
    blocks.push({ type: 'paragraph', inline: parseInline(para.join('\n')), source: lines.slice(i, j).join('\n') });
    i = j;
  }
  return blocks;
}

type MdHeading = Extract<MdBlock, { type: 'heading' }>;

/**
 * Rank-normalise the answer's headings in document order (nested ones included).
 * Models usually start at `##`; a fixed offset would jump from the message h3 to an
 * h5 (axe `heading-order`). Instead the distinct Markdown levels present are ranked
 * (shallowest = 1) and each rank is capped at the previous heading's rank + 1, so the
 * real nesting is kept and no level is ever skipped.
 */
function rankHeadings(blocks: MdBlock[]): void {
  const headings: MdHeading[] = [];
  const walk = (list: MdBlock[]) => {
    for (const block of list) {
      if (block.type === 'heading') headings.push(block);
      else if (block.type === 'blockquote') walk(block.blocks);
      else if (block.type === 'list') for (const item of block.items) walk(item.blocks);
    }
  };
  walk(blocks);
  const levels = Array.from(new Set(headings.map((heading) => heading.level))).sort((a, b) => a - b);
  let previous = 0;
  for (const heading of headings) {
    heading.rank = Math.min(levels.indexOf(heading.level) + 1, previous + 1);
    previous = heading.rank;
  }
}

/**
 * Parse answer prose into the fixed AST. Never throws. Invisible, bidi and control
 * characters are stripped first; tabs become four spaces; input past
 * {@link MAX_MARKDOWN_CHARS} is cut. Headings carry their outline `rank`.
 */
export function parseChatMarkdown(input: unknown): MdBlock[] {
  let text = displayText(typeof input === 'string' ? input : '', 0, { multiline: true });
  if (text.length > MAX_MARKDOWN_CHARS) text = `${text.slice(0, MAX_MARKDOWN_CHARS)}…`;
  if (!text.trim()) return [];
  try {
    const blocks = parseBlockLines(text.replace(/\t/g, '    ').split('\n'), 0);
    rankHeadings(blocks);
    return blocks;
  } catch {
    // Defensive: a parser bug must never blank an answer. Fall back to plain text.
    return [{ type: 'paragraph', inline: [{ t: 'text', v: text }], source: text }];
  }
}

/* -------------------------------------------------------------------------- */
/* Inline parser.                                                              */
/* -------------------------------------------------------------------------- */

const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/;
const URL_AT_RE = /(?:https?|ftps?|wss?):\/\/[^\s<>"'`]+/iy;
const URL_TRAILING_RE = /[.,;:!?)\]}'"]+$/;
const CITE_AT_RE = /\[([A-Z][0-9]{1,3})\](?!\()/y;
const ALNUM_RE = /[\p{L}\p{N}]/u;

/** Push plain text, splitting bare URLs out as defanged `url` nodes. */
function pushText(out: MdInline[], text: string): void {
  if (!text) return;
  for (const segment of splitBareUrls(text)) {
    if (segment.kind === 'url') {
      out.push({ t: 'url', url: segment.url, defanged: segment.defanged });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.t === 'text') last.v += segment.text;
    else out.push({ t: 'text', v: segment.text });
  }
}

/** `[label](target "title")` starting at `s[i] === '['`; null when malformed. */
function matchLink(s: string, i: number): { label: string; target: string; end: number } | null {
  let depth = 0;
  let j = i;
  const labelLimit = Math.min(s.length, i + MAX_LINK_LABEL);
  for (; j < labelLimit; j += 1) {
    const ch = s[j];
    if (ch === '\\') {
      j += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || s[j] !== ']' || s[j + 1] !== '(') return null;
  const label = s.slice(i + 1, j);
  let k = j + 2;
  let parens = 0;
  const targetLimit = Math.min(s.length, k + MAX_LINK_TARGET);
  for (; k < targetLimit; k += 1) {
    const ch = s[k];
    if (ch === '\n') return null;
    if (ch === '(') parens += 1;
    else if (ch === ')') {
      if (parens === 0) break;
      parens -= 1;
    }
  }
  if (s[k] !== ')') return null;
  // Drop an optional quoted title; only the destination matters.
  const target = s
    .slice(j + 2, k)
    .trim()
    .replace(/\s+(?:"[^"]*"|'[^']*')$/, '')
    .replace(/^<(.*)>$/, '$1');
  return { label, target, end: k + 1 };
}

interface InlineState {
  /** Delimiter runs already known to have no closer to the end of the text. */
  unclosed: Set<string>;
}

function findCloser(s: string, delim: string, from: number): number {
  const single = delim.length === 1;
  const ch = delim[0];
  let k = s.indexOf(delim, from);
  while (k >= 0) {
    const before = s[k - 1];
    const after = s[k + delim.length];
    const okBefore = before !== undefined && !/\s/.test(before);
    const okRun = !single || (before !== ch && after !== ch);
    const okWord = ch !== '_' || after === undefined || !ALNUM_RE.test(after);
    if (k > from && okBefore && okRun && okWord) return k;
    k = s.indexOf(delim, k + 1);
  }
  return -1;
}

function parseInlineInner(s: string, depth: number, state: InlineState): MdInline[] {
  const out: MdInline[] = [];
  let buf = '';
  const flush = () => {
    pushText(out, buf);
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    if (ch === '\\' && i + 1 < s.length && ASCII_PUNCT_RE.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i += 1;
      continue;
    }

    // A bare URL is consumed whole so emphasis/code markers inside it stay literal. It
    // is recognised even glued to a word (`foohttps://…`): the word stays text and the
    // URL is still defanged (BLOCKS.md amendment 5), whatever injected prose does.
    if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'w' || ch === 'W') {
      URL_AT_RE.lastIndex = i;
      const match = URL_AT_RE.exec(s);
      if (match) {
        const url = match[0].replace(URL_TRAILING_RE, '');
        if (url.length > url.indexOf('://') + 3) {
          flush();
          out.push({ t: 'url', url, defanged: defangUrl(url) });
          i += url.length;
          continue;
        }
      }
    }

    if (ch === '`') {
      let n = 1;
      while (s[i + n] === '`') n += 1;
      const fence = '`'.repeat(n);
      let close = -1;
      if (!state.unclosed.has(fence)) {
        let j = i + n;
        while (j < s.length) {
          if (s[j] === '`') {
            let m = 1;
            while (s[j + m] === '`') m += 1;
            if (m === n) {
              close = j;
              break;
            }
            j += m;
          } else {
            j += 1;
          }
        }
        if (close < 0) state.unclosed.add(fence);
      }
      if (close < 0) {
        buf += fence;
        i += n;
        continue;
      }
      let code = s.slice(i + n, close).replace(/\n/g, ' ');
      if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      flush();
      out.push({ t: 'code', v: code });
      i = close + n;
      continue;
    }

    if (ch === '!' && s[i + 1] === '[') {
      // Images are never rendered: the whole source stays literal text (URLs defanged).
      const link = matchLink(s, i + 1);
      if (link) {
        buf += s.slice(i, link.end);
        i = link.end;
        continue;
      }
    }

    if (ch === '[') {
      const link = matchLink(s, i);
      if (link) {
        const label = link.label.trim();
        if (isDocLink(link.target)) {
          flush();
          out.push({
            t: 'doc',
            href: link.target,
            c: depth < MAX_INLINE_DEPTH ? parseInlineInner(label, depth + 1, state) : [{ t: 'text', v: label }],
          });
        } else if (/^(?:https?|ftps?|wss?):\/\/\S+$/i.test(link.target)) {
          flush();
          if (label && label !== link.target) {
            const inner = depth < MAX_INLINE_DEPTH ? parseInlineInner(label, depth + 1, state) : [{ t: 'text' as const, v: label }];
            out.push(...inner, { t: 'text', v: ' ' });
          }
          out.push({ t: 'url', url: link.target, defanged: defangUrl(link.target) });
        } else {
          // An in-app path, a script URL or anything else: literal text, never a link.
          buf += s.slice(i, link.end);
        }
        i = link.end;
        continue;
      }
      CITE_AT_RE.lastIndex = i;
      const cite = CITE_AT_RE.exec(s);
      if (cite) {
        flush();
        out.push({ t: 'cite', id: cite[1] });
        i += cite[0].length;
        continue;
      }
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 1;
      while (s[i + run] === ch) run += 1;
      const delim = ch === '~' ? (run >= 2 ? '~~' : '') : ch.repeat(Math.min(run, 3));
      const opensWord = ch !== '_' || !ALNUM_RE.test(s[i - 1] ?? ' ');
      const next = s[i + (delim.length || 1)];
      if (delim && opensWord && next !== undefined && !/\s/.test(next) && depth < MAX_INLINE_DEPTH && !state.unclosed.has(delim)) {
        const close = findCloser(s, delim, i + delim.length);
        if (close > i + delim.length) {
          flush();
          const inner = parseInlineInner(s.slice(i + delim.length, close), depth + 1, state);
          if (delim === '~~') out.push({ t: 'del', c: inner });
          else if (delim.length === 3) out.push({ t: 'strong', c: [{ t: 'em', c: inner }] });
          else out.push({ t: delim.length === 2 ? 'strong' : 'em', c: inner });
          i = close + delim.length;
          continue;
        }
        if (close < 0) state.unclosed.add(delim);
      }
      buf += s.slice(i, i + run);
      i += run;
      continue;
    }

    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Parse one run of inline Markdown (exported for the report exporters and tests). */
export function parseInline(text: string): MdInline[] {
  return parseInlineInner(text, 0, { unclosed: new Set() });
}

/* -------------------------------------------------------------------------- */
/* Rendering.                                                                  */
/* -------------------------------------------------------------------------- */

interface RenderContext {
  /** The level of the heading this prose sits under (the message's hidden h3). */
  headingBase: number;
  citationIds: ReadonlySet<string> | null;
  onCitation: ((id: string) => void) | null;
}

/** A defanged external URL plus a copy button (copies the DEFANGED text). */
function DefangedUrl({ defanged }: { defanged: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onCopy = () => {
    // copyText works over plain HTTP too; claim success only when it happened.
    void copyText(defanged).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <span className="inline-flex max-w-full items-baseline gap-0.5 align-baseline" data-chat-url="">
      <code className="break-all rounded-sm bg-muted px-1 font-mono text-xs text-foreground">{defanged}</code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Copied defanged link' : 'Copy defanged link'}
        title="External link, defanged. Copy it to inspect it safely."
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center self-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
      </button>
    </span>
  );
}

/** Inline code up to this length stays on one line (identifiers, hosts, case ids). */
const INLINE_CODE_NOWRAP_CHARS = 32;

/**
 * Inline nodes → React. Inside a docs link (`inLink`) nothing interactive is nested
 * (an `<a>` may not contain a button or another link): URLs stay defanged text,
 * citations literal, a nested docs link plain text.
 */
function renderInline(nodes: MdInline[], ctx: RenderContext, key = 'i', inLink = false): React.ReactNode[] {
  return nodes.map((node, index) => {
    const k = `${key}.${index}`;
    switch (node.t) {
      case 'text':
        return <React.Fragment key={k}>{node.v}</React.Fragment>;
      case 'br':
        return <br key={k} />;
      case 'code':
        return (
          <code
            key={k}
            className={cn(
              'rounded-sm border border-border bg-muted px-1 py-0.5 font-mono text-xs text-foreground [box-decoration-break:clone]',
              // A short identifier (a case id, a host) never splits at its hyphen across
              // lines; a long one may wrap anywhere rather than overflow the lane.
              node.v.length <= INLINE_CODE_NOWRAP_CHARS ? 'whitespace-nowrap' : '[overflow-wrap:anywhere]',
            )}
          >
            {node.v}
          </code>
        );
      case 'strong':
        return (
          <strong key={k} className="font-semibold text-foreground">
            {renderInline(node.c, ctx, k, inLink)}
          </strong>
        );
      case 'em':
        return <em key={k}>{renderInline(node.c, ctx, k, inLink)}</em>;
      case 'del':
        return <del key={k}>{renderInline(node.c, ctx, k, inLink)}</del>;
      case 'doc':
        // A docs link written inside another one's label: its text only (an <a> may
        // not contain an <a>).
        if (inLink) return <React.Fragment key={k}>{renderInline(node.c, ctx, k, true)}</React.Fragment>;
        return (
          <a
            key={k}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-2 hover:no-underline"
          >
            {renderInline(node.c, ctx, k, true)}
          </a>
        );
      case 'url':
        return inLink ? <React.Fragment key={k}>{node.defanged}</React.Fragment> : <DefangedUrl key={k} defanged={node.defanged} />;
      case 'cite':
        if (!inLink && ctx.onCitation && ctx.citationIds?.has(node.id)) {
          const onCitation = ctx.onCitation;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onCitation(node.id)}
              aria-label={`Source ${node.id}`}
              className="mx-0.5 inline-flex items-center rounded-sm bg-muted px-1 align-baseline font-mono text-2xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {node.id}
            </button>
          );
        }
        return <React.Fragment key={k}>{`[${node.id}]`}</React.Fragment>;
      default:
        return null;
    }
  });
}

/** Heading style by outline rank (1, 2, 3+), whatever the host level. */
const HEADING_CLASS: Record<number, string> = {
  1: 'text-base font-semibold text-foreground',
  2: 'text-sm font-semibold text-foreground',
  3: 'text-sm font-medium text-foreground',
};
const ALIGN_CLASS: Record<'left' | 'center' | 'right', string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

function BlockView({ block, ctx }: { block: MdBlock; ctx: RenderContext }): React.ReactElement | null {
  switch (block.type) {
    case 'heading': {
      // Rank 1 sits one level below the host heading; deeper ranks follow, capped at h6.
      const rank = Number.isInteger(block.rank) && block.rank > 0 ? block.rank : 1;
      const Tag = `h${Math.min(6, ctx.headingBase + rank)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag className={cn('mt-3 first:mt-0', HEADING_CLASS[Math.min(3, rank)])}>{renderInline(block.inline, ctx)}</Tag>;
    }
    case 'paragraph':
      return <p className="leading-relaxed">{renderInline(block.inline, ctx)}</p>;
    case 'rule':
      return <hr className="my-3 border-border" />;
    case 'code':
      return <CodeBlock value={block.code} caption={block.lang ?? undefined} wrap />;
    case 'blockquote':
      return (
        <blockquote className="space-y-2 border-l-2 border-border pl-3 text-muted-foreground">
          {block.blocks.map((child, index) => (
            <BlockView key={index} block={child} ctx={ctx} />
          ))}
        </blockquote>
      );
    case 'list': {
      const items = block.items.map((item, index) => {
        const only = item.blocks.length === 1 ? item.blocks[0] : null;
        return (
          <li key={index} className="pl-0.5">
            {only?.type === 'paragraph' ? (
              renderInline(only.inline, ctx)
            ) : (
              <div className="space-y-1.5">
                {item.blocks.map((child, childIndex) => (
                  <BlockView key={childIndex} block={child} ctx={ctx} />
                ))}
              </div>
            )}
          </li>
        );
      });
      return block.ordered ? (
        <ol start={block.start} className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">
          {items}
        </ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">{items}</ul>
      );
    }
    case 'table':
      return (
        <div className="max-w-full overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface">
                {block.header.map((cell, index) => (
                  <th
                    key={index}
                    scope="col"
                    className={cn(
                      'whitespace-nowrap px-3 py-2 text-xs font-semibold text-muted-foreground',
                      ALIGN_CLASS[block.align[index] ?? 'left'],
                    )}
                  >
                    {renderInline(cell, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-border/60 last:border-0">
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      className={cn('px-3 py-1.5 align-top text-foreground', ALIGN_CLASS[block.align[index] ?? 'left'])}
                    >
                      {renderInline(cell, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

/** The heading ranks inside a block: a later, shallower heading can re-rank earlier ones. */
function rankKey(block: MdBlock): string {
  if (block.type === 'heading') return String(block.rank);
  if (block.type === 'blockquote') return block.blocks.map(rankKey).join(',');
  if (block.type === 'list') return block.items.map((item) => item.blocks.map(rankKey).join(',')).join(';');
  return '';
}

/**
 * Re-render a top-level block only when its source text, its heading ranks (or the
 * context) changed.
 */
const MemoBlock = React.memo(
  BlockView,
  (prev, next) =>
    prev.block.source === next.block.source &&
    prev.block.type === next.block.type &&
    prev.ctx === next.ctx &&
    rankKey(prev.block) === rankKey(next.block),
);

export interface ChatMarkdownProps {
  /** The prose (untrusted). */
  text: string;
  /**
   * The level of the heading this prose sits under. Default 3 (the message's hidden
   * `<h3>`), so the answer's shallowest heading renders as `<h4>`; never deeper than
   * `<h6>`.
   */
  headingBase?: number;
  /** Citation ids that exist on this answer; only these markers become buttons. */
  citationIds?: ReadonlySet<string> | null;
  /** Called with a citation id when its marker is activated (e.g. open Sources). */
  onCitation?: ((id: string) => void) | null;
  className?: string;
}

/** Render answer prose under the Markdown subset rules. Memoised per block. */
export const ChatMarkdown = React.memo(function ChatMarkdown({
  text,
  headingBase = 3,
  citationIds = null,
  onCitation = null,
  className,
}: ChatMarkdownProps) {
  const blocks = React.useMemo(() => parseChatMarkdown(text), [text]);
  const base = Number.isInteger(headingBase) ? Math.min(5, Math.max(1, headingBase)) : 3;
  const ctx = React.useMemo<RenderContext>(
    () => ({ headingBase: base, citationIds, onCitation }),
    [base, citationIds, onCitation],
  );
  if (!blocks.length) return null;
  return (
    <div className={cn('min-w-0 space-y-2 break-words text-md text-foreground', className)} data-chat-markdown="">
      {blocks.map((block, index) => (
        <MemoBlock key={index} block={block} ctx={ctx} />
      ))}
    </div>
  );
});

export default ChatMarkdown;
