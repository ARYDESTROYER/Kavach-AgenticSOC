/**
 * CaseDetail: the case page's structure (Round 16, SPEC D8 and §4.4 WP03), mounted.
 *
 * - Six tabs, one lane each, each opening on its first block (`case-tab-first`, where the
 *   case geometry is measured).
 * - Segregation: nothing the code decided shows on the AI investigation tab, and nothing
 *   the model said shows on the Evidence tab (the provenance tags are the guard).
 * - Alt+1 to Alt+6 always name the same tab: Alt+5 is Activity and Alt+6 is Chat.
 * - The meta strip never wraps: each item that gives way at a narrow pane carries its
 *   container-query class, and the owner never hides, so M opens the owner popover at a
 *   30rem pane.
 * - A finding's "Cites N events" opens Evidence with its events filtered.
 * - No axe violations on the Brief.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const CASE = {
  case_id: 'c-struct-1',
  case_number: 'CASE-000501',
  title: 'Password spray against the VPN',
  status: 'open',
  verdict: 'TRUE_POSITIVE',
  confidence: 0.91,
  risk_score: 74,
  severity_band: 'high',
  assignee: 'asha',
  summary: 'Many accounts saw failed sign-ins from one address.',
  entity: { type: 'ip', value: '203.0.113.9' },
  source_name: 'Prod Elasticsearch',
  rule_ids: ['auth-failures'],
  evidence: [{ summary: 'Forty failed sign-ins in two minutes.', query: 'source.ip:203.0.113.9' }],
  updated_at: '2026-11-01T10:00:00Z',
  created_at: '2026-11-01T09:00:00Z',
  history: [],
  tags: ['vpn'],
};

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  const target: Record<string, unknown> = {
    getCase: vi.fn(() => Promise.resolve(CASE)),
    get: vi.fn(() => Promise.resolve({ case_id: CASE.case_id, stages: [], spans: [], total: 0, messages: [] })),
    // The lazy case chat reads the viewer's chat preferences when it mounts.
    prefs: { getUser: vi.fn(() => Promise.resolve({})), putUser: vi.fn(() => Promise.resolve({})) },
  };
  return {
    ApiError,
    // The case's screenshots (none) and its runbook read (no run attached).
    request: vi.fn((_method: string, path: string) =>
      Promise.resolve(
        path.endsWith('/files')
          ? {
              case_id: CASE.case_id,
              files: [],
              deleted: [],
              count: 0,
              bytes: 0,
              can_upload: true,
              limits: {
                max_files: 20,
                max_case_bytes: 20971520,
                max_file_bytes: 2097152,
                max_thumbnail_bytes: 65536,
                max_side_px: 4096,
                max_pixels: 16777216,
                max_caption_chars: 200,
                max_filename_chars: 120,
                accepted_types: ['image/png', 'image/jpeg', 'image/webp'],
              },
            }
          : { runs: [], progress: {}, newer_versions: {}, other_tasks: [], revision: 1 },
      ),
    ),
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
        return t[prop as string];
      },
    }),
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'probe', hasPermission: () => true, user: null }),
  useOptionalAuth: () => ({ hasPermission: () => true }),
  useCan: () => () => true,
}));

// The records kit is WP14's. The findings list offers its "Cites N events" path, and the
// events table shows the ids it is filtered to.
vi.mock('../casedetail/records/FindingsList', () => ({
  FindingsList: ({ onShowEvents }: { onShowEvents?: (ids: string[]) => void }) => (
    <button type="button" onClick={() => onShowEvents?.(['evt-1', 'evt-2'])}>
      Cites 2 events
    </button>
  ),
}));
vi.mock('../casedetail/records/CaseEvents', () => ({
  CaseEvents: ({ filterEventIds }: { filterEventIds?: string[] | null }) => (
    <div data-testid="case-events-stub">{filterEventIds?.length ? `Filtered to ${filterEventIds.join(', ')}` : 'All events'}</div>
  ),
}));

import { CaseDetail } from '@/soc/pages/CaseDetail';
import { CASE_TABS } from '@/soc/case-tabs';

async function renderCase() {
  const view = render(<CaseDetail caseId={CASE.case_id} presentation="embedded" onClose={() => undefined} />);
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent(/Password spray/));
  return view;
}

const activePanel = () => screen.getByRole('tabpanel');
const tab = (name: RegExp) => screen.getByRole('tab', { name });
const pressAlt = (digit: number) =>
  fireEvent.keyDown(document.body, { key: String(digit), code: `Digit${digit}`, altKey: true });

beforeEach(() => {
  window.localStorage.clear();
});

describe('the six tabs', () => {
  it('opens every tab on its first block, Brief first and Chat last', async () => {
    const user = userEvent.setup();
    await renderCase();
    const tabs = screen.getAllByRole('tab');
    // The labels in order (a count may follow; Response shows none with no runbook, since
    // the tab also holds the tasks and is never empty).
    expect(tabs.map((t) => t.textContent)).toEqual(['Brief', 'Evidence', 'AI investigation', 'Response', 'Activity', 'Chat']);
    expect(screen.getByRole('tablist', { name: 'Case sections' })).toHaveAttribute('data-density', 'compact');
    for (const [index, trigger] of tabs.entries()) {
      await user.click(trigger);
      await waitFor(() => expect(trigger).toHaveAttribute('data-state', 'active'));
      expect(trigger).toHaveAttribute('aria-controls');
      expect(document.getElementById(trigger.getAttribute('aria-controls') ?? '')).toBe(activePanel());
      // Each tab's first block carries the geometry hook (Chat's composer pane included).
      await waitFor(() => expect(within(activePanel()).getAllByTestId('case-tab-first').length).toBeGreaterThan(0));
      expect(CASE_TABS[index]).toBeTruthy();
    }
  });

  it('keeps the code off the AI investigation tab and the model off the Evidence tab', async () => {
    const user = userEvent.setup();
    await renderCase();
    await user.click(tab(/^AI investigation/));
    await waitFor(() => expect(tab(/^AI investigation/)).toHaveAttribute('data-state', 'active'));
    expect(activePanel().querySelector('[data-provenance="ai"]')).not.toBeNull();
    expect(activePanel().querySelector('[data-provenance="code"]')).toBeNull();
    expect(within(activePanel()).queryByRole('heading', { name: 'Decision' })).toBeNull();

    await user.click(tab(/^Evidence/));
    await waitFor(() => expect(tab(/^Evidence/)).toHaveAttribute('data-state', 'active'));
    expect(activePanel().querySelector('[data-provenance="ai"]')).toBeNull();
    expect(activePanel().querySelector('[data-provenance="code"]')).toBeNull();

    // The Brief holds the four lanes, one per author, the Decision the code's.
    await user.click(tab(/^Brief/));
    await waitFor(() => expect(tab(/^Brief/)).toHaveAttribute('data-state', 'active'));
    const lanes = Array.from(activePanel().querySelectorAll('[data-lane]')).map((lane) => lane.getAttribute('data-lane'));
    expect(lanes).toEqual(['source', 'ai', 'code', 'analyst']);
  });
});

describe('Alt+N names the same tab for every viewer', () => {
  it('Alt+5 opens Activity and Alt+6 opens Chat; Alt+1 goes back to the Brief', async () => {
    await renderCase();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    pressAlt(5);
    await waitFor(() => expect(tab(/^Activity/)).toHaveAttribute('data-state', 'active'));
    pressAlt(6);
    await waitFor(() => expect(tab(/^Chat/)).toHaveAttribute('data-state', 'active'));
    // The lazy chat arrives and reads the viewer's chat preferences without throwing.
    await waitFor(() => expect(screen.queryByText('Loading chat')).toBeNull(), { timeout: 5000 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    pressAlt(4);
    await waitFor(() => expect(tab(/^Response/)).toHaveAttribute('data-state', 'active'));
    pressAlt(3);
    await waitFor(() => expect(tab(/^AI investigation/)).toHaveAttribute('data-state', 'active'));
    pressAlt(2);
    await waitFor(() => expect(tab(/^Evidence/)).toHaveAttribute('data-state', 'active'));
    pressAlt(1);
    await waitFor(() => expect(tab(/^Brief/)).toHaveAttribute('data-state', 'active'));
    // Alt+7 is nothing.
    pressAlt(7);
    expect(tab(/^Brief/)).toHaveAttribute('data-state', 'active');
  });
});

describe('the meta strip', () => {
  it('never wraps, and names the container width at which each item gives way', async () => {
    await renderCase();
    const meta = screen.getByTestId('case-detail-meta');
    // In a very narrow pane the line scrolls sideways (with no visible scrollbar).
    expect(meta).toHaveClass('h-6', 'flex-nowrap', 'whitespace-nowrap', 'overflow-x-auto');
    const item = (id: string) => meta.querySelector(`[data-meta-item="${id}"]`) as HTMLElement | null;
    // The Risk chip from 30rem, the verdict from 40rem (XFUI3), the SLA from 52rem.
    expect(within(meta).getByTestId('case-detail-risk').closest('[data-meta-item]')).toHaveClass(
      'hidden',
      '@[30rem]/case:inline-flex',
    );
    expect(item('verdict')).toHaveClass('hidden', '@[40rem]/case:inline-flex');
    // The owner never hides; only the name beside the monogram gives way below 44rem.
    const owner = screen.getByTestId('case-detail-owner');
    expect(owner).not.toHaveClass('hidden');
    for (let node: HTMLElement | null = owner.parentElement; node && node !== meta; node = node.parentElement) {
      expect(node).not.toHaveClass('hidden');
    }
    expect(screen.getByTestId('case-detail-owner-name')).toHaveClass('hidden', '@[44rem]/case:inline');
  });

  it('M opens the owner popover at a 30rem pane', async () => {
    const proto = HTMLElement.prototype as HTMLElement & { checkVisibility?: () => boolean };
    const original = proto.checkVisibility;
    // A 30rem pane: the inspector column and its probe are hidden.
    proto.checkVisibility = function checkVisibility(this: HTMLElement) {
      const id = this.getAttribute('data-testid');
      return id !== 'case-facts-column' && id !== 'case-inspector-probe';
    };
    try {
      await renderCase();
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      fireEvent.keyDown(document.body, { key: 'm' });
      const popover = await screen.findByRole('dialog', { name: 'Owner' });
      expect(popover).toBeInTheDocument();
      expect(screen.getByTestId('case-detail-owner')).toHaveAttribute('aria-expanded', 'true');
    } finally {
      if (original) proto.checkVisibility = original;
      else delete proto.checkVisibility;
    }
  });
});

describe('one back control below the split', () => {
  it('puts Back first in the title row, marked so Case Manager drops its own back bar', async () => {
    await renderCase();
    const row = screen.getByTestId('case-title-row');
    const back = within(row).getByTestId('case-back');
    // Case Manager hides its below-xl back bar while the case header holds a control
    // with this marker (a CSS `:has` rule), so a phone shows one Back, not two.
    expect(back).toHaveAttribute('data-case-header-back');
    expect(back).toHaveAccessibleName('Back to case queue');
    expect(row.querySelector('button')).toBe(back);
  });
});

describe('a finding cites its events', () => {
  it('"Cites N events" opens Evidence with the events filtered to them', async () => {
    const user = userEvent.setup();
    await renderCase();
    await user.click(tab(/^AI investigation/));
    await user.click(await screen.findByRole('button', { name: 'Cites 2 events' }));
    await waitFor(() => expect(tab(/^Evidence/)).toHaveAttribute('data-state', 'active'));
    expect(within(activePanel()).getByTestId('case-events-stub')).toHaveTextContent('Filtered to evt-1, evt-2');
  });
});

describe('accessibility', () => {
  it('has no axe violations on the Brief', async () => {
    const { container } = await renderCase();
    await waitFor(() => expect(within(activePanel()).getAllByTestId('case-tab-first').length).toBeGreaterThan(0));
    expect(await axe(container)).toHaveNoViolations();
  });
});
