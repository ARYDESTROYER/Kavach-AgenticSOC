/**
 * Markdown export (chat revamp SPEC §9.3, BLOCKS.md §7.2): a deterministic, pure string
 * serialiser over the walker's document nodes and the sanitised answer AST.
 *
 * Injection rules — the output is read in viewers that render inline HTML and autolink:
 *   - text escapes Markdown syntax (`\ * _ [ ] ( ) ! | ~ #`) and HTML-significant
 *     characters (`< > &` become entities), so untrusted text can never become a link,
 *     an image, an emphasis run or a tag;
 *   - untrusted values go in code spans with a fence-safe backtick count;
 *   - external URLs from data are never links: they are code spans holding the URL or
 *     its defanged form (per the toggle), so no viewer autolinks them;
 *   - the only link written is an ATT&CK technique page constructed from a validated id;
 *   - headings nest by the AST heading `rank`, never by the model's raw level.
 */
import type { MdBlock, MdInline } from '../../ChatMarkdown';
import type { ReportDoc } from '../model';
import { documentNodes, type DocNode, type Line, type WalkOptions } from './walker';

/* -------------------------------------------------------------------------- */
/* Escaping.                                                                   */
/* -------------------------------------------------------------------------- */

/** Escape plain text for a Markdown paragraph (inline position). */
export function mdText(text: string): string {
  return text
    .replace(/[\\`*_[\]()!|~#]/g, '\\$&')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ');
}

/** Escape a line start that would otherwise read as a list, quote or heading marker. */
function guardLineStart(text: string): string {
  return text.replace(/^(\s*)([-+]|\d+[.)])(\s)/, (_m, sp: string, marker: string, after: string) =>
    `${sp}${marker.replace(/([-+.)])/g, '\\$1')}${after}`,
  );
}

/** A code span that cannot be broken by backticks inside it (CommonMark §6.1). */
export function mdCode(text: string, inTable = false): string {
  const flat = text.replace(/\r?\n/g, ' ');
  const longest = Math.max(0, ...Array.from(flat.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') || flat === '' ? ' ' : '';
  // A GFM table splits a row on `|` even inside a code span, so escape it there.
  const body = inTable ? flat.replace(/\|/g, '\\|') : flat;
  return `${fence}${pad}${body}${pad}${fence}`;
}

function runs(line: Line, inTable = false): string {
  return line
    .map((r) => {
      if (!r.text) return '';
      if (r.code) return mdCode(r.text, inTable);
      const t = mdText(r.text);
      return r.strong ? `**${t}**` : t;
    })
    .join('');
}

/* -------------------------------------------------------------------------- */
/* The answer AST.                                                             */
/* -------------------------------------------------------------------------- */

interface MdContext {
  base: number;
  defang: boolean;
}

function inline(nodes: readonly MdInline[], ctx: MdContext, inTable = false): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case 'text':
          return mdText(node.v);
        case 'code':
          return mdCode(node.v, inTable);
        case 'strong':
          return `**${inline(node.c, ctx, inTable)}**`;
        case 'em':
          return `*${inline(node.c, ctx, inTable)}*`;
        case 'del':
          return `~~${inline(node.c, ctx, inTable)}~~`;
        case 'doc':
          // A same-origin Help Center path does not resolve from a downloaded file.
          return `${inline(node.c, ctx, inTable)} (Help Center ${mdCode(node.href, inTable)})`;
        case 'url':
          return mdCode(ctx.defang ? node.defanged : node.url, inTable);
        case 'cite':
          return `\\[${node.id}\\]`;
        case 'br':
          return inTable ? ' ' : '\\\n';
        default:
          return '';
      }
    })
    .join('');
}

const headingLevel = (ctx: MdContext, rank: number): number =>
  Math.max(1, Math.min(6, ctx.base + (Number.isInteger(rank) && rank > 0 ? rank : 1) - 1));

function fenceFor(code: string): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
  return '`'.repeat(longest + 1);
}

const LANG_RE = /^[A-Za-z0-9_+.#-]{1,20}$/;

function mdBlock(block: MdBlock, ctx: MdContext): string {
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(headingLevel(ctx, block.rank))} ${inline(block.inline, ctx)}`;
    case 'paragraph':
      return guardLineStart(inline(block.inline, ctx));
    case 'rule':
      return '---';
    case 'code': {
      const fence = fenceFor(block.code);
      const lang = block.lang && LANG_RE.test(block.lang) ? block.lang : '';
      return `${fence}${lang}\n${block.code}\n${fence}`;
    }
    case 'blockquote':
      return mdBlocks(block.blocks, ctx)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'list':
      return block.items
        .map((item, i) => {
          const marker = block.ordered ? `${block.start + i}.` : '-';
          const body = mdBlocks(item.blocks, ctx);
          const indent = ' '.repeat(marker.length + 1);
          return body
            .split('\n')
            .map((l, li) => (li === 0 ? `${marker} ${l}` : l ? `${indent}${l}` : ''))
            .join('\n');
        })
        .join('\n');
    case 'table': {
      const sep = block.align.map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'));
      const row = (cells: MdInline[][]) => `| ${block.header.map((_, i) => inline(cells[i] ?? [], ctx, true) || ' ').join(' | ')} |`;
      return [row(block.header), `| ${sep.join(' | ')} |`, ...block.rows.map(row)].join('\n');
    }
    default:
      return '';
  }
}

function mdBlocks(blocks: readonly MdBlock[], ctx: MdContext): string {
  return blocks.map((b) => mdBlock(b, ctx)).filter(Boolean).join('\n\n');
}

/** Serialise sanitised answer prose; rank-1 headings render at `base`. */
export function markdownFromAst(blocks: readonly MdBlock[], base = 3, defang = true): string {
  return mdBlocks(blocks, { base, defang });
}

/* -------------------------------------------------------------------------- */
/* Document nodes.                                                             */
/* -------------------------------------------------------------------------- */

function cell(text: string, code: boolean): string {
  if (code && text !== '—') return mdCode(text, true);
  return mdText(text) || ' ';
}

function node(n: DocNode): string {
  switch (n.k) {
    case 'heading':
      return `${'#'.repeat(n.level)} ${mdText(n.text)}`;
    case 'meta':
      return `_${guardLineStart(mdText(n.text))}_`;
    case 'para': {
      const text = guardLineStart(runs(n.line));
      return n.muted ? `_${text}_` : text;
    }
    case 'md':
      return markdownFromAst(n.blocks, n.base, n.defang);
    case 'table': {
      const head = `| ${n.head.map((h) => mdText(h) || ' ').join(' | ')} |`;
      const sep = `| ${n.head.map((_, i) => (n.numeric[i] ? '---:' : '---')).join(' | ')} |`;
      const rows = n.rows.map((r, ri) => `| ${r.map((c, i) => cell(c, n.cellCode?.[ri]?.[i] ?? n.code[i] ?? false)).join(' | ')} |`);
      return [head, sep, ...rows].join('\n');
    }
    case 'list':
      return n.items.map((line, i) => `${n.ordered ? `${i + 1}.` : '-'} ${runs(line)}`).join('\n');
    case 'code': {
      const fence = fenceFor(n.text);
      const lang = n.lang && LANG_RE.test(n.lang) ? n.lang : '';
      const caption = n.caption ? `_${mdText(n.caption)}_\n\n` : '';
      return `${caption}${fence}${lang}\n${n.text}\n${fence}`;
    }
    case 'callout': {
      // Keep the note's own line breaks (hard breaks inside one quote).
      const lines = n.text.split(/\r?\n/).map((l) => mdText(l));
      return `> **${mdText(n.label)}:** ${lines.join('\\\n> ')}`;
    }
    case 'attack':
      return n.items
        .map((t) => {
          const id = t.url ? `[${t.id}](${t.url})` : mdText(t.id);
          return `- ${id}${t.label ? ` ${mdText(t.label)}` : ''}`;
        })
        .join('\n');
    case 'rule':
      return '---';
    default:
      return '';
  }
}

/** Serialise document nodes to Markdown. */
export function nodesToMarkdown(nodes: readonly DocNode[]): string {
  return `${nodes.map(node).filter(Boolean).join('\n\n')}\n`;
}

/** The whole document as Markdown (defanged by default). */
export function reportToMarkdown(doc: ReportDoc, options: WalkOptions = {}): string {
  return nodesToMarkdown(documentNodes(doc, options));
}
