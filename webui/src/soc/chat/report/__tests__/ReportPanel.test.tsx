/**
 * Report panel flows (SPEC §10.6): load and count, an add from the transcript (change
 * event), reorder and remove with announcements, note autosave after 800 ms with
 * `expected_version`, the 409 "changed elsewhere — Reload" path that keeps the typed note,
 * the dry-run summary estimate, generation and "Out of date — Regenerate", the 40-item
 * limit, delete, and the overlay focus rule.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Report } from '@/lib/types';
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
  getReport: vi.fn(),
  patchReport: vi.fn(),
  deleteReport: vi.fn(),
  estimateReportSummary: vi.fn(),
  generateReportSummary: vi.fn(),
  getConversation: vi.fn(),
}));
vi.mock('@/soc/chat/chat-api', () => api);
const exportReport = vi.hoisted(() => vi.fn(async () => ({ ok: true, message: 'Markdown downloaded' })));
vi.mock('@/soc/chat/report/export/run', () => ({ exportReport }));

import ReportPanel, { NOTE_AUTOSAVE_MS } from '../ReportPanel';
import { emitReportChanged } from '../report-sync';
import { clearSourceTurnCache } from '../useSourceTurns';
import { sampleConversation, sampleReport } from './fixtures';

function conflict(): ApiError {
  return new ApiError(409, 'This report changed elsewhere. Reload it.', {
    detail: { code: 'report_version_conflict', message: 'changed', current_version: 9 },
  });
}

function show(props: Partial<React.ComponentProps<typeof ReportPanel>> = {}) {
  const onCountChange = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <TooltipProvider>
      <ReportPanel conversationId="conv-1" reportId="rep-1" mode="split" onClose={onClose} onCountChange={onCountChange} {...props} />
    </TooltipProvider>,
  );
  return { ...utils, onCountChange, onClose };
}

const withVersion = (report: Report, version: number, patch: Partial<Report> = {}): Report => ({ ...report, version, ...patch });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  exportReport.mockClear();
  announce.mockClear();
  navigate.mockClear();
  clearSourceTurnCache();
  api.getReport.mockResolvedValue(sampleReport());
  api.getConversation.mockResolvedValue(sampleConversation());
  api.estimateReportSummary.mockResolvedValue({ prompt_tokens: 1200, max_output_tokens: 600, total_tokens: 1400, cost: 0.001, simulated: false, model: 'm' });
});
afterEach(() => vi.useRealTimers());

describe('ReportPanel', () => {
  it('loads the report, shows n/40 and reports the count', async () => {
    const { onCountChange } = show();
    expect(await screen.findByRole('button', { name: /Brute force on vpn-gw-2, rename report/ })).toBeInTheDocument();
    expect(screen.getByTestId('report-count')).toHaveTextContent('6/40');
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(6));
    expect(api.getReport).toHaveBeenCalledWith('rep-1', expect.anything());
    const items = screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-report-item'));
    expect(items).toHaveLength(6);
    expect(within(items[0]).getByText('1. Who is failing logins against vpn-gw-2?')).toBeInTheDocument();
  });

  it('shows the empty state before the first add and picks up the draft from the change event', async () => {
    const { onCountChange } = show({ reportId: null });
    expect(screen.getByTestId('report-empty')).toHaveTextContent('No report yet');
    const created = sampleReport({ items: sampleReport().items.slice(0, 1), version: 1, summary: null });
    act(() => emitReportChanged({ reportId: 'rep-1', conversationId: 'conv-1', report: created }));
    expect(await screen.findByTestId('report-count')).toHaveTextContent('1/40');
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(1));
    expect(api.getReport).not.toHaveBeenCalled();
  });

  it('ignores another conversation’s report changes', async () => {
    show({ reportId: null });
    act(() => emitReportChanged({ reportId: 'rep-x', conversationId: 'conv-other', report: sampleReport({ id: 'rep-x' }) }));
    expect(screen.getByTestId('report-empty')).toBeInTheDocument();
  });

  it('moves an item to the top with the current version and announces it', async () => {
    const user = userEvent.setup();
    const report = sampleReport();
    const moved = withVersion(report, 6, { items: [report.items[2], report.items[0], report.items[1], ...report.items.slice(3)] });
    api.patchReport.mockResolvedValue(moved);
    show();
    await user.click(await screen.findByRole('button', { name: 'Actions for item 3' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to top' }));
    await waitFor(() =>
      expect(api.patchReport).toHaveBeenCalledWith('rep-1', {
        expected_version: 5,
        item_order: ['it-3', 'it-1', 'it-2', 'it-4', 'it-5', 'it-6'],
      }),
    );
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Moved Alerts by source to position 1 of 6'));
  });

  it('disables impossible moves', async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Actions for item 1' }));
    expect(await screen.findByRole('menuitem', { name: 'Move up' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Move to top' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Move down' })).not.toHaveAttribute('aria-disabled');
  });

  it('removes an item and announces the new count', async () => {
    const user = userEvent.setup();
    const report = sampleReport();
    api.patchReport.mockResolvedValue(withVersion(report, 6, { items: report.items.slice(1) }));
    const { onCountChange } = show();
    await user.click(await screen.findByRole('button', { name: 'Actions for item 1' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await waitFor(() => expect(api.patchReport).toHaveBeenCalledWith('rep-1', { expected_version: 5, remove_items: ['it-1'] }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Removed from report (5 items)'));
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(5));
  });

  it('autosaves a note 800 ms after typing stops, with expected_version', async () => {
    const user = userEvent.setup();
    const report = sampleReport();
    api.patchReport.mockImplementation(async (_id: string, body: { notes: Record<string, string> }) =>
      withVersion(report, 6, { items: report.items.map((i) => (i.id === 'it-3' ? { ...i, note: body.notes['it-3'] } : i)) }),
    );
    show();
    const note = await screen.findByRole('textbox', { name: 'Note for item 3' });
    await user.type(note, 'Spike at 07:00');
    expect(api.patchReport).not.toHaveBeenCalled();
    await waitFor(() => expect(api.patchReport).toHaveBeenCalledTimes(1), { timeout: NOTE_AUTOSAVE_MS + 1500 });
    expect(api.patchReport).toHaveBeenCalledWith('rep-1', { expected_version: 5, notes: { 'it-3': 'Spike at 07:00' } });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('keeps the typed note on a 409, offers Reload, then lets the analyst save it', async () => {
    const user = userEvent.setup();
    const report = sampleReport();
    api.patchReport.mockRejectedValueOnce(conflict());
    show();
    const note = await screen.findByRole('textbox', { name: 'Note for item 3' });
    await user.type(note, 'My finding');
    const banner = await screen.findByTestId('report-conflict', {}, { timeout: NOTE_AUTOSAVE_MS + 1500 });
    expect(banner).toHaveTextContent('This report changed elsewhere');
    expect(note).toHaveValue('My finding');
    expect(announce).toHaveBeenCalledWith('This report changed elsewhere. Reload to continue editing.');

    // Reload brings the newer version; the typed note survives, explicitly unsaved.
    const newer = withVersion(report, 9);
    api.getReport.mockResolvedValue(newer);
    await user.click(within(banner).getByRole('button', { name: /Reload/ }));
    await waitFor(() => expect(screen.queryByTestId('report-conflict')).toBeNull());
    expect(screen.getByRole('textbox', { name: 'Note for item 3' })).toHaveValue('My finding');

    api.patchReport.mockResolvedValue(withVersion(newer, 10));
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() =>
      expect(api.patchReport).toHaveBeenLastCalledWith('rep-1', { expected_version: 9, notes: { 'it-3': 'My finding' } }),
    );
  });

  it('offers the summary with the dry-run estimate and shows the AI label after generation', async () => {
    const user = userEvent.setup();
    const report = sampleReport({ summary: null });
    api.getReport.mockResolvedValue(report);
    api.generateReportSummary.mockResolvedValue({
      report: withVersion(report, 6, {
        summary: { ...sampleReport().summary!, based_on_version: 6 },
      }),
      summary: null,
    });
    show();
    const button = await screen.findByTestId('report-generate-summary');
    await waitFor(() => expect(button).toHaveTextContent('Generate summary · ≈ 1.4k tokens · ≈ $0.0010'));
    await user.click(button);
    await waitFor(() =>
      expect(api.generateReportSummary).toHaveBeenCalledWith('rep-1', { idempotencyKey: expect.any(String), expectedVersion: 5 }),
    );
    const summary = await screen.findByTestId('report-summary');
    expect(summary).toHaveTextContent('AI-written summary');
    expect(summary).toHaveTextContent('AI-generated; verify before acting');
    expect(summary).toHaveTextContent('Block 203.0.113.14 at the edge');
    expect(screen.queryByTestId('report-summary-stale')).toBeNull();
    expect(announce).toHaveBeenCalledWith('Summary ready');
  });

  it('marks a summary out of date when the report moved on and regenerates it', async () => {
    const user = userEvent.setup();
    // Fixture: based_on_version 4 < version 5.
    api.generateReportSummary.mockResolvedValue({
      report: withVersion(sampleReport(), 6, { summary: { ...sampleReport().summary!, based_on_version: 6 } }),
      summary: null,
    });
    show();
    const stale = await screen.findByTestId('report-summary-stale');
    expect(stale).toHaveTextContent('Out of date');
    await user.click(within(stale).getByRole('button', { name: /Regenerate/ }));
    await waitFor(() => expect(screen.queryByTestId('report-summary-stale')).toBeNull());
  });

  it('explains a single-flight 409 without discarding the summary area', async () => {
    const user = userEvent.setup();
    api.getReport.mockResolvedValue(sampleReport({ summary: null }));
    api.generateReportSummary.mockRejectedValue(
      new ApiError(409, 'busy', { detail: { code: 'report_summary_in_progress', message: 'busy' } }),
    );
    show();
    await user.click(await screen.findByTestId('report-generate-summary'));
    expect(await screen.findByText('A summary for this report is already being written')).toBeInTheDocument();
  });

  it('states the 40-item limit', async () => {
    const report = sampleReport();
    const items = Array.from({ length: 40 }, (_, i) => ({ ...report.items[1], id: `x-${i}` }));
    api.getReport.mockResolvedValue({ ...report, items });
    show();
    expect(await screen.findByText('Report is full (40 items)')).toBeInTheDocument();
    expect(screen.getByTestId('report-count')).toHaveTextContent('40/40');
  });

  it('deletes after confirmation with the current version', async () => {
    const user = userEvent.setup();
    api.deleteReport.mockResolvedValue(undefined);
    const { onCountChange } = show();
    await user.click(await screen.findByTestId('report-menu-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete report' }));
    await user.click(await screen.findByRole('button', { name: 'Delete report' }));
    await waitFor(() => expect(api.deleteReport).toHaveBeenCalledWith('rep-1', 5));
    expect(await screen.findByTestId('report-empty')).toBeInTheDocument();
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(0));
  });

  it('opens the library and renames the report', async () => {
    const user = userEvent.setup();
    api.patchReport.mockResolvedValue(withVersion(sampleReport(), 6, { title: 'VPN brute force' }));
    show();
    await user.click(await screen.findByTestId('report-menu-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'Open in Reports library' }));
    expect(navigate).toHaveBeenCalledWith('reports', { reportId: 'rep-1' });

    await user.click(screen.getByRole('button', { name: /rename report/ }));
    const field = screen.getByRole('textbox', { name: 'Report title' });
    await user.clear(field);
    await user.type(field, 'VPN brute force{Enter}');
    await waitFor(() => expect(api.patchReport).toHaveBeenCalledWith('rep-1', { expected_version: 5, title: 'VPN brute force' }));
  });

  it('expands an item to render its snapshot through the lazy answer blocks', async () => {
    const user = userEvent.setup();
    show();
    const toggle = await screen.findByRole('button', { name: /2\. Recent sign-in failures/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // The first expand transforms the whole lazy blocks kit; allow for a loaded machine.
    expect(await screen.findByRole('heading', { name: 'Recent sign-in failures' }, { timeout: 15_000 })).toBeInTheDocument();
    // A report item is read-only: no Add to report control inside it.
    expect(screen.queryByTestId('block-add-to-report')).toBeNull();
  }, 20_000);

  it('exports with the source turns read on demand and the defang preference', async () => {
    const user = userEvent.setup();
    show();
    // Nothing is read from the source conversations until an export needs it.
    await screen.findByTestId('report-count');
    expect(api.getConversation).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('report-menu-trigger'));
    // Keyboard path through the submenu (Radix sub-menus open on ArrowRight).
    const sub = await screen.findByRole('menuitem', { name: 'Export' });
    // Radix menu items set their focused state in onFocus: a bare .focus() outside act
    // logs an act() warning (stderr fails test:strict) whenever it lands between flushes.
    act(() => sub.focus());
    await user.keyboard('{ArrowRight}');
    const md = await screen.findByRole('menuitem', { name: 'Markdown (.md)' });
    await waitFor(() => expect(md).toHaveFocus());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    // Let the menu finish closing inside act so no late Radix update escapes the test.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    const [report, format, options] = exportReport.mock.calls[0] as unknown as [Report, string, { defang: boolean; author: string; sourceTurns: Map<string, unknown> }];
    expect(report.id).toBe('rep-1');
    expect(format).toBe('markdown');
    expect(options.defang).toBe(true);
    expect(options.author).toBe('ana');
    expect(options.sourceTurns.has('msg-2')).toBe(true);
    expect(announce).toHaveBeenCalledWith('Markdown downloaded');
  });

  it('never applies a late write for the previous report after the host switches reports', async () => {
    // The host keeps one panel mounted and swaps reportId when the conversation changes.
    const user = userEvent.setup();
    const other = sampleReport({ id: 'rep-B', conversation_id: 'conv-2', title: 'Phishing wave', items: sampleReport().items.slice(0, 2), version: 3 });
    let releasePatch: (r: Report) => void = () => undefined;
    api.patchReport.mockImplementation(
      () => new Promise<Report>((resolve) => {
        releasePatch = resolve;
      }),
    );
    const { rerender, onCountChange, onClose } = show();
    const note = await screen.findByRole('textbox', { name: 'Note for item 3' });
    await user.type(note, 'Typed on rep-1');

    // Switch before the autosave fires: the pending note is flushed to rep-1 ...
    let releaseGet: (r: Report) => void = () => undefined;
    api.getReport.mockImplementation(
      () => new Promise<Report>((resolve) => {
        releaseGet = resolve;
      }),
    );
    onCountChange.mockClear();
    rerender(
      <TooltipProvider>
        <ReportPanel conversationId="conv-2" reportId="rep-B" mode="split" onClose={onClose} onCountChange={onCountChange} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(api.patchReport).toHaveBeenCalledWith('rep-1', { expected_version: 5, notes: { 'it-3': 'Typed on rep-1' } }));
    // ... and rep-1 is gone from the screen at once: nothing of it can be edited meanwhile.
    expect(screen.queryByRole('textbox', { name: 'Note for item 3' })).toBeNull();
    expect(screen.queryByText('Brute force on vpn-gw-2')).toBeNull();
    expect(screen.getByText('Loading report')).toBeInTheDocument();
    expect(onCountChange).not.toHaveBeenCalled();

    // rep-B arrives first, then rep-1's save resolves late: rep-B stays on screen.
    await act(async () => releaseGet(other));
    expect(await screen.findByTestId('report-count')).toHaveTextContent('2/40');
    const saved = withVersion(sampleReport(), 6);
    const events: string[] = [];
    const off = (await import('../report-sync')).onReportChanged((d) => events.push(String(d.reportId)));
    await act(async () => releasePatch(saved));
    off();
    expect(events).toContain('rep-1');
    expect(screen.getByRole('button', { name: /Phishing wave, rename report/ })).toBeInTheDocument();
    expect(screen.getByTestId('report-count')).toHaveTextContent('2/40');
    expect(screen.queryByTestId('report-conflict')).toBeNull();
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(2));
    expect(onCountChange).not.toHaveBeenCalledWith(6);
  });

  it('drops a slow summary for a report the panel has left', async () => {
    const user = userEvent.setup();
    api.getReport.mockResolvedValue(sampleReport({ summary: null }));
    let release: (v: { report: Report; summary: null }) => void = () => undefined;
    api.generateReportSummary.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { rerender, onClose } = show();
    await user.click(await screen.findByTestId('report-generate-summary'));
    const other = sampleReport({ id: 'rep-B', conversation_id: 'conv-2', title: 'Phishing wave', summary: null, version: 2 });
    api.getReport.mockResolvedValue(other);
    rerender(
      <TooltipProvider>
        <ReportPanel conversationId="conv-2" reportId="rep-B" mode="split" onClose={onClose} />
      </TooltipProvider>,
    );
    expect(await screen.findByRole('button', { name: /Phishing wave, rename report/ })).toBeInTheDocument();
    // The new report's Generate is not blocked by the old report's call.
    await waitFor(() => expect(screen.getByTestId('report-generate-summary')).not.toBeDisabled());
    announce.mockClear();
    await act(async () => release({ report: withVersion(sampleReport(), 6), summary: null }));
    expect(screen.getByRole('button', { name: /Phishing wave, rename report/ })).toBeInTheDocument();
    expect(screen.queryByTestId('report-summary')).toBeNull();
    expect(announce).not.toHaveBeenCalledWith('Summary ready');
  });

  it('returns focus after a keyboard rename, a removal and a delete', async () => {
    const user = userEvent.setup();
    const report = sampleReport();
    api.patchReport.mockResolvedValueOnce(withVersion(report, 6, { title: 'Renamed' }));
    show();
    await user.click(await screen.findByRole('button', { name: /rename report/ }));
    const field = screen.getByRole('textbox', { name: 'Report title' });
    await user.clear(field);
    await user.type(field, 'Renamed{Enter}');
    expect(screen.getByRole('button', { name: /rename report/ })).toHaveFocus();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Renamed, rename report' })).toBeInTheDocument());

    // Removing item 2 lands on the item that took its place.
    api.patchReport.mockResolvedValueOnce(withVersion(report, 7, { items: [report.items[0], ...report.items.slice(2)] }));
    await user.click(screen.getByRole('button', { name: 'Actions for item 2' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^2\. Alerts by source/ })).toHaveFocus());

    // Deleting the report lands on the panel heading (the menu trigger is gone).
    api.deleteReport.mockResolvedValue(undefined);
    await user.click(screen.getByTestId('report-menu-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete report' }));
    await user.click(await screen.findByRole('button', { name: 'Delete report' }));
    await screen.findByTestId('report-empty');
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H2'));
  });

  it('announces a reload only when it worked and shows why it did not', async () => {
    const user = userEvent.setup();
    api.patchReport.mockRejectedValueOnce(conflict());
    show();
    const note = await screen.findByRole('textbox', { name: 'Note for item 3' });
    await user.type(note, 'x');
    const banner = await screen.findByTestId('report-conflict', {}, { timeout: NOTE_AUTOSAVE_MS + 1500 });
    api.getReport.mockRejectedValue(new ApiError(503, 'down', { detail: { code: 'report_store_unavailable', message: 'down' } }));
    announce.mockClear();
    await user.click(within(banner).getByRole('button', { name: /Reload/ }));
    expect(await screen.findByTestId('report-reload-error')).toHaveTextContent('Reports are temporarily unavailable');
    expect(announce).not.toHaveBeenCalledWith('Report reloaded');
  });

  it('moves focus to its heading only in overlay mode', async () => {
    const { unmount } = show({ mode: 'split' });
    await screen.findByTestId('report-count');
    expect(document.activeElement?.tagName).not.toBe('H2');
    unmount();
    show({ mode: 'overlay' });
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H2'));
  });
});
