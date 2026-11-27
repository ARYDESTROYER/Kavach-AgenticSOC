/**
 * Round 16 (SPEC §4.5 WP14): the case records are reachable from the case.
 *
 * * `CaseEvents`: the raw events behind a case, every value as text, a finding's filter,
 *   the honest unavailable states, a side sheet with Table and JSON views, Copy, an
 *   NDJSON download and "Open in Logs"; nothing is asked without `sources:read`.
 * * `CaseUsageButton`: one row per ledger call with the formula in its own numbers, the
 *   "Estimated" mark, the case chat line ("at least" when the page was cut) and the
 *   reconciliation.
 * * `AllFieldsSheet`: the stored record in a searchable tree; Copy takes the exact text;
 *   the sheet says when costs are left out.
 * * `FindingsList`: "More" and "Cites N events".
 * * `AwaitingReason`: why a candidate waits, and the gates behind it.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

const h = vi.hoisted(() => ({
  grants: new Set<string>(['cases:read', 'sources:read', 'cost:view']),
  copyText: vi.fn(async (_text: string) => true),
  downloadBlob: vi.fn((_name: string, _blob: Blob) => true),
}));

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ hasPermission: (r: string, a: string) => h.grants.has(`${r}:${a}`) }),
}));
vi.mock('@/lib/clipboard', () => ({ copyText: h.copyText }));
vi.mock('@/lib/download-blob', () => ({ downloadBlob: h.downloadBlob }));

import type { Case, CaseEventRow, CaseEventsPage, CaseUsagePage, CaseUsageRow } from '@/lib/types';
import { searchJson } from '@/soc/components/JsonTree';
import { CaseEvents, flattenRecord, logsHrefFor, timeParts } from '../CaseEvents';
import { CaseUsageButton, tierWords } from '../CaseUsageButton';
import { optsFromHash } from '@/soc/router';
import { parseLogsDeepLink } from '@/soc/pages/UnifiedLogs';
import { AllFieldsSheet } from '../AllFieldsSheet';
import { FindingsList } from '../FindingsList';
import { AwaitingReason, awaitingWords } from '../AwaitingReason';
import { costFormula, exactMoney, recomputeCost } from '../usageFormula';
import { costStep, recomputeCost as kitRecomputeCost } from '@/lib/explain/cost';
import { NotificationsSent } from '../NotificationsSent';

expect.extend(toHaveNoViolations);

const HOSTILE = '<img src=x onerror=alert(1)>';

const event = (id: string, over: Partial<CaseEventRow> = {}): CaseEventRow => ({
  id,
  ts: '2026-11-20T10:00:05+00:00',
  source_ip: '203.0.113.9',
  user: 'alice',
  host: 'web-1',
  rule: 'ssh-brute',
  severity: 'high',
  message: 'Failed password for alice',
  _raw: { event: { id }, message: 'Failed password for alice', nested: { a: [1, 2] } },
  index: 'logs-1',
  source_id: 'src-1',
  in_evidence: [],
  ...over,
});

const page = (rows: CaseEventRow[], over: Partial<CaseEventsPage> = {}): CaseEventsPage => ({
  case_id: 'case-1',
  available: true,
  reason: null,
  returned: rows.length,
  expected: rows.length,
  truncated: false,
  limit: 50,
  next_cursor: null,
  rows,
  ...over,
});

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.grants = new Set(['cases:read', 'sources:read', 'cost:view']);
  h.copyText.mockClear();
  h.downloadBlob.mockClear();
  errorSpy = vi.spyOn(console, 'error');
});
afterEach(() => {
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

describe('CaseEvents', () => {
  it('lists the events with every value as text', async () => {
    const load = vi.fn(async () => page([event('e1', { message: HOSTILE, user: HOSTILE }), event('e2')]));
    render(<CaseEvents caseId="case-1" load={load} />);
    const rows = await screen.findAllByTestId('case-event-row');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByText(HOSTILE).length).toBeGreaterThan(0);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByTestId('case-events-count')).toHaveTextContent('2 events');
    expect(load).toHaveBeenCalledWith('case-1', expect.objectContaining({ limit: 50, cursor: null }));
  });

  it('narrows the table to the events one finding cites, and clears it', async () => {
    const load = vi.fn(async () => page([event('e1'), event('e2', { in_evidence: [0] }), event('e3')]));
    const onClear = vi.fn();
    render(<CaseEvents caseId="case-1" load={load} filterEventIds={['e2', 'e9']} onClearFilter={onClear} />);
    const rows = await screen.findAllByTestId('case-event-row');
    expect(rows).toHaveLength(1);
    // One mark for a wide pane (the Rule column) and one for a narrow pane (the message
    // cell); a container query shows one of them.
    expect(within(rows[0]).getAllByText('Cited by finding 1').length).toBeGreaterThan(0);
    expect(screen.getByTestId('case-events-filter')).toHaveTextContent(
      'Showing the 2 events one finding cites. 1 could not be read from the source.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show all events' }));
    expect(onClear).toHaveBeenCalled();
  });

  it('says when the events aged out, and still offers the next page', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(
        page([], { available: false, reason: 'aged_out', expected: 120, truncated: true, next_cursor: '50' }),
      )
      .mockResolvedValueOnce(page([event('e51')], { expected: 120, truncated: true, next_cursor: '100' }));
    render(<CaseEvents caseId="case-1" load={load} />);
    expect(await screen.findByTestId('case-events-unavailable')).toHaveTextContent('These events are no longer in the source.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more events' }));
    });
    expect(load).toHaveBeenLastCalledWith('case-1', expect.objectContaining({ cursor: '50' }));
    expect(await screen.findAllByTestId('case-event-row')).toHaveLength(1);
    expect(screen.getByTestId('case-events-count')).toHaveTextContent('1 of 120 events shown');
  });

  it('says a push source keeps no copy', async () => {
    const load = vi.fn(async () =>
      page([], { available: false, reason: 'push_source_not_retrievable', expected: 4 }),
    );
    render(<CaseEvents caseId="case-1" load={load} />);
    expect(await screen.findByTestId('case-events-unavailable')).toHaveAttribute('data-reason', 'push_source_not_retrievable');
    expect(screen.queryByRole('button', { name: 'Load more events' })).toBeNull();
  });

  it('asks nothing without permission to read sources', () => {
    h.grants.delete('sources:read');
    const load = vi.fn();
    render(<CaseEvents caseId="case-1" load={load} />);
    expect(screen.getByText('You cannot see the raw events. They need permission to read sources.')).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it('opens one event with a Table view and a JSON view that copies the exact record', async () => {
    const row = event('e1', { _raw: { message: HOSTILE, deep: { list: [1, 'two'] } } });
    render(<CaseEvents caseId="case-1" load={vi.fn(async () => page([row]))} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Open event 2026-11-20 10:00:05 UTC$/ }));
    const sheet = await screen.findByRole('dialog');
    const fields = within(sheet).getByTestId('case-event-fields');
    expect(within(fields).getByText('deep.list[1]')).toBeInTheDocument();
    expect(within(fields).getByText(JSON.stringify(HOSTILE))).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('radio', { name: 'JSON' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy JSON' }));
    await waitFor(() => expect(h.copyText).toHaveBeenCalled());
    expect(JSON.parse(h.copyText.mock.calls[0][0])).toEqual(row._raw);
    expect(document.querySelector('img')).toBeNull();
  });

  it('returns focus to the row it opened from when the event sheet closes', async () => {
    render(<CaseEvents caseId="case-1" load={vi.fn(async () => page([event('e1'), event('e2', { ts: '2026-11-20T10:00:09+00:00' })]))} />);
    const second = await screen.findByRole('button', { name: /^Open event 2026-11-20 10:00:09 UTC$/ });
    second.focus();
    fireEvent.click(second);
    const sheet = await screen.findByRole('dialog');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(second));
  });

  it('downloads the shown events as NDJSON and links them to Logs', async () => {
    render(<CaseEvents caseId="case-1" load={vi.fn(async () => page([event('e1'), event('e2')]))} />);
    await screen.findAllByTestId('case-event-row');
    fireEvent.click(screen.getByRole('button', { name: 'Download these events (NDJSON)' }));
    const [name, blob] = h.downloadBlob.mock.calls[0];
    expect(name).toBe('case-1-events.ndjson');
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    const lines = text.trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(['e1', 'e2']);
    const link = screen.getByRole('link', { name: 'Open in Logs' });
    expect(link.getAttribute('href')).toBe(logsHrefFor([event('e1'), event('e2')]));
    expect(link.getAttribute('href')).toContain('sourceId=src-1');
    expect(link.getAttribute('href')).toContain('rule=ssh-brute');
  });

  it('leaves out a rule the Logs page would refuse, so the link still opens the window', () => {
    // Logs ignores a link whole when one part breaks its grammar (a control character,
    // more than 256 characters); the source and the window must still reach it.
    for (const rule of ['ssh\u0007brute', 'x'.repeat(257), '   ']) {
      const href = logsHrefFor([event('e1', { rule })]) ?? '';
      window.location.hash = href;
      const link = parseLogsDeepLink(optsFromHash());
      expect(link).not.toBeNull();
      expect(link?.sourceId).toBe('src-1');
      expect(link?.from).toBeTruthy();
      expect(link?.rule).toBeUndefined();
    }
    window.location.hash = logsHrefFor([event('e1')]) ?? '';
    expect(parseLogsDeepLink(optsFromHash())?.rule).toBe('ssh-brute');
    window.location.hash = '';
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CaseEvents caseId="case-1" load={vi.fn(async () => page([event('e1')]))} />);
    await screen.findAllByTestId('case-event-row');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('splits a time into its date and clock for a narrow pane, and keeps other text whole', () => {
    expect(timeParts('2026-11-20 10:00:05 UTC')).toEqual(['2026-11-20', '10:00:05 UTC']);
    expect(timeParts('Time not recorded')).toEqual(['Time not recorded']);
  });

  it('flattens a record to paths and values', () => {
    expect(flattenRecord({ a: { b: [1, 'x'] }, c: {} }).fields).toEqual([
      { path: 'a.b[0]', text: '1' },
      { path: 'a.b[1]', text: '"x"' },
      { path: 'c', text: '{}' },
    ]);
  });
});

const usageRow = (over: Partial<CaseUsageRow> = {}): CaseUsageRow => ({
  ts: '2026-11-20T10:00:05Z',
  surface: 'pipeline',
  case_id: 'case-1',
  role: 'investigator',
  model: 'gpt-test',
  prompt_tokens: 2000,
  completion_tokens: 300,
  total_tokens: 2300,
  cost: 0.0055,
  currency: 'USD',
  latency_ms: 1840,
  outcome: 'ok',
  pricing_source: 'exact',
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  batch: false,
  processing_tier: 'standard',
  failure_class: '',
  attempts: 1,
  usage_estimated: false,
  input_rate_per_million: 1.25,
  output_rate_per_million: 10,
  cache_read_rate_per_million: 0.125,
  cache_write_rate_per_million: 1.5625,
  cache_write_ttl: '5m',
  price_basis: 'catalog',
  ...over,
});

const usagePage = (rows: CaseUsageRow[], over: Partial<CaseUsagePage> = {}): CaseUsagePage => ({
  case_id: 'case-1',
  rows,
  returned: rows.length,
  rows_total: rows.length,
  truncated: false,
  totals: { pipeline: 0.0055, chat: 0.0021, other: 0 },
  token_cost: 0.0055,
  reconciles: true,
  ...over,
});

describe('the usage formula', () => {
  it('recomputes a cost from its own rates, Batch halved, and reads an unrated row as stored', () => {
    expect(recomputeCost(usageRow())).toBe(0.0055);
    expect(recomputeCost(usageRow({ batch: true }))).toBe(0.00275);
    expect(recomputeCost(usageRow({ cache_read_tokens: 4000 }))).toBe(0.006);
    expect(recomputeCost(usageRow({ input_rate_per_million: null }))).toBeNull();
    expect(costFormula(usageRow())).toBe('(2,000 x $1.25 + 300 x $10) / 1,000,000 = $0.0055');
    expect(costFormula(usageRow({ batch: true }))).toBe('(2,000 x $1.25 + 300 x $10) / 1,000,000 x 0.5 (Batch) = $0.00275');
    expect(costFormula(usageRow({ input_rate_per_million: undefined }))).toBeNull();
  });

  it('prints the Explain kit arithmetic, with the ledger precision and the tier by name (WP16)', () => {
    // One recompute and one expression for the popover and a cost explanation.
    expect(recomputeCost).toBe(kitRecomputeCost);
    const cached = usageRow({ cache_read_tokens: 4000, cache_read_rate_per_million: 0.125 });
    expect(costFormula(cached)).toBe(`${costStep(cached).expression} = $0.0060`);
    // The kit names any half-price row Batch; the popover names a Flex call Flex.
    const flex = usageRow({ batch: true, processing_tier: 'flex' });
    expect(costStep(flex).expression).toMatch(/x 0\.5 \(Batch\)$/);
    expect(costFormula(flex)).toMatch(/\) \/ 1,000,000 x 0\.5 \(Flex\) = \$0\.00275$/);
  });

  it('ends the formula in the amount to the ledger precision, never $0.0000 for a call that cost something', () => {
    const tiny = usageRow({ prompt_tokens: 100, completion_tokens: 0, input_rate_per_million: 0.15, cost: 0.000015 });
    expect(costFormula(tiny)).toBe('(100 x $0.15 + 0 x $10) / 1,000,000 = $0.000015');
    expect(exactMoney(1.5)).toBe('$1.50');
    expect(exactMoney(0.00465)).toBe('$0.00465');
    expect(exactMoney(0)).toBe('$0.0000');
  });
});

describe('CaseUsageButton', () => {
  it('opens every AI call with its own formula, the estimated mark and the chat line', async () => {
    const load = vi.fn(async () =>
      usagePage([
        usageRow(),
        usageRow({ role: 'chat', surface: 'chat', usage_estimated: true, cost: 0.0021 }),
        usageRow({ input_rate_per_million: null, output_rate_per_million: null, price_basis: null }),
      ]),
    );
    render(<CaseUsageButton caseId="case-1" totalCost={0.0055} load={load} />);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '$0.0055, show the AI calls behind it' }));
    const dialog = await screen.findByRole('dialog', { name: 'AI usage on this case' });
    const rows = await within(dialog).findAllByTestId('case-usage-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByTestId('case-usage-formula')).toHaveTextContent('(2,000 x $1.25 + 300 x $10) / 1,000,000 = $0.0055');
    expect(within(rows[0]).getByText('Catalog price')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Estimated')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Case chat')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Rates not recorded for this call. The cost is shown as stored.')).toBeInTheDocument();
    expect(within(dialog).getByTestId('case-usage-chat')).toHaveTextContent(
      'Case chat on this case: $0.0021. Not part of the investigation cost.',
    );
    expect(within(dialog).getByTestId('case-usage-reconcile')).toHaveTextContent(
      "The investigation calls add up to the case's recorded cost.",
    );
  });

  it('reads chat as "at least" when the page was cut, and says when the calls do not add up', async () => {
    const load = vi.fn(async () =>
      usagePage([usageRow()], { truncated: true, rows_total: null, reconciles: false, token_cost: 0.01 }),
    );
    render(<CaseUsageButton caseId="case-1" totalCost={0.01} load={load} />);
    fireEvent.click(screen.getByRole('button', { name: /show the AI calls behind it/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('case-usage-chat')).toHaveTextContent('at least $0.0021');
    expect(within(dialog).getByTestId('case-usage-reconcile')).toHaveTextContent(
      'The investigation calls add up to $0.0055; the case records $0.0100.',
    );
    expect(within(dialog).getByTestId('case-usage-summary')).toHaveTextContent('Older calls are not listed.');
  });

  it('names a Flex call as Flex, not Batch, though the ledger marks both half price', async () => {
    // `llm/providers.py` sets `batch` for a Flex call; `processing_tier` tells them apart.
    const flex = usageRow({ batch: true, processing_tier: 'flex', cost: 0.00275 });
    expect(tierWords(flex)).toBe('Flex');
    expect(tierWords(usageRow({ batch: true, processing_tier: 'batch' }))).toBe('Batch');
    expect(tierWords(usageRow())).toBe('Standard tier');
    expect(costFormula(flex)).toBe('(2,000 x $1.25 + 300 x $10) / 1,000,000 x 0.5 (Flex) = $0.00275');
    render(<CaseUsageButton caseId="case-1" totalCost={0.00275} load={vi.fn(async () => usagePage([flex]))} />);
    fireEvent.click(screen.getByRole('button', { name: /show the AI calls behind it/ }));
    const [row] = await screen.findAllByTestId('case-usage-row');
    expect(within(row).getByText('Flex')).toBeInTheDocument();
    expect(within(row).queryByText('Batch')).toBeNull();
  });

  it('shows a cheap call at the ledger precision, the same amount its formula ends in', async () => {
    const tiny = usageRow({ prompt_tokens: 100, completion_tokens: 0, input_rate_per_million: 0.15, cost: 0.000015 });
    render(<CaseUsageButton caseId="case-1" totalCost={0.000015} load={vi.fn(async () => usagePage([tiny]))} />);
    fireEvent.click(screen.getByRole('button', { name: /show the AI calls behind it/ }));
    const [row] = await screen.findAllByTestId('case-usage-row');
    expect(within(row).getByText('$0.000015')).toBeInTheDocument();
    expect(within(row).queryByText('$0.0000')).toBeNull();
  });

  it("says so when a call's recorded cost is not what its rates give", async () => {
    const odd = usageRow({ cost: 0.0021 });
    render(<CaseUsageButton caseId="case-1" totalCost={0.0076} load={vi.fn(async () => usagePage([usageRow(), odd]))} />);
    fireEvent.click(screen.getByRole('button', { name: /show the AI calls behind it/ }));
    const [plain, differs] = await screen.findAllByTestId('case-usage-row');
    expect(within(plain).queryByTestId('case-usage-differs')).toBeNull();
    expect(within(differs).getByTestId('case-usage-differs')).toHaveTextContent(
      'The ledger records $0.0021 for this call, not the amount its rates give.',
    );
  });

  it('says honestly when the ledger holds no call for the case', async () => {
    const load = vi.fn(async () =>
      usagePage([], { totals: { pipeline: 0, chat: 0, other: 0 }, reconciles: false, token_cost: 0.04 }),
    );
    render(<CaseUsageButton caseId="case-1" totalCost={0.04} load={load} />);
    fireEvent.click(screen.getByRole('button', { name: /show the AI calls behind it/ }));
    expect(await screen.findByText('No AI calls are recorded in the cost ledger for this case.')).toBeInTheDocument();
  });

  it('renders nothing without a cost to show', () => {
    const { container } = render(<CaseUsageButton caseId="case-1" totalCost={null} load={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AllFieldsSheet', () => {
  const record = {
    case_id: 'case-1',
    status_reason: 'Waiting for the vendor',
    history: [{ event: 'attach', added_events: 3 }],
    precedent_signal: { status: 'not_qualified', confirmed_false_positive: 3 },
    token_cost: 0.25,
    title: HOSTILE,
  };
  const content = JSON.stringify(record, null, 2);

  it('shows every stored field, finds one by search and copies the exact record', async () => {
    const load = vi.fn(async () => ({ filename: 'case-1.json', content_type: 'application/json', content }));
    render(<AllFieldsSheet caseId="case-1" open onOpenChange={() => undefined} load={load} />);
    const sheet = await screen.findByRole('dialog', { name: 'All fields' });
    const tree = await within(sheet).findByRole('group', { name: 'Case record' });
    expect(within(tree).getByText('status_reason:')).toBeInTheDocument();
    expect(within(tree).getByText(JSON.stringify('Waiting for the vendor'))).toBeInTheDocument();
    expect(within(tree).getByText(JSON.stringify(HOSTILE))).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    fireEvent.change(within(sheet).getByLabelText('Search fields'), { target: { value: 'confirmed' } });
    expect(within(sheet).getByTestId('json-search-results')).toHaveTextContent('precedent_signal.confirmed_false_positive:');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy JSON' }));
    await waitFor(() => expect(h.copyText).toHaveBeenCalledWith(content));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Download' }));
    expect(h.downloadBlob.mock.calls[0][0]).toBe('case-1.json');
  });

  it('returns focus to the button that opened it when it closes', async () => {
    const load = vi.fn(async () => ({ filename: 'case-1.json', content_type: 'application/json', content }));
    const Host = () => {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            View all fields
          </button>
          <AllFieldsSheet caseId="case-1" open={open} onOpenChange={setOpen} load={load} />
        </>
      );
    };
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'View all fields' });
    opener.focus();
    fireEvent.click(opener);
    const sheet = await screen.findByRole('dialog', { name: 'All fields' });
    await within(sheet).findByRole('group', { name: 'Case record' });
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('says costs are left out without cost:view', async () => {
    h.grants.delete('cost:view');
    const load = vi.fn(async () => ({
      filename: 'case-1.json',
      content_type: 'application/json',
      content: JSON.stringify({ ...record, token_cost: null }),
    }));
    render(<AllFieldsSheet caseId="case-1" open onOpenChange={() => undefined} load={load} />);
    expect(await screen.findByTestId('all-fields-cost-withheld')).toHaveTextContent('Costs are left out.');
  });

  it('loads nothing while closed', () => {
    const load = vi.fn();
    render(<AllFieldsSheet caseId="case-1" open={false} onOpenChange={() => undefined} load={load} />);
    expect(load).not.toHaveBeenCalled();
  });

  it('searches keys and values with a bound', () => {
    const found = searchJson({ a: { needle: 1 }, b: ['x', 'needle here'], c: 'other' }, 'NEEDLE');
    expect(found.matches.map((m) => m.path)).toEqual(['a.needle', 'b[1]']);
    expect(searchJson({ list: Array.from({ length: 10 }, () => 'hit') }, 'hit', 3)).toMatchObject({ total: 10 });
  });
});

describe('FindingsList', () => {
  it('shows the first sentence, and the whole finding after More', () => {
    render(<FindingsList findings={[{ summary: 'One. Two. Three.', event_ids: [] }]} />);
    expect(screen.getByText('One.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByText('One. Two. Three.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the events a finding cites', () => {
    const onShowEvents = vi.fn();
    render(<FindingsList findings={[{ summary: 'Burst.', event_ids: ['e1', 'e2', 'e1'] }]} onShowEvents={onShowEvents} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cites 2 events' }));
    expect(onShowEvents).toHaveBeenCalledWith(['e1', 'e2']);
  });

  it('lists the cited ids as text with Copy when there is no table to open', async () => {
    render(<FindingsList findings={[{ summary: 'Burst.', event_ids: [HOSTILE] }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cites 1 event' }));
    expect(within(screen.getByTestId('finding-event-ids')).getByText(HOSTILE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy ids' }));
    await waitFor(() => expect(h.copyText).toHaveBeenCalledWith(HOSTILE));
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('AwaitingReason', () => {
  const candidate = (reason: string, over: Partial<Case> = {}) =>
    ({ case_id: 'case-1', verdict: null, awaiting_reason: reason, ...over }) as unknown as Case;

  it('words each reason ingest records', () => {
    expect(awaitingWords('deferred: per-tick auto-investigation cap reached; drains to investigation on a later tick')).toMatch(
      /^Waiting for a free investigation slot\./,
    );
    expect(awaitingWords('available-signal routing score 45 is below the auto-investigate floor 70')).toBe(
      'Its routing score, 45, is below the floor of 70 for an automatic investigation.',
    );
    expect(awaitingWords('automated background investigation is disabled')).toBe('Automatic investigation is turned off.');
  });

  it('opens the gates behind a waiting case, with the routing score against the floor', async () => {
    const load = vi.fn(async () => ({
      case_id: 'case-1',
      gate: 'risk_floor',
      forwarded: false,
      dropped: false,
      sentence: 'An events-role cluster scored below the auto-investigate floor.',
      notes: [],
      routing_total: 45.25,
      risk_floor: 70,
      routing_gate_applied: true,
    }));
    render(<AwaitingReason caseRecord={candidate('available-signal routing score 45 is below the auto-investigate floor 70')} load={load} />);
    fireEvent.click(screen.getByRole('button', { name: 'Why is this waiting?' }));
    const panel = await screen.findByTestId('awaiting-forwarding');
    expect(panel).toHaveTextContent('The routing score is below the floor for an automatic investigation.');
    expect(within(panel).getByTestId('awaiting-routing')).toHaveTextContent('Routing score 45.25 against a floor of 70.');
  });

  it('states the hold reason while the case is on hold, as text', () => {
    const held = { case_id: 'case-1', verdict: 'TRUE_POSITIVE', status: 'on_hold', status_reason: `Vendor ${HOSTILE}` } as unknown as Case;
    const { rerender } = render(<AwaitingReason caseRecord={held} load={vi.fn()} />);
    expect(screen.getByTestId('hold-reason')).toHaveTextContent(`On hold: Vendor ${HOSTILE}`);
    expect(document.querySelector('img')).toBeNull();
    rerender(<AwaitingReason caseRecord={{ ...held, status: 'investigating' } as Case} load={vi.fn()} />);
    expect(screen.queryByTestId('hold-reason')).toBeNull();
  });

  it('renders nothing for a case the AI assessed, or one with no reason', () => {
    const { container, rerender } = render(<AwaitingReason caseRecord={candidate('deferred: x', { verdict: 'FALSE_POSITIVE' })} load={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AwaitingReason caseRecord={candidate('')} load={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('NotificationsSent', () => {
  const records = Array.from({ length: 7 }, (_, i) => ({
    channel_id: `ch-${i}`,
    type: 'slack',
    ok: i !== 6,
    detail: i === 6 ? HOSTILE : '',
    trigger: 'case_escalated',
    ts: `2026-11-20T10:0${i}:00Z`,
  }));

  it('shows the newest five with their channel ids, then all of them', () => {
    render(<NotificationsSent records={records} />);
    const list = screen.getByTestId('facts-notifications');
    expect(within(list).getByText('Notifications sent (7)')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list).getByText('ch-6')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent(`failed (${HOSTILE})`);
    expect(within(list).queryByText('ch-0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all (7)' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(within(list).getByText('ch-0')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders nothing without a record', () => {
    const { container } = render(<NotificationsSent records={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
