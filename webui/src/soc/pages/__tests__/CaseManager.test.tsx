/** Case Manager queue/workspace integration tests (prototype → live Console). */
import * as React from 'react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { BackgroundJob, BackgroundJobKind, Case } from '@/lib/types';
import CaseManager from '../CaseManager';

expect.extend(toHaveNoViolations);

const mocks = vi.hoisted(() => ({
  listCases: vi.fn(),
  getCase: vi.fn(),
  jobGet: vi.fn(),
  bulk: vi.fn(),
  caseAssign: vi.fn(),
  caseTags: vi.fn(),
  reinvestigateCase: vi.fn(),
  submitJob: vi.fn(),
  navigate: vi.fn(),
  routeOpts: undefined as { caseId?: string } | undefined,
  username: 'analyst.one' as string | null,
  demoActive: false,
  permissions: new Set<string>(),
  toastLoading: vi.fn(() => 'case-manager-bulk'),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  // The live `cases` topic: the queue's onEvent handler, captured from useEventStream.
  streamOnEvent: null as null | ((event: { type: string; data: unknown }) => void),
  // What the mocked detail's "Mock reopen" reports (an Undo/Reopen right after a close).
  detailNext: null as Case | null,
  resolveDialogFocus: null as null | ((opener: HTMLElement | null, andNext: boolean) => HTMLElement | null),
}));

vi.mock('@/lib/useEventStream', async () => {
  const actual = await vi.importActual<typeof import('@/lib/useEventStream')>('@/lib/useEventStream');
  return {
    ...actual,
    useEventStream: (topics: string[], opts: { onEvent?: (event: { type: string; data: unknown }) => void } = {}) => {
      if (topics.includes('cases')) mocks.streamOnEvent = opts.onEvent ?? null;
      return { live: false };
    },
  };
});

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      listCases: mocks.listCases,
      getCase: mocks.getCase,
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
        get: mocks.jobGet,
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

vi.mock('@/soc/demo', async () => {
  const actual = await vi.importActual<typeof import('@/soc/demo')>('@/soc/demo');
  return {
    ...actual,
    useDemo: () => ({
      status: { mode: mocks.demoActive ? 'live' : 'off', active: mocks.demoActive, run_id: null },
      active: mocks.demoActive,
      loading: false,
      refresh: async () => ({ mode: 'off', active: false, run_id: null }),
    }),
  };
});

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

vi.mock('../CaseDetail.api', async () => {
  const actual = await vi.importActual<typeof import('../CaseDetail.api')>('../CaseDetail.api');
  return { ...actual, listPickableUsers: vi.fn(async () => []) };
});

vi.mock('../CaseDetail', () => ({
  CaseDetail: ({
    caseId,
    presentation,
    onClose,
    onCaseChange,
    onAdvance,
    resolveDialogFocus,
  }: {
    caseId: string;
    presentation: string;
    onClose: () => void;
    onCaseChange?: (c: Case) => void;
    onAdvance?: () => void;
    resolveDialogFocus?: (opener: HTMLElement | null, andNext: boolean) => HTMLElement | null;
  }) => {
    mocks.resolveDialogFocus = resolveDialogFocus ?? null;
    return (
    <section data-testid="embedded-case-detail" data-case-id={caseId} data-presentation={presentation}>
      <h2 data-case-title tabIndex={-1}>Mock title</h2>
      <button
        type="button"
        onClick={() => {
          if (mocks.detailNext) onCaseChange?.(mocks.detailNext);
        }}
      >
        Mock reopen
      </button>
      <button type="button" onClick={() => onAdvance?.()}>
        Mock advance
      </button>
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
    );
  },
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

const TERMINAL = new Set(['closed', 'resolved']);

/**
 * A faithful stand-in for `GET /api/cases` (Round 12): the queue is SERVER-backed, so the
 * mock applies the same status-group / status / assignee / severity / q / sort / paging the
 * backend does. A view the UI forgets to ask the server for therefore stays empty here.
 */
function serve(dataset: Case[]) {
  return async (query: Record<string, unknown> = {}) => {
    let rows = [...dataset];
    if (query.status_group === 'active') rows = rows.filter((c) => !TERMINAL.has(String(c.status)));
    if (query.status) rows = rows.filter((c) => c.status === query.status);
    if (query.assignee) {
      rows = rows.filter((c) => String(c.assignee || '').toLowerCase() === String(query.assignee).toLowerCase());
    }
    if (query.severity) rows = rows.filter((c) => c.severity_band === query.severity);
    if (typeof query.q === 'string' && query.q.trim()) {
      const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);
      rows = rows.filter((c) => {
        const hay = [c.case_id, c.case_number, c.title, c.status, c.entity?.value, c.source_name]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }
    const field = String(query.sort_field || 'updated_at') as keyof Case;
    const dir = query.sort_order === 'asc' ? 1 : -1;
    rows.sort((a, b) => (String(a[field] ?? '') < String(b[field] ?? '') ? -dir : dir));
    const offset = Number(query.offset || 0);
    const limit = Number(query.limit || 50);
    return { cases: rows.slice(offset, offset + limit), total: rows.length };
  };
}

async function chooseBulkAction(name: string | RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /more bulk actions for/i }));
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
    mocks.demoActive = false;
    mocks.permissions = new Set([
      'cases:write',
      'cases:assign',
      'cases:close',
      'cases:reinvestigate',
    ]);
    mocks.listCases.mockReset().mockImplementation(serve(CASES));
    mocks.getCase.mockReset().mockImplementation(async (id: string) => {
      const item = CASES.find((candidate) => candidate.case_id === id);
      if (!item) throw new Error('Case not found');
      return item;
    });
    mocks.jobGet.mockReset().mockImplementation(async (id: string) => ({
      ...acceptedJob('case_lifecycle', { case_ids: [] }),
      job_id: id,
      status: 'running',
    }));
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
    mocks.streamOnEvent = null;
    mocks.detailNext = null;
    mocks.resolveDialogFocus = null;
  });

  it('centers the shared loading state while the initial case queue is unavailable', async () => {
    mocks.listCases.mockReturnValue(new Promise(() => {}));
    render(<CaseManager />);
    // Let the mount-time owner list settle inside act (strict console gate).
    await act(async () => {});

    const loading = screen.getByRole('status', { name: 'Loading cases' });
    expect(loading).toHaveAttribute('data-loading-layout', 'panel');
    expect(loading).toHaveClass('items-center', 'justify-center');
    expect(within(loading).getByText('Preparing the case queue.')).toBeInTheDocument();
    expect(within(loading).getByTestId('console-loading-glyph')).toBeInTheDocument();
  });

  it('opens on the newest active case and embeds the complete shared workspace', async () => {
    render(<CaseManager />);

    expect(await screen.findByRole('heading', { name: 'Active cases' })).toBeInTheDocument();
    // Server-backed (CM-1): the whole active lifecycle group is asked for, one page at a time.
    expect(mocks.listCases).toHaveBeenCalledWith(
      expect.objectContaining({ status_group: 'active', offset: 0, limit: 50, sort_field: 'updated_at' }),
    );
    expect(await screen.findByText('1 of 2 active · 2 loaded')).toBeInTheDocument();
    expect(screen.queryByText('Benign health check')).not.toBeInTheDocument();

    const manager = screen.getByTestId('case-manager');
    expect(manager).toHaveClass(
      'h-[calc(100dvh-7rem)]',
      'min-h-0',
      'w-auto',
      'sm:-mx-2',
      'xl:min-h-[600px]',
    );
    expect(manager.className.split(/\s+/)).not.toContain('min-h-[600px]');
    expect(manager.className.split(/\s+/)).not.toContain('w-full');
    // The bleed tracks the shell's now-FLAT gutter. The old ladder steps would over-bleed
    // and push the board out of the shell's `overflow-x-hidden` main at >=1024px.
    expect(manager.className.split(/\s+/)).not.toContain('lg:-mx-4');
    expect(manager.className.split(/\s+/)).not.toContain('2xl:-mx-8');

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
    // The filter is applied by the SERVER across every case, not to a loaded page.
    await waitFor(() =>
      expect(mocks.listCases).toHaveBeenLastCalledWith(expect.objectContaining({ severity: 'high' })),
    );
    await waitFor(() =>
      expect(screen.queryByText('Suspicious S3 bucket exfiltration')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Multiple failed logins')).toBeInTheDocument();
  });

  it('titles the queue in sentence case without a generated eyebrow', async () => {
    render(<CaseManager />);
    const heading = await screen.findByRole('heading', { level: 1, name: 'Active cases' });
    expect(heading).not.toHaveClass('uppercase');
    // The old tracked "CASE MANAGER" eyebrow above the h1 is gone; the h1 names the queue.
    expect(screen.queryByText(/^case manager$/i)).not.toBeInTheDocument();
    const queue = screen.getByRole('complementary', { name: 'Case queue' });
    expect(queue.querySelectorAll('.uppercase')).toHaveLength(0);
  });

  it('renders each case as a divided two-line row that shows severity, risk, id and status', async () => {
    // Round 12: a third line (id · primary fact) and the outcome word were added; the
    // two-line title/meta reading order is unchanged.
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');

    // A divided list rather than boxed cards: hairlines between rows, no card chrome.
    const list = screen.getByRole('list', { name: 'Cases' });
    expect(list).toHaveClass('divide-y');
    const rows = within(list).getAllByTestId('case-queue-row');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.className).not.toMatch(/\brounded|\bborder\b|\bshadow/);
    }

    const critical = rows.find((row) =>
      within(row).queryByText('Suspicious S3 bucket exfiltration'),
    ) as HTMLElement;
    // Line 2: the severity WORD (never colour alone), the loaded risk score that the card
    // never showed, the display id and the sentence-case status with its glyph.
    expect(within(critical).getByTestId('case-queue-severity')).toHaveTextContent('Critical');
    expect(within(critical).getByTestId('case-queue-severity')).toHaveClass('text-critical-text');
    expect(within(critical).getByText('Risk 92')).toBeInTheDocument();
    expect(within(critical).getByText('CASE-2026-0092')).toHaveClass('font-mono');
    expect(within(critical).getByTestId('case-queue-status')).toHaveTextContent(/^Investigating$/);
    expect(within(critical).getByTestId('case-queue-status').querySelector('svg')).not.toBeNull();
    // The entity is not in this title, so it is kept as the row's secondary fact.
    expect(within(critical).getByText('IP 198.51.100.45')).toBeInTheDocument();
    // The severity rail reinforces the word: solid for critical.
    expect(within(critical).getByTestId('case-queue-severity-rail')).toHaveClass('bg-critical');

    const high = rows.find((row) => within(row).queryByText('Multiple failed logins')) as HTMLElement;
    expect(within(high).getByTestId('case-queue-severity')).toHaveTextContent('High');
    expect(within(high).getByText('Risk 68')).toBeInTheDocument();
    expect(within(high).getByText('CASE-2026-0091')).toBeInTheDocument();
    expect(within(high).getByTestId('case-queue-status')).toHaveTextContent(
      /^Open · awaiting analyst$/,
    );
    expect(within(high).getByText('User admin_svc')).toBeInTheDocument();

    // No tracked capitals anywhere in a row.
    for (const row of rows) expect(row.querySelectorAll('.uppercase')).toHaveLength(0);
  });

  it('omits an entity the title already names, and falls back to the source name', async () => {
    const REPEATED: Case = {
      case_id: 'case-repeated',
      case_number: 'CASE-2026-0100',
      title: 'user:pnair — impossible travel',
      status: 'open',
      severity_band: 'medium',
      risk_score: 40,
      updated_at: '2026-07-20T10:30:00Z',
      entity: { type: 'user', value: 'pnair' },
    };
    mocks.listCases.mockResolvedValue({ cases: [REPEATED, RESOLVED_LOW], total: 2 });
    render(<CaseManager />);
    await screen.findByText('user:pnair — impossible travel');
    const row = screen.getAllByTestId('case-queue-row')[0];
    expect(within(row).queryByText('User pnair')).not.toBeInTheDocument();
    expect(within(row).getByText('CASE-2026-0100')).toBeInTheDocument();
    // Medium is reinforced by a dashed (gradient) rail, not a solid one.
    expect(within(row).getByTestId('case-queue-severity-rail').className).toMatch(
      /repeating-linear-gradient/,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    // The All view is a new server query; wait for it so no update lands after the test.
    expect(await screen.findByText('1 of 2 cases · 2 loaded')).toBeInTheDocument();
    const resolved = screen
      .getAllByTestId('case-queue-row')
      .find((candidate) => within(candidate).queryByText('Benign health check')) as HTMLElement;
    // No entity recorded: the source name is the secondary fact, exactly as before.
    expect(within(resolved).getByText('Wazuh Manager')).toBeInTheDocument();
    expect(within(resolved).getByTestId('case-queue-status')).toHaveTextContent(/^Resolved$/);
    // Low severity carries no rail colour: colour appears only where it flags something.
    expect(within(resolved).getByTestId('case-queue-severity-rail').className).not.toMatch(
      /\bbg-/,
    );
  });

  it('falls through a redundant entity to the source name instead of dropping the fact', async () => {
    const NAMED: Case = {
      case_id: 'case-named',
      case_number: 'CASE-2026-0101',
      title: 'ip:203.0.113.77 — AUTH-ANOMALY',
      status: 'open',
      severity_band: 'high',
      risk_score: 70,
      updated_at: '2026-07-20T10:30:00Z',
      source_name: 'IBM QRadar SIEM',
      entity: { type: 'ip', value: '203.0.113.77' },
    };
    mocks.listCases.mockResolvedValue({ cases: [NAMED], total: 1 });
    render(<CaseManager />);
    await screen.findByText('ip:203.0.113.77 — AUTH-ANOMALY');
    const row = screen.getAllByTestId('case-queue-row')[0];
    expect(within(row).queryByText('IP 203.0.113.77')).not.toBeInTheDocument();
    expect(within(row).getByText('IBM QRadar SIEM')).toBeInTheDocument();
    // The fact shrinks first and hides below a 360px queue (container query), and it
    // never leaves the row: the open control's accessible name still carries it.
    const fact = within(row).getByTestId('case-queue-fact');
    expect(fact).toHaveClass('hidden', '@[22.5rem]/queue:flex');
    expect(within(row).getByRole('button', { name: /IBM QRadar SIEM/ })).toBeInTheDocument();
  });

  it('keeps open, selected, hovered and focused rows visually distinct', async () => {
    render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');

    const rowFor = (title: string) =>
      screen
        .getAllByTestId('case-queue-row')
        .find((row) => within(row).queryByText(title)) as HTMLElement;
    const openRow = rowFor('Suspicious S3 bucket exfiltration');
    const otherRow = rowFor('Multiple failed logins');
    const openButton = within(openRow).getByRole('button');
    const otherButton = within(otherRow).getByRole('button');

    // OPEN: aria-current, the stronger primary tint and a primary edge rail.
    expect(openButton).toHaveAttribute('aria-current', 'true');
    expect(openRow).toHaveAttribute('data-row-state', 'open');
    expect(openRow).toHaveClass('bg-primary/[0.09]');
    expect(within(openRow).getByTestId('case-queue-open-rail')).toHaveClass('bg-primary');

    // IDLE: no aria-current, no rail, only a neutral hover wash.
    expect(otherButton).not.toHaveAttribute('aria-current');
    expect(otherRow).toHaveAttribute('data-row-state', 'idle');
    expect(otherRow).toHaveClass('hover:bg-muted/70');
    expect(within(otherRow).queryByTestId('case-queue-open-rail')).toBeNull();

    // FOCUS: every row's open button draws an inset keyboard ring.
    for (const button of [openButton, otherButton]) {
      expect(button).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-inset', 'focus-visible:ring-ring');
    }

    // Round 12 (CM-4): checkboxes are ALWAYS visible (no hover-only reveal) and stay out
    // of the tab order — the queue is one roving tab stop; X / Space toggles selection.
    const otherCheckbox = within(otherRow).getByRole('checkbox', { name: 'Select CASE-2026-0091' });
    expect(otherCheckbox).not.toHaveClass('opacity-0');
    expect(otherCheckbox).toHaveAttribute('tabindex', '-1');
    expect(openButton).toHaveAttribute('tabindex', '0');
    expect(otherButton).toHaveAttribute('tabindex', '-1');

    // SELECTED: checked box + a lighter tint than the open row, never the open treatment.
    fireEvent.click(otherCheckbox);
    expect(otherCheckbox).toHaveAttribute('aria-checked', 'true');
    expect(otherRow).toHaveAttribute('data-row-state', 'selected');
    expect(otherRow).toHaveClass('bg-primary/[0.04]');
    expect(otherRow).not.toHaveClass('bg-primary/[0.09]');
    expect(otherButton).not.toHaveAttribute('aria-current');
    expect(within(otherRow).queryByTestId('case-queue-open-rail')).toBeNull();
    expect(openRow.className).not.toBe(otherRow.className);

    // Once anything is selected every row keeps its checkbox visible.
    for (const checkbox of screen
      .getAllByTestId('case-queue-row')
      .map((row) => within(row).getByRole('checkbox'))) {
      expect(checkbox).not.toHaveClass('opacity-0');
    }
  });

  it('keeps each row checkbox a sibling of its open button, never nested inside it', async () => {
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');

    for (const row of screen.getAllByTestId('case-queue-row')) {
      const checkbox = within(row).getByRole('checkbox');
      const [openButton] = within(row).getAllByRole('button');
      expect(openButton.contains(checkbox)).toBe(false);
      expect(checkbox.parentElement).toBe(openButton.parentElement);
      expect(checkbox.closest('button:not([role="checkbox"])')).toBeNull();
    }
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
    expect(screen.getByRole('heading', { name: 'All cases' })).toBeInTheDocument();
    expect(await screen.findByText('1 of 3 cases · 3 loaded')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search case queue' }), {
      target: { value: 'health check' },
    });
    // Instant pre-filter of the loaded rows while the server query is debounced (a
    // filtered-out row leaves through a short exit animation)…
    expect(screen.getByText('Benign health check')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Multiple failed logins')).not.toBeInTheDocument());
    // …then the search runs on the server over every case.
    await waitFor(() =>
      expect(mocks.listCases).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'health check' })),
    );

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

    // The resolved case leaves the Active window AND its total, so loaded vs total stays exact.
    await waitFor(() => {
      expect(screen.queryByText('Suspicious S3 bucket exfiltration')).not.toBeInTheDocument();
      expect(screen.getByText('1 active · 1 loaded')).toBeInTheDocument();
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
    await waitFor(() =>
      expect(screen.queryByText('Suspicious S3 bucket exfiltration')).not.toBeInTheDocument(),
    );
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
    // The job is tracked in place (CM-7): progress shows here; the rows stay selected
    // until it finishes (successes then leave the selection, failures stay with a reason).
    expect(await screen.findByText('Acknowledgement: 0 of 2 done')).toBeInTheDocument();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/acknowledgement queued for 2 cases/i),
      expect.anything(),
    );
    expect(screen.getByText('2 selected')).toBeInTheDocument();
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

    // The selection is kept while the first job is tracked, so the next action reuses it.
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
        // A person picked it in the bulk form, so it counts as their classification (D15).
        disposition_declared: true,
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
    await user.click(screen.getByRole('button', { name: /more bulk actions for/i }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Assign' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /^Resolve/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /^Close/ })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Acknowledge' })).toBeInTheDocument();
    // The toolbar's direct Assign / Close buttons follow the same grants.
    expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close…' })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    mocks.permissions.add('cases:close');
    fireEvent.click(rowCheckbox);
    fireEvent.click(rowCheckbox);
    await chooseBulkAction(/^Resolve/);
    // Resolve is gated by the outcome dialog: a disposition is REQUIRED (D15).
    const dialog = await screen.findByTestId('bulk-close-dialog');
    expect(within(dialog).getByRole('heading', { name: 'Resolve 1 case' })).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Resolve 1 case' });
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('radio', { name: /true positive/i }));
    expect(mocks.submitJob).not.toHaveBeenCalled();
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(1));
    expect(mocks.submitJob.mock.calls[0][0]).toMatchObject({
      kind: 'case_lifecycle',
      params: {
        case_ids: [OPEN_HIGH.case_id],
        action: 'resolve',
        disposition: 'true_positive',
        disposition_declared: true,
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
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/reinvestigation queued for 2 cases/i),
        expect.anything(),
      ),
    );
    expect(await screen.findByText('Reinvestigation: 0 of 2 done')).toBeInTheDocument();
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

    // Still selected (the accepted job is tracked in place): submit the same ids again.
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
    expect(screen.getByRole('heading', { name: 'Active cases' })).toBeInTheDocument();
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

  it('reaches an active case beyond the old newest-200 window by paging the server', async () => {
    // 260 active cases: before Round 12 the queue loaded the newest 200 and filtered in
    // the browser, so the oldest 60 were silently missing from "Active".
    const many: Case[] = Array.from({ length: 260 }, (_, i) => ({
      case_id: `case-${String(i).padStart(3, '0')}`,
      case_number: `CASE-${String(1000 + i)}`,
      title: `Active case ${i}`,
      status: 'open',
      severity_band: 'medium',
      risk_score: 30,
      updated_at: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + i * 60_000).toISOString(),
    }));
    mocks.listCases.mockImplementation(serve(many));
    render(<CaseManager />);
    expect(await screen.findByText('1 of 260 active · 50 loaded')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() =>
      expect(mocks.listCases).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50, limit: 50 })),
    );
    expect(await screen.findByText('1 of 260 active · 100 loaded')).toBeInTheDocument();

    // The oldest case is found by a server-side search, not a loaded-page filter.
    fireEvent.change(screen.getByRole('textbox', { name: 'Search case queue' }), {
      target: { value: 'CASE-1000' },
    });
    expect(await screen.findByText('Active case 0')).toBeInTheDocument();
    // Settle the search's own page before the test ends, so a slow run never leaves a
    // queue update to land (outside act) in the next test.
    expect(await screen.findByText(/^(?:1 of )?1 active · 1 loaded$/)).toBeInTheDocument();
    await waitFor(() => expect(mocks.listCases).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'CASE-1000' })));
    // Two pages of 50 full queue rows: ~2.3 s alone, and several times that on a loaded CI
    // runner, so this test gets its own budget instead of Vitest's 5 s default.
  }, 20_000);

  it('Mine asks the server for the signed-in analyst’s active cases', async () => {
    mocks.listCases.mockImplementation(
      serve([{ ...OPEN_HIGH, assignee: 'analyst.one' }, OPEN_CRITICAL, RESOLVED_LOW]),
    );
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');
    fireEvent.click(screen.getByRole('radio', { name: 'Mine' }));
    expect(screen.getByRole('heading', { name: 'My cases' })).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listCases).toHaveBeenLastCalledWith(
        expect.objectContaining({ assignee: 'analyst.one', status_group: 'active' }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText('Suspicious S3 bucket exfiltration')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Multiple failed logins')).toBeInTheDocument();
  });

  it('moves through the queue with J/K and arrows, toggles selection with X, and opens shortcuts with ?', async () => {
    render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');
    const list = screen.getByRole('list', { name: 'Cases' });
    const rowButton = (title: string) =>
      within(
        screen.getAllByTestId('case-queue-row').find((row) => within(row).queryByText(title)) as HTMLElement,
      ).getAllByRole('button')[0];

    act(() => rowButton('Suspicious S3 bucket exfiltration').focus());
    fireEvent.keyDown(list, { key: 'j' });
    await waitFor(() =>
      expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', OPEN_HIGH.case_id),
    );
    expect(rowButton('Multiple failed logins')).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(list, { key: 'x' });
    expect(screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    fireEvent.keyDown(list, { key: 'ArrowUp' });
    await waitFor(() =>
      expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', OPEN_CRITICAL.case_id),
    );

    await waitFor(() => expect(rowButton('Suspicious S3 bucket exfiltration')).toHaveFocus());

    fireEvent.keyDown(document.body, { key: '?' });
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('focuses the queue search with /', async () => {
    render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByRole('textbox', { name: 'Search case queue' })).toHaveFocus();
  });

  it('bulk Close requires a disposition and submits it as declared', async () => {
    render(<CaseManager />);
    await screen.findByText('Multiple failed logins');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible cases' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close…' }));

    const dialog = await screen.findByTestId('bulk-close-dialog');
    const submit = within(dialog).getByRole('button', { name: 'Close 2 cases' });
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('radio', { name: /false positive/i }));
    fireEvent.click(submit);

    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(1));
    expect(mocks.submitJob.mock.calls[0][0]).toMatchObject({
      kind: 'case_lifecycle',
      params: {
        action: 'close',
        case_ids: [OPEN_CRITICAL.case_id, OPEN_HIGH.case_id],
        disposition: 'false_positive',
        disposition_declared: true,
        resolution: 'Bulk-closed by analyst',
      },
    });
  });

  it('keeps failed rows selected with their reason when a tracked bulk job finishes', async () => {
    render(<CaseManager />);
    await screen.findByText('Multiple failed logins');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible cases' }));
    await chooseBulkAction('Acknowledge');
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Acknowledge cases' }));
    await screen.findByText('Acknowledgement: 0 of 2 done');

    // No live stream in jsdom: the tracked job is polled until it is terminal.
    mocks.jobGet.mockImplementation(async (id: string) => ({
      ...acceptedJob('case_lifecycle', { case_ids: [OPEN_CRITICAL.case_id, OPEN_HIGH.case_id] }),
      job_id: id,
      status: 'partial',
      progress: { done: 2, total: 2, unit: 'cases' },
      failures: [{ item_ref: OPEN_HIGH.case_id, reason: 'Case is closed' }],
      failure_count: 1,
    }));
    expect(
      await screen.findByText(/1 of 2 done\. 1 failed and stays selected/i, undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: 'Select CASE-2026-0092' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Case is closed')).toBeInTheDocument();
  });

  it('says up front that bulk changes are off in Demo Mode instead of failing after the dialog', async () => {
    mocks.demoActive = true;
    render(<CaseManager />);
    await screen.findByText('Suspicious S3 bucket exfiltration');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CASE-2026-0092' }));
    expect(await screen.findByTestId('case-bulk-demo-note')).toHaveTextContent(
      'Bulk changes run as background jobs, which are off in Demo Mode.',
    );
    expect(screen.getByRole('button', { name: /^close…$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /more bulk actions for/i })).toBeDisabled();
    expect(mocks.submitJob).not.toHaveBeenCalled();
  });

  // ---- live queue honesty (Round 12 review: F1/F2/F5) ------------------------------ //

  /** 68 active cases, newest-updated first; the queue loads the newest 50. */
  function activeDataset(count = 68): Case[] {
    return Array.from({ length: count }, (_, i) => ({
      case_id: `case-${String(i).padStart(4, '0')}`,
      case_number: `CASE-${String(5000 + i)}`,
      title: `Active case ${i}`,
      status: 'open',
      severity_band: 'medium',
      risk_score: 30,
      updated_at: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + i * 60_000).toISOString(),
    }));
  }

  function liveChanged(caseId: string, created = false) {
    act(() => {
      mocks.streamOnEvent?.({ type: 'case.changed', data: { case_id: caseId, status: 'open', created } });
    });
  }

  it('shows a case that a live change moves INTO the loaded window (unloaded id, not created)', async () => {
    const dataset = activeDataset();
    mocks.listCases.mockImplementation(serve(dataset));
    mocks.getCase.mockImplementation(async (id: string) => dataset.find((c) => c.case_id === id));
    render(<CaseManager />);
    expect(await screen.findByText('1 of 68 active · 50 loaded')).toBeInTheDocument();
    expect(screen.queryByText('Active case 5')).not.toBeInTheDocument();

    // Another analyst puts an old, unloaded case on hold: it now lists first under Latest.
    dataset[5] = { ...dataset[5], status: 'on_hold', updated_at: '2026-10-02T00:00:00Z' };
    liveChanged(dataset[5].case_id);

    expect(await screen.findByText('Active case 5', undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByTestId('case-queue-scope')).toHaveTextContent('68 active');

    // …and Load more still reaches every case (no offset drift, no stuck "67 of 68").
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText('All 68 loaded')).toBeInTheDocument();
    expect(screen.getAllByTestId('case-queue-row')).toHaveLength(68);
  });

  it('re-reads the window when Load more pages over a live-shifted order instead of skipping a case', async () => {
    const dataset = activeDataset();
    mocks.listCases.mockImplementation(serve(dataset));
    render(<CaseManager />);
    expect(await screen.findByText('1 of 68 active · 50 loaded')).toBeInTheDocument();

    // A case beyond the window moves to the top with NO live event (the stream is down).
    dataset[3] = { ...dataset[3], updated_at: '2026-10-02T00:00:00Z' };
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    // The offset page repeats a loaded row; the queue re-reads instead of appending a gap.
    expect(await screen.findByText('All 68 loaded')).toBeInTheDocument();
    expect(screen.getByText('Active case 3')).toBeInTheDocument();
    const ids = screen.getAllByTestId('case-queue-row').map((row) => row.getAttribute('data-case-id'));
    expect(new Set(ids).size).toBe(68);
  });

  it('brings a case reopened right after a close back into the Active queue and its total', async () => {
    const dataset = [OPEN_HIGH, RESOLVED_LOW, OPEN_CRITICAL];
    mocks.listCases.mockImplementation(serve(dataset));
    render(<CaseManager initialCaseId={OPEN_CRITICAL.case_id} />);
    await screen.findByText('1 of 2 active · 2 loaded');

    // Close: the row leaves the Active window and its total.
    dataset[2] = { ...OPEN_CRITICAL, status: 'resolved' };
    fireEvent.click(screen.getByRole('button', { name: 'Mock resolve' }));
    await waitFor(() => expect(screen.getByTestId('case-queue-scope')).toHaveTextContent('1 active · 1 loaded'));
    await waitFor(() => expect(screen.queryByText('Suspicious S3 bucket exfiltration')).not.toBeInTheDocument());

    // Reopen (the close toast's action): the server lists it again, so must the queue.
    const reopened = { ...OPEN_CRITICAL, status: 'open', updated_at: '2026-07-20T11:00:00Z' };
    dataset[2] = reopened;
    mocks.detailNext = reopened;
    fireEvent.click(screen.getByRole('button', { name: 'Mock reopen' }));

    expect(await screen.findByText('Suspicious S3 bucket exfiltration')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('case-queue-scope')).toHaveTextContent('2 active · 2 loaded'));
  });

  it('drops a row that no longer matches the status filter after a live change, and counts only matching new cases', async () => {
    const dataset = [OPEN_HIGH, RESOLVED_LOW, OPEN_CRITICAL];
    mocks.listCases.mockImplementation(serve(dataset));
    mocks.getCase.mockImplementation(async (id: string) => dataset.find((c) => c.case_id === id));
    render(<CaseManager />);
    await screen.findByText('Multiple failed logins');

    // Status filter: "Open · awaiting analyst" (needs_human).
    fireEvent.click(screen.getByRole('combobox', { name: 'Status filter' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Open · awaiting analyst' }));
    await waitFor(() =>
      expect(mocks.listCases).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'needs_human' })),
    );
    await waitFor(() => expect(screen.getByTestId('case-queue-scope')).toHaveTextContent('1 active · 1 loaded'));

    // Acknowledged elsewhere: no longer needs_human, so it leaves this filtered view.
    dataset[0] = { ...OPEN_HIGH, status: 'investigating' };
    liveChanged(OPEN_HIGH.case_id);
    await waitFor(() => expect(screen.queryByText('Multiple failed logins')).not.toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByTestId('case-queue-scope')).toHaveTextContent('0 active · 0 loaded');

    // A new case outside the filter is not "new" here; a matching one is.
    const outside: Case = { ...OPEN_CRITICAL, case_id: 'case-new-1', title: 'New investigating case', status: 'investigating' };
    const inside: Case = { ...OPEN_HIGH, case_id: 'case-new-2', title: 'New awaiting case', status: 'needs_human' };
    dataset.push(outside);
    liveChanged(outside.case_id, true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(screen.queryByRole('button', { name: /new case/i })).not.toBeInTheDocument();
    dataset.push(inside);
    liveChanged(inside.case_id, true);
    expect(await screen.findByRole('button', { name: '1 new case · Show' }, { timeout: 3000 })).toBeInTheDocument();
  });

  it('re-reads the queue when the live stream overflowed (frames were dropped)', async () => {
    render(<CaseManager />);
    await screen.findByText('Multiple failed logins');
    const before = mocks.listCases.mock.calls.length;
    act(() => {
      mocks.streamOnEvent?.({ type: 'overflow', data: {} });
    });
    await waitFor(() => expect(mocks.listCases.mock.calls.length).toBeGreaterThan(before));
  });

  // ---- focus and keyboard (Round 12 review: F8/F15/F16/F17/F18) ------------------- //

  it('Close & next focus: lands on the next case row, never <body> (SYNTHESIS-ux §3.4/§3.7)', async () => {
    render(<CaseManager initialCaseId={OPEN_CRITICAL.case_id} />);
    await screen.findByText('1 of 2 active · 2 loaded');
    const rowButton = (id: string) =>
      within(document.querySelector(`[data-queue-row][data-case-id="${id}"]`) as HTMLElement).getAllByRole('button')[0];
    const opener = rowButton(OPEN_CRITICAL.case_id);
    act(() => opener.focus());

    // The dialog's submit: the case leaves Active, then the queue advances.
    fireEvent.click(screen.getByRole('button', { name: 'Mock resolve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mock advance' }));
    await waitFor(() =>
      expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', OPEN_HIGH.case_id),
    );
    // The dialog asks where focus goes after "Close & next": the next case's row.
    const target = mocks.resolveDialogFocus?.(opener, true) ?? null;
    expect(target).toBe(rowButton(OPEN_HIGH.case_id));
    await waitFor(() => expect(rowButton(OPEN_HIGH.case_id)).toHaveFocus());
  });

  it('Close & next below xl (queue hidden): lands on the next case title, never a hidden row', async () => {
    render(<CaseManager initialCaseId={OPEN_CRITICAL.case_id} />);
    await screen.findByText('1 of 2 active · 2 loaded');
    // Below xl the detail replaces the queue (`hidden xl:flex`). jsdom applies no
    // Tailwind, so hide the queue the way the browser does.
    const queue = screen.getByRole('complementary', { name: 'Case queue' });
    queue.style.display = 'none';
    // Role queries skip display:none content, so read the hidden row's button directly.
    const rowButton = (id: string) =>
      document.querySelector<HTMLElement>(`[data-queue-row][data-case-id="${id}"] button`) as HTMLElement;
    const title = screen.getByRole('heading', { name: 'Mock title' });
    const opener = screen.getByRole('button', { name: 'Mock back' });
    act(() => opener.focus());

    fireEvent.click(screen.getByRole('button', { name: 'Mock resolve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mock advance' }));
    await waitFor(() =>
      expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', OPEN_HIGH.case_id),
    );
    // The next case's row is mounted but not rendered, so it is never the target.
    expect(rowButton(OPEN_HIGH.case_id).isConnected).toBe(true);
    expect(mocks.resolveDialogFocus?.(opener, true)).toBe(title);
    await waitFor(() => expect(title).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it('J below xl opens the next case and focuses its title, not the hidden queue', async () => {
    render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');
    const first = within(
      document.querySelector(`[data-queue-row][data-case-id="${OPEN_CRITICAL.case_id}"]`) as HTMLElement,
    ).getAllByRole('button')[0];
    act(() => first.focus());
    // Opening a case from the queue hides the queue below xl.
    const queue = screen.getByRole('complementary', { name: 'Case queue' });
    queue.style.display = 'none';
    fireEvent.keyDown(first, { key: 'j' });
    await waitFor(() =>
      expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', OPEN_HIGH.case_id),
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Mock title' })).toHaveFocus());
  });

  it('a plain Close from a queue row lands on the row that took its place', async () => {
    render(<CaseManager initialCaseId={OPEN_CRITICAL.case_id} />);
    await screen.findByText('1 of 2 active · 2 loaded');
    const opener = within(
      document.querySelector(`[data-queue-row][data-case-id="${OPEN_CRITICAL.case_id}"]`) as HTMLElement,
    ).getAllByRole('button')[0];
    fireEvent.click(screen.getByRole('button', { name: 'Mock resolve' }));
    await waitFor(() => expect(screen.getByTestId('case-queue-scope')).toHaveTextContent('1 active'));
    const target = mocks.resolveDialogFocus?.(opener, false);
    expect(target?.closest('[data-queue-row]')).toHaveAttribute('data-case-id', OPEN_HIGH.case_id);
    // An opener that stays (a detail control) keeps the dialog's own default.
    expect(mocks.resolveDialogFocus?.(screen.getByRole('button', { name: 'Mock back' }), false)).toBeNull();
  });

  it('X on a focused checkbox toggles THAT row, and Space is left to the checkbox itself', async () => {
    render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');
    const list = screen.getByRole('list', { name: 'Cases' });
    const lowCheckbox = screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' });
    const topCheckbox = screen.getByRole('checkbox', { name: 'Select CASE-2026-0092' });

    act(() => lowCheckbox.focus());
    fireEvent.keyDown(lowCheckbox, { key: ' ' });
    // Space is the checkbox's native toggle: the queue handler does not toggle the roving row.
    expect(topCheckbox).toHaveAttribute('aria-checked', 'false');

    fireEvent.keyDown(lowCheckbox, { key: 'x' });
    expect(lowCheckbox).toHaveAttribute('aria-checked', 'true');
    expect(topCheckbox).toHaveAttribute('aria-checked', 'false');
    expect(list).toBeInTheDocument();
  });

  it('keeps one live region: the scope line is not aria-live and opening announces only the position', async () => {
    render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');
    expect(screen.getByTestId('case-queue-scope')).not.toHaveAttribute('aria-live');
  });

  it('labels the density toggle once and carries its state in aria-pressed', async () => {
    render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');
    const toggle = screen.getByRole('button', { name: 'Compact rows' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Compact rows' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('returns focus from the shortcuts dialog to the control that opened it', async () => {
    const user = userEvent.setup();
    render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');
    const button = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    await user.click(button);
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument());
    expect(button).toHaveFocus();
  });

  it('"Back to case queue" lands on the case row, not <body>', async () => {
    render(<CaseManager initialCaseId={OPEN_HIGH.case_id} />);
    await screen.findByText('2 of 2 active · 2 loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Back to case queue' }));
    await waitFor(() =>
      expect(document.activeElement?.closest('[data-queue-row]')).toHaveAttribute('data-case-id', OPEN_HIGH.case_id),
    );
  });

  it('a letter typed on a queue filter never fires a page shortcut', async () => {
    render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');
    const severity = screen.getByRole('combobox', { name: 'Severity filter' });
    severity.focus();
    fireEvent.keyDown(severity, { key: '?' });
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
  });

  // ---- final review: the "new cases" pill and Close → J (Round 12 final fixer) ------- //

  const queueRowButton = (id: string) =>
    within(document.querySelector(`[data-queue-row][data-case-id="${id}"]`) as HTMLElement).getAllByRole('button')[0];

  it('"N new cases · Show" keeps a window grown with Load more and adds the new case on top', async () => {
    const dataset = activeDataset(70);
    mocks.listCases.mockImplementation(serve(dataset));
    mocks.getCase.mockImplementation(async (id: string) => dataset.find((c) => c.case_id === id));
    render(<CaseManager />);
    expect(await screen.findByText('1 of 70 active · 50 loaded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(await screen.findByText('All 70 loaded')).toBeInTheDocument();

    // The analyst works a case deep in the grown window (the oldest loaded row).
    fireEvent.click(queueRowButton('case-0000'));
    await waitFor(() =>
      expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', 'case-0000'),
    );

    // The poller creates a case: the prompt appears; Show must not shrink the window to 50.
    const created: Case = {
      ...dataset[0],
      case_id: 'case-new',
      case_number: 'CASE-9999',
      title: 'Brand new case',
      updated_at: '2026-10-05T00:00:00Z',
    };
    dataset.push(created);
    liveChanged(created.case_id, true);
    const show = await screen.findByRole('button', { name: '1 new case · Show' }, { timeout: 3000 });
    const callsBeforeShow = mocks.listCases.mock.calls.length;
    fireEvent.click(show);

    await waitFor(() => expect(screen.getAllByTestId('case-queue-row')).toHaveLength(71));
    expect(screen.getByText('Brand new case')).toBeInTheDocument();
    expect(screen.getByText('All 71 loaded')).toBeInTheDocument();
    // The open case keeps its row, its place and the detail pane.
    expect(document.querySelector('[data-queue-row][data-case-id="case-0000"]')).not.toBeNull();
    expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', 'case-0000');
    expect(screen.getByTestId('case-queue-scope')).toHaveTextContent('71 of 71 active');
    expect(screen.queryByTestId('case-queue-show-new')).not.toBeInTheDocument();
    // One window re-read sized to the grown window — never a first-page-only read.
    const reads = mocks.listCases.mock.calls.slice(callsBeforeShow).map(([query]) => query as Record<string, unknown>);
    expect(reads).toContainEqual(expect.objectContaining({ offset: 0, limit: 71 }));
    expect(reads).not.toContainEqual(expect.objectContaining({ offset: 0, limit: 50 }));
  });

  /** Close the OPEN case (as the detail's plain Close does) and land where the dialog would. */
  async function plainCloseOpenCase(dataset: Case[], id: string, neighbourId: string) {
    const opener = queueRowButton(id);
    const index = dataset.findIndex((c) => c.case_id === id);
    dataset[index] = { ...dataset[index], status: 'closed' };
    mocks.detailNext = dataset[index];
    fireEvent.click(screen.getByRole('button', { name: 'Mock reopen' }));
    await waitFor(() => expect(document.querySelector(`[data-queue-row][data-case-id="${id}"]`)).toBeNull());
    const target = mocks.resolveDialogFocus?.(opener, false) ?? null;
    expect(target?.closest('[data-queue-row]')).toHaveAttribute('data-case-id', neighbourId);
    act(() => target?.focus());
    // The closed case stays in the detail pane; the row that took its place is not open.
    expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', id);
    return target as HTMLElement;
  }

  it('plain Close, then J opens the row that took the closed row\'s place (never skips it)', async () => {
    // Latest first: case-0003, case-0002, case-0001, case-0000.
    const dataset = activeDataset(4);
    mocks.listCases.mockImplementation(serve(dataset));
    render(<CaseManager initialCaseId="case-0002" />);
    await screen.findByText('2 of 4 active · 4 loaded');

    const stop = await plainCloseOpenCase(dataset, 'case-0002', 'case-0001');
    fireEvent.keyDown(stop, { key: 'j' });
    await waitFor(() =>
      expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', 'case-0001'),
    );
    await waitFor(() => expect(queueRowButton('case-0001')).toHaveFocus());

    // From there J moves on as usual.
    fireEvent.keyDown(queueRowButton('case-0001'), { key: 'j' });
    await waitFor(() =>
      expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', 'case-0000'),
    );
  });

  it('plain Close, then K still moves up past the gap to the case before the closed one', async () => {
    const dataset = activeDataset(4);
    mocks.listCases.mockImplementation(serve(dataset));
    render(<CaseManager initialCaseId="case-0002" />);
    await screen.findByText('2 of 4 active · 4 loaded');

    const stop = await plainCloseOpenCase(dataset, 'case-0002', 'case-0001');
    fireEvent.keyDown(stop, { key: 'ArrowUp' });
    await waitFor(() =>
      expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', 'case-0003'),
    );
  });

  it('closing the LAST row: K opens the row above it (the stop) instead of skipping it', async () => {
    const dataset = activeDataset(4);
    mocks.listCases.mockImplementation(serve(dataset));
    render(<CaseManager initialCaseId="case-0000" />);
    await screen.findByText('4 of 4 active · 4 loaded');

    const stop = await plainCloseOpenCase(dataset, 'case-0000', 'case-0001');
    fireEvent.keyDown(stop, { key: 'k' });
    await waitFor(() =>
      expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', 'case-0001'),
    );
  });

  it('Enter on the stop after a plain Close opens that row', async () => {
    const dataset = activeDataset(4);
    mocks.listCases.mockImplementation(serve(dataset));
    render(<CaseManager initialCaseId="case-0002" />);
    await screen.findByText('2 of 4 active · 4 loaded');

    const stop = await plainCloseOpenCase(dataset, 'case-0002', 'case-0001');
    fireEvent.keyDown(stop, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByTestId('embedded-case-detail')).toHaveAttribute('data-case-id', 'case-0001'),
    );
  });

  it('has no detectable accessibility violations in the split workspace', async () => {
    const user = userEvent.setup();
    const view = render(<CaseManager />);
    await screen.findByTestId('embedded-case-detail');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CASE-2026-0091' }));
    await user.click(screen.getByRole('button', { name: /more bulk actions for/i }));
    const menu = await screen.findByRole('menu');

    expect(await axe(view.container)).toHaveNoViolations();
    expect(await axe(menu)).toHaveNoViolations();
  });
});
