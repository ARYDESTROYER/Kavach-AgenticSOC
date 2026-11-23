/**
 * CollaborationPanel (Round 15, SPEC D8.3): Discussion, Files (a slot the WP4 kit fills),
 * Tasks and History, with no owner picker (the owner's one home is the header).
 *
 * The assignee Select value binding (Round-6 finding #11) is kept with the picker, which
 * now lives in the header's owner popover: it must reflect the ACTUAL assignee, not a
 * false "Unassigned", when the case is assigned to someone outside the pickable user
 * list, and normalise a case-mismatched known user to the canonical username.
 */
import type * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

const { useEventStreamMock } = vi.hoisted(() => ({ useEventStreamMock: vi.fn() }));

vi.mock('@/lib/useEventStream', () => ({ useEventStream: useEventStreamMock }));

import { CollaborationThreadTab } from '../CollaborationPanel';
import { assigneeSelectValue } from '../AssigneePicker';
import type {
  CaseActivityItem,
  CaseMessage,
  PickableUser,
} from '@/soc/pages/CaseDetail.api';
import type { Case } from '@/lib/types';

expect.extend(toHaveNoViolations);

const USERS: PickableUser[] = [{ username: 'alice' }, { username: 'bob' }];

const CASE = {
  case_id: 'case-2026-00892',
  assignee: 'alice',
  history: [
    { event: 'decision', ts: '2026-07-20T10:40:00Z', status: 'needs_human', decision_by: 'system' },
    { event: 'analyst_action', ts: '2026-07-20T10:45:00Z', action: 'acknowledge', analyst: 'alice', note: '' },
    {
      event: 'analyst_action',
      ts: '2026-07-20T11:00:00Z',
      action: 'close',
      analyst: 'alice',
      note: 'Confirmed with the owner.',
      classified_disposition: 'true_positive',
      actions_taken: ['blocked_indicator', 'reset_credentials'],
    },
  ],
} as unknown as Case;

const THREAD: CaseMessage[] = [
  {
    id: 'human-1',
    case_id: CASE.case_id,
    parent_id: null,
    author_type: 'human',
    author: 'alice',
    body: 'I am validating the affected IAM role now.',
    mentions: [],
    reactions: [],
    kind: 'comment',
    created_at: '2026-07-20T10:47:00Z',
    edited_at: null,
    deleted_at: null,
    ai_meta: null,
  },
  {
    id: 'ai-1',
    case_id: CASE.case_id,
    parent_id: null,
    author_type: 'ai',
    author: 'triage-agent',
    body: 'I correlated the source IP with a known Tor exit node.',
    mentions: [],
    reactions: [],
    kind: 'assessment',
    created_at: '2026-07-20T10:46:30Z',
    edited_at: null,
    deleted_at: null,
    ai_meta: { confidence: 0.94 },
  },
];

const ACTIVITY: CaseActivityItem[] = [
  {
    id: 'activity-1',
    case_id: CASE.case_id,
    source: 'activity',
    ts: '2026-07-20T10:46:00Z',
    kind: 'escalated',
    actor: 'case-manager',
    summary: 'Escalated for analyst review; containment initiated.',
  },
];

const PANEL_PROPS = {
  c: CASE,
  thread: THREAD,
  threadLoading: false,
  threadError: null,
  threadBusyId: null,
  activity: ACTIVITY,
  activityLoading: false,
  activityError: null,
  users: USERS,
  currentUser: 'alice',
  canComment: false,
  onRetryThread: vi.fn(),
  onRetryActivity: vi.fn(),
  onPost: vi.fn(),
  onReply: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onReact: vi.fn(),
  onOpenTasks: vi.fn(),
  liveCaseId: CASE.case_id,
  onLiveThread: vi.fn(),
  onLiveActivity: vi.fn(),
} as const;

describe('assigneeSelectValue (#11)', () => {
  it('preserves a free-text assignee not in the user list (not "__unassigned__")', () => {
    expect(assigneeSelectValue('carol', USERS)).toBe('carol');
  });

  it('normalises a case-mismatched known user to the canonical username', () => {
    expect(assigneeSelectValue('ALICE', USERS)).toBe('alice');
  });

  it('returns the unassigned sentinel only for an empty assignee', () => {
    expect(assigneeSelectValue('', USERS)).toBe('__unassigned__');
    expect(assigneeSelectValue('   ', USERS)).toBe('__unassigned__');
  });
});

/** Open the full activity feed under History. */
function openAllActivity() {
  fireEvent.click(screen.getByRole('button', { name: /show all activity/i }));
}

describe('CollaborationThreadTab: Discussion, Files, Tasks, History (D8.3)', () => {
  beforeEach(() => useEventStreamMock.mockClear());

  it('lays out the discussion beside tasks and history, with no owner picker', () => {
    const { container } = render(<CollaborationThreadTab {...PANEL_PROPS} />);

    const panel = container.querySelector('[data-case-panel="collaboration"][data-presentation="case-manager"]');
    expect(panel).not.toBeNull();
    // The columns follow the PANE (a container query), never the viewport.
    expect(panel?.className).toContain('@container/collab');
    expect(panel?.querySelector('.grid')?.className).toContain('@[52rem]/collab:grid-cols-[minmax(0,1fr)_18rem]');

    expect(screen.getByRole('heading', { name: 'Discussion' })).toBeInTheDocument();
    const discussion = container.querySelector('[data-collaboration-surface="discussion-canvas"]') as HTMLElement;
    expect(within(discussion).getByText('I am validating the affected IAM role now.')).toBeInTheDocument();
    expect(within(discussion).getByText('I correlated the source IP with a known Tor exit node.')).toBeInTheDocument();
    // The AI author badge lives in the discussion.
    expect(within(discussion).getByText('AI')).toBeInTheDocument();
    expect(screen.getByText('2 messages')).toBeInTheDocument();

    // D8.3: no owner picker on this tab (the header owns it).
    expect(screen.queryByRole('heading', { name: 'Ownership' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Assignee' })).toBeNull();

    // Round 14 (D36): the case's tasks live in the Runbook tab under "Other tasks".
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByText('Case tasks are in the Runbook tab, under Other tasks.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();

    // No Files section until the caller fills the slot.
    expect(screen.queryByRole('heading', { name: 'Files' })).toBeNull();

    // The thread keeps its live wiring.
    expect(useEventStreamMock).toHaveBeenCalledWith(
      [`cases:${CASE.case_id}`],
      expect.objectContaining({ enabled: true, onEvent: expect.any(Function) }),
    );
  });

  it('shows the lifecycle with who, when and the actions taken (D4.2)', () => {
    render(<CollaborationThreadTab {...PANEL_PROPS} />);
    const history = screen.getByTestId('case-history');
    const items = within(history).getAllByTestId('case-history-item');
    // Newest first.
    expect(items[0]).toHaveTextContent('Closed as true positive');
    expect(items[0]).toHaveTextContent('alice');
    expect(within(items[0]).getByTestId('case-history-actions')).toHaveTextContent(
      'Actions taken: Blocked an indicator, Reset credentials',
    );
    expect(items[0]).toHaveTextContent('Confirmed with the owner.');
    expect(items[1]).toHaveTextContent('Acknowledged');
    expect(items[2]).toHaveTextContent('Sent to an analyst');
    expect(items[2]).toHaveTextContent('Case manager');
  });

  it('fills the Files slot with the tab as its paste scope (D5.12)', () => {
    let scope: React.RefObject<HTMLElement | null> | null = null;
    const { container } = render(
      <CollaborationThreadTab
        {...PANEL_PROPS}
        renderFiles={(pasteScope) => {
          scope = pasteScope;
          return <p>Screenshot gallery</p>;
        }}
      />,
    );
    const files = screen.getByTestId('collaboration-files');
    expect(within(files).getByRole('heading', { name: 'Files' })).toBeInTheDocument();
    expect(within(files).getByText('Screenshot gallery')).toBeInTheDocument();
    expect(files).toHaveAttribute('data-section', 'files');
    expect((scope as React.RefObject<HTMLElement | null> | null)?.current).toBe(
      container.querySelector('[data-case-panel="collaboration"]'),
    );
  });

  it('keeps the full activity feed one click away, with its live wiring', () => {
    render(<CollaborationThreadTab {...PANEL_PROPS} />);
    expect(screen.queryByText('Escalated for analyst review; containment initiated.')).toBeNull();
    openAllActivity();
    expect(screen.getByText('Escalated for analyst review; containment initiated.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide all activity/i })).toBeInTheDocument();
  });

  it('pins the empty-thread composer to a single quiet boundary instead of nesting another card', () => {
    const { container } = render(
      <CollaborationThreadTab
        {...PANEL_PROPS}
        thread={[]}
        canComment
      />,
    );

    expect(screen.getByText('No discussion yet')).toBeInTheDocument();
    const composer = screen
      .getByPlaceholderText(/Share findings or a hand-off/i)
      .parentElement?.parentElement;
    const threadSurface = composer?.parentElement;
    expect(threadSurface).toHaveClass('flex', 'flex-1', 'flex-col');
    expect(threadSurface?.className).toContain('[&>div:last-child]:mt-auto');
    expect(threadSurface?.className).toContain('[&>div:last-child]:border-t');
    expect(threadSurface?.className).toContain('[&>div:last-child]:border-x-0');
    expect(threadSurface?.className).toContain('[&>div:last-child]:bg-transparent');
    expect(threadSurface?.className).toContain('[&>div:last-child]:px-0');
    expect(
      container.querySelector('[data-collaboration-surface="discussion-canvas"]'),
    ).toContainElement(threadSurface as HTMLElement);
  });

  it('renders a truthful activity failure, preserves last good data, and opens the Runbook tab for tasks', () => {
    const onRetryActivity = vi.fn();
    const onOpenTasks = vi.fn();
    render(
      <CollaborationThreadTab
        {...PANEL_PROPS}
        activityError={new Error('activity endpoint unavailable')}
        onRetryActivity={onRetryActivity}
        onOpenTasks={onOpenTasks}
      />,
    );

    // The failure is named on the collapsed control too.
    expect(screen.getByRole('button', { name: /show all activity/i })).toHaveTextContent('could not load');
    openAllActivity();
    expect(screen.getByText('Could not refresh activity')).toBeInTheDocument();
    expect(screen.getByText('activity endpoint unavailable')).toBeInTheDocument();
    expect(
      screen.getByText('Escalated for analyst review; containment initiated.'),
    ).toBeInTheDocument();

    const opened = onRetryActivity.mock.calls.length;
    screen.getByRole('button', { name: 'Retry activity' }).click();
    screen.getByRole('button', { name: 'Open the Runbook tab' }).click();
    expect(onRetryActivity).toHaveBeenCalledTimes(opened + 1);
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
  });

  it('shows the tasks themselves to a viewer with no Runbook tab, and no tasks section otherwise', () => {
    const { rerender } = render(
      <CollaborationThreadTab
        {...PANEL_PROPS}
        onOpenTasks={undefined}
        tasksSection={<p>Standalone task list</p>}
      />,
    );
    expect(screen.getByText('Standalone task list')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open the Runbook tab' })).toBeNull();

    rerender(<CollaborationThreadTab {...PANEL_PROPS} onOpenTasks={undefined} />);
    expect(screen.queryByTestId('collaboration-tasks')).toBeNull();
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
  });

  it('keeps the last good discussion visible beside a retryable refresh failure', () => {
    const onRetryThread = vi.fn();
    render(
      <CollaborationThreadTab
        {...PANEL_PROPS}
        threadError={new Error('discussion endpoint unavailable')}
        onRetryThread={onRetryThread}
      />,
    );

    expect(screen.getByText('Could not refresh discussion')).toBeInTheDocument();
    expect(screen.getByText('discussion endpoint unavailable')).toBeInTheDocument();
    expect(screen.getByText('I am validating the affected IAM role now.')).toBeInTheDocument();
    expect(
      screen.getByText('I correlated the source IP with a known Tor exit node.'),
    ).toBeInTheDocument();

    screen.getByRole('button', { name: 'Retry discussion' }).click();
    expect(onRetryThread).toHaveBeenCalledTimes(1);
  });

  it('keeps an initial discussion failure blocking until retry succeeds', () => {
    render(
      <CollaborationThreadTab
        {...PANEL_PROPS}
        thread={null}
        threadError={new Error('discussion endpoint unavailable')}
      />,
    );

    expect(screen.getByText('Could not load discussion')).toBeInTheDocument();
    expect(screen.getByText('discussion endpoint unavailable')).toBeInTheDocument();
    expect(screen.queryByText('I am validating the affected IAM role now.')).not.toBeInTheDocument();
    expect(screen.queryByText('No discussion yet')).not.toBeInTheDocument();
  });

  it('uses canonical named loading states without inventing successful empty states', () => {
    render(<CollaborationThreadTab {...PANEL_PROPS} activity={null} activityLoading />);
    openAllActivity();
    expect(screen.getByRole('status', { name: 'Loading case activity' })).toBeInTheDocument();
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument();
  });

  it('has no axe violations with live collaboration content', async () => {
    const { container } = render(
      <CollaborationThreadTab {...PANEL_PROPS} />,
    );
    openAllActivity();
    expect(await axe(container)).toHaveNoViolations();
  });
});
