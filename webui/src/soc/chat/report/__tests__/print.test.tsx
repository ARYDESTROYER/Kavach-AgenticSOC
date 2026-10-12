/**
 * Print / Save as PDF (BLOCKS.md §7.4; Round 12 SPEC WP-REP R5, R6, R8–R13): a print root
 * directly under <body> carrying the light tokens inline, the @media print / @page A4
 * hooks, static block renderers (data tables visible, no menus, no content rendered as
 * hidden buttons), defanged content by default, the export file name as the document
 * title while printing, a wait for a closing menu's scroll lock, then `window.print()`
 * and an unmount on `afterprint` after a grace period. jsdom cannot print; the portal
 * content, the CSS hooks and the timing are the contract.
 */
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConversationDoc, buildReportDoc } from '../model';
import { PRINT_CSS, PRINT_HIDDEN, PRINT_ROOT_ID, clearPrintRoot, mountPrintRoot, printDocument, printRootMounted } from '../export/print';
import { GALLERY_RAW } from '../../blocks/__fixtures__/gallery';
import { REPORT_LIGHT_TOKENS } from '../export/report-tokens';
import { SCREEN_DOC_ID, screenPrintCss } from '../print-fallback';
import { BlockCard } from '../../blocks/BlockCard';
import { NOW, rawBlock, sampleConversation, sampleReport } from './fixtures';

const doc = () => buildReportDoc(sampleReport(), { author: 'ana', appVersion: '0.1.13', generatedAt: NOW.toISOString() });

/** The sample report plus a Brief (contents list, sections, KPI leaf). */
const briefDoc = () =>
  buildReportDoc(
    sampleReport({
      items: [
        ...sampleReport().items,
        {
          id: 'it-brief',
          kind: 'block',
          block: rawBlock('shift-brief'),
          note: null,
          source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: 'shift-brief' },
          scope: { window: 'last 12h', sources: ['Wazuh'], generated_by: 'demo-chat', app_version: '0.1.13', demo: true },
          added_at: '2026-10-08T13:00:00Z',
        },
        {
          id: 'it-cases',
          kind: 'block',
          block: rawBlock('open-cases'),
          note: null,
          source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: 'open-cases' },
          scope: { window: 'last 12h', sources: ['Wazuh'], generated_by: 'demo-chat', app_version: '0.1.13', demo: true },
          added_at: '2026-10-08T13:00:00Z',
        },
      ],
    }),
    { author: 'ana', appVersion: '0.1.13', generatedAt: NOW.toISOString() },
  );

/** The `@media print` rules as `[selector, declarations]` (the stylesheet is one rule per line). */
function printRules(): Array<[string, string]> {
  const body = PRINT_CSS.slice(PRINT_CSS.indexOf('@media print {') + '@media print {'.length);
  const out: Array<[string, string]> = [];
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (selector && !selector.startsWith('@')) out.push([selector, m[2]]);
  }
  return out;
}

/** Every value the print rules that match `el` give `property` (in stylesheet order). */
function printValues(el: Element, property: string): string[] {
  const re = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;!]+)`);
  const out: string[] = [];
  for (const [selector, decls] of printRules()) {
    const m = re.exec(decls);
    if (m && el.matches(selector)) out.push(m[1].trim());
  }
  return out;
}

/** A table block (`columns` × 2 rows). */
function tableBlock(id: string, title: string, columns: Array<{ label: string; type: string }>, rows: unknown[][]) {
  return {
    id,
    type: 'table',
    title,
    provenance: 'source',
    artifact_kind: 'table',
    allowed_views: ['table'],
    columns: columns.map((c, i) => ({ key: `c${i}`, ...c, ...(c.type === 'number' ? { unit: 'count' } : {}) })),
    rows,
  };
}

function blockItem(id: string, block: Record<string, unknown>) {
  return {
    id,
    kind: 'block' as const,
    block,
    note: null,
    source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: String(block.id) },
    scope: { window: 'last 7d', sources: ['Wazuh'], generated_by: 'demo-chat', app_version: '0.1.13', demo: true },
    added_at: '2026-10-08T13:00:00Z',
  };
}

const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const EXE = 'C:\\Users\\jdoe\\AppData\\Local\\Temp\\invoice.pdf.exe';
const TWELVE = ['Destination IP', 'Bytes transferred', 'Source host', 'Destination port', 'Protocol', 'First seen', 'Last seen', 'Sessions', 'Packets', 'Country', 'Rule', 'Severity'];
const HOSTS = ['dc01.corp.example.internal', 'web01.dmz.example.internal', 'files01.corp.example.internal', 'jump01.corp.example.internal'];

/** The sample report (its ATT&CK coverage block has a screen-reader-only table) plus wide tables. */
const wideDoc = () =>
  buildReportDoc(
    sampleReport({
      items: [
        ...sampleReport().items,
        blockItem(
          'it-twelve',
          tableBlock(
            'twelve',
            'Connections by destination',
            TWELVE.map((label, i) => ({ label, type: [1, 3, 7, 8].includes(i) ? 'number' : i === 5 || i === 6 ? 'time' : 'text' })),
            [0, 1].map((r) => TWELVE.map((_, i) => ([1, 3, 7, 8].includes(i) ? 1000 + r : i === 5 || i === 6 ? '2026-10-08T12:00:00Z' : `value-${r}-${i}`))),
          ),
        ),
        blockItem(
          'it-hosts',
          tableBlock('per-host', 'Failed logons per host per day', [{ label: 'Time', type: 'time' }, ...HOSTS.map((label) => ({ label, type: 'number' }))], [
            ['2026-10-01T00:00:00Z', 100, 113, 126, 139],
          ]),
        ),
        blockItem('it-md', {
          id: 'md-table',
          type: 'markdown',
          provenance: 'ai',
          text: `| File | SHA-256 | Host | Path |\n| --- | --- | --- | --- |\n| invoice.pdf.exe | ${SHA} | ws-0142-finance.corp.example.internal | ${EXE} |\n| \`short-code-value-x\` | \`${SHA.slice(0, 30)}\` | a | b |\n`,
        }),
      ],
    }),
    { author: 'ana', appVersion: '0.1.13', generatedAt: NOW.toISOString() },
  );

let print: ReturnType<typeof vi.fn>;
beforeEach(() => {
  print = vi.fn();
  Object.defineProperty(window, 'print', { configurable: true, writable: true, value: print });
});
afterEach(async () => {
  // `clearPrintRoot` unmounts the print root one task later (never mid-render). Run that
  // task inside act, so the unmount never lands between tests outside it.
  await act(async () => {
    clearPrintRoot();
    if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
    else await new Promise((resolve) => setTimeout(resolve, 0));
  });
  document.body.removeAttribute('data-scroll-locked');
  vi.useRealTimers();
});

describe('printDocument', () => {
  it('mounts a light-token print root under <body> and opens the print dialog', async () => {
    let ok = false;
    await act(async () => {
      ok = await printDocument(doc());
    });
    expect(ok).toBe(true);
    expect(print).toHaveBeenCalledTimes(1);
    // The product-named id (AGENTS.md naming contract): never a compatibility prefix.
    expect(PRINT_ROOT_ID).toBe('agentic-soc-report-print');
    const root = document.getElementById(PRINT_ROOT_ID)!;
    expect(root.parentElement).toBe(document.body);
    expect(root.style.getPropertyValue('--background')).toBe(REPORT_LIGHT_TOKENS.background);
    expect(root.style.getPropertyValue('--chart-1')).toBe(REPORT_LIGHT_TOKENS['chart-1']);
    expect(root.querySelector('style')?.textContent).toBe(PRINT_CSS);
    expect(PRINT_CSS).toContain('@page { size: A4');
    expect(PRINT_CSS).toContain(`body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }`);
    expect(PRINT_CSS).toContain(`@media screen { #${PRINT_ROOT_ID} { display: none !important; } }`);
  });

  it('renders the whole document statically, defanged by default', async () => {
    await act(async () => {
      await printDocument(doc());
    });
    const root = document.getElementById(PRINT_ROOT_ID)!;
    expect(root.querySelector('[data-report-document="print"]')).not.toBeNull();
    expect(root).toHaveTextContent('Methodology & limitations');
    expect(root).toHaveTextContent('AI-generated; verify before acting.');
    expect(root).toHaveTextContent('Generated by Agentic SOC');
    // Static blocks: the chart's data table is visible and no block menu is offered.
    expect(root.querySelector('[data-testid="block-menu-trigger"]')).toBeNull();
    expect(root.textContent).toContain('203[.]0[.]113[.]14');
    expect(root.textContent).not.toContain('203.0.113.14');
  });

  it('keeps an empty block item titled and says the lookup found nothing', async () => {
    const report = sampleReport({
      items: [{ ...sampleReport().items[1], block: { ...rawBlock('signins'), rows: [] } }],
      summary: null,
    });
    await act(async () => {
      await printDocument(buildReportDoc(report, { generatedAt: NOW.toISOString() }));
    });
    const root = document.getElementById(PRINT_ROOT_ID)!;
    expect(root).toHaveTextContent('1. Recent sign-in failures');
    expect(root).toHaveTextContent('Table · Window: last 24h');
    expect(root).toHaveTextContent('The lookup found nothing.');
    expect(root).not.toHaveTextContent('not displayable');
  });

  it('keeps raw indicators when the toggle is off', async () => {
    await act(async () => {
      await printDocument(doc(), { defang: false });
    });
    expect(document.getElementById(PRINT_ROOT_ID)!.textContent).toContain('203.0.113.14');
  });

  it('unmounts after printing (after the grace) and replaces a pending root', async () => {
    await act(async () => {
      await printDocument(doc(), { graceMs: 10 });
    });
    await act(async () => {
      await printDocument(doc(), { graceMs: 10 });
    });
    expect(document.querySelectorAll(`#${PRINT_ROOT_ID}`)).toHaveLength(1);
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    await waitFor(() => expect(document.getElementById(PRINT_ROOT_ID)).toBeNull());
  });
});

describe('print document title (R5)', () => {
  it('is the export file stem while printing and is restored afterwards', async () => {
    document.title = 'Agentic SOC';
    let during = '';
    print.mockImplementation(() => {
      during = document.title;
    });
    await act(async () => {
      await printDocument(doc(), { documentTitle: 'agentic-soc-report-brute-force-on-vpn-gw-2-20261008-1405Z', graceMs: 5 });
    });
    expect(during).toBe('agentic-soc-report-brute-force-on-vpn-gw-2-20261008-1405Z');
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    await waitFor(() => expect(document.title).toBe('Agentic SOC'));
  });
});

describe('print content is never hidden (R6, R7, R13)', () => {
  it('hides only [data-print-hide] and copy controls, never every button', () => {
    expect(PRINT_CSS).not.toMatch(/button\s*[,{]/);
    expect(PRINT_CSS).toContain(`${PRINT_HIDDEN} { display: none !important; }`);
    expect(PRINT_HIDDEN).toContain('[data-print-hide]');
    expect(PRINT_HIDDEN).toContain('button[aria-label^="Copy"]');
    expect(PRINT_CSS).toContain('content-visibility: visible !important');
  });

  it('prints no control: every button left visible is content (a KPI tile with a link)', async () => {
    // The sample report plus every gallery block, with defang off (prose links then
    // carry a "Copy defanged link" button), through the real static renderers.
    const base = sampleReport();
    const gallery = (GALLERY_RAW as Array<Record<string, unknown>>).map((block, i) => ({
      ...base.items[1],
      id: `g-${i}`,
      kind: 'block' as const,
      block,
      source: { ...base.items[1].source, block_id: String(block.id) },
    }));
    const all = buildReportDoc(sampleReport({ items: [...base.items, ...gallery] }), { generatedAt: NOW.toISOString() });
    await act(async () => {
      await printDocument(all, { defang: false });
    });
    const root = document.getElementById(PRINT_ROOT_ID)!;
    const buttons = Array.from(root.querySelectorAll('button'));
    const hidden = buttons.filter((b) => b.matches(PRINT_HIDDEN) || b.closest('[data-print-hide]'));
    // The code block's "Copy", a prose link's "Copy defanged link", an entity's "Copy value".
    const labels = new Set(hidden.map((b) => b.getAttribute('aria-label')));
    expect(labels).toEqual(new Set(['Copy to clipboard', 'Copy defanged link', 'Copy value']));
    const shown = buttons.filter((b) => !hidden.includes(b));
    // Round 12 (WP-CHATUI): a KPI tile with a link is plain content on paper, never a
    // button, so no visible control is left at all; the tile itself still prints.
    expect(shown).toEqual([]);
    const tiles = Array.from(root.querySelectorAll('[data-testid^="kpi-"]'));
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) expect(tile.tagName).not.toBe('BUTTON');
  });

  it('prints an entity\'s linked, changed counts as plain tiles with the change on its own line', async () => {
    // Review (WP-CHATUI): the static KPI contract reached kpi_group blocks but not an
    // entity's counts, which stayed buttons with an inline chip on paper.
    const entity = {
      id: 'ioc-linked',
      type: 'entity',
      provenance: 'source',
      artifact_kind: 'entity',
      allowed_views: ['entity'],
      entity: { kind: 'ip', value: '203.0.113.14' },
      facts: [],
      reputation: [],
      counts: [
        {
          key: 'cases',
          label: 'Open cases',
          value: 4,
          unit: 'count',
          delta: { value: 2, period_label: 'vs last week', good_direction: 'down' },
          ref: { page: 'cases', opts: { status: 'open' } },
        },
      ],
      related_cases: [],
    };
    const linked = buildReportDoc(sampleReport({ items: [blockItem('it-ioc', entity)] }), { generatedAt: NOW.toISOString() });
    await act(async () => {
      await printDocument(linked, { defang: false });
    });
    const root = document.getElementById(PRINT_ROOT_ID)!;
    const counts = root.querySelector('[data-testid="block-entity"] [data-testid="block-kpis"]') as HTMLElement;
    expect(counts).toHaveAttribute('data-static', 'true');
    const tile = counts.querySelector('[data-testid^="kpi-"]') as HTMLElement;
    expect(tile).toHaveTextContent('Open cases');
    expect(tile.tagName).not.toBe('BUTTON');
    expect(counts.querySelector('button')).toBeNull();
    // The numeral row that holds the change chip is a column on paper.
    expect(tile.className).toContain('[&_div:has(>[role=img])]:flex-col');
    expect(tile.querySelector('[role="img"]')).not.toBeNull();
  });

  it('lays static data tables out fixed and wrapping, never a row label forced onto one line', () => {
    expect(PRINT_CSS).not.toMatch(/white-space:\s*nowrap/);
    expect(PRINT_CSS).toContain('table[data-static-table] { table-layout: fixed !important; }');
    expect(PRINT_CSS).toMatch(/table\[data-static-table\] td \{ overflow-wrap: anywhere; \}/);
  });

  it('lets every table cell wrap anywhere, so no table is wider than the A4 column', () => {
    const R = `#${PRINT_ROOT_ID}`;
    // `break-word` never lowers a cell's minimum width: one long host name, hash or path
    // made the table wider than the page and the browser shrank EVERY page to fit it.
    expect(PRINT_CSS).not.toContain('break-word');
    expect(PRINT_CSS).toContain(`${R} th, ${R} td { white-space: normal !important; overflow-wrap: anywhere; }`);
    expect(PRINT_CSS).toContain(`${R} th *, ${R} td .whitespace-nowrap { white-space: normal !important; }`);
    expect(PRINT_CSS).toContain(`${R} td .tabular-nums { overflow-wrap: normal; }`);
    // A screen-reader-only table is not laid out at all (its one-line caption could widen the page).
    expect(PRINT_CSS).toContain(`${R} table.sr-only { display: none !important; }`);
    // Only visible tables are sized to the column: a screen-reader-only table keeps its 1 px box.
    expect(PRINT_CSS).toContain(`${R} table:not(.sr-only) { width: 100% !important; max-width: 100% !important;`);
    for (const [selector, decls] of printRules()) {
      if (/(?:^|;)\s*(?:max-|min-)?width:/.test(decls) && /\btable\b/.test(selector)) expect(selector).toContain('table:not(.sr-only)');
    }
  });

  it('applies the same table rules to the document view\'s Ctrl/Cmd+P fallback', () => {
    const css = screenPrintCss();
    const D = `#${SCREEN_DOC_ID}`;
    expect(css).not.toMatch(new RegExp(`${D} table \\{`));
    expect(css).toContain(`${D} table:not(.sr-only) { width: 100% !important; }`);
    expect(css).toContain(`${D} table.sr-only { display: none !important; }`);
    expect(css).toContain(`${D} th, body:not(:has(> #${PRINT_ROOT_ID})) ${D} td { white-space: normal !important; overflow-wrap: anywhere; }`);
    expect(css).toContain(`${D} td .tabular-nums { overflow-wrap: normal; }`);
    expect(css).not.toContain('break-word');
  });

  it('wraps a 12-column table, host-name headers and a Markdown hash and path; sr-only tables are not laid out', async () => {
    await act(async () => {
      await printDocument(wideDoc(), { defang: false });
    });
    const root = document.getElementById(PRINT_ROOT_ID)!;
    // Every value is printed in full (nothing elided to fit).
    for (const label of [...TWELVE, ...HOSTS, SHA, EXE, 'ws-0142-finance.corp.example.internal']) expect(root).toHaveTextContent(label);
    // The two block tables print statically (plain-text headers, every row).
    expect(root.querySelectorAll('[data-testid="block-table"][data-static] table').length).toBeGreaterThanOrEqual(2);
    const cells = Array.from(root.querySelectorAll('th, td')).filter((c) => !c.closest('table.sr-only'));
    expect(cells.length).toBeGreaterThan(TWELVE.length * 3 + HOSTS.length + 8);
    for (const cell of cells) {
      // Every printed cell may wrap anywhere, and nothing in the stylesheet says otherwise.
      expect(printValues(cell, 'overflow-wrap').length, cell.outerHTML.slice(0, 120)).toBeGreaterThan(0);
      expect(new Set(printValues(cell, 'overflow-wrap')), cell.outerHTML.slice(0, 120)).toEqual(new Set(['anywhere']));
      expect(printValues(cell, 'white-space')).toContain('normal');
    }
    // A one-line utility inside a cell (a header label, a short inline code) wraps too.
    const oneLine = Array.from(root.querySelectorAll('th *, td .whitespace-nowrap'));
    expect(oneLine.some((el) => el.classList.contains('whitespace-nowrap'))).toBe(true);
    for (const el of oneLine) expect(printValues(el, 'white-space')).toContain('normal');
    // A number or a time wraps only at its spaces, never inside "1,000".
    const numbers = Array.from(root.querySelectorAll('td .tabular-nums'));
    expect(numbers.some((el) => el.textContent === '1,000')).toBe(true);
    for (const el of numbers) expect(printValues(el, 'overflow-wrap')).toEqual(['normal']);
    // The Markdown table and the block tables are sized to the column …
    const tables = Array.from(root.querySelectorAll('table'));
    const srOnly = tables.filter((t) => t.classList.contains('sr-only'));
    expect(srOnly.length).toBeGreaterThan(0); // the ATT&CK coverage block's screen-reader table
    for (const t of tables.filter((x) => !srOnly.includes(x))) expect(printValues(t, 'width')).toEqual(['100%']);
    // … a screen-reader-only table is not (stretched to 100% at a card's inset it widened the page).
    for (const t of srOnly) {
      expect(printValues(t, 'display')).toEqual(['none']);
      expect(printValues(t, 'width')).toEqual([]);
      expect(printValues(t, 'max-width')).toEqual([]);
      for (const c of Array.from(t.querySelectorAll('th, td'))) expect(printValues(c, 'padding-left')).toEqual([]);
    }
  });

  it('prints table headers, the Brief contents and case ids as text', async () => {
    await act(async () => {
      await printDocument(briefDoc(), { defang: false });
    });
    const root = document.getElementById(PRINT_ROOT_ID)!;
    // Nothing that carries text is hidden by the print stylesheet.
    for (const el of Array.from(root.querySelectorAll('[data-print-hide]'))) expect(el.textContent ?? '').toBe('');
    // Every header cell and list item has text (no empty "1. 2. 3." contents list).
    const ths = Array.from(root.querySelectorAll('th'));
    expect(ths.length).toBeGreaterThan(0);
    for (const th of ths) expect((th.textContent ?? '').trim(), th.outerHTML).not.toBe('');
    for (const li of Array.from(root.querySelectorAll('li'))) expect((li.textContent ?? '').trim()).not.toBe('');
    // Sortable headers are plain text, not buttons.
    expect(Array.from(root.querySelectorAll('th button'))).toHaveLength(0);
    const toc = root.querySelector('[data-testid="report-toc-static"]')!;
    expect(toc).toHaveTextContent('Contents (3 sections)');
    expect(toc).toHaveTextContent('Summary');
    expect(toc.querySelector('button')).toBeNull();
    // No provenance glyph ("01/10") and no block controls in print.
    expect(root.querySelector('figcaption button')).toBeNull();
    // Content-visibility is never set on a printed block.
    expect(root.querySelector('[class*="content-visibility"]')).toBeNull();
    // The KPI values are all there (a tile with a link still prints).
    expect(root).toHaveTextContent('12,840');
    expect(root).toHaveTextContent('6,400');
  });

  it.each([
    ['a report', () => doc()],
    [
      'a conversation',
      () => {
        // A multi-line prompt is quoted under its heading (a one-line prompt is the heading).
        const conversation = sampleConversation();
        const first = conversation.messages.findIndex((m) => m.role === 'user');
        conversation.messages[first] = {
          ...conversation.messages[first],
          content: 'Who is failing logins against vpn-gw-2?\nInclude every gateway and the last 24 hours.',
        };
        return buildConversationDoc(conversation, { generatedAt: NOW.toISOString() });
      },
    ],
  ])("keeps each item's header with its first content in %s (heading, meta line, question)", async (_name, make) => {
    const printed = make();
    await act(async () => {
      await printDocument(printed, { defang: false });
    });
    const root = document.getElementById(PRINT_ROOT_ID)!;
    const items = Array.from(root.querySelectorAll('[data-report-item]'));
    expect(items).toHaveLength(printed.items.length);
    for (const item of items) {
      // The CSS selector and the rendered markup can no longer drift apart: every item
      // carries the header the print rule targets, holding the heading and the meta line.
      const header = item.querySelector(':scope > .report-item-header');
      expect(header, item.outerHTML.slice(0, 200)).not.toBeNull();
      expect(header!.querySelector(':scope > h3')).not.toBeNull();
      expect(header!.querySelector(':scope > p')).not.toBeNull();
      // Nothing but the header precedes the item's content.
      expect(item.firstElementChild).toBe(header);
      expect(printValues(header!, 'break-after')).toContain('avoid');
      expect(printValues(header!, 'break-inside')).toContain('avoid');
    }
    // A conversation's question note sits inside its header (it introduces the answer).
    if (printed.kind === 'conversation') {
      const questions = Array.from(root.querySelectorAll('[data-report-item] [role="note"]')).filter((n) =>
        (n.textContent ?? '').startsWith('Question: '),
      );
      expect(questions.length).toBeGreaterThan(0);
      for (const q of questions) expect(q.parentElement?.classList.contains('report-item-header')).toBe(true);
    }
  });

  it('keeps headings and item headers with what follows in the Ctrl/Cmd+P fallback', () => {
    const css = screenPrintCss();
    expect(css).toMatch(/\.report-item-header \{ break-inside: avoid; \}/);
    expect(css).toMatch(/figcaption, [^{]*\.report-item-header \{ break-after: avoid; \}/);
  });

  it('keeps page breaks on small atoms only (R8)', () => {
    expect(PRINT_CSS).not.toContain('.report-block, ');
    expect(PRINT_CSS).toContain('thead { display: table-header-group; }');
    expect(PRINT_CSS).toContain('orphans: 3; widows: 3;');
    expect(PRINT_CSS).toMatch(/h4, [^{]*figcaption[^{]*\{ break-after: avoid; \}/);
    // Wide tables wrap instead of being cut at the page edge.
    expect(PRINT_CSS).toContain('overflow: visible !important');
    expect(PRINT_CSS).toContain('white-space: normal !important');
  });
});

describe('print guidance (R17)', () => {
  it('shows the guidance before the dialog opens, never after it closed', async () => {
    const order: string[] = [];
    print.mockImplementation(() => {
      // The dialog blocks here: the guidance must already be on screen.
      order.push(`print (root ${printRootMounted() ? 'mounted' : 'missing'})`);
    });
    await act(async () => {
      await printDocument(doc(), { onBeforePrint: () => order.push('guidance') });
    });
    expect(order).toEqual(['guidance', 'print (root mounted)']);
  });

  it('shows no guidance where printing is unavailable', async () => {
    Object.defineProperty(window, 'print', { configurable: true, writable: true, value: undefined });
    const guidance = vi.fn();
    let ok = true;
    await act(async () => {
      ok = await printDocument(doc(), { onBeforePrint: guidance });
    });
    expect(ok).toBe(false);
    expect(guidance).not.toHaveBeenCalled();
    expect(printRootMounted()).toBe(false);
  });
});

describe('print timing (R10, R11)', () => {
  it('waits for a closing menu to release the scroll lock before printing', async () => {
    document.body.setAttribute('data-scroll-locked', '1');
    let lockedAtPrint: boolean | null = null;
    print.mockImplementation(() => {
      lockedAtPrint = document.body.hasAttribute('data-scroll-locked');
    });
    await act(async () => {
      const pending = printDocument(doc(), { settleMs: 2_000 });
      await new Promise((r) => setTimeout(r, 60));
      expect(print).not.toHaveBeenCalled();
      document.body.removeAttribute('data-scroll-locked');
      await pending;
    });
    expect(print).toHaveBeenCalledTimes(1);
    expect(lockedAtPrint).toBe(false);
    // The stylesheet lifts any lock that remains anyway.
    expect(PRINT_CSS).toContain('html body[data-scroll-locked]');
  });

  it('keeps the root through an immediate afterprint, then unmounts after the grace', () => {
    vi.useFakeTimers();
    let done: (() => void) | null = null;
    act(() => {
      done = mountPrintRoot(doc(), BlockCard as never, { graceMs: 1_000 });
    });
    expect(printRootMounted()).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(printRootMounted()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(printRootMounted()).toBe(false);
    expect(typeof done).toBe('function');
  });

  it('waits longer while the page is still in print media', () => {
    vi.useFakeTimers();
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query === 'print', media: query }) as MediaQueryList,
    );
    act(() => {
      mountPrintRoot(doc(), BlockCard as never, { graceMs: 1_000 });
    });
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(printRootMounted()).toBe(true);
    matchMedia.mockImplementation((query: string) => ({ matches: false, media: query }) as MediaQueryList);
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    expect(printRootMounted()).toBe(false);
  });

  it('falls back to the timeout when afterprint never fires', () => {
    vi.useFakeTimers();
    act(() => {
      mountPrintRoot(doc(), BlockCard as never, { timeoutMs: 60_000 });
    });
    act(() => {
      vi.advanceTimersByTime(60_001);
    });
    expect(printRootMounted()).toBe(false);
  });
});
