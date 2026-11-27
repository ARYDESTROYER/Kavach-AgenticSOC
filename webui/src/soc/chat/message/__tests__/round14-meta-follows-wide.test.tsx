/**
 * Round 14 (SPEC §4.7.3, SPEC-chat §5.1): the meta row and the blocks it acts on never
 * disagree about the answer's right edge, even when a card changes its width after the
 * answer is drawn. A severity breakdown is compact at rest (it reads in the 42rem reading
 * column, so its meta row does too); its "Rules by level" matrix is a view the person
 * picks, and it takes the wide lane. The meta row then takes the lane with it, through
 * CSS only (`:has()` on the turn), while what follows the row keeps the reading measure.
 *
 * jsdom runs no cascade, so this compiles the meta column's real class strings with the
 * app's own Tailwind config and resolves the winning `max-width` by hand (matching rules,
 * then specificity and source order), as `lane-cascade.test.ts` does for the block column.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import postcss, { type AtRule, type Rule } from 'postcss';
import tailwindcss from 'tailwindcss';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/soc/prefs', () => ({ useOptionalPrefs: () => null }));
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => () => undefined }));

import { TooltipProvider } from '@/ui/tooltip';
import sample from '../../blocks/__tests__/fixtures/severity-sample.json';
import { META_COL, READING_COL } from '../lane';
import { META_FOLLOWS_WIDE, Message } from '../Message';
import { assistantItem, response, stubEngine } from './fixtures';

const WEBUI_ROOT = path.resolve(__dirname, '../../../../..');

interface Declared {
  value: string;
  selector: string;
  order: number;
}

let declared: Declared[] = [];

beforeAll(async () => {
  const configUrl = pathToFileURL(path.join(WEBUI_ROOT, 'tailwind.config.js')).href;
  const config = (await import(/* @vite-ignore */ configUrl)).default;
  const result = await postcss([
    tailwindcss({
      ...config,
      content: [{ raw: `<div class="${READING_COL} ${META_FOLLOWS_WIDE} ${META_COL}"></div>`, extension: 'html' }],
      corePlugins: { preflight: false },
    }),
  ]).process('@tailwind utilities;', { from: undefined });
  const out: Declared[] = [];
  result.root.walkRules((rule: Rule) => {
    if (rule.parent?.type === 'atrule' && (rule.parent as AtRule).name.endsWith('keyframes')) return;
    for (let node = rule.parent; node && node.type !== 'root'; node = node.parent) {
      // The meta column carries no media or container condition: fail loudly if one appears.
      if (node.type === 'atrule') throw new Error(`unhandled @${(node as AtRule).name}`);
    }
    rule.walkDecls('max-width', (decl) => {
      for (const selector of rule.selectors) out.push({ value: decl.value, selector, order: out.length });
    });
  });
  declared = out;
}, 30_000);

/** Selector specificity [ids, classes/attributes/pseudo-classes, types]; `:has()`/`:not()` by their argument. */
function specificity(selector: string): [number, number, number] {
  const total: [number, number, number] = [0, 0, 0];
  const skipIdent = (i: number): number => {
    let j = i;
    while (j < selector.length && (selector[j] === '\\' || /[\w-]/.test(selector[j]))) j += selector[j] === '\\' ? 2 : 1;
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
    } else if (selector.startsWith(':has(', i) || selector.startsWith(':not(', i)) {
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
      i += 1;
    }
  }
  return total;
}

const compare = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The winning `max-width` of an element, or null when no rule sets one. */
function maxWidth(el: Element): string | null {
  let best: Declared | null = null;
  let bestSpec: [number, number, number] = [0, 0, 0];
  for (const decl of declared) {
    if (!el.matches(decl.selector)) continue;
    const spec = specificity(decl.selector);
    if (!best || compare(spec, bestSpec) > 0 || (compare(spec, bestSpec) === 0 && decl.order > best.order)) {
      best = decl;
      bestSpec = spec;
    }
  }
  return best?.value ?? null;
}

/** A turn as Message lays it out: the article (`group/turn`), a card, then the meta column. */
function turn(width: 'compact' | 'wide'): { card: HTMLElement; meta: HTMLElement } {
  document.body.innerHTML = '';
  const article = document.createElement('article');
  article.className = 'group/turn';
  const blocks = document.createElement('div');
  const card = document.createElement('figure');
  card.dataset.blockWidth = width;
  blocks.appendChild(card);
  const meta = document.createElement('div');
  meta.className = `${READING_COL} ${META_FOLLOWS_WIDE}`;
  meta.append(document.createElement('div'), document.createElement('p'));
  article.append(blocks, meta);
  document.body.appendChild(article);
  return { card, meta };
}

describe('the meta column follows a card the person widens (cascade)', () => {
  it('compiles a rule for every width it carries', () => {
    expect(declared.some((d) => d.value === 'none' && d.selector.includes(':has('))).toBe(true);
    expect(specificity('.a:has([x]) .b')).toEqual([0, 3, 0]);
  });

  it('stays in the reading column beside compact cards, and takes the lane once one shows itself wide', () => {
    const { card, meta } = turn('compact');
    expect(maxWidth(meta)).toBe('42rem');
    card.dataset.blockWidth = 'wide';
    expect(maxWidth(meta)).toBe('none');
    // What follows the row (the run log, Sources, the memory line) keeps the reading measure.
    expect(maxWidth(meta.children[1])).toBe('42rem');
    // Back to the table view: back to the reading column.
    card.dataset.blockWidth = 'compact';
    expect(maxWidth(meta)).toBe('42rem');
  });

  it('never reaches outside its own turn', () => {
    const { meta } = turn('compact');
    const other = document.createElement('article');
    other.className = 'group/turn';
    const wide = document.createElement('figure');
    wide.dataset.blockWidth = 'wide';
    other.appendChild(wide);
    document.body.prepend(other);
    expect(maxWidth(meta)).toBe('42rem');
  });
});

function renderSeverityAnswer(compact = false) {
  const item = assistantItem({
    messageId: 'm-sev',
    response: response({ blocks: [structuredClone(sample.severity)], message_id: 'm-sev' }),
  });
  return render(
    <TooltipProvider>
      <Message latest headingId="h-sev" item={item} compact={compact} engine={stubEngine({ conversationId: 'conv-1' })} />
    </TooltipProvider>,
  );
}

describe('the meta row of a severity breakdown answer', () => {
  it('sits in the reading column with the table, and takes the lane with "Rules by level"', async () => {
    const user = userEvent.setup();
    const { container } = renderSeverityAnswer();
    await screen.findByTestId('severity-breakdown', undefined, { timeout: 4000 });
    const meta = screen.getByTestId('meta-row').parentElement as HTMLElement;
    expect(meta.className).toBe(`${READING_COL} ${META_FOLLOWS_WIDE} space-y-1.5`);
    const figure = container.querySelector('figure[data-block-type="table"]') as HTMLElement;
    expect(figure).toHaveAttribute('data-block-width', 'compact');
    expect(maxWidth(meta)).toBe('42rem');

    await user.click(within(figure).getByTestId('block-menu-trigger'));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Rules by level' }));
    await waitFor(() => expect(figure).toHaveAttribute('data-block-width', 'wide'));
    // The row that acts on the card now ends on the card's edge.
    expect(maxWidth(meta)).toBe('none');
    expect(maxWidth(screen.getByTestId('meta-row'))).toBeNull();
  });

  it('keeps the Case Manager’s compact chat in the reading column whatever the card shows', async () => {
    renderSeverityAnswer(true);
    await screen.findByTestId('severity-breakdown', undefined, { timeout: 4000 });
    const meta = screen.getByTestId('meta-row').parentElement as HTMLElement;
    expect(meta.className).toBe(`${READING_COL} space-y-1.5`);
  });
});
