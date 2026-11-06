/**
 * CaseDetail collaboration truth contract.
 *
 * Discussion and activity reads are independent endpoints. A rejected read must never be
 * normalised into a successful empty collection, and retrying one endpoint must not hide
 * the other endpoint's state. This mounts the real orchestrator + panel over rejected
 * client calls, then proves each rail recovers independently.
 *
 * Round 14 (D36): the case's tasks moved to the Runbook tab ("Other tasks"); the
 * Collaboration rail points there and no longer reads the tasks endpoint itself.
 */
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const {
  getThreadMock,
  getTasksMock,
  getActivityMock,
  postThreadMock,
} = vi.hoisted(() => ({
  getThreadMock: vi.fn(),
  getTasksMock: vi.fn(),
  getActivityMock: vi.fn(),
  postThreadMock: vi.fn(),
}));

vi.mock('@/soc/pages/CaseDetail.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../CaseDetail.api')>();
  return {
    ...actual,
    getTriage: vi.fn().mockResolvedValue({ case_id: 'case-collab', found: false, chips: null }),
    getThread: getThreadMock,
    getTasks: getTasksMock,
    getActivity: getActivityMock,
    listPickableUsers: vi.fn().mockResolvedValue([]),
    postThread: postThreadMock,
    editThreadMessage: vi.fn(),
    deleteThreadMessage: vi.fn(),
    reactThreadMessage: vi.fn(),
    addTask: vi.fn(),
    patchTask: vi.fn(),
    logTask: vi.fn(),
  };
});

vi.mock('@/soc/pages/Campaigns.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Campaigns.api')>();
  return {
    ...actual,
    campaignsApi: {
      ...actual.campaignsApi,
      forCase: vi.fn().mockResolvedValue({ case_id: 'case-collab', campaign: null }),
    },
  };
});

vi.mock('@/lib/useEventStream', () => ({
  useEventStream: vi.fn(() => ({ live: false })),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  const openCase = {
    case_id: 'case-collab',
    case_number: 'SOC-0042',
    title: 'Suspicious identity activity',
    status: 'open',
    disposition: null,
    verdict: 'needs_human',
    confidence: 0.52,
    risk_score: 61,
    created_at: '2026-08-04T08:00:00Z',
    updated_at: '2026-08-04T08:05:00Z',
    escalation_level: 0,
    evidence: [],
    assets: {},
    iocs: [],
    tags: [],
    comments: [],
  };
  return {
    ...actual,
    setUnauthorizedHandler: vi.fn(),
    api: {
      getCase: ok(openCase),
      getModels: ok({ providers: {} }),
      getSettings: ok({ prefs: {}, configured: {}, read_only: false }),
      cases: {
        threatContext: ok(null),
        notify: ok({ sent: [] }),
      },
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  },
}));

import { AuthProvider } from '../../auth';
import { RouterProvider } from '../../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CaseDetail } from '../CaseDetail';

function renderWithProviders(node: React.ReactNode) {
  return render(
    <AuthProvider>
      <RouterProvider>
        <TooltipProvider>{node}</TooltipProvider>
      </RouterProvider>
    </AuthProvider>,
  );
}

describe('CaseDetail — collaboration endpoint failures', () => {
  beforeEach(() => {
    postThreadMock.mockReset().mockResolvedValue(undefined);
    getThreadMock.mockReset().mockResolvedValue({
      case_id: 'case-collab',
      messages: [],
      count: 0,
    });
    getTasksMock
      .mockReset()
      .mockRejectedValueOnce(new Error('tasks endpoint unavailable'))
      .mockResolvedValue({
        case_id: 'case-collab',
        tasks: [
          {
            id: 'task-recovered',
            case_id: 'case-collab',
            title: 'Validate the identity session',
            assignee: null,
            status: 'open',
            order: 0,
            created_at: '2026-08-04T08:06:00Z',
            logs: [],
          },
        ],
        count: 1,
      });
    getActivityMock
      .mockReset()
      .mockRejectedValueOnce(new Error('activity endpoint unavailable'))
      .mockResolvedValue({
        case_id: 'case-collab',
        activity: [
          {
            id: 'activity-recovered',
            case_id: 'case-collab',
            source: 'activity',
            ts: '2026-08-04T08:06:00Z',
            kind: 'assigned',
            actor: 'operator',
            summary: 'Assigned to the identity response queue.',
          },
        ],
        count: 1,
      });
  });

  it('shows a retryable activity failure, recovers it without a false empty state, and points tasks at the Runbook tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CaseDetail caseId="case-collab" onClose={vi.fn()} />);

    await screen.findByText('Suspicious identity activity');
    const collaborationTab = screen.getByRole('tab', { name: /Collaboration/i });
    await user.click(collaborationTab);
    await waitFor(() => expect(collaborationTab).toHaveAttribute('data-state', 'active'));
    await waitFor(() => expect(getActivityMock).toHaveBeenCalledTimes(1));

    expect(await screen.findByText('Could not load activity')).toBeInTheDocument();
    expect(screen.getByText('activity endpoint unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument();
    // The tasks are not read here any more: the rail points at the Runbook tab.
    expect(screen.getByText('Case tasks are in the Runbook tab, under Other tasks.')).toBeInTheDocument();
    expect(getTasksMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry activity' }));
    expect(
      await screen.findByText('Assigned to the identity response queue.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Could not load activity')).not.toBeInTheDocument(),
    );

    expect(getActivityMock).toHaveBeenCalledTimes(2);
    // Discussion remains independently available throughout the failure.
    expect(screen.getByText('No discussion yet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open the Runbook tab' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /^Runbook/ })).toHaveAttribute('data-state', 'active'),
    );
  });

  it('preserves the last good discussion when a post-triggered refresh fails, then recovers', async () => {
    const message = {
      id: 'message-before-refresh',
      case_id: 'case-collab',
      parent_id: null,
      author_type: 'human',
      author: 'operator',
      body: 'Existing investigation context remains authoritative.',
      mentions: [],
      reactions: [],
      kind: 'comment',
      created_at: '2026-08-04T08:05:30Z',
      edited_at: null,
      deleted_at: null,
      ai_meta: null,
    };
    getThreadMock
      .mockReset()
      .mockResolvedValueOnce({ case_id: 'case-collab', messages: [message], count: 1 })
      .mockRejectedValueOnce(new Error('discussion refresh unavailable'))
      .mockResolvedValue({ case_id: 'case-collab', messages: [message], count: 1 });
    getTasksMock.mockReset().mockResolvedValue({ case_id: 'case-collab', tasks: [], count: 0 });
    getActivityMock
      .mockReset()
      .mockResolvedValue({ case_id: 'case-collab', activity: [], count: 0 });

    const user = userEvent.setup();
    renderWithProviders(<CaseDetail caseId="case-collab" onClose={vi.fn()} />);

    await screen.findByText('Suspicious identity activity');
    const collaborationTab = screen.getByRole('tab', { name: /Collaboration/i });
    await user.click(collaborationTab);
    expect(await screen.findByText(message.body)).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText(/Share findings or a hand-off/i),
      'Trigger an authoritative discussion refresh.',
    );
    await user.click(screen.getByRole('button', { name: 'Post' }));

    expect(await screen.findByText('Could not refresh discussion')).toBeInTheDocument();
    expect(screen.getByText('discussion refresh unavailable')).toBeInTheDocument();
    expect(screen.getByText(message.body)).toBeInTheDocument();
    expect(getThreadMock).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Retry discussion' }));
    await waitFor(() =>
      expect(screen.queryByText('Could not refresh discussion')).not.toBeInTheDocument(),
    );
    expect(screen.getByText(message.body)).toBeInTheDocument();
    expect(getThreadMock).toHaveBeenCalledTimes(3);
  });
});
