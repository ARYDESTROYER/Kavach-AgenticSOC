/**
 * HTML export (chat revamp SPEC §9.3, BLOCKS.md §7.3 + amendment 8): a static,
 * scriptless, self-contained file produced by a deterministic STRING serialiser over the
 * walker's document nodes — no `react-dom/server` (it would land in the eager
 * `react-vendor` chunk), no scripts, no network.
 *
 * Defence in depth:
 *   - every text is HTML-escaped (`& < > " '`); attributes carry only enum class names
 *     and the one constructed ATT&CK URL — never a string from data;
 *   - model prose comes from the sanitised AST, so a model-written image, link or tag
 *     is literal text; external URLs from data are `<code>` text, never `<a>`;
 *   - the file pins `Content-Security-Policy: default-src 'none'; style-src
 *     'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`, so even if
 *     something slipped through it could run no script and make no request;
 *   - colours are the inline light-theme tokens (`report-tokens.ts`).
 */
import type { MdBlock, MdInline } from '../../ChatMarkdown';
import type { ReportDoc } from '../model';
import { tokenDeclarations } from './report-tokens';
import { documentNodes, type DocNode, type Line, type WalkOptions } from './walker';

/** The exact CSP of BLOCKS.md amendment 8. */
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/** Escape text for HTML element content and attribute values. */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A small dedicated stylesheet (plain classes, no Tailwind): ~3 kB. */
export const REPORT_CSS = `
*{box-sizing:border-box}
body.report{margin:0;background:hsl(var(--background));color:hsl(var(--foreground));font:14px/1.55 'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
.doc{max-width:56rem;margin:0 auto;padding:32px 24px 48px}
h1{font-size:24px;line-height:1.25;margin:0 0 6px}
h2{font-size:18px;margin:28px 0 8px;padding-top:12px;border-top:1px solid hsl(var(--border))}
h3{font-size:15px;margin:20px 0 6px}
h4,h5,h6{font-size:14px;margin:14px 0 4px}
p{margin:6px 0}
.meta{color:hsl(var(--muted-foreground));font-size:12px;margin:2px 0 8px}
.muted{color:hsl(var(--muted-foreground))}
code,pre{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
code{background:hsl(var(--muted));padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
pre{background:hsl(var(--surface-sunken));border:1px solid hsl(var(--border));border-radius:6px;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
pre code{background:none;padding:0}
.caption{color:hsl(var(--muted-foreground));font-size:12px;margin:8px 0 2px}
table{border-collapse:collapse;width:100%;margin:6px 0 10px;font-size:13px}
th,td{border-bottom:1px solid hsl(var(--border));padding:4px 8px;text-align:left;vertical-align:top}
th{color:hsl(var(--muted-foreground));font-weight:600;font-size:12px;background:hsl(var(--surface))}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.c,th.c{text-align:center}
ul,ol{margin:6px 0;padding-left:22px}
li{margin:2px 0}
blockquote{margin:6px 0;padding-left:10px;border-left:2px solid hsl(var(--border));color:hsl(var(--muted-foreground))}
hr{border:0;border-top:1px solid hsl(var(--border));margin:24px 0 8px}
.callout{border:1px solid hsl(var(--border));border-left-width:3px;border-radius:6px;padding:8px 10px;margin:8px 0;white-space:pre-wrap}
.callout b{margin-right:4px}
.tone-info,.tone-success{border-left-color:hsl(var(--info))}
.tone-warning{border-left-color:hsl(var(--warning))}
.tone-critical{border-left-color:hsl(var(--critical))}
a{color:hsl(var(--primary))}
.report-block,figure,table,.callout{break-inside:avoid}
@page{size:A4;margin:14mm 12mm}
@media print{.doc{max-width:none;padding:0}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}h2,h3{break-after:avoid}}
`.trim();

/* -------------------------------------------------------------------------- */
/* The answer AST.                                                             */
/* -------------------------------------------------------------------------- */

interface HtmlContext {
  base: number;
  defang: boolean;
}

function inline(nodes: readonly MdInline[], ctx: HtmlContext): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case 'text':
          return esc(node.v);
        case 'code':
          return `<code>${esc(node.v)}</code>`;
        case 'strong':
          return `<strong>${inline(node.c, ctx)}</strong>`;
        case 'em':
          return `<em>${inline(node.c, ctx)}</em>`;
        case 'del':
          return `<del>${inline(node.c, ctx)}</del>`;
        case 'doc':
          // A same-origin Help Center path does not resolve from a saved file: text only.
          return `${inline(node.c, ctx)} <span class="muted">(Help Center <code>${esc(node.href)}</code>)</span>`;
        case 'url':
          return `<code>${esc(ctx.defang ? node.defanged : node.url)}</code>`;
        case 'cite':
          return `[${esc(node.id)}]`;
        case 'br':
          return '<br>';
        default:
          return '';
      }
    })
    .join('');
}

const ALIGN_CLASS = { left: '', center: ' class="c"', right: ' class="num"' } as const;

function mdBlock(block: MdBlock, ctx: HtmlContext): string {
  switch (block.type) {
    case 'heading': {
      const rank = Number.isInteger(block.rank) && block.rank > 0 ? block.rank : 1;
      const level = Math.max(1, Math.min(6, ctx.base + rank - 1));
      return `<h${level}>${inline(block.inline, ctx)}</h${level}>`;
    }
    case 'paragraph':
      return `<p>${inline(block.inline, ctx)}</p>`;
    case 'rule':
      return '<hr>';
    case 'code':
      return `<pre><code>${esc(block.code)}</code></pre>`;
    case 'blockquote':
      return `<blockquote>${mdBlocks(block.blocks, ctx)}</blockquote>`;
    case 'list': {
      const items = block.items
        .map((item) => {
          const only = item.blocks.length === 1 && item.blocks[0].type === 'paragraph' ? item.blocks[0] : null;
          return `<li>${only ? inline(only.inline, ctx) : mdBlocks(item.blocks, ctx)}</li>`;
        })
        .join('');
      const start = Number.isInteger(block.start) && block.start > 1 ? ` start="${block.start}"` : '';
      return block.ordered ? `<ol${start}>${items}</ol>` : `<ul>${items}</ul>`;
    }
    case 'table': {
      const align = (i: number) => ALIGN_CLASS[block.align[i] ?? 'left'];
      const head = block.header.map((c, i) => `<th scope="col"${align(i)}>${inline(c, ctx)}</th>`).join('');
      const rows = block.rows
        .map((r) => `<tr>${block.header.map((_, i) => `<td${align(i)}>${inline(r[i] ?? [], ctx)}</td>`).join('')}</tr>`)
        .join('');
      return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    default:
      return '';
  }
}

function mdBlocks(blocks: readonly MdBlock[], ctx: HtmlContext): string {
  return blocks.map((b) => mdBlock(b, ctx)).join('');
}

/** Serialise sanitised answer prose; rank-1 headings render at `base`. */
export function htmlFromAst(blocks: readonly MdBlock[], base = 3, defang = true): string {
  return mdBlocks(blocks, { base, defang });
}

/* -------------------------------------------------------------------------- */
/* Document nodes.                                                             */
/* -------------------------------------------------------------------------- */

function runs(line: Line): string {
  return line
    .map((r) => {
      const t = esc(r.text);
      if (r.code) return `<code>${t}</code>`;
      return r.strong ? `<strong>${t}</strong>` : t;
    })
    .join('');
}

function node(n: DocNode): string {
  switch (n.k) {
    case 'heading':
      return `<h${n.level}>${esc(n.text)}</h${n.level}>`;
    case 'meta':
      return `<p class="meta">${esc(n.text)}</p>`;
    case 'para':
      return `<p${n.muted ? ' class="muted"' : ''}>${runs(n.line)}</p>`;
    case 'md':
      return htmlFromAst(n.blocks, n.base, n.defang);
    case 'table': {
      const cls = (i: number) => (n.numeric[i] ? ' class="num"' : '');
      const head = n.head.map((h, i) => `<th scope="col"${cls(i)}>${esc(h)}</th>`).join('');
      const rows = n.rows
        .map(
          (r, ri) =>
            `<tr>${r
              .map((c, i) => {
                const code = n.cellCode?.[ri]?.[i] ?? n.code[i] ?? false;
                return `<td${cls(i)}>${code && c !== '—' ? `<code>${esc(c)}</code>` : esc(c)}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('');
      return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    case 'list': {
      const items = n.items.map((line) => `<li>${runs(line)}</li>`).join('');
      return n.ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
    }
    case 'code':
      return `${n.caption ? `<p class="caption">${esc(n.caption)}</p>` : ''}<pre><code>${esc(n.text)}</code></pre>`;
    case 'callout':
      return `<div class="callout tone-${n.tone}"><b>${esc(n.label)}:</b> ${esc(n.text)}</div>`;
    case 'attack': {
      const items = n.items
        .map((t) => {
          // The ONLY external link: constructed from a validated technique id.
          const id = t.url ? `<a href="${esc(t.url)}" rel="noopener noreferrer">${esc(t.id)}</a>` : esc(t.id);
          return `<li>${id}${t.label ? ` ${esc(t.label)}` : ''}</li>`;
        })
        .join('');
      return `<ul>${items}</ul>`;
    }
    case 'rule':
      return '<hr>';
    default:
      return '';
  }
}

/** Serialise document nodes to an HTML fragment. */
export function nodesToHtml(nodes: readonly DocNode[]): string {
  return nodes.map(node).join('\n');
}

/** A complete standalone HTML file around a fragment. */
export function htmlDocument(title: string, body: string): string {
  return (
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">\n` +
    `<title>${esc(title)}</title>\n` +
    `<style>:root{${tokenDeclarations()}}\n${REPORT_CSS}</style></head>\n` +
    `<body class="report"><main class="doc">\n${body}\n</main></body></html>\n`
  );
}

/** The whole document as a static HTML file (defanged by default). */
export function reportToHtml(doc: ReportDoc, options: WalkOptions = {}): string {
  return htmlDocument(doc.title, nodesToHtml(documentNodes(doc, options)));
}
