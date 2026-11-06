/**
 * Round 14 chat drill and severity, the rendered half (SPEC §4.6.3, §4.6.5, §4.7.3, F6,
 * F7). Pinned here, on the blocks one backend sample produced (`fixtures/severity-sample.json`):
 *
 * - a rule row of a table opens the ONE rule sheet (its name is a `RuleLink`; a click on
 *   the row does what the link does; the row stays marked while its sheet is open), the
 *   sheet opening on the answer's window "From your answer"; a row with a route gets one
 *   "Open in Logs" link; a trend column sits after the name; print shows plain cells;
 * - a rule bar opens the sheet on click and on Enter, and the opened bar is marked;
 * - the card title carries a native tooltip only while it is cut off (F6);
 * - the severity breakdown: five levels with zeros, raw values in brackets, shares, a
 *   disclosure per level listing its rules with rule sheets and Logs links, "Split by"
 *   Source swapping the Top column without a request, the matrix in the wide lane, the
 *   narrow card dropping Trend and Top, and print drawing the plain table;
 * - the case entity card: the number, the status in words, and the Rules fact of an answer
 *   saved before its rules were listed one by one, as written (display text, never split
 *   into rule links; the listed form is pinned in `round14-entity-rules.test.tsx`);
 * - no rule value is ever markup.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { summaryMock, logsMock } = vi.hoisted(() => ({ summaryMock: vi.fn(), logsMock: vi.fn() }));

vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => () => undefined }));
vi.mock('@/lib/api-rules', () => ({ getRuleSummary: summaryMock }));
vi.mock('@/soc/UnifiedLogs.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/UnifiedLogs.api')>()),
  fetchUnifiedLogs: logsMock,
}));
vi.mock('@/soc/auth', () => {
  const auth = () => ({ username: 'analyst', hasPermission: () => true });
  return { useAuth: auth, useOptionalAuth: auth };
});

import { TooltipProvider } from '@/ui/tooltip';
import { answerOrigin, clearAnswerOrigin } from '@/soc/answer-origin';
import { getRuleSheetRequest, resetRuleSheetStoreForTests } from '@/soc/components/rule-sheet-store';
import { latestFixture, summaryFixture } from '@/soc/components/__tests__/rule-sheet.fixtures';
import AnswerBlocks from '../AnswerBlocks';
import { BlockBody, withChartDrill } from '../BlockCard';
import { RowTrend } from '../renderers/RowTrend';
import { parseBlock } from '../schema';
import type { AnswerBlock, ChartBlock, EntityBlock, TableBlock } from '../schema';
import sample from './fixtures/severity-sample.json';

const severityBlock = () => parseBlock(structuredClone(sample.severity)) as TableBlock;
const rulesTable = () => parseBlock(structuredClone(sample.rules_table)) as TableBlock;
const rulesChart = () => parseBlock(structuredClone(sample.rules_chart)) as ChartBlock;
const SSH = 'Fehlgeschlagene Anmeldung über SSH';
const WINDOW = { from: sample.rules_table.drill[0].opts.from, to: sample.rules_table.drill[0].opts.to };

function show(block: AnswerBlock, props: Partial<React.ComponentProps<typeof AnswerBlocks>> = {}) {
  return render(
    <TooltipProvider>
      <AnswerBlocks blocks={[block]} messageId="m1" {...props} />
    </TooltipProvider>,
  );
}

beforeAll(async () => {
  // The sheet chunk is cached after the first open in the app; load it up front here.
  await import('@/soc/components/RuleSheet');
});

beforeEach(() => {
  summaryMock.mockImplementation(async ({ rule }: { rule: string }) => summaryFixture({ rule }));
  logsMock.mockResolvedValue(latestFixture());
});

afterEach(() => {
  act(() => resetRuleSheetStoreForTests());
  summaryMock.mockReset();
  logsMock.mockReset();
});

describe('a rule table in an answer', () => {
  it('names every rule as a link that opens the rule sheet on the answer window', async () => {
    const user = userEvent.setup();
    show(rulesTable());
    const table = screen.getByTestId('block-table');
    const link = within(table).getByRole('button', { name: `Open rule ${SSH}` });
    expect(within(table).getAllByRole('button', { name: /^Open rule / })).toHaveLength(4);
    await user.click(link);
    expect(getRuleSheetRequest()).toMatchObject({ rule: SSH, window: WINDOW, origin: 'your answer' });
    expect(await screen.findByRole('dialog')).toHaveAccessibleDescription('From your answer');
    // The opened row stays marked while its sheet is open.
    expect(link).toHaveAttribute('aria-current', 'true');
    expect(table.className).toContain('[&_tr:has([data-rule-link][aria-current=true])]:bg-primary/10');
  });

  it('opens the same sheet from a click anywhere on the row', async () => {
    show(rulesTable());
    const row = within(screen.getByTestId('block-table')).getByRole('button', { name: 'Open rule web_scan' }).closest('tr')!;
    fireEvent.click(within(row).getAllByRole('cell')[1]);
    await waitFor(() => expect(getRuleSheetRequest()?.rule).toBe('web_scan'));
  });

  it('draws each row trend after the name, a line for five or more points', () => {
    show(rulesTable());
    const table = screen.getByTestId('block-table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers.slice(0, 3)).toEqual(['Rule', 'Trend', expect.stringMatching(/^Count/)]);
    const trends = within(table).getAllByTestId('row-trend');
    expect(trends).toHaveLength(4);
    expect(trends[0]).toHaveAttribute('data-shape', 'line');
    expect(trends[0]).toHaveTextContent(/^Trend: /);
  });

  it('gives a routed row one "Open in Logs" link and no rule link', () => {
    const block = severityBlock();
    // The levels table without its breakdown is a plain table with Logs routes.
    show({ ...block, severity: undefined });
    const table = screen.getByTestId('block-table');
    const open = within(table).getByRole('link', { name: 'Open in Logs: High (8, 7, 55)' });
    expect(open.getAttribute('href')).toMatch(/^#\/logs\?/);
    expect(open.getAttribute('href')).toContain('severity=high');
    expect(within(table).queryByRole('button', { name: /^Open rule / })).toBeNull();
  });

  it('prints plain cells: no rule link, no Logs link, no Trend column (the exports have none)', () => {
    render(<BlockBody block={rulesTable()} title="Top rules" index={0} staticMode />);
    expect(screen.queryByRole('button', { name: /^Open rule / })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(SSH)).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Trend' })).toBeNull();
    expect(screen.queryByTestId('row-trend')).toBeNull();
  });

  it('names a row\'s Logs icon by a tooltip shown on keyboard focus, never a native title', async () => {
    const block = severityBlock();
    show({ ...block, severity: undefined });
    const open = within(screen.getByTestId('block-table')).getByRole('link', { name: 'Open in Logs: High (8, 7, 55)' });
    expect(open).not.toHaveAttribute('title');
    // 44px on a phone, where it is the row's primary control; 32px from 640px.
    expect(open).toHaveClass('size-11', 'sm:size-8');
    act(() => open.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Open in Logs: High (8, 7, 55)');
  });

  it('a row the server could not link looks plain and does nothing on click', () => {
    const base = structuredClone(sample.rules_table) as Record<string, unknown> & { drill: unknown[] };
    base.drill = [base.drill[0], null, base.drill[2], base.drill[3]];
    show(parseBlock(base));
    const table = screen.getByTestId('block-table');
    // Only rows with something to open keep the pointer.
    expect(table.className).toContain('[&_tbody_tr:not(:has([data-row-target]))]:cursor-auto');
    const plain = within(table).getByText('Web scanner user agent detected').closest('tr')!;
    expect(plain.querySelector('[data-row-target]')).toBeNull();
    fireEvent.click(within(plain).getAllByRole('cell')[1]);
    expect(getRuleSheetRequest()).toBeNull();
    expect(within(table).getAllByRole('button', { name: /^Open rule / })).toHaveLength(3);
  });

  it('never renders a rule value as markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const base = structuredClone(sample.rules_table);
    base.rows[0][0] = hostile;
    base.drill[0].opts.rule = hostile;
    const { container } = show(parseBlock(base));
    expect(screen.getByRole('button', { name: `Open rule ${hostile}` })).toHaveTextContent(hostile);
    expect(container.querySelector('img')).toBeNull();
  });

  it('a model-made table names its rules as plain text', () => {
    show(parseBlock({ ...structuredClone(sample.rules_table), provenance: 'ai' }));
    expect(screen.queryByRole('button', { name: /^Open rule / })).toBeNull();
  });
});

describe('the way back to the answer a drill left', () => {
  /**
   * Go to `hash` and let its `hashchange` land before the test remembers anything: the
   * memory counts the pages reached since the answer, so an event still queued from an
   * earlier navigation would count as a page the person moved on to.
   */
  const settleHash = async (hash: string) => {
    if (window.location.hash !== hash) {
      const changed = new Promise<void>((resolve) => window.addEventListener('hashchange', () => resolve(), { once: true }));
      window.location.hash = hash;
      await changed;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(async () => {
    await settleHash('#/chat');
  });

  afterEach(async () => {
    clearAnswerOrigin();
    await settleHash('');
  });

  it('remembers nothing when a rule sheet is only opened and closed', async () => {
    const user = userEvent.setup();
    show(rulesTable(), { answerLocation: { conversationId: 'c-2', messageId: 'm1' } });
    await user.click(screen.getByRole('button', { name: 'Open rule web_scan' }));
    await screen.findByTestId('rule-open-logs');
    expect(answerOrigin()).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(getRuleSheetRequest()).toBeNull());
    // A later visit to Logs from the navigation is not a drill from this answer.
    expect(answerOrigin()).toBeNull();
  });

  it('remembers the exact saved answer when a link in the sheet leaves it', async () => {
    const user = userEvent.setup();
    show(rulesTable(), { answerLocation: { conversationId: 'c-2', messageId: 'm1' } });
    await user.click(screen.getByRole('button', { name: 'Open rule web_scan' }));
    await user.click(await screen.findByTestId('rule-open-logs'));
    expect(answerOrigin()).toEqual({ hash: '#/chat?conversationId=c-2&messageId=m1', label: 'Back to answer' });
  });

  it('remembers nothing for a link opened in a new tab (this page stays where it is)', async () => {
    const user = userEvent.setup();
    show(rulesTable(), { answerLocation: { conversationId: 'c-2', messageId: 'm1' } });
    await user.click(screen.getByRole('button', { name: 'Open rule web_scan' }));
    const logs = await screen.findByTestId('rule-open-logs');
    fireEvent.click(logs, { ctrlKey: true });
    expect(answerOrigin()).toBeNull();
  });

  it('remembers it for a Logs drill too', async () => {
    const user = userEvent.setup();
    const block = severityBlock();
    show({ ...block, severity: undefined }, { answerLocation: { conversationId: 'c-2', messageId: 'm1' } });
    await user.click(screen.getByRole('link', { name: 'Open in Logs: High (8, 7, 55)' }));
    expect(answerOrigin()?.hash).toBe('#/chat?conversationId=c-2&messageId=m1');
  });

  it('offers nothing when the answer is not known on the bare Chat page', async () => {
    const user = userEvent.setup();
    show(rulesTable());
    await user.click(screen.getByRole('button', { name: 'Open rule web_scan' }));
    await user.click(await screen.findByTestId('rule-open-logs'));
    expect(answerOrigin()).toBeNull();
  });
});

describe('a rule chart in an answer', () => {
  it('opens the sheet from a bar on Enter, says so, and marks the bar', async () => {
    show(rulesChart());
    const plot = screen.getByTestId('chart-hbar-plot');
    act(() => plot.focus());
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(screen.getByTestId('chart-hbar-tooltip')).toHaveTextContent("See this rule's alerts and cases ›");
    expect(plot).toHaveAccessibleDescription(/Enter opens the rule's alerts and cases\./);
    fireEvent.keyDown(plot, { key: 'Enter' });
    await waitFor(() => expect(getRuleSheetRequest()).toMatchObject({ rule: SSH, origin: 'your answer', window: WINDOW }));
    expect(await screen.findByTestId('chart-opened-row')).toBeInTheDocument();
  });
});

describe('a rule chart shown as a table', () => {
  it('keeps every bar\'s rule sheet on its row', async () => {
    const user = userEvent.setup();
    show(rulesChart());
    await user.click(screen.getByTestId('block-menu-trigger'));
    await user.click(screen.getByRole('menuitem', { name: 'Show table' }));
    const table = screen.getByTestId('block-table');
    expect(within(table).getAllByRole('button', { name: /^Open rule / })).toHaveLength(4);
    await user.click(within(table).getByRole('button', { name: 'Open rule dns_tunnel' }));
    expect(getRuleSheetRequest()).toMatchObject({ rule: 'dns_tunnel', origin: 'your answer' });
  });

  it('keeps no link when the rows are not the chart categories in order', () => {
    const chart = rulesChart();
    const table = parseBlock(structuredClone(sample.rules_table)) as TableBlock;
    const plain = { ...table, drill: undefined };
    expect(withChartDrill(chart, plain).drill).toEqual(chart.drill);
    const reordered = { ...plain, rows: [...plain.rows].reverse() };
    expect(withChartDrill(chart, reordered).drill).toBeUndefined();
    expect(withChartDrill({ ...chart, drill: undefined }, plain).drill).toBeUndefined();
  });
});

describe('the card title (F6)', () => {
  const dims = (scroll: number, client: number) => {
    const s = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scroll);
    const c = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(client);
    return () => {
      s.mockRestore();
      c.mockRestore();
    };
  };

  it('has no tooltip while the whole title shows, and is as wide as its text', () => {
    const restore = dims(120, 120);
    try {
      show(rulesTable());
      const heading = screen.getByRole('heading', { name: 'Top rules' });
      expect(heading).not.toHaveAttribute('title');
      expect(heading).toHaveClass('w-fit', 'max-w-full', 'truncate');
    } finally {
      restore();
    }
  });

  it('shows the whole title as a tooltip only while it is cut off', () => {
    const restore = dims(480, 160);
    try {
      show(rulesTable());
      expect(screen.getByRole('heading', { name: 'Top rules' })).toHaveAttribute('title', 'Top rules');
    } finally {
      restore();
    }
  });
});

describe('the severity breakdown', () => {
  it('lists the five levels in order with zeros, raw values in brackets and one-decimal shares', () => {
    show(severityBlock());
    const view = screen.getByTestId('severity-breakdown');
    const rows = Array.from(view.querySelectorAll('tr[data-level]'));
    expect(rows.map((r) => r.getAttribute('data-level'))).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    expect(rows[1]).toHaveTextContent('High (8, 7, 55)');
    expect(rows[1]).toHaveTextContent('53.8%');
    expect(rows[2]).toHaveTextContent('0.0%');
    // A level with nothing in it opens nothing.
    expect(within(rows[2] as HTMLElement).queryByRole('button', { expanded: false })).toBeNull();
    // Each level's raw values are explained on its own source scales.
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: 'What High means here' })).toBeInTheDocument();
    expect(screen.getByTestId('severity-footnote')).toHaveTextContent(
      "Levels use each source's own scale; the raw value is in brackets. Share is of the 13 events counted.",
    );
    // The sample is stated once, in the caption.
    expect(screen.getByTestId('block-caption')).toHaveTextContent('13 of 48 events counted');
  });

  it('opens a level with its disclosure and lists its rules with sheets and Logs views', async () => {
    const user = userEvent.setup();
    show(severityBlock());
    const high = screen.getByTestId('severity-breakdown').querySelector('tr[data-level="high"]') as HTMLElement;
    const toggle = within(high).getByRole('button', { name: /^High \(8, 7, 55\)\s*, list its rules$/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    const list = within(panel).getByRole('list', { name: 'High rules' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const logs = within(list).getByRole('link', { name: 'Open in Logs: Web scanner user agent detected, High' });
    const params = new URLSearchParams(logs.getAttribute('href')!.split('?')[1]);
    expect(params.get('severity')).toBe('high');
    expect(params.get('rule')).toBe('Web scanner user agent detected');
    expect(within(panel).getByRole('link', { name: 'Open High events in Logs' })).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Open rule Web scanner user agent detected' }));
    expect(getRuleSheetRequest()).toMatchObject({ rule: 'Web scanner user agent detected', origin: 'your answer' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(getRuleSheetRequest()).toBeNull());
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the top rules as links, and drops Trend and Top on a narrow card', () => {
    show(severityBlock());
    const view = screen.getByTestId('severity-breakdown');
    const headers = within(view).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual(['Severity', 'Events', 'Share', 'Trend', 'Top rules']);
    for (const h of headers.slice(3)) expect(h).toHaveClass('hidden', '@[34rem]:table-cell');
    expect(view).toHaveClass('@container');
    const top = within(view).getByRole('list', { name: 'Critical top rules' });
    expect(within(top).getByRole('button', { name: `Open rule ${SSH}` })).toBeInTheDocument();
  });

  it('splits by source without a request, and back to rules', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      show(severityBlock());
      await user.click(screen.getByTestId('severity-split-trigger'));
      expect(screen.getByRole('menuitem', { name: /Host/ })).toHaveAttribute('aria-disabled', 'true');
      await user.click(screen.getByRole('menuitemradio', { name: 'Source' }));
      const view = screen.getByTestId('severity-breakdown');
      expect(within(view).getByRole('columnheader', { name: 'Top sources' })).toBeInTheDocument();
      expect(within(view).getByRole('list', { name: 'High top sources' })).toHaveTextContent('QRadar');
      await user.click(screen.getByTestId('severity-split-trigger'));
      await user.click(screen.getByRole('menuitemradio', { name: 'None' }));
      expect(within(view).queryByRole('columnheader', { name: /^Top/ })).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('offers the rules-by-level matrix in "Show as", in the wide lane', async () => {
    const user = userEvent.setup();
    const { container } = show(severityBlock());
    await user.click(screen.getByTestId('block-menu-trigger'));
    const levels = screen.getByRole('menuitemradio', { name: 'Levels table' });
    expect(levels).toHaveAttribute('aria-checked', 'true');
    // One "Show as" group, never two.
    expect(screen.getAllByText('Show as')).toHaveLength(1);
    await user.click(screen.getByRole('menuitemradio', { name: 'Rules by level' }));
    const matrix = screen.getByTestId('severity-matrix');
    expect(matrix).toHaveTextContent('Shown as a matrix because 2 rules fall in two or more levels.');
    expect(container.querySelector('figure')).toHaveAttribute('data-block-width', 'wide');
    const cell = within(matrix).getByRole('link', { name: `Open in Logs: ${SSH}, Critical, 3 events` });
    expect(cell.getAttribute('href')).toContain('severity=critical');
  });

  it('keeps every rule name as wide as its text, 24px tall, and the level toggle 24px (44px on a phone)', async () => {
    const user = userEvent.setup();
    show(severityBlock());
    const view = screen.getByTestId('severity-breakdown');
    // Top rules: names one under another, 24px apart (no gap between their 24px boxes).
    const top = within(view).getByRole('list', { name: 'Critical top rules' });
    expect(top).not.toHaveClass('gap-0.5');
    for (const b of within(top).getAllByRole('button', { name: /^Open rule / })) expect(b).toHaveClass('inline-block', 'py-1');
    const toggle = within(view.querySelector('tr[data-level="high"]') as HTMLElement).getByTestId('severity-level-toggle');
    expect(toggle).toHaveClass('min-h-6', 'max-sm:min-h-11');
    await user.click(toggle);
    const panel = screen.getByTestId('severity-level-panel');
    const link = within(panel).getByRole('button', { name: 'Open rule Web scanner user agent detected' });
    // The wrapper takes the row's spare width, never the link (hit box = visible text).
    expect(link).not.toHaveClass('flex-1');
    expect(link).toHaveClass('inline-block', 'py-1');
    expect(link.closest('li')?.firstElementChild).toHaveClass('flex-1');
    expect(link.closest('li')?.firstElementChild?.contains(link)).toBe(true);
    const logs = within(panel).getByRole('link', { name: 'Open in Logs: Web scanner user agent detected, High' });
    expect(logs).not.toHaveAttribute('title');
  });

  it('keeps a level row on one line on a phone: the counts on the badge line and the help tip beside its badge', () => {
    show(severityBlock());
    const view = screen.getByTestId('severity-breakdown');
    const high = view.querySelector('tr[data-level="high"]') as HTMLElement;
    const toggle = within(high).getByTestId('severity-level-toggle');
    // The 44px phone target hands its extra height back to the 8px cell padding, so the
    // row is the target's 44px (36px elsewhere) and the toggle spans it.
    expect(toggle).toHaveClass('min-h-6', '-my-0.5', 'max-sm:min-h-11', 'max-sm:-my-2');
    // The counts move down to the badge's centre line on a phone, in that row only.
    const [, count, share] = Array.from(high.querySelectorAll('td'));
    expect(count).toHaveTextContent('7');
    expect(count).toHaveClass('align-top', 'max-sm:pt-3');
    expect(share).toHaveClass('align-top', 'max-sm:pt-3');
    const medium = view.querySelector('tr[data-level="medium"]') as HTMLElement;
    expect(within(medium).queryByTestId('severity-level-toggle')).toBeNull();
    for (const cell of Array.from(medium.querySelectorAll('td')).slice(1)) expect(cell).not.toHaveClass('max-sm:pt-3');
    // The help tip never wraps away from its badge; a long raw-value list wraps inside the
    // chip on a phone instead of widening the table.
    const tip = within(high).getByRole('button', { name: 'What High means here' });
    const line = toggle.parentElement as HTMLElement;
    expect(line).toBe(tip.parentElement);
    expect(line).toHaveClass('flex', 'items-center');
    expect(line).not.toHaveClass('flex-wrap');
    expect(within(toggle).getByText(/^High \(8, 7, 55\)$/)).toHaveClass('whitespace-nowrap', 'max-sm:whitespace-normal');
    expect(toggle).toHaveClass('text-left');
    // A row without a toggle indents its badge by the chevron and its gap, so the badges
    // of every level start on one line.
    expect(toggle).toHaveClass('gap-1');
    expect(within(medium).getByText(/^Medium$/).closest('span.pl-5')).not.toBeNull();
    // Phone padding: 12px at the table's outer edges, 16px gutters between the columns.
    const heads = Array.from(view.querySelectorAll('thead th'));
    expect(heads[0]).toHaveClass('max-sm:pl-3', 'max-sm:pr-2');
    expect(heads[1]).toHaveClass('max-sm:px-2');
    expect(heads[2]).toHaveClass('max-sm:pl-2', 'max-sm:pr-3');
    const [first] = Array.from(high.querySelectorAll('td'));
    expect(first).toHaveClass('max-sm:pl-3', 'max-sm:pr-2');
    expect(count).toHaveClass('max-sm:px-2');
    expect(share).toHaveClass('max-sm:pl-2', 'max-sm:pr-3');
  });

  it('hides "Split by" while rules by level are shown (the matrix ignores it)', async () => {
    const user = userEvent.setup();
    show(severityBlock());
    expect(screen.getByTestId('severity-split-trigger')).toBeInTheDocument();
    await user.click(screen.getByTestId('block-menu-trigger'));
    await user.click(screen.getByRole('menuitemradio', { name: 'Rules by level' }));
    expect(screen.getByTestId('severity-matrix')).toBeInTheDocument();
    expect(screen.queryByTestId('severity-split-trigger')).toBeNull();
  });

  it('on a narrow card, offers "Split by" in the card menu and keeps the header for the title', async () => {
    const user = userEvent.setup();
    show(severityBlock(), { compact: true });
    expect(screen.queryByTestId('severity-split-trigger')).toBeNull();
    await user.click(screen.getByTestId('block-menu-trigger'));
    expect(screen.getByText('Split by')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Host/ })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('menuitemradio', { name: 'Source' }));
    expect(within(screen.getByTestId('severity-breakdown')).getByRole('columnheader', { name: 'Top sources' })).toBeInTheDocument();
  });

  it('says counts open Logs only when a matrix cell is a Logs link (never for cases)', async () => {
    const user = userEvent.setup();
    const block = severityBlock();
    const sev = block.severity!;
    const cases = {
      ...block,
      severity: {
        ...sev,
        subject: 'cases' as const,
        multi_level_rules: 1,
        levels: sev.levels.map((l) => ({ ...l, drill: { page: 'cases' as const } })),
      },
    };
    show(cases);
    await user.click(screen.getByTestId('block-menu-trigger'));
    await user.click(screen.getByRole('menuitemradio', { name: 'Rules by level' }));
    const note = screen.getByTestId('severity-matrix-note');
    expect(note).toHaveTextContent('Darker means more; the colour is not a severity.');
    expect(note).not.toHaveTextContent(/in Logs/);
    expect(within(screen.getByTestId('severity-matrix')).queryByRole('link')).toBeNull();
  });

  it('writes no em dash, no en dash as punctuation and never the retired procedure word', async () => {
    const user = userEvent.setup();
    show(severityBlock());
    const strings = () => [
      document.body.textContent ?? '',
      ...Array.from(document.body.querySelectorAll('[aria-label], [title]')).flatMap((el) => [
        el.getAttribute('aria-label') ?? '',
        el.getAttribute('title') ?? '',
      ]),
    ];
    const check = () => {
      for (const text of strings()) {
        expect(text).not.toMatch(/\u2014/);
        expect(text).not.toMatch(/\s\u2013\s/);
        expect(text).not.toMatch(/playbook/i);
      }
    };
    check();
    // An opened level.
    await user.click(within(screen.getByTestId('severity-breakdown').querySelector('tr[data-level="high"]') as HTMLElement).getByTestId('severity-level-toggle'));
    check();
    // The Split by menu.
    await user.click(screen.getByTestId('severity-split-trigger'));
    check();
    await user.keyboard('{Escape}');
    // The matrix.
    await user.click(screen.getByTestId('block-menu-trigger'));
    check();
    await user.click(screen.getByRole('menuitemradio', { name: 'Rules by level' }));
    check();
  });

  it('does not offer the matrix when no rule spans two levels', async () => {
    const user = userEvent.setup();
    const block = severityBlock();
    show({ ...block, severity: { ...block.severity!, multi_level_rules: 0 } });
    await user.click(screen.getByTestId('block-menu-trigger'));
    expect(screen.queryByRole('menuitemradio', { name: 'Rules by level' })).toBeNull();
  });

  it('prints the plain table the exports use', () => {
    render(<BlockBody block={severityBlock()} title="Events by severity" index={0} staticMode />);
    expect(screen.queryByTestId('severity-breakdown')).toBeNull();
    expect(screen.getByText('High (8, 7, 55)')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('the case entity card (F7)', () => {
  const caseCard = (facts: EntityBlock['facts']) =>
    parseBlock({
      id: 'case-card',
      type: 'entity',
      provenance: 'code',
      artifact_kind: 'entity',
      allowed_views: ['entity'],
      entity: { kind: 'ip', value: '203.0.113.9' },
      facts,
      reputation: [],
      counts: [],
      related_cases: [],
    }) as EntityBlock;

  it('names the case by number and its status in words', () => {
    show(
      caseCard([
        { label: 'Case', value: 'CASE-000214' },
        { label: 'Status', value: 'needs_human' },
      ]),
    );
    const card = screen.getByTestId('block-entity');
    expect(within(card).getByText('CASE-000214')).toBeInTheDocument();
    expect(within(card).getByText('Open · awaiting analyst')).toBeInTheDocument();
  });

  it.each([
    ['two rules the server joined', `${SSH}, web_scan`],
    ['a rule whose own name holds a comma', 'Multiple failed logins, then success'],
    ['a list the server clamped', 'a, b…'],
  ])('shows an older Rules fact (no items) as written, never split into rule links (%s)', (_name, value) => {
    // The fact is display text (joined, cleaned and clamped by the server), so no part of
    // it is an exact rule value a drill may be built from (SPEC §4.6.3): only the rules the
    // server lists one by one, each with its own ref, become links.
    show(caseCard([{ label: 'Rules', value, untrusted: true }]));
    const card = screen.getByTestId('block-entity');
    expect(within(card).queryByRole('button', { name: /^Open rule / })).toBeNull();
    const shown = within(card).getByText(value);
    expect(shown).toHaveClass('font-mono');
  });

  it('shows a stored internal id the queue way, never the bare id', () => {
    const id = 'case-95928c4b1e2d4f6a8b0c1d2e3f405162';
    show(caseCard([{ label: 'Case', value: id }]));
    const card = screen.getByTestId('block-entity');
    const ref = card.querySelector('[data-case-ref="id"]')!;
    expect(ref).toHaveAttribute('title', id);
    expect(ref.querySelector('[aria-hidden]')?.textContent).not.toBe(id);
    expect(within(card).getByRole('link', { name: id })).toHaveAttribute('href', `#/case_manager?caseId=${id}`);
  });
});

describe('RowTrend', () => {
  afterAll(() => undefined);
  it('in line mode, draws a lone measured point between gaps as a dot and the rest as lines', () => {
    const { container } = render(<RowTrend points={[5, null, 3, null, 4, 6, 7]} />);
    expect(screen.getByTestId('row-trend')).toHaveAttribute('data-shape', 'line');
    expect(container.querySelectorAll('circle[data-trend-dot]')).toHaveLength(2);
    expect(container.querySelectorAll('polyline')).toHaveLength(1);
  });

  it('draws dots for fewer than five points and says when nothing was measured', () => {
    const { rerender } = render(<RowTrend points={[1, 3, 2]} />);
    expect(screen.getByTestId('row-trend')).toHaveAttribute('data-shape', 'dots');
    rerender(<RowTrend points={[null, null]} />);
    expect(screen.getByTestId('row-trend')).toHaveTextContent('No trend measured.');
  });
});
