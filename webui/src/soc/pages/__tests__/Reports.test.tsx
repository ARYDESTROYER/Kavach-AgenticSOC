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
vi.mock('@/soc/auth', () => ({ useAuth: () => ({ username: 'ana', hasPermission: () => true }) }));
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
});

describe('Reports library', () => {
  it('lists reports with template, items and source, and filters by search', async () => {
    const user = userEvent.setup();
    show();
    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Reports' });
    expect(within(table).getByRole('button', { name: 'Brute force on vpn-gw-2' })).toBeInTheDocument();
    expect(within(table).getByText('Shift handoff')).toBeInTheDocument();
    expect(screen.getByText('of 100 reports')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Search reports' }), 'night');
    expect(within(table).queryByRole('button', { name: 'Brute force on vpn-gw-2' })).toBeNull();
    expect(within(table).getByRole('button', { name: 'Night shift handoff' })).toBeInTheDocument();
  });

  it('names each source conversation, or says it no longer exists', async () => {
    api.listReports.mockResolvedValue([...ROWS, { ...ROWS[0], id: 'rep-3', title: 'Old hunt', conversation_id: 'conv-gone' }]);
    const user = userEvent.setup();
    show();
    const table = await screen.findByRole('table', { name: 'Reports' });
    const link = await within(table).findByRole('button', { name: 'Open the source conversation of Brute force on vpn-gw-2: VPN brute force' });
    expect(link).toHaveTextContent('VPN brute force');
    // The listing holds every conversation, so one it lacks is gone.
    expect(within(table).getByText('Conversation no longer available')).toBeInTheDocument();
    await user.click(link);
    expect(navigate).toHaveBeenLastCalledWith('chat', { conversationId: 'conv-1' });
  });

  it('exports a list row with the same source facts as the document view', async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Actions for Brute force on vpn-gw-2' }));
    // Keyboard path through the submenu (Radix sub-menus open on ArrowRight).
    const sub = await screen.findByRole('menuitem', { name: 'Export' });
    act(() => sub.focus());
    await user.keyboard('{ArrowRight}');
    const md = await screen.findByRole('menuitem', { name: 'Markdown (.md)' });
    await waitFor(() => expect(md).toHaveFocus());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(api.getConversation).toHaveBeenCalledWith('conv-1');
    const options = (exportReport.mock.calls[0] as unknown as [unknown, string, { sourceTurns: Map<string, unknown>; conversationStatus: Map<string, string> }])[2];
    expect(options.sourceTurns.has('msg-2')).toBe(true);
    expect(options.conversationStatus.get('conv-1')).toBe('read');
    expect(options.conversationStatus.get('conv-gone')).toBe('gone');
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
    // The deleted conversation's item says so; the others link back.
    await waitFor(() => expect(within(doc).getByText('Conversation no longer available')).toBeInTheDocument());
    const links = within(doc).getAllByRole('button', { name: 'Open source conversation' });
    await user.click(links[0]);
    expect(navigate).toHaveBeenLastCalledWith('chat', { conversationId: 'conv-1', messageId: 'msg-2' });
  });

  it('opens straight into a deep-linked report and goes back to the list', async () => {
    const user = userEvent.setup();
    show({ reportId: 'rep-1' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' })).toBeInTheDocument();
    expect(api.listReports).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /All reports/ }));
    expect(navigate).toHaveBeenLastCalledWith('reports');
    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument();
  });

  it('reads the report id from the router deep link', async () => {
    window.location.hash = '#/reports?reportId=rep-1';
    show();
    expect(await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' })).toBeInTheDocument();
    expect(api.getReport).toHaveBeenCalledWith('rep-1', expect.anything());
  });

  it('says so when the report no longer exists', async () => {
    api.getReport.mockRejectedValue(new ApiError(404, 'Report not found.', { detail: { code: 'report_not_found' } }));
    show({ reportId: 'rep-9' });
    expect(await screen.findByText('Could not open the report')).toBeInTheDocument();
  });

  it('exports from the document view with the defang toggle', async () => {
    const user = userEvent.setup();
    show({ reportId: 'rep-1' });
    await user.click(await screen.findByRole('button', { name: /Export/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Defang indicators/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(menu).getByRole('menuitem', { name: 'Markdown (.md)' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledWith(expect.objectContaining({ id: 'rep-1' }), 'markdown', expect.objectContaining({ defang: true, author: 'ana' })));
    expect(announce).toHaveBeenCalledWith('Markdown downloaded');
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
});
