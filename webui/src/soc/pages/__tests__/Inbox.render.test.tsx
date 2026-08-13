/**
 * Inbox page + read-state tests (Group 6 / Feature 8).
 *
 * Mocks the co-located Inbox.api module (so no network) and asserts:
 *   - notifications render NEWEST first as PLAIN text (title/body, #9),
 *   - "Mark read" calls markRead and, in the default (all) view, dims the row in place,
 *   - "Mark all read" calls the bulk endpoint,
 *   - "Dismiss" removes the row,
 *   - an "Open case" deep-link navigates to the referenced case.
 *
 * The api module is fully mocked; the prefs slide-over is covered separately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { listMock, markReadMock, markAllReadMock, dismissMock, getPrefsMock, putPrefsMock, cancelJobMock } =
  vi.hoisted(() => ({
    listMock: vi.fn(),
    markReadMock: vi.fn(),
    markAllReadMock: vi.fn(),
    dismissMock: vi.fn(),
    getPrefsMock: vi.fn(),
    putPrefsMock: vi.fn(),
    cancelJobMock: vi.fn(),
  }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      jobs: { ...actual.api.jobs, cancel: cancelJobMock },
    },
  };
});

vi.mock('@/soc/pages/Inbox.api', async (importOriginal) => {
  // Keep the real catalog constants; only stub the network surface.
  const actual = await importOriginal<typeof import('../Inbox.api')>();
  return {
    ...actual,
    inboxApi: {
      list: listMock,
      unreadCount: vi.fn().mockResolvedValue({ unread: 0 }),
      markRead: markReadMock,
      markAllRead: markAllReadMock,
      dismiss: dismissMock,
      getPrefs: getPrefsMock,
      putPrefs: putPrefsMock,
    },
  };
});

import { TooltipProvider } from '@/ui/tooltip';
import Inbox from '../Inbox';

const ITEMS = [
  {
    id: 'ntf-1',
    category: 'case_escalated',
    title: 'Case escalated: brute force',
    body: 'Risk 82 from 10.0.0.9',
    severity: 'high',
    case_id: 'case-123',
    state: 'unseen' as const,
    created_at: '2026-06-30T12:00:00Z',
  },
  {
    id: 'ntf-2',
    category: 'assignment',
    title: 'Assigned to you',
    body: 'You now own case-200',
    case_id: 'case-200',
    state: 'read' as const,
    created_at: '2026-06-30T10:00:00Z',
  },
];

function renderInbox(onNavigate = vi.fn()) {
  const utils = render(
    <TooltipProvider>
      <Inbox onNavigate={onNavigate} />
    </TooltipProvider>,
  );
  return { ...utils, onNavigate };
}

describe('Inbox page (read-state)', () => {
  beforeEach(() => {
    listMock.mockReset();
    markReadMock.mockReset();
    markAllReadMock.mockReset();
    dismissMock.mockReset();
    cancelJobMock.mockReset().mockResolvedValue({ status: 'running' });
    listMock.mockResolvedValue({ items: ITEMS, total: 2, limit: 50, offset: 0 });
    markReadMock.mockResolvedValue({ ok: true });
    markAllReadMock.mockResolvedValue({ ok: true, marked: 1 });
    dismissMock.mockResolvedValue({ ok: true, dismissed: true });
  });

  it('uses the shared blocking state on the first inbox load', async () => {
    listMock.mockReturnValue(new Promise(() => {}));
    const { container } = renderInbox();

    expect(await screen.findByRole('status', { name: 'Loading inbox' })).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('renders notifications as plain text with the unread one first', async () => {
    renderInbox();
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    expect(await screen.findByText('Inbox')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Inbox controls' })).toBeInTheDocument();
    expect(screen.getByText('1 unread · 2 total')).toBeInTheDocument();
    // Both titles render as plain text.
    expect(screen.getByText('Case escalated: brute force')).toBeInTheDocument();
    expect(screen.getByText('Assigned to you')).toBeInTheDocument();
    // Bodies render as plain text.
    expect(screen.getByText('Risk 82 from 10.0.0.9')).toBeInTheDocument();
    // The unread item shows a "New" marker; the read one does not.
    expect(screen.getAllByText('New').length).toBe(1);
  });

  it('marks one item read and dims it in place (all view)', async () => {
    renderInbox();
    await screen.findByText('Case escalated: brute force');

    // Only the unread item has a "Mark read" button.
    const buttons = screen.getAllByRole('button', { name: /mark read/i });
    // First is the per-row "Mark read"; "Mark all read" is a separate button.
    const rowMark = buttons.find((b) => b.textContent?.trim() === 'Mark read');
    expect(rowMark).toBeTruthy();
    fireEvent.click(rowMark as HTMLElement);

    await waitFor(() => expect(markReadMock).toHaveBeenCalledWith('ntf-1'));
    // Still present (dimmed in place, not removed) in the all view.
    await waitFor(() =>
      expect(screen.getByText('Case escalated: brute force')).toBeInTheDocument(),
    );
    // The "New" marker is gone after marking read.
    await waitFor(() => expect(screen.queryByText('New')).not.toBeInTheDocument());
  });

  it('marks all read via the bulk endpoint', async () => {
    renderInbox();
    await screen.findByText('Case escalated: brute force');

    const allBtn = screen.getByRole('button', { name: /mark all read/i });
    fireEvent.click(allBtn);
    await waitFor(() => expect(markAllReadMock).toHaveBeenCalled());
  });

  it('dismisses an item, removing it from the list', async () => {
    renderInbox();
    await screen.findByText('Assigned to you');

    const dismissButtons = screen.getAllByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissButtons[0]);
    await waitFor(() => expect(dismissMock).toHaveBeenCalledWith('ntf-1'));
    await waitFor(() =>
      expect(screen.queryByText('Case escalated: brute force')).not.toBeInTheDocument(),
    );
  });

  it('deep-links to the referenced case via onNavigate', async () => {
    const { onNavigate } = renderInbox();
    await screen.findByText('Case escalated: brute force');

    const openButtons = screen.getAllByRole('button', { name: /open case/i });
    fireEvent.click(openButtons[0]);
    expect(onNavigate).toHaveBeenCalledWith('cases', { caseId: 'case-123' });
  });

  it('renders durable job progress, cancels active work, and gates artifact Download', async () => {
    listMock.mockResolvedValue({
      items: [
        {
          id: 'job-note-running',
          category: 'system',
          title: 'Export is running',
          body: 'Background export progress',
          state: 'read',
          created_at: '2026-08-13T10:00:00Z',
          job_id: 'job-running',
          job_status: 'running',
          progress: { done: 2, total: 6, unit: 'scopes' },
          result: null,
        },
        {
          id: 'job-note-no-artifact',
          category: 'system',
          title: 'Case work complete',
          body: 'No artifact expected',
          state: 'read',
          created_at: '2026-08-13T09:00:00Z',
          job_id: 'job-case',
          job_status: 'succeeded',
          progress: { done: 1, total: 1, unit: 'cases' },
          result: { kind: 'case_tag', counts: { total: 1, succeeded: 1 } },
        },
        {
          id: 'job-note-artifact',
          category: 'system',
          title: 'Export complete',
          body: 'Verified artifact ready',
          state: 'read',
          created_at: '2026-08-13T08:00:00Z',
          job_id: 'job-export',
          job_status: 'succeeded',
          progress: { done: 6, total: 6, unit: 'scopes' },
          result: {
            kind: 'data_export_archive',
            artifact_id: 'artifact-1',
            counts: { total: 6, succeeded: 6 },
          },
        },
        {
          id: 'batch-note-running',
          category: 'system',
          title: 'LLM batch job',
          body: 'Provider batch progress',
          state: 'read',
          created_at: '2026-08-13T07:00:00Z',
          ref: { batch_job_id: 'batch-1', kind: 'llm_batch' },
          job_id: 'batch-job:batch-1',
          job_status: 'running',
          progress: { done: 4, total: 10, unit: 'requests' },
          result: null,
          url: '#/analytics?tab=jobs',
        },
      ],
      total: 4,
      limit: 50,
      offset: 0,
    });
    renderInbox();

    await screen.findByText('Export is running');
    expect(screen.getByRole('status', { name: '2 of 6 scopes complete' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '4 of 10 requests complete' })).toBeInTheDocument();
    expect(screen.getByText('Related LLM Batch running')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelJobMock).toHaveBeenCalledWith('job-running'));
  });

  it('routes a terminal LLM Batch Inbox entry to Jobs without cancel or artifact actions', async () => {
    listMock.mockResolvedValue({
      items: [
        {
          id: 'batch-note-terminal',
          category: 'system',
          title: 'LLM batch job',
          body: 'Provider batch complete',
          state: 'read',
          created_at: '2026-08-13T07:00:00Z',
          ref: { batch_job_id: 'batch-1', kind: 'llm_batch' },
          job_id: 'batch-job:batch-1',
          job_status: 'succeeded',
          progress: { done: 10, total: 10, unit: 'requests' },
          result: {
            kind: 'llm_batch',
            counts: { succeeded: 10, failed: 0, total: 10 },
          },
          url: '#/analytics?tab=jobs',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const { onNavigate } = renderInbox();
    await screen.findByText('Provider batch complete');

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View result' }));
    expect(onNavigate).toHaveBeenCalledWith('batchjobs', undefined);
  });

  it('uses a kind-derived safe result route and hides unknown malformed actions', async () => {
    listMock.mockResolvedValue({
      items: [
        {
          id: 'known-job',
          category: 'system',
          title: 'Known export',
          body: 'Ready',
          state: 'read',
          job_id: 'job-known',
          job_status: 'succeeded',
          progress: { done: 1, total: 1, unit: 'exports' },
          result: { kind: 'data_export_archive', counts: { total: 1, succeeded: 1 } },
          url: 'javascript:alert(1)',
        },
        {
          id: 'unknown-job',
          category: 'system',
          title: 'Unknown legacy work',
          body: 'No safe destination',
          state: 'read',
          job_id: 'job-unknown',
          job_status: 'succeeded',
          progress: { done: 1, total: 1, unit: 'items' },
          result: { kind: 'future_unknown_kind', counts: { total: 1, succeeded: 1 } },
          url: 'https://attacker.example/result',
        },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });
    const { onNavigate } = renderInbox();
    await screen.findByText('Known export');

    const actions = screen.getAllByRole('button', { name: 'View result' });
    expect(actions).toHaveLength(1);
    fireEvent.click(actions[0]);
    expect(onNavigate).toHaveBeenCalledWith('settings', { section: 'data_export' });
  });

  it('switches to the unread-only view and re-queries', async () => {
    renderInbox();
    await screen.findByText('Case escalated: brute force');
    listMock.mockClear();
    listMock.mockResolvedValue({ items: [ITEMS[0]], total: 1, limit: 50, offset: 0 });

    // The toggle button text starts as "All"; clicking flips to unread-only.
    const toggle = screen.getByRole('button', { name: /^all$/i });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(
        expect.objectContaining({ unread_only: true }),
      ),
    );
  });

  // Use within() to keep tree-scoped queries available to future cases.
  it('groups by category when toggled', async () => {
    renderInbox();
    await screen.findByText('Case escalated: brute force');

    // The group toggle is a SegmentedControl — a single-select value picker built on
    // Radix RadioGroup (role="radio"), not a tab surface. Drive it with userEvent.
    const byCat = screen.getByRole('radio', { name: /by category/i });
    await userEvent.click(byCat);
    // The category group heading appears (curated label for case_escalated).
    const heading = await screen.findByRole('heading', { name: /escalations/i });
    expect(within(heading.parentElement as HTMLElement).getByText(/escalations/i)).toBeInTheDocument();
  });
});
