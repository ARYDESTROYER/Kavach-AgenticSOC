/**
 * The block column's caps as the browser applies them (BLOCKS amendment 32, chat-revamp
 * A66, SPEC-chat T7): a model-written `markdown` block keeps the 38rem prose measure and
 * a `callout` the 42rem reading column, with no hang, although both are marked compact;
 * a compact framed card is 42rem of text plus its hang.
 *
 * jsdom does not run the cascade (no specificity order, no container queries), so this
 * compiles the column's real class strings with the app's own Tailwind config and
 * resolves the winning `max-width` and `margin-left` for each child by hand: matching
 * rules, `@container (min-width)` against a conversation width, then specificity and
 * source order. A class string that reads right but loses the cascade fails here.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import postcss, { type AtRule, type Rule } from 'postcss';
import tailwindcss from 'tailwindcss';
import { beforeAll, describe, expect, it } from 'vitest';

import { BLOCK_HANG, BLOCK_PROSE_CAP, CARD_HANG_PX, PROSE_PX, READING_PX, WIDE_COL } from '../lane';

const WEBUI_ROOT = path.resolve(__dirname, '../../../../..');
const REM = 16;

interface Declared {
  prop: string;
  value: string;
  selector: string;
  minWidthPx: number | null;
  order: number;
}

let declared: Declared[] = [];

beforeAll(async () => {
  const configUrl = pathToFileURL(path.join(WEBUI_ROOT, 'tailwind.config.js')).href;
  const config = (await import(/* @vite-ignore */ configUrl)).default;
  const result = await postcss([
    tailwindcss({
      ...config,
      content: [{ raw: `<div class="${WIDE_COL}"></div>`, extension: 'html' }],
      corePlugins: { preflight: false },
    }),
  ]).process('@tailwind utilities;', { from: undefined });
  const out: Declared[] = [];
  result.root.walkRules((rule: Rule) => {
    if (rule.parent?.type === 'atrule' && (rule.parent as AtRule).name.endsWith('keyframes')) return;
    let minWidthPx: number | null = null;
    for (let node = rule.parent; node && node.type !== 'root'; node = node.parent) {
      if (node.type !== 'atrule') continue;
      const at = node as AtRule;
      const match = /^\(min-width:\s*([\d.]+)rem\)$/.exec(at.params.trim());
      // Any other condition is new to this test: fail loudly rather than guess.
      if (at.name !== 'container' || !match) throw new Error(`unhandled @${at.name} ${at.params}`);
      minWidthPx = Number(match[1]) * REM;
    }
    rule.walkDecls((decl) => {
      for (const selector of rule.selectors) {
        out.push({ prop: decl.prop, value: decl.value, selector, minWidthPx, order: out.length });
      }
    });
  });
  declared = out;
}, 30_000);

/** Selector specificity [ids, classes/attributes/pseudo-classes, types], `:not()` by its argument. */
function specificity(selector: string): [number, number, number] {
  const total: [number, number, number] = [0, 0, 0];
  const skipIdent = (i: number): number => {
    let j = i;
    while (j < selector.length) {
      if (selector[j] === '\\') j += 2;
      else if (/[\w-]/.test(selector[j])) j += 1;
      else break;
    }
    return j;
  };
  const closing = (i: number, open: string, close: string): number => {
    let depth = 0;
    for (let j = i; j < selector.length; j += 1) {
      if (selector[j] === '\\') j += 1;
      else if (selector[j] === open) depth += 1;
      else if (selector[j] === close && --depth === 0) return j;
    }
    throw new Error(`unbalanced ${open} in ${selector}`);
  };
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === '.') {
      total[1] += 1;
      i = skipIdent(i + 1);
    } else if (ch === '#') {
      total[0] += 1;
      i = skipIdent(i + 1);
    } else if (ch === '[') {
      total[1] += 1;
      i = closing(i, '[', ']') + 1;
    } else if (selector.startsWith('::', i)) {
      total[2] += 1;
      i = skipIdent(i + 2);
    } else if (selector.startsWith(':not(', i)) {
      const end = closing(i + 4, '(', ')');
      const inner = specificity(selector.slice(i + 5, end));
      total[0] += inner[0];
      total[1] += inner[1];
      total[2] += inner[2];
      i = end + 1;
    } else if (ch === ':') {
      total[1] += 1;
      i = skipIdent(i + 1);
      if (selector[i] === '(') i = closing(i, '(', ')') + 1;
    } else if (/[a-zA-Z]/.test(ch)) {
      total[2] += 1;
      i = skipIdent(i);
    } else {
      i += 1; // `*`, combinators and whitespace add nothing
    }
  }
  return total;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** A length as Tailwind writes it here (`38rem`, `calc(42rem + 1.5rem + 2px)`, `calc(calc(…) * -1)`), in px. */
function px(value: string): number {
  const expr = value
    .replace(/calc\(/g, '(')
    .replace(/([\d.]+)rem/g, (_, n: string) => String(Number(n) * REM))
    .replace(/([\d.]+)px/g, '$1');
  if (!/^[\d.\s()+*-]+$/.test(expr)) throw new Error(`unhandled length ${value}`);
  return Function(`"use strict"; return (${expr});`)() as number;
}

/** The block column as AnswerBlocks renders it: column > answer-blocks root > blocks. */
function column(): { root: HTMLElement; blocks: Record<string, HTMLElement> } {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.className = WIDE_COL;
  const list = document.createElement('div');
  root.appendChild(list);
  const make = (name: string, attrs: Record<string, string>): HTMLElement => {
    const el = document.createElement('div');
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    el.dataset.probe = name;
    list.appendChild(el);
    return el;
  };
  const blocks = {
    // BlockCard's bare branch: prose and notes, marked compact by blocks/layout.ts.
    markdown: make('markdown', { 'data-block-type': 'markdown', 'data-block-width': 'compact' }),
    callout: make('callout', { 'data-block-type': 'callout', 'data-block-width': 'compact' }),
    // A framed compact card, a framed wide card and the shared scope line.
    table: make('table', { 'data-block-type': 'table', 'data-block-width': 'compact' }),
    chart: make('chart', { 'data-block-type': 'chart', 'data-block-width': 'wide' }),
    scope: make('scope', { 'data-scope-line': '' }),
    // The motionless placeholders while the blocks chunk loads (Message.tsx).
    prosePlaceholder: make('prosePlaceholder', { 'data-block-type': 'markdown', 'data-block-width': 'compact' }),
    framedPlaceholder: make('framedPlaceholder', { 'data-block-type': 'placeholder', 'data-block-width': 'compact' }),
  };
  document.body.appendChild(root);
  return { root, blocks };
}

/** The winning value of a property for an element at a conversation (container) width, or null. */
function computed(el: HTMLElement, prop: string, conversationPx: number): number | null {
  let best: Declared | null = null;
  let bestSpec: [number, number, number] = [0, 0, 0];
  for (const decl of declared) {
    if (decl.prop !== prop) continue;
    if (decl.minWidthPx !== null && conversationPx < decl.minWidthPx) continue;
    if (!el.matches(decl.selector)) continue;
    const spec = specificity(decl.selector);
    if (!best || compare(spec, bestSpec) > 0 || (compare(spec, bestSpec) === 0 && decl.order > best.order)) {
      best = decl;
      bestSpec = spec;
    }
  }
  return best ? px(best.value) : null;
}

describe('the block column caps as the cascade resolves them (BLOCKS 32, A66, T7)', () => {
  it('compiles every cap and the hang the column carries', () => {
    expect(WIDE_COL).toContain(BLOCK_PROSE_CAP);
    expect(WIDE_COL).toContain(BLOCK_HANG);
    const { root } = column();
    // Each class string produced a rule that reaches a child (none was dropped by Tailwind).
    expect(declared.filter((d) => d.prop === 'max-width').length).toBe(BLOCK_PROSE_CAP.split(' ').length);
    expect(declared.some((d) => d.prop === 'margin-left' && d.minWidthPx === 40 * REM)).toBe(true);
    expect(root.querySelectorAll(':scope > * > *').length).toBe(7);
    expect(specificity('.a>*>*[x]:not([y]):not([z])')).toEqual([0, 4, 0]);
    expect(specificity('.a>*>*[x]')).toEqual([0, 2, 0]);
  });

  for (const conversation of [1440, 1920, 600, 390]) {
    it(`keeps prose at its own measure with no hang in a ${conversation}px conversation`, () => {
      const { blocks } = column();
      expect(computed(blocks.markdown, 'max-width', conversation)).toBe(PROSE_PX);
      expect(computed(blocks.callout, 'max-width', conversation)).toBe(READING_PX);
      expect(computed(blocks.scope, 'max-width', conversation)).toBe(READING_PX);
      expect(computed(blocks.prosePlaceholder, 'max-width', conversation)).toBe(PROSE_PX);
      for (const bare of [blocks.markdown, blocks.callout, blocks.scope, blocks.prosePlaceholder]) {
        expect(computed(bare, 'margin-left', conversation) ?? 0).toBe(0);
      }
    });

    it(`gives a compact card 42rem of text and a wide card the lane in a ${conversation}px conversation`, () => {
      const { blocks } = column();
      const hangs = conversation >= 40 * REM;
      for (const card of [blocks.table, blocks.framedPlaceholder]) {
        expect(computed(card, 'max-width', conversation)).toBe(hangs ? READING_PX + 2 * CARD_HANG_PX : READING_PX);
        expect(computed(card, 'margin-left', conversation) ?? 0).toBe(hangs ? -CARD_HANG_PX : 0);
      }
      expect(computed(blocks.chart, 'max-width', conversation)).toBeNull();
      expect(computed(blocks.chart, 'margin-left', conversation) ?? 0).toBe(hangs ? -CARD_HANG_PX : 0);
    });
  }
});
