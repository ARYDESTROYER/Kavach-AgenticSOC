/** Case Manager queue/workspace integration tests (prototype → live Console). */
import * as React from 'react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { BackgroundJob, BackgroundJobKind, Case } from '@/lib/types';
import CaseManager from '../CaseManager';

expect.extend(toHaveNoViolations);

const mocks = vi.hoisted(() => ({
  listCases: vi.fn(),
  bulk: vi.fn(),
  caseAssign: vi.fn(),
  caseTags: vi.fn(),
  reinvestigateCase: vi.fn(),
  submitJob: vi.fn(),
  navigate: vi.fn(),
  routeOpts: undefined as { caseId?: string } | undefined,
  username: 'analyst.one' as string | null,
  permissions: new Set<string>(),
  toastLoading: vi.fn(() => 'case-manager-bulk'),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      listCases: mocks.listCases,
      caseAssign: mocks.caseAssign,
      caseTags: mocks.caseTags,
      reinvestigateCase: mocks.reinvestigateCase,
      cases: {
        ...actual.api.cases,
        bulk: mocks.bulk,
      },
      jobs: {
        ...actual.api.jobs,
        submit: mocks.submitJob,
      },
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
    error: mocks.toastError,
  },
}));

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: mocks.username,
    hasPermission: (resource: string, action: string) =>
      mocks.permissions.has(`${resource}:${action}`),
  }),
}));

vi.mock('@/soc/router', () => ({
  useRoute: () => ({ page: 'case_manager', opts: mocks.routeOpts, navigate: mocks.navigate }),
}));

vi.mock('@/soc/components/Can', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Can: ({
    resource,
    action,
    children,
  }: {
    resource: string;
    action: string;
    children: React.ReactNode;
  }) => (mocks.permissions.has(`${resource}:${action}`) ? <>{children}</> : null),
}));

vi.mock('../CaseDetail', () => ({
  CaseDetail: ({
    caseId,
    presentation,
    onClose,
    onCaseChange,
  }: {
    caseId: string;
    presentation: string;
    onClose: () => void;
    onCaseChange?: (c: Case) => void;
  }) => (
    <section data-testid="embedded-case-detail" data-case-id={caseId} data-presentation={presentation}>
      <span>Overview</span><span>Timeline</span><span>Investigation</span>
      <span>Threat context</span><span>Collaboration</span><span>Chat</span>
      <button type="button" onClick={onClose}>Mock back</button>
      <button
        type="button"
        onClick={() => onCaseChange?.({ ...OPEN_CRITICAL, status: 'resolved' })}
      >
        Mock resolve
      </button>
    </section>
  ),
}));

const OPEN_CRITICAL: Case = {
  case_id: 'case-open-critical',
  case_number: 'CASE-2026-0092',
  title: 'Suspicious S3 bucket exfiltration',
  status: 'investigating',
  severity_band: 'critical',
  risk_score: 92,
  updated_at: '2026-07-20T10:20:00Z',
  entity: { type: 'ip', value: '198.51.100.45' },
};

const OPEN_HIGH: Case = {
  case_id: 'case-open-high',
  case_number: 'CASE-2026-0091',
  title: 'Multiple failed logins',
  status: 'needs_human',
  verdict: 'NEEDS_HUMAN',
  severity_band: 'high',
  risk_score: 68,
  updated_at: '2026-07-20T10:10:00Z',
  entity: { type: 'user', value: 'admin_svc' },
};

const RESOLVED_LOW: Case = {
  case_id: 'case-resolved-low',
  case_number: 'CASE-2026-0088',
  title: 'Benign health check',
  status: 'resolved',
  severity_band: 'low',
  risk_score: 12,
  updated_at: '2026-07-20T09:00:00Z',
  source_name: 'Wazuh Manager',
};

const CASES = [OPEN_HIGH, RESOLVED_LOW, OPEN_CRITICAL];

async function chooseBulkAction(name: string | RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /bulk actions for/i }));
  const menu = await screen.findByRole('menu');
  await user.click(within(menu).getByRole('menuitem', { name }));
}

function acceptedJob(kind: BackgroundJobKind, params: Record<string, unknown>): BackgroundJob {
  return {
    job_id: `job-${kind}`,
    kind,
    actor: 'analyst.one',
    created_at: '2026-08-13T10:00:00Z',
    started_at: null,
    finished_at: null,
    status: 'queued',
    progress: { done: 0, total: (params.case_ids as string[])?.length ?? 0, unit: 'cases' },
    failures: [],
    failure_count: 0,
    failures_truncated: 0,
    request_fingerprint: 'fp',
    result: null,
    params,
    cancel_requested: false,
  };
}

describe('CaseManager', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.navigate.mockReset();
    mocks.routeOpts = undefined;
    mocks.username = 'analyst.one';
    mocks.permissions = new Set([
      'cases:write',
      'cases:assign',
      'cases:close',
      'cases:reinvestigate',
    ]);
    mocks.listCases.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    mocks.bulk.mockReset().mockImplementation(async (ids: string[]) => ({
      results: ids.map((id) => ({ id, ok: true })),
    }));
    mocks.caseAssign.mockReset().mockImplementation(async (caseId: string, assignee: string) => {
      const item = CASES.find((candidate) => candidate.case_id === caseId);
      if (!item) throw new Error('Case not found');
      return { ...item, assignee };
    });
    mocks.caseTags.mockReset().mockImplementation(async (caseId: string, tags: string[]) => {
      const item = CASES.find((candidate) => candidate.case_id === caseId);
      if (!item) throw new Error('Case not found');
      return { ...item, tags };
    });
    mocks.reinvestigateCase.mockReset().mockImplementation(async (caseId: string) => {
      const item = CASES.find((candidate) => candidate.case_id === caseId);
      if (!item) throw new Error('Case not found');
      return { ...item, updated_at: '2026-07-20T10:30:00Z' };
    });
    mocks.submitJob.mockReset().mockImplementation(async (input) =>
      acceptedJob(input.kind, input.params),
    );
    mocks.toastLoading.mockClear();
    mocks.toastSuccess.mockClear();
    mocks.toastWarning.mockClear();
    mocks.toastError.mockClear();
  });

  it('centers the shared loading state while the initial case queue is unavailable', () => {
    mocks.listCases.mockReturnValue(new Promise(() => {}));
    render(<CaseManager />);

    const loading = screen.getByRole('status', { name: 'Loading cases' });
    expect(loading).toHaveAttribute('data-loading-layout', 'panel');
    expect(loading).toHaveClass('items-center', 'justify-center');
    expect(within(loading).getByText('Preparing the active case queue.')).toBeInTheDocument();
    expect(within(loading).getByTestId('console-loading-glyph')).toBeInTheDocument();
  });

  it('opens on the newest active case and embeds the complete shared workspace', async () => {
    render(<CaseManager />);

    expect(await screen.findByRole('heading', { name: 'Active Cases' })).toBeInTheDocument();
    expect(screen.getByText('2 shown · 2 active / 3 loaded')).toBeInTheDocument();
    expect(screen.queryByText('Benign health check')).not.toBeInTheDocument();

    const manager = screen.getByTestId('case-manager');
    expect(manager).toHaveClass(
      'h-[calc(100dvh-7rem)]',
      'min-h-0',
      'w-auto',
      'sm:-mx-2',
      'lg:-mx-4',
      'xl:min-h-[600px]',
      '2xl:-mx-8',
    );
    expect(manager.className.split(/\s+/)).not.toContain('min-h-[600px]');
    expect(manager.className.split(/\s+/)).not.toContain('w-full');

    const splitFrame = manager.firstElementChild as HTMLElement;
    expect(splitFrame).toHaveClass(
      'xl:grid-cols-[var(--case-manager-columns)]',
      'border',
      'border-border',
    );
    expect(splitFrame.style.getPropertyValue('--case-manager-columns')).toContain('400px');
    expect(splitFrame.className).not.toMatch(/rounded|shadow/);

    const detail = await screen.findByTestId('embedded-case-detail');
    expect(detail).toHaveAttribute('data-case-id', OPEN_CRITICAL.case_id);
    expect(detail).toHaveAttribute('data-presentation', 'embedded');
    for (const label of ['Overview', 'Timeline', 'Investigation', 'Threat context', 'Collaboration', 'Chat']) {
      expect(within(detail).getByText(label)).toBeInTheDocument();
    }
  });

  it('keeps severity in the filter instead of repeating Critical/High summary cards', async () => {
    const user = userEvent.setup();
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');

    expect(screen.queryByRole('button', { name: /^Critical$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^High$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Severity filter' }));
    await user.click(await screen.findByRole('option', { name: 'High' }));
    expect(screen.getByText('Multiple failed logins')).toBeInTheDocument();
    expect(screen.queryByText('Suspicious S3 bucket exfiltration')).not.toBeInTheDocument();
  });

  it('exposes a persisted keyboard and pointer adjustable split separator', async () => {
    render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');

    const divider = screen.getByRole('separator', { name: 'Resize case queue' });
    const frame = screen.getByTestId('case-manager-split-frame');
    expect(divider).toHaveAttribute('aria-orientation', 'vertical');
    expect(divider).toHaveAttribute('aria-valuemin', '320');
    expect(divider).toHaveAttribute('aria-valuenow', '400');
    expect(divider).toHaveClass('hidden', 'xl:flex');

    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(divider).toHaveAttribute('aria-valuenow', '424');
    expect(frame.style.getPropertyValue('--case-manager-columns')).toContain('424px');
    expect(window.localStorage.getItem('soc.caseManager.queueWidth')).toBe('424');

    const dispatchPointer = (type: string, clientX: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        button: { value: 0 },
        pointerId: { value: 7 },
        clientX: { value: clientX },
      });
      fireEvent(divider, event);
    };
    dispatchPointer('pointerdown', 424);
    dispatchPointer('pointermove', 472);
    dispatchPointer('pointerup', 472);
    expect(divider).toHaveAttribute('aria-valuenow', '472');
    expect(window.localStorage.getItem('soc.caseManager.queueWidth')).toBe('472');

    fireEvent.keyDown(divider, { key: 'Home' });
    expect(divider).toHaveAttribute('aria-valuenow', '320');
    expect(window.localStorage.getItem('soc.caseManager.queueWidth')).toBe('320');
  });

  it('switches Active/All, filters the real queue, and selects a different case', async () => {
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');

    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    expect(screen.getByRole('heading', { name: 'All Cases' })).toBeInTheDocument();
    expect(screen.getByText('3 shown · 3 loaded')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search case queue' }), {
      target: { value: 'health check' },
    });
    expect(screen.getByText('Benign health check')).toBeInTheDocument();
    expect(screen.queryByText('Multiple failed logins')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Benign health check'));
    expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute(
      'data-case-id',
      RESOLVED_LOW.case_id,
    );
    expect(mocks.navigate).toHaveBeenLastCalledWith('case_manager', {
      caseId: RESOLVED_LOW.case_id,
    });
  });

  it('keeps the queue synchronized after an authoritative detail mutation', async () => {
    render(<CaseManager initialCaseId={OPEN_CRITICAL.case_id} />);
    await screen.findByTestId('embedded-case-detail');

    fireEvent.click(screen.getByRole('button', { name: 'Mock resolve' }));

    await waitFor(() => {
      expect(screen.queryByText('Suspicious S3 bucket exfiltration')).not.toBeInTheDocument();
      expect(screen.getByText('1 shown · 1 active / 3 loaded')).toBeInTheDocument();
    });
  });

  it('selects cases without opening them and keeps hidden selections across filtering', async () => {
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');

    const highCheckbox = screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' });
    const selectVisible = screen.getByRole('checkbox', { name: 'Select all visible cases' });
    expect(selectVisible).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(highCheckbox);
    expect(highCheckbox).toHaveAttribute('aria-checked', 'true');
    expect(selectVisible).toHaveAttribute('aria-checked', 'mixed');
    expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute(
      'data-case-id',
      OPEN_CRITICAL.case_id,
    );
    expect(mocks.navigate).not.toHaveBeenCalled();

    // Clicking an indeterminate select-all selects every currently visible case.
    fireEvent.click(selectVisible);
    expect(selectVisible).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search case queue' }), {
      target: { value: 'failed logins' },
    });
    expect(screen.getByText('Multiple failed logins')).toBeInTheDocument();
    expect(screen.queryByText('Suspicious S3 bucket exfiltration')).not.toBeInTheDocument();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(selectVisible).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Clear case selection' }));
    expect(selectVisible).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('button', { name: /bulk actions for/i })).not.toBeInTheDocument();
  });

  it('snapshots selected case ids into one durable lifecycle job', async () => {
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible cases' }));
    await chooseBulkAction('Acknowledge');

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Acknowledge 2 cases?')).toBeInTheDocument();
    expect(mocks.submitJob).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge cases' }));

    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(1));
    expect(mocks.submitJob).toHaveBeenCalledWith({
      kind: 'case_lifecycle',
      idempotency_key: expect.stringMatching(/^case_lifecycle-/),
      params: {
        action: 'acknowledge',
        case_ids: [OPEN_CRITICAL.case_id, OPEN_HIGH.case_id],
      },
    });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await screen.findByText(/track progress in inbox/i)).toBeInTheDocument();
    expect(screen.getByText('2 visible')).toBeInTheDocument();
  });

  it('keeps assignment and tagging status-neutral with their dedicated job kinds', async () => {
    render(<CaseManager />);
    await screen.findByText('Multiple failed logins');

    const rowCheckbox = screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' });
    fireEvent.click(rowCheckbox);
    await chooseBulkAction('Assign');
    let dialog = await screen.findByRole('dialog');
    const assignee = within(dialog).getByRole('textbox', { name: 'Analyst or team' });
    expect(assignee).toHaveValue('analyst.one');
    fireEvent.change(assignee, { target: { value: 'tier-2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign cases' }));

    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(1));
    expect(mocks.submitJob.mock.calls[0][0]).toMatchObject({
      kind: 'case_assign',
      params: { case_ids: [OPEN_HIGH.case_id], assignee: 'tier-2' },
    });
    expect(mocks.caseAssign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' }));
    await chooseBulkAction('Add tag');
    dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Tag to add' }), {
      target: { value: 'needs-review' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add tag' }));

    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(2));
    expect(mocks.submitJob.mock.calls[1][0]).toMatchObject({
      kind: 'case_tag',
      params: { case_ids: [OPEN_HIGH.case_id], tag: 'needs-review' },
    });
    expect(mocks.caseTags).not.toHaveBeenCalled();
  });

  it('collects status and disposition values before submitting lifecycle jobs', async () => {
    render(<CaseManager />);
    await screen.findByText('Multiple failed logins');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' }));
    await chooseBulkAction('Set status');
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'New status' }));
    fireEvent.click(await screen.findByRole('option', { name: 'On hold' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set status' }));
    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(1));
    expect(mocks.submitJob.mock.calls[0][0]).toMatchObject({
      kind: 'case_lifecycle',
      params: { case_ids: [OPEN_HIGH.case_id], action: 'set_status', status: 'on_hold' },
    });

    const checkbox = await screen.findByRole('checkbox', { name: 'Select CASE-2026-0091' });
    fireEvent.click(checkbox);
    await chooseBulkAction('Set disposition');
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Disposition' }));
    fireEvent.click(await screen.findByRole('option', { name: 'False positive' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set disposition' }));
    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(2));
    expect(mocks.submitJob.mock.calls[1][0]).toMatchObject({
      kind: 'case_lifecycle',
      params: {
        case_ids: [OPEN_HIGH.case_id],
        action: 'set_disposition',
        disposition: 'false_positive',
      },
    });
  });

  it('confirmation-gates resolve and hides actions without their RBAC grants', async () => {
    const user = userEvent.setup();
    mocks.permissions.delete('cases:assign');
    mocks.permissions.delete('cases:close');
    render(<CaseManager />);
    await screen.findByText('Multiple failed logins');

    const rowCheckbox = screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' });
    fireEvent.click(rowCheckbox);
    await user.click(screen.getByRole('button', { name: /bulk actions for/i }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Assign' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Resolve' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Acknowledge' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    mocks.permissions.add('cases:close');
    fireEvent.click(rowCheckbox);
    fireEvent.click(rowCheckbox);
    await chooseBulkAction('Resolve');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Resolve 1 case?')).toBeInTheDocument();
    expect(mocks.submitJob).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resolve cases' }));
    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(1));
    expect(mocks.submitJob.mock.calls[0][0]).toMatchObject({
      kind: 'case_lifecycle',
      params: {
        case_ids: [OPEN_HIGH.case_id],
        action: 'resolve',
        reason: 'Bulk-resolved by analyst',
      },
    });
  });

  it('confirms token-spending work and submits one background reinvestigation', async () => {
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible cases' }));
    await chooseBulkAction('Reinvestigate');

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Reinvestigate 2 cases?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/spends LLM tokens per case/i),
    ).toBeInTheDocument();
    expect(mocks.reinvestigateCase).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reinvestigate' }));
    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(1));
    expect(mocks.submitJob).toHaveBeenCalledWith({
      kind: 'case_reinvestigate',
      idempotency_key: expect.stringMatching(/^case_reinvestigate-/),
      params: { case_ids: [OPEN_CRITICAL.case_id, OPEN_HIGH.case_id] },
    });
    expect(mocks.reinvestigateCase).not.toHaveBeenCalled();
    expect(await screen.findByText(/reinvestigation queued for 2 cases/i)).toBeInTheDocument();
  });

  it('reuses one idempotency key across an ambiguous retry and rotates after acceptance', async () => {
    mocks.submitJob
      .mockRejectedValueOnce(new Error('connection closed'))
      .mockImplementationOnce(async (input) => acceptedJob(input.kind, input.params))
      .mockImplementationOnce(async (input) => acceptedJob(input.kind, input.params));
    render(<CaseManager />);
    await screen.findByText('Multiple failed logins');
    const checkbox = screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' });
    fireEvent.click(checkbox);
    await chooseBulkAction('Reinvestigate');
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reinvestigate' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());

    await chooseBulkAction('Reinvestigate');
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reinvestigate' }));
    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(2));
    const firstKey = mocks.submitJob.mock.calls[0][0].idempotency_key;
    expect(mocks.submitJob.mock.calls[1][0].idempotency_key).toBe(firstKey);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' }));
    await chooseBulkAction('Reinvestigate');
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reinvestigate' }));
    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(3));
    expect(mocks.submitJob.mock.calls[2][0].idempotency_key).not.toBe(firstKey);
  });

  it('returns to the queue on narrow-layout back/dismiss without reopening a case', async () => {
    render(<CaseManager initialCaseId={OPEN_HIGH.case_id} />);
    await screen.findByTestId('embedded-case-detail');

    fireEvent.click(screen.getAllByRole('button', { name: 'Back to case queue' })[0]);

    expect(screen.queryByTestId('embedded-case-detail')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Active Cases' })).toBeInTheDocument();
    expect(mocks.navigate).toHaveBeenLastCalledWith('case_manager');
  });

  it('shows a retryable queue failure while retaining a deep-linked detail target', async () => {
    mocks.listCases.mockRejectedValueOnce(new Error('offline'));
    render(<CaseManager initialCaseId={OPEN_CRITICAL.case_id} />);

    expect(await screen.findByText('Could not load cases')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute(
      'data-case-id',
      OPEN_CRITICAL.case_id,
    );
  });

  it('has no detectable accessibility violations in the split workspace', async () => {
    const user = userEvent.setup();
    const view = render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' }));
    await user.click(screen.getByRole('button', { name: /bulk actions for/i }));
    const menu = await screen.findByRole('menu');

    expect(await axe(view.container)).toHaveNoViolations();
    expect(await axe(menu)).toHaveNoViolations();
  });
});
