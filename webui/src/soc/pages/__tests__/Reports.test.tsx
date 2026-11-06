/**
 * Reports library (SPEC §10.6): the list (search, open, rename, delete, export), the
 * document view rendered by the shared ReportDocument, the deep link
 * `#/reports?reportId=…`, and the link back to the source conversation
 * (`navigate('chat', {conversationId, messageId})`), including a conversation that no
 * longer exists.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { ReportListEntry } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

const announce = vi.fn();
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));
const canReadCases = vi.hoisted(() => ({ value: true }));
vi.mock('@/soc/auth', () => ({ useAuth: () => ({ username: 'ana', hasPermission: () => canReadCases.value }) }));
const navigate = vi.fn();
vi.mock('@/soc/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/router')>();
  return { ...actual, useNavigateOptional: () => navigate };
});

const api = vi.hoisted(() => ({
  listReports: vi.fn(),
  getReport: vi.fn(),
  patchReport: vi.fn(),
  deleteReport: vi.fn(),
  getConversation: vi.fn(),
  listConversations: vi.fn(),
}));
vi.mock('@/soc/chat/chat-api', () => api);
const exportReport = vi.hoisted(() => vi.fn(async () => ({ ok: true, message: 'Markdown downloaded' })));
vi.mock('@/soc/chat/report/export/run', () => ({ exportReport }));

import { RouterProvider } from '../../router';
import Reports from '../Reports';
import { clearSourceTurnCache } from '@/soc/chat/report/useSourceTurns';
import { sampleConversation, sampleReport } from '@/soc/chat/report/__tests__/fixtures';
import { SCREEN_DOC_ID, screenPrintCss } from '@/soc/chat/report/print-fallback';

const ROWS: ReportListEntry[] = [
  { id: 'rep-1', title: 'Brute force on vpn-gw-2', template: 'investigation', conversation_id: 'conv-1', item_count: 6, updated_at: '2026-10-08T13:40:00Z', version: 5 },
  { id: 'rep-2', title: 'Night shift handoff', template: 'shift', conversation_id: null, item_count: 2, updated_at: '2026-10-07T07:00:00Z', version: 2 },
];

function show(props: React.ComponentProps<typeof Reports> = {}) {
  return render(
    <TooltipProvider>
      <RouterProvider>
        <Reports {...props} />
      </RouterProvider>
    </TooltipProvider>,
  );
}

/**
 * The Reports table once its rows are in. The table (named "Reports") is on screen from
 * the first paint, holding its loading rows, so wait for it to stop being busy.
 */
async function findLoadedTable(): Promise<HTMLElement> {
  const table = await screen.findByRole('table', { name: 'Reports' });
  await waitFor(() => expect(table.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false'));
  return table;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  exportReport.mockClear();
  announce.mockClear();
  navigate.mockClear();
  clearSourceTurnCache();
  api.listReports.mockResolvedValue(ROWS);
  api.listConversations.mockResolvedValue({ conversations: [{ id: 'conv-1', title: 'VPN brute force', created_at: '', updated_at: '', message_count: 2 }] });
  api.getReport.mockResolvedValue(sampleReport());
  api.getConversation.mockImplementation(async (id: string) => {
    if (id === 'conv-1') return sampleConversation();
    throw new ApiError(404, 'Not found', { detail: 'Conversation not found' });
  });
});
afterEach(() => {
  window.location.hash = '';
  canReadCases.value = true;
});

describe('Reports library', () => {
  it('lists reports with template, items and source, and filters by search', async () => {
    const user = userEvent.setup();
    show();
    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument();
    const table = await findLoadedTable();
    expect(within(table).getByRole('button', { name: 'Brute force on vpn-gw-2' })).toBeInTheDocument();
    expect(within(table).getByText('Shift handoff')).toBeInTheDocument();
    // Round 14: the list sits on one "Saved reports" panel with its count; the cap is said
    // only when it applies (it does not here).
    const panel = screen.getByRole('region', { name: 'Saved reports' });
    expect(panel).toContainElement(table);
    expect(panel.querySelector('[data-panel-count]')).toHaveTextContent(/^2$/);
    expect(screen.queryByText(/limit/i)).toBeNull();

    await user.type(screen.getByRole('textbox', { name: 'Search reports' }), 'night');
    expect(within(table).queryByRole('button', { name: 'Brute force on vpn-gw-2' })).toBeNull();
    expect(within(table).getByRole('button', { name: 'Night shift handoff' })).toBeInTheDocument();
  });

  it('names each source conversation, or says it no longer exists', async () => {
    api.listReports.mockResolvedValue([...ROWS, { ...ROWS[0], id: 'rep-3', title: 'Old hunt', conversation_id: 'conv-gone' }]);
    const user = userEvent.setup();
    show();
    const table = await findLoadedTable();
    const link = await within(table).findByRole('button', { name: 'Open the source conversation of Brute force on vpn-gw-2: VPN brute force' });
    expect(link).toHaveTextContent('VPN brute force');
    // The listing holds every conversation, so one it lacks is gone.
    expect(within(table).getByText('Conversation no longer available')).toBeInTheDocument();
    await user.click(link);
    expect(navigate).toHaveBeenLastCalledWith('chat', { conversationId: 'conv-1' });
  });

  it('links a report saved from an answer or a conversation to its source conversation', async () => {
    api.listReports.mockResolvedValue([
      // Saved from chat: not that conversation's draft, but it came from it.
      { ...ROWS[1], id: 'rep-4', title: 'Lifetime performance', conversation_id: null, source_conversation_id: 'conv-1' },
      // Items from several conversations (or none): no single source.
      { ...ROWS[1], id: 'rep-5', title: 'Mixed', conversation_id: null, source_conversation_id: null },
    ]);
    const user = userEvent.setup();
    show();
    const table = await findLoadedTable();
    const link = await within(table).findByRole('button', { name: 'Open the source conversation of Lifetime performance: VPN brute force' });
    expect(link).toHaveTextContent('VPN brute force');
    const mixed = within(table).getByRole('button', { name: 'Mixed' }).closest('tr')!;
    expect(within(mixed).getByText('—')).toBeInTheDocument();
    await user.click(link);
    expect(navigate).toHaveBeenLastCalledWith('chat', { conversationId: 'conv-1' });
  });

  it('exports a list row with the same source facts as the document view', async () => {
    const user = userEvent.setup();
    show();
    // A flat Export menu per row (Round 12 WP-REP: no sub-menu under ⋯).
    await user.click(await screen.findByRole('button', { name: 'Export Brute force on vpn-gw-2' }));
    const md = await screen.findByRole('menuitem', { name: 'Markdown (.md)' });
    await user.click(md);
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(api.getConversation).toHaveBeenCalledWith('conv-1');
    const options = (exportReport.mock.calls[0] as unknown as [unknown, string, { sourceTurns: Map<string, unknown>; conversationStatus: Map<string, string> }])[2];
    expect(options.sourceTurns.has('msg-2')).toBe(true);
    expect(options.conversationStatus.get('conv-1')).toBe('read');
    expect(options.conversationStatus.get('conv-gone')).toBe('gone');
  });

  it('explains a missing cases:read grant instead of failing on a 403', async () => {
    canReadCases.value = false;
    show();
    expect(await screen.findByText('Reports need access to cases')).toBeInTheDocument();
    expect(api.listReports).not.toHaveBeenCalled();
    // Round 14: the shell's header is the Overview grammar, title plus help, no overline.
    const h1 = screen.getByRole('heading', { level: 1, name: 'Reports' });
    const header = h1.closest('[data-page-header]') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'About Reports' })).toBeInTheDocument();
    expect(within(header).queryByText('Workspace')).toBeNull();
  });

  it('shows a first-use state when there are no reports', async () => {
    api.listReports.mockResolvedValue([]);
    show();
    expect(await screen.findByText('No reports yet')).toBeInTheDocument();
  });

  it('opens the document view and links each item back to its conversation', async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Brute force on vpn-gw-2' }));
    expect(navigate).toHaveBeenCalledWith('reports', { reportId: 'rep-1' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' })).toBeInTheDocument();
    const doc = document.querySelector('[data-report-document="screen"]') as HTMLElement;
    expect(doc).toHaveTextContent('AI-generated; verify before acting.');
    expect(doc).toHaveTextContent('Methodology & limitations');
    expect(doc).toHaveTextContent('Appendix: queries');
    // The screen stamp is the report's last change, and conversations go by title only.
    await waitFor(() => expect(doc).toHaveTextContent('Source conversations: VPN brute force, conv-gone'));
    expect(doc).toHaveTextContent('Updated 2026-10-08 13:40');
    expect(doc).not.toHaveTextContent('(conv-1)');
    // The deleted conversation's item says so; the others link back.
    await waitFor(() => expect(within(doc).getByText('Conversation no longer available')).toBeInTheDocument());
    const links = within(doc).getAllByRole('button', { name: 'Open source conversation' });
    await user.click(links[0]);
    expect(navigate).toHaveBeenLastCalledWith('chat', { conversationId: 'conv-1', messageId: 'msg-2' });
  });

  it('opens straight into a deep-linked report and links back to the list', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/reports?reportId=rep-1';
    show();
    expect(await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' })).toBeInTheDocument();
    expect(api.listReports).not.toHaveBeenCalled();
    // "All reports" is the page header's one sanctioned link (SPEC §4.9.3), above the
    // title, followed through the router.
    const back = screen.getByRole('link', { name: 'All reports' });
    expect(back).toHaveAttribute('href', '#/reports');
    await user.click(back);
    expect(navigate.mock.lastCall?.[0]).toBe('reports');
    // The router follows it: the URL is the list, so the page is the list.
    act(() => {
      window.location.hash = '#/reports';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument();
  });

  it('reads the report id from the router deep link', async () => {
    window.location.hash = '#/reports?reportId=rep-1';
    show();
    expect(await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' })).toBeInTheDocument();
    expect(api.getReport).toHaveBeenCalledWith('rep-1', expect.anything());
  });

  it('follows browser Back and Forward between a report and the list', async () => {
    window.location.hash = '#/reports?reportId=rep-1';
    show();
    expect(await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' })).toBeInTheDocument();
    const go = (hash: string) =>
      act(() => {
        window.location.hash = hash;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
    // Back: the URL is the list, so the page is the list (never the stale document).
    go('#/reports');
    expect(await findLoadedTable()).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull();
    // Forward: the document again.
    go('#/reports?reportId=rep-1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' })).toBeInTheDocument();
  });

  it('says so when the report no longer exists', async () => {
    api.getReport.mockRejectedValue(new ApiError(404, 'Report not found.', { detail: { code: 'report_not_found' } }));
    show({ reportId: 'rep-9' });
    expect(await screen.findByText('Could not open the report')).toBeInTheDocument();
  });

  it('exports from the document view with the defang toggle', async () => {
    const user = userEvent.setup();
    show({ reportId: 'rep-1' });
    await user.click(await screen.findByTestId('report-export-trigger'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Defang indicators/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(menu).getByRole('menuitem', { name: 'Markdown (.md)' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledWith(expect.objectContaining({ id: 'rep-1' }), 'markdown', expect.objectContaining({ defang: true, author: 'ana' })));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Markdown downloaded'));
  });

  it('renames and deletes from the list with the row version', async () => {
    const user = userEvent.setup();
    api.patchReport.mockResolvedValue({ ...sampleReport(), title: 'Renamed', version: 6 });
    api.deleteReport.mockResolvedValue(undefined);
    show();
    await user.click(await screen.findByRole('button', { name: 'Actions for Night shift handoff' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByRole('textbox', { name: 'Report title' });
    await user.clear(field);
    await user.type(field, 'Renamed{Enter}');
    await waitFor(() => expect(api.patchReport).toHaveBeenCalledWith('rep-2', { expected_version: 2, title: 'Renamed' }));

    await user.click(screen.getByRole('button', { name: 'Actions for Night shift handoff' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete report' }));
    await waitFor(() => expect(api.deleteReport).toHaveBeenCalledWith('rep-2', 2));
    expect(announce).toHaveBeenCalledWith('Report deleted');
  });

  it('offers a visible Download PDF on the document view (R5/R17)', async () => {
    const user = userEvent.setup();
    exportReport.mockResolvedValueOnce({ ok: true, message: 'Print dialog opened. Choose Save as PDF.' });
    show({ reportId: 'rep-1' });
    await user.click(await screen.findByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledWith(expect.objectContaining({ id: 'rep-1' }), 'print', expect.objectContaining({ defang: true })));
  });

  it('prints the report, not the console, on Ctrl/Cmd+P from the document view (R12)', async () => {
    document.title = 'Agentic SOC';
    show({ reportId: 'rep-1' });
    await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' });
    const rootId = 'agentic-soc-report-print';
    // The print code and the static renderer preload on mount; beforeprint then mounts
    // the report's print root synchronously.
    await waitFor(
      () => {
        act(() => {
          window.dispatchEvent(new Event('beforeprint'));
        });
        expect(document.getElementById(rootId)).not.toBeNull();
      },
      { timeout: 5000 },
    );
    const root = document.getElementById(rootId)!;
    expect(root).toHaveTextContent('Brute force on vpn-gw-2');
    expect(root).toHaveTextContent('Methodology & limitations');
    expect(document.title).toMatch(/^agentic-soc-report-brute-force-on-vpn-gw-2-\d{8}-\d{4}Z$/);
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    await waitFor(() => expect(document.getElementById(rootId)).toBeNull(), { timeout: 4000 });
    expect(document.title).toBe('Agentic SOC');
  }, 15_000);

  it('falls back to printing the on-screen document when no print root mounted (R12)', async () => {
    show({ reportId: 'rep-1' });
    await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' });
    const doc = document.getElementById(SCREEN_DOC_ID)!;
    expect(doc).not.toBeNull();
    expect(doc).toHaveTextContent('Methodology & limitations');
    // The paper copy keeps the title (the page header is not printed by the fallback).
    expect(within(doc).getByTestId('report-print-title')).toHaveTextContent('Brute force on vpn-gw-2');
    expect(within(doc).getByTestId('report-print-title')).toHaveAttribute('aria-hidden', 'true');
    // The fallback stylesheet is on the page while the view is open, and stands down
    // whenever the report's own print root is mounted.
    const css = Array.from(document.querySelectorAll('style')).map((st) => st.textContent ?? '').find((t) => t.includes(SCREEN_DOC_ID));
    expect(css).toBe(screenPrintCss());
    expect(css).toContain('@media print');
    expect(css).toContain(`body:not(:has(> #agentic-soc-report-print))`);
    expect(css).toContain(`*:not(:has(#${SCREEN_DOC_ID})):not(#${SCREEN_DOC_ID}):not(#${SCREEN_DOC_ID} *) { display: none !important; }`);
    expect(css).toContain('--background:240 20% 99%;');
    // Screen-only actions inside the document never reach paper.
    for (const button of Array.from(doc.querySelectorAll('button'))) {
      if (/Open source conversation/.test(button.textContent ?? '')) expect(button).toHaveAttribute('data-print-hide');
    }
  });

  it('keeps focus on the Export trigger after a successful Retry, never on <body>', async () => {
    const user = userEvent.setup();
    exportReport.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ ok: true, message: 'HTML downloaded' });
    show({ reportId: 'rep-1' });
    await user.click(await screen.findByTestId('report-export-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'HTML (.html)' }));
    const note = await screen.findByTestId('report-export-error');
    await user.click(within(note).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('report-export-error')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('report-export-trigger'));
  });

  it('names the report whose row export failed', async () => {
    const user = userEvent.setup();
    exportReport.mockRejectedValueOnce(new Error('boom'));
    show();
    await user.click(await screen.findByRole('button', { name: 'Export Night shift handoff' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Markdown (.md)' }));
    const note = await screen.findByTestId('report-export-error');
    expect(note).toHaveTextContent('Night shift handoff: The report could not be exported. Try again.');
    exportReport.mockResolvedValueOnce({ ok: true, message: 'Markdown downloaded' });
    await user.click(within(note).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('report-export-error')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Export Night shift handoff' }));
  });
});

describe('Reports library on the Round 14 grammar (SPEC §4.9.1, §4.9.3)', () => {
  const many = (n: number): ReportListEntry[] =>
    Array.from({ length: n }, (_, i) => ({
      ...ROWS[1],
      id: `rep-${i + 10}`,
      title: `Shift handoff ${i + 1}`,
      updated_at: `2026-10-07T07:${String(i % 60).padStart(2, '0')}:00Z`,
    }));

  it('explains the library in the help tip, with no overline, icon or description line', async () => {
    const user = userEvent.setup();
    show();
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Reports' });
    const header = h1.closest('[data-page-header]') as HTMLElement;
    await findLoadedTable();
    expect(within(header).queryByText('Workspace')).toBeNull();
    expect(within(header).queryByText(/Reports you built from chat answers/)).toBeNull();
    await user.click(within(header).getByRole('button', { name: 'About Reports' }));
    expect(await screen.findByText(/Reports you built from chat answers/)).toBeInTheDocument();
  });

  it('shows the first-use state on the panel with no column header row and no search', async () => {
    api.listReports.mockResolvedValue([]);
    show();
    const panel = await screen.findByRole('region', { name: 'Saved reports' });
    expect(within(panel).getByText('No reports yet')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Open Chat' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('columnheader')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Search reports' })).toBeNull();
    expect(panel.querySelector('[data-panel-count]')).toBeNull();
  });

  it('says the cap only when it applies, and keeps the columns for a search with no match', async () => {
    const user = userEvent.setup();
    api.listReports.mockResolvedValue(many(100));
    show();
    const panel = await screen.findByRole('region', { name: 'Saved reports' });
    expect(within(panel).getByText('Limit of 100 reached. Delete a report to save a new one.')).toBeInTheDocument();
    expect(panel.querySelector('[data-panel-count]')).toHaveTextContent(/^100$/);

    await user.type(within(panel).getByRole('textbox', { name: 'Search reports' }), 'nothing like this');
    expect(panel.querySelector('[data-panel-count]')).toHaveTextContent(/^0 of 100$/);
    expect(within(panel).getByText('No matching reports')).toBeInTheDocument();
    expect(within(panel).getAllByRole('columnheader').length).toBeGreaterThan(0);
  });

  it('keeps a fixed column layout, so a search never moves the columns', async () => {
    const user = userEvent.setup();
    show();
    const table = await findLoadedTable();
    // Declared widths switch the table to a fixed layout; only the title column flexes.
    expect(table).toHaveClass('table-fixed');
    const widths = () =>
      within(table)
        .getAllByRole('columnheader')
        .map((th) => (th as HTMLElement).style.width);
    const before = widths();
    expect(before).toEqual(['', '10rem', '6rem', '14rem', '13rem', '7rem']);
    await user.type(screen.getByRole('textbox', { name: 'Search reports' }), 'night');
    expect(widths()).toEqual(before);
  });

  it('opens a report from anywhere on its row, with the title as the named action', async () => {
    const user = userEvent.setup();
    show();
    const table = await findLoadedTable();
    // A pointer click on a plain cell (the template) opens the report.
    await user.click(within(table).getByText('Investigation'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' })).toBeInTheDocument();
  });

  it('names each row by its title button, a phone-sized target, with no second Open button', async () => {
    show();
    const table = await findLoadedTable();
    const title = within(table).getByRole('button', { name: 'Brute force on vpn-gw-2' });
    expect(title).toHaveClass('min-h-11', 'sm:min-h-0');
    // DataTable's trailing row action would be "Open row rep-1" (or "Open <title>").
    expect(within(table).queryByRole('button', { name: /^Open (row |Brute|Night)/ })).toBeNull();
  });

  it('loads inside the same "Saved reports" panel the rows arrive in', async () => {
    let resolve: (rows: ReportListEntry[]) => void = () => undefined;
    api.listReports.mockReturnValue(new Promise((r) => (resolve = r)));
    show();
    const panel = await screen.findByRole('region', { name: 'Saved reports' });
    expect(within(panel).getByTestId('data-table-initial-loading')).toBeInTheDocument();
    await act(async () => resolve(ROWS));
    expect(await within(panel).findByRole('button', { name: 'Brute force on vpn-gw-2' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Saved reports' })).toBe(panel);
  });

  it('counts the matches while a search narrows the list', async () => {
    const user = userEvent.setup();
    show();
    const panel = await screen.findByRole('region', { name: 'Saved reports' });
    await user.type(within(panel).getByRole('textbox', { name: 'Search reports' }), 'night');
    expect(panel.querySelector('[data-panel-count]')).toHaveTextContent(/^1 of 2$/);
    expect(screen.queryByText(/limit/i)).toBeNull();
  });

  it('shows the item count beside the title and states the template and last update once, without the help tip', async () => {
    window.location.hash = '#/reports?reportId=rep-1';
    show();
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' });
    const header = h1.closest('[data-page-header]') as HTMLElement;
    // Visible text, read without opening anything: no help tip holds the facts.
    expect(within(header).getByTestId('report-facts')).toHaveTextContent(/^6 items$/);
    expect(within(header).getByTestId('report-facts')).toBeVisible();
    expect(within(header).queryByRole('button', { name: /^About / })).toBeNull();
    // The template and the last update are in the document's meta row right under the
    // header, once each on the page: the header never repeats them.
    expect(within(header).queryByText(/Updated|Investigation/)).toBeNull();
    const doc = document.getElementById(SCREEN_DOC_ID) as HTMLElement;
    expect(within(doc).getAllByText(/Updated 2026-10-08 13:40 UTC/)).toHaveLength(1);
    expect(within(doc).getAllByText(/Template: Investigation/)).toHaveLength(1);
    const page = document.body.textContent ?? '';
    expect(page.split('Updated 2026-10-08 13:40 UTC').length - 1).toBe(1);
    expect(page.split('Template: Investigation').length - 1).toBe(1);
    // No overline or icon chip: the only text above the title is the back link.
    expect(within(header).queryByText('Reports')).toBeNull();
    expect(header.textContent ?? '').not.toMatch(/[–—]/);
  });

  it('keeps the back link on the loading and missing states', async () => {
    api.getReport.mockRejectedValue(new ApiError(404, 'Report not found.', { detail: { code: 'report_not_found' } }));
    window.location.hash = '#/reports?reportId=rep-9';
    show();
    expect(await screen.findByText('Could not open the report')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All reports' })).toHaveAttribute('href', '#/reports');
  });
});
