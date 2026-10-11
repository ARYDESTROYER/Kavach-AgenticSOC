/**
 * CollaborationPanel — assignee Select value binding (Round-6 finding #11).
 *
 * The picker must reflect the ACTUAL assignee, not a false "Unassigned", when the case
 * is assigned to someone outside the pickable user list (a free-text / deleted / display
 * -name assignee). It must also normalise a case-mismatched known user to the canonical
 * username so the trigger matches a real SelectItem.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

const { useEventStreamMock } = vi.hoisted(() => ({ useEventStreamMock: vi.fn() }));

vi.mock('@/lib/useEventStream', () => ({ useEventStream: useEventStreamMock }));

import { assigneeSelectValue, CollaborationThreadTab } from '../CollaborationPanel';
import type {
  CaseActivityItem,
  CaseMessage,
  CaseTask,
  PickableUser,
} from '@/soc/pages/CaseDetail.api';
import type { Case } from '@/lib/types';

expect.extend(toHaveNoViolations);

const USERS: PickableUser[] = [{ username: 'alice' }, { username: 'bob' }];

const CASE = {
  case_id: 'case-2026-00892',
  assignee: 'alice',
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

const TASKS: CaseTask[] = [
  {
    id: 'task-1',
    case_id: CASE.case_id,
    title: 'Revoke the IAM sessions and block the source IP',
    assignee: 'alice',
    status: 'in_progress',
    order: 0,
    created_at: '2026-07-20T10:47:15Z',
    logs: [],
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
  tasks: TASKS,
  tasksLoading: false,
  tasksError: null,
  tasksBusyId: null,
  activity: ACTIVITY,
  activityLoading: false,
  activityError: null,
  users: USERS,
  currentUser: 'alice',
  canComment: false,
  canWrite: false,
  onRetryThread: vi.fn(),
  onRetryTasks: vi.fn(),
  onRetryActivity: vi.fn(),
  onPost: vi.fn(),
  onReply: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onReact: vi.fn(),
  onAddTask: vi.fn(),
  onTaskStatus: vi.fn(),
  onTaskLog: vi.fn(),
  onAssigned: vi.fn(),
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

describe('CollaborationThreadTab — Case Manager presentation', () => {
  beforeEach(() => useEventStreamMock.mockClear());

  it('uses the compact two-lane layout without dropping discussion, ownership, tasks, activity, or live wiring', () => {
    const { container } = render(
      <CollaborationThreadTab {...PANEL_PROPS} presentation="case-manager" />,
    );

    const panel = container.querySelector(
      '[data-case-panel="collaboration"][data-presentation="case-manager"]',
    );
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass('grid', 'lg:grid-cols-[minmax(0,1fr)_18rem]');

    const discussion = container.querySelector('[data-collaboration-surface="discussion-canvas"]');
    expect(discussion).toHaveClass(
      'rounded-none',
      'border-0',
      'bg-transparent',
      'p-0',
      'shadow-none',
    );
    const rail = container.querySelector('[data-collaboration-surface="context-rail"]');
    expect(rail).toHaveClass('space-y-0', 'bg-muted/20');
    const railSections = container.querySelectorAll('[data-collaboration-rail-section]');
    expect(railSections).toHaveLength(3);
    railSections.forEach((section) => {
      expect(section).toHaveClass('rounded-none', 'bg-transparent', 'shadow-none');
    });

    expect(screen.getByRole('heading', { name: 'Discussion' })).toBeInTheDocument();
    expect(screen.getByText('I am validating the affected IAM role now.')).toBeInTheDocument();
    expect(
      screen.getByText('I correlated the source IP with a known Tor exit node.'),
    ).toBeInTheDocument();
    // The AI author badge lives in the discussion (the Activity feed's Human / AI / System
    // filter, added in Round 12, also says "AI").
    expect(within(discussion as HTMLElement).getByText('AI')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ownership' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Assignee' })).toHaveTextContent('alice');
    expect(
      screen.getByText('Revoke the IAM sessions and block the source IP'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(
      screen.getByText('Escalated for analyst review; containment initiated.'),
    ).toBeInTheDocument();

    expect(useEventStreamMock).toHaveBeenCalledWith(
      [`cases:${CASE.case_id}`],
      expect.objectContaining({ enabled: true, onEvent: expect.any(Function) }),
    );
  });

  it('pins the empty-thread composer to a single quiet boundary instead of nesting another card', () => {
    const { container } = render(
      <CollaborationThreadTab
        {...PANEL_PROPS}
        thread={[]}
        canComment
        presentation="case-manager"
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

  it('renders truthful independent task/activity failures and preserves last good data', () => {
    const onRetryTasks = vi.fn();
    const onRetryActivity = vi.fn();
    render(
      <CollaborationThreadTab
        {...PANEL_PROPS}
        tasksError={new Error('tasks endpoint unavailable')}
        activityError={new Error('activity endpoint unavailable')}
        onRetryTasks={onRetryTasks}
        onRetryActivity={onRetryActivity}
        presentation="case-manager"
      />,
    );

    expect(screen.getByText('Could not refresh tasks')).toBeInTheDocument();
    expect(screen.getByText('tasks endpoint unavailable')).toBeInTheDocument();
    expect(
      screen.getByText('Revoke the IAM sessions and block the source IP'),
    ).toBeInTheDocument();
    expect(screen.getByText('Could not refresh activity')).toBeInTheDocument();
    expect(screen.getByText('activity endpoint unavailable')).toBeInTheDocument();
    expect(
      screen.getByText('Escalated for analyst review; containment initiated.'),
    ).toBeInTheDocument();

    screen.getByRole('button', { name: 'Retry tasks' }).click();
    screen.getByRole('button', { name: 'Retry activity' }).click();
    expect(onRetryTasks).toHaveBeenCalledTimes(1);
    expect(onRetryActivity).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good discussion visible beside a retryable refresh failure', () => {
    const onRetryThread = vi.fn();
    render(
      <CollaborationThreadTab
        {...PANEL_PROPS}
        threadError={new Error('discussion endpoint unavailable')}
        onRetryThread={onRetryThread}
        presentation="case-manager"
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
    render(
      <CollaborationThreadTab
        {...PANEL_PROPS}
        tasks={null}
        tasksLoading
        activity={null}
        activityLoading
      />,
    );

    expect(screen.getByRole('status', { name: 'Loading case tasks' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading case activity' })).toBeInTheDocument();
    expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument();
  });

  it('has no axe violations with live collaboration content', async () => {
    const { container } = render(
      <CollaborationThreadTab {...PANEL_PROPS} presentation="case-manager" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
