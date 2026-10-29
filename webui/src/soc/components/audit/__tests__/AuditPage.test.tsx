/**
 * The Audit log page (Round 14 SPEC §4.5.1, §4.5.2, §4.5.7): scopes, the URL, search
 * qualifiers, chips and facets, the keyboard grid, the inspector (non-modal from 1280
 * px, modal below), focus hand-off, paging across a page boundary, investigation groups,
 * Copy link, every state, Demo Mode and the phone layout. The read API and the clipboard
 * are mocked; every value must render as plain text (#9).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
  submit: vi.fn(),
  request: vi.fn(),
  jobsGet: vi.fn(),
  artifact: vi.fn(),
  copy: vi.fn(async () => true),
  authEnabled: false,
  perms: new Set<string>(),
  demo: { active: false, confirmed: true, loading: false, status: { mode: 'off' as string, run_id: null as string | null } },
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/api-audit', () => ({
  AUDIT_COUNT_CAP: 100_001,
  listAuditPage: h.list,
  countAudit: h.count,
  submitAuditExport: h.submit,
}));
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    body?: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    request: h.request,
    api: { jobs: { get: h.jobsGet, artifact: h.artifact } },
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
  };
});
vi.mock('@/lib/clipboard', () => ({ copyText: h.copy, default: h.copy }));
vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    authEnabled: h.authEnabled,
    hasPermission: (resource: string, action: string) => !h.authEnabled || h.perms.has(`${resource}:${action}`),
  }),
}));
vi.mock('@/soc/demo', () => ({ useDemo: () => h.demo }));
vi.mock('sonner', () => ({ toast: h.toast }));

import { ApiError } from '@/lib/api';
import type { AuditPage, AuditRecord } from '@/lib/types-audit';
import { TooltipProvider } from '@/ui/tooltip';
import { RouterProvider } from '@/soc/router';
import Audit from '@/soc/pages/Audit';

import { page, rec, rows } from './audit-fixtures';

const realMatchMedia = window.matchMedia;

function setViewport(width: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+(?:\.\d+)?)px/.exec(query);
    const max = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(query);
    const matches = (min ? width >= Number(min[1]) : true) && (max ? width <= Number(max[1]) : true);
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  }) as typeof window.matchMedia;
}

const tree = () => (
  <TooltipProvider>
    <RouterProvider>
      <Audit />
    </RouterProvider>
  </TooltipProvider>
);

function renderAudit(hash = '#/audit') {
  window.location.hash = hash;
  return render(tree());
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const lastQuery = () => h.list.mock.calls[h.list.mock.calls.length - 1][0];

beforeEach(() => {
  h.list.mockReset();
  h.count.mockReset();
  h.submit.mockReset();
  h.request.mockReset();
  h.copy.mockClear();
  Object.values(h.toast).forEach((f) => f.mockReset());
  h.authEnabled = false;
  h.perms = new Set();
  h.demo = { active: false, confirmed: true, loading: false, status: { mode: 'off', run_id: null } };
  h.list.mockResolvedValue(page(rows(3)));
  setViewport(1440);
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
  window.matchMedia = realMatchMedia;
});

describe('Audit log: reading', () => {
  it('opens on People and settings over the last 7 days, 50 rows, and says what it shows', async () => {
    renderAudit();
    expect(await screen.findByText('Settings changed 1')).toBeInTheDocument();
    expect(h.list).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'people', from: 'now-7d', limit: 50, order: 'desc' }),
      expect.anything(),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Audit log' })).toBeInTheDocument();
    const line = screen.getByTestId('audit-scope-line');
    expect(line).toHaveTextContent('Showing 1 to 3 of 3 events · last 7 days · times in UTC · newest first');
    expect(line).toHaveTextContent('Kept 180 days hot, then 90 days warm');
    expect(screen.getByRole('radio', { name: 'People and settings' })).toBeChecked();
  });

  it('says "at least" when the store can only bound the total', async () => {
    h.list.mockResolvedValue(page(rows(3), { total: 10_000, total_relation: 'gte', next_cursor: 'c2' }));
    renderAudit();
    expect(await screen.findByTestId('audit-scope-line')).toHaveTextContent('of at least 10,000 events');
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('renders a crafted value as plain text, never markup', async () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    h.list.mockResolvedValue(page([rec({ record_id: 'mem:9', result_summary: evil, actor: '<b>x</b>' })]));
    const { container } = renderAudit();
    expect(await screen.findByText(evil)).toBeInTheDocument();
    expect(container.querySelector('script, img[src="x"], b')).toBeNull();
  });

  it('reads the URL view and writes filter changes back without empty keys', async () => {
    const user = userEvent.setup();
    renderAudit('#/audit?scope=all&from=now-30d&event=auth.login&outcome=denied');
    await screen.findByText('Settings changed 1');
    expect(lastQuery()).toMatchObject({ scope: 'all', from: 'now-30d', event: 'auth.login', outcome: 'denied' });
    expect(screen.getByText('Event: Signed in')).toBeInTheDocument();
    expect(screen.getByText('Outcome: Denied')).toBeInTheDocument();
    // The facet names its value only when one is set, like Event and Actor.
    expect(screen.getByRole('button', { name: 'Outcome: Denied' })).toHaveTextContent('OutcomeDenied');
    await user.click(screen.getByRole('button', { name: 'Remove filter Outcome: Denied' }));
    await waitFor(() => expect(window.location.hash).toBe('#/audit?scope=all&from=now-30d&event=auth.login'));
    await waitFor(() => expect(lastQuery().outcome).toBeUndefined());
    expect(screen.getByRole('button', { name: 'Outcome' })).toHaveTextContent(/^Outcome$/);
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(window.location.hash).toBe('#/audit?scope=all&from=now-30d'));
  });

  it('switches scope through the URL', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('radio', { name: 'Agent activity' }));
    await waitFor(() => expect(lastQuery().scope).toBe('agent'));
    expect(window.location.hash).toContain('scope=agent');
  });

  it('compiles search qualifiers into structured filters on Enter', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    const box = screen.getByRole('searchbox', { name: 'Search the audit log' });
    await user.type(box, 'actor:trao outcome:failed role change');
    expect(screen.getByTestId('audit-search-key')).toHaveTextContent('Enter');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ q: 'role change', actor_contains: 'trao', outcome: 'failure' }),
    );
    expect(window.location.hash).toContain('actor_contains=trao');
    expect(box).toHaveValue('role change');
    expect(screen.getByText('Actor contains: trao')).toBeInTheDocument();
  });

  it('applies a quick view in one click, names it as its chip does, and clears it on a second press', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    const view = screen.getByRole('button', { name: 'Sign-in failed' });
    expect(view).toHaveAttribute('aria-pressed', 'false');
    await user.click(view);
    await waitFor(() => expect(lastQuery().event).toBe('auth.login_failed'));
    expect(screen.getByText('Event: Sign-in failed')).toBeInTheDocument();
    const pressed = screen.getByRole('button', { name: 'Sign-in failed' });
    expect(pressed).toHaveAttribute('aria-pressed', 'true');
    // Pressed is never colour alone: a check glyph comes with it.
    expect(pressed.querySelector('svg')).not.toBeNull();
    await user.click(pressed);
    await waitFor(() => expect(lastQuery().event).toBeUndefined());
    expect(screen.getByRole('button', { name: 'Sign-in failed' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('applies each quick view as the one filter it names', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    const cases: Array<[string, Record<string, string | undefined>]> = [
      ['Access denied', { event: undefined, outcome: 'denied' }],
      ['User events', { event: 'user', outcome: undefined }],
      ['Settings events', { event: 'settings', outcome: undefined }],
      ['Configuration and data', { event: 'config', outcome: undefined }],
    ];
    for (const [label, want] of cases) {
      await user.click(screen.getByRole('button', { name: label }));
      await waitFor(() => expect(lastQuery()).toMatchObject({ scope: 'people' }));
      await waitFor(() => expect({ event: lastQuery().event, outcome: lastQuery().outcome }).toEqual(want));
    }
    expect(screen.getByRole('button', { name: 'What the quick views match' })).toBeInTheDocument();
  });

  it('switches Agent activity to People and settings when a quick view is applied there', async () => {
    const user = userEvent.setup();
    renderAudit('#/audit?scope=agent&from=now-7d');
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('button', { name: 'Access denied' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ scope: 'people', outcome: 'denied' }));
    // From All, the scope stays.
    cleanup();
    renderAudit('#/audit?scope=all&from=now-7d');
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('button', { name: 'User events' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ scope: 'all', event: 'user' }));
  });

  it('keeps an ip: qualifier that is not one address in the free text, as typed', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    const box = screen.getByRole('searchbox', { name: 'Search the audit log' });
    await user.type(box, 'ip:10.0.0{Enter}');
    await waitFor(() => expect(lastQuery().q).toBe('ip:10.0.0'));
    expect(lastQuery().ip).toBeUndefined();
    expect(screen.queryByText(/^Client IP:/)).toBeNull();
    await user.clear(box);
    await user.type(box, 'ip:2001:db8::1{Enter}');
    await waitFor(() => expect(lastQuery().ip).toBe('2001:db8::1'));
    expect(window.location.hash).toContain('ip=2001%3Adb8%3A%3A1');
  });

  it('refuses a Client IP in More filters that is not one address', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('button', { name: 'More filters' }));
    await user.type(await screen.findByLabelText('Client IP'), '10.0.0');
    expect(screen.getByText('An IPv4 or IPv6 address.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('marks the chosen outcome with a checked radio item', async () => {
    const user = userEvent.setup();
    renderAudit('#/audit?scope=people&from=now-7d&outcome=denied');
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('button', { name: 'Outcome: Denied' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: 'Denied' })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: 'Any' })).toHaveAttribute('aria-checked', 'false');
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Any' }));
    await waitFor(() => expect(lastQuery().outcome).toBeUndefined());
  });

  it('marks the time zone and order with checked radio items', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('button', { name: /^Time \(UTC\), newest first/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: 'UTC' })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: 'Newest first' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Oldest first' }));
    await waitFor(() => expect(lastQuery().order).toBe('asc'));
  });

  it('focuses the search box with /', async () => {
    renderAudit();
    await screen.findByText('Settings changed 1');
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByRole('searchbox', { name: 'Search the audit log' })).toHaveFocus();
  });
});

describe('Audit log: states', () => {
  it('shows the shared loading state first', () => {
    h.list.mockReturnValue(new Promise(() => {}));
    renderAudit();
    expect(screen.getByText('Loading the audit log')).toBeInTheDocument();
  });

  it('offers a wider range when the view has no events, in the words of its scope', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValue(page([], { total: 0 }));
    renderAudit();
    expect(await screen.findByText('No people and settings events in the last 7 days.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show the last 30 days' }));
    await waitFor(() => expect(lastQuery().from).toBe('now-30d'));
  });

  it('never says the log is empty when only this scope is, and offers every scope', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValue(page([], { total: 0 }));
    renderAudit('#/audit?scope=agent&from=now-7d');
    expect(await screen.findByText('No agent activity in the last 7 days.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all scopes' }));
    await waitFor(() => expect(lastQuery().scope).toBe('all'));
    expect(await screen.findByText('No audit events in the last 7 days.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show all scopes' })).toBeNull();
  });

  it('offers Clear filters when filters match nothing', async () => {
    h.list.mockResolvedValue(page([], { total: 0 }));
    renderAudit('#/audit?scope=people&from=now-7d&q=nothing');
    expect(await screen.findByText('No events match these filters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    expect(screen.getByText('Search: "nothing"')).toBeInTheDocument();
  });

  it('shows a retryable error and keeps no fake rows', async () => {
    const user = userEvent.setup();
    h.list.mockRejectedValueOnce(new ApiError(503, 'The audit log could not be read.'));
    renderAudit();
    expect(await screen.findByText('The audit log could not be loaded.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Settings changed 1')).toBeInTheDocument();
  });

  it('keeps the rows of the same view under the error when a Refresh fails', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValueOnce(page(rows(3))).mockRejectedValueOnce(new ApiError(503, 'The audit log could not be read.'));
    renderAudit();
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('button', { name: 'Refresh the audit log' }));
    expect(await screen.findByText('The audit log could not be loaded.')).toBeInTheDocument();
    expect(screen.getByText('Settings changed 1')).toBeInTheDocument();
    expect(screen.getByText('Settings changed 3')).toBeInTheDocument();
    // Export says why it cannot run now.
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('The audit log could not be loaded.')).toBeInTheDocument();
  });

  it('reads on from the rows kept under the error when a Refresh fails', async () => {
    const user = userEvent.setup();
    h.list
      .mockResolvedValueOnce(page(rows(3), { total: 5, next_cursor: 'c2' }))
      .mockRejectedValueOnce(new ApiError(503, 'The audit log could not be read.'))
      .mockResolvedValueOnce(page(rows(2, 4), { total: 5, next_cursor: null }));
    renderAudit();
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('button', { name: 'Refresh the audit log' }));
    expect(await screen.findByText('The audit log could not be loaded.')).toBeInTheDocument();
    // The rows on screen still answer this view, so their cursor reads on.
    const more = screen.getByRole('button', { name: 'Load more' });
    expect(more).toBeEnabled();
    await user.click(more);
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(3));
    expect(lastQuery()).toMatchObject({ cursor: 'c2', scope: 'people' });
    expect(await screen.findByText('Settings changed 5')).toBeInTheDocument();
    expect(screen.getByText('Settings changed 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it('holds Load more, Next and J while a read is in flight, then reads on from its rows', async () => {
    const user = userEvent.setup();
    const refresh = deferred<AuditPage>();
    h.list
      .mockResolvedValueOnce(page(rows(2), { total: 4, next_cursor: 'c2' }))
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValue(page(rows(2, 3), { total: 4, next_cursor: null }));
    renderAudit();
    await user.click(await screen.findByText('Settings changed 2'));
    const region = await screen.findByRole('region', { name: 'Settings changed 2' });
    expect(within(region).getByRole('button', { name: 'Next' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Refresh the audit log' }));
    // The rows stay, dimmed, and nothing that would read past them can run.
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled();
    expect(within(region).getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(h.list).toHaveBeenCalledTimes(2);
    await act(async () => refresh.resolve(page(rows(2), { total: 4, next_cursor: 'c2b' })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled());
    expect(within(screen.getByRole('region', { name: 'Settings changed 2' })).getByRole('button', { name: 'Next' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(3));
    // The page reads on from the refreshed rows' cursor, never the old one.
    expect(lastQuery()).toMatchObject({ cursor: 'c2b' });
    expect(await screen.findByText('Settings changed 3')).toBeInTheDocument();
  });

  it('never lands a page on rows a newer read replaced', async () => {
    const user = userEvent.setup();
    const more = deferred<AuditPage>();
    h.list
      .mockResolvedValueOnce(page(rows(2), { total: 4, next_cursor: 'c2' }))
      .mockReturnValueOnce(more.promise)
      .mockResolvedValueOnce(page(rows(2, 10), { total: 2, next_cursor: null }));
    renderAudit();
    await screen.findByText('Settings changed 2');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await user.click(screen.getByRole('button', { name: 'Refresh the audit log' }));
    expect(await screen.findByText('Settings changed 10')).toBeInTheDocument();
    await act(async () => more.resolve(page(rows(2, 3), { total: 4, next_cursor: null })));
    expect(screen.queryByText('Settings changed 3')).toBeNull();
    expect(screen.getByTestId('audit-scope-line')).toHaveTextContent('Showing 1 to 2 of 2 events');
  });

  it('shows only the error when another view fails, never the rows of the last one', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValueOnce(page(rows(3))).mockRejectedValueOnce(new ApiError(503, 'The audit log could not be read.'));
    renderAudit();
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('radio', { name: 'All' }));
    expect(await screen.findByText('The audit log could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('Settings changed 1')).toBeNull();
  });

  it('warns calmly when the store is in memory', async () => {
    h.list.mockResolvedValue(page(rows(1), { retention: { hot_days: null, warm_days: null, volatile: true } }));
    renderAudit();
    expect(await screen.findByText('This deployment keeps the audit log in memory; it is lost on restart.')).toBeInTheDocument();
  });

  it('says plainly when the person may not read the audit log', () => {
    h.authEnabled = true;
    h.perms = new Set(['cases:read']);
    renderAudit();
    expect(screen.getByText('You do not have access to the audit log.')).toBeInTheDocument();
    expect(h.list).not.toHaveBeenCalled();
  });

  it('hides the Export menu without audit:export', async () => {
    h.authEnabled = true;
    h.perms = new Set(['audit:view']);
    renderAudit();
    await screen.findByText('Settings changed 1');
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Configuration and data' })).toBeInTheDocument();
  });

  it('labels Demo Mode rows and says which rows are real', async () => {
    h.demo = { active: true, confirmed: true, loading: false, status: { mode: 'seeded', run_id: 'r1' } };
    h.list.mockResolvedValue(page([rec({ record_id: 'demo:mem:1', demo: true, event_label: 'Verdict' })]));
    renderAudit();
    expect(await screen.findByTestId('audit-demo-note')).toHaveTextContent(
      'Demo Mode: agent activity is demo data; sign-ins and settings changes are real.',
    );
    expect(within(screen.getByRole('grid', { name: 'Audit events' })).getByText('Demo')).toBeInTheDocument();
  });

  it('reads once when Demo Mode is first confirmed, and again when it really changes', async () => {
    h.demo = { active: false, confirmed: false, loading: true, status: { mode: 'off', run_id: null } };
    const { rerender } = renderAudit();
    await screen.findByText('Settings changed 1');
    expect(h.list).toHaveBeenCalledTimes(1);
    // The first answer of the status read is no change: the read already reflects it.
    h.demo = { active: false, confirmed: true, loading: false, status: { mode: 'off', run_id: null } };
    rerender(tree());
    // A failed status read (the unconfirmed stand-in) is no change either.
    h.demo = { active: false, confirmed: false, loading: false, status: { mode: 'off', run_id: null } };
    rerender(tree());
    await act(async () => {});
    expect(h.list).toHaveBeenCalledTimes(1);
    // Demo Mode turned on: a different identity, so the list is read again.
    h.demo = { active: true, confirmed: true, loading: false, status: { mode: 'seeded', run_id: 'r1' } };
    rerender(tree());
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
  });

  it('reloads from the top with the server reason when a cursor expired', async () => {
    const user = userEvent.setup();
    h.list
      .mockResolvedValueOnce(page(rows(2), { total: 4, next_cursor: 'c2' }))
      .mockRejectedValueOnce(
        new ApiError(409, 'expired', {
          detail: { code: 'audit_cursor_expired', message: 'The list was refreshed because Demo Mode was turned on or off.' },
        }),
      )
      .mockResolvedValue(page(rows(2), { total: 4, next_cursor: 'c2' }));
    renderAudit();
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(h.toast.info).toHaveBeenCalledWith('The list was refreshed because Demo Mode was turned on or off.'));
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(3));
    expect(lastQuery().cursor).toBeUndefined();
  });

  it('folds the filters into one sheet on a phone and shows Time, Outcome and Event only', async () => {
    setViewport(390);
    renderAudit('#/audit?scope=people&from=now-7d&outcome=success');
    await screen.findByText('Settings changed 1');
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Event/ })).toBeNull();
    const headers = within(screen.getByRole('grid', { name: 'Audit events' })).getAllByRole('columnheader');
    expect(headers.map((th) => th.textContent?.trim())).toEqual(['Time (UTC)', 'Outcome', 'Event']);
    // No keyboard on a phone: the `/` hint gives its room to the placeholder.
    expect(screen.queryByTestId('audit-search-key')).toBeNull();
  });

  it('counts on the phone Filters button only what its sheet holds, never the search', async () => {
    setViewport(390);
    renderAudit('#/audit?scope=people&from=now-7d&q=admin');
    await screen.findByText('Settings changed 1');
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.getByText('Search: "admin"')).toBeInTheDocument();
  });

  it('hands focus back to the phone Filters button when its sheet closes', async () => {
    setViewport(390);
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    const button = screen.getByRole('button', { name: 'Filters' });
    await user.click(button);
    expect(await screen.findByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Filters' })).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('shows every column from 1280 px and folds Target below', async () => {
    renderAudit();
    await screen.findByText('Settings changed 1');
    const wide = within(screen.getByRole('grid', { name: 'Audit events' })).getAllByRole('columnheader');
    expect(wide.map((th) => th.textContent?.trim())).toEqual(['Time (UTC)', 'Outcome', 'Event', 'Actor', 'Target', 'Summary']);
  });
});

describe('Audit log: the grid and the inspector', () => {
  const rowOf = (text: string) =>
    within(screen.getByRole('grid', { name: 'Audit events' })).getByText(text).closest('tr') as HTMLTableRowElement;

  it('is one tab stop that Up and Down move through', async () => {
    renderAudit();
    await screen.findByText('Settings changed 1');
    const grid = screen.getByRole('grid', { name: 'Audit events' });
    const stops = within(grid).getAllByRole('row').filter((r) => r.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    act(() => rowOf('Settings changed 1').focus());
    fireEvent.keyDown(rowOf('Settings changed 1'), { key: 'ArrowDown' });
    expect(rowOf('Settings changed 2')).toHaveFocus();
    expect(screen.queryByRole('region', { name: /Settings changed/ })).toBeNull();
  });

  it('opens a record with J and keeps focus on the row; Enter moves focus to the title', async () => {
    renderAudit();
    await screen.findByText('Settings changed 1');
    act(() => rowOf('Settings changed 1').focus());
    fireEvent.keyDown(rowOf('Settings changed 1'), { key: 'j' });
    const region = await screen.findByRole('region', { name: 'Settings changed 2' });
    expect(rowOf('Settings changed 2')).toHaveFocus();
    expect(window.location.hash).toContain('record=mem%3A2');
    expect(screen.getByTestId('audit-live')).toHaveTextContent('Settings changed 2, 25 Oct 14:58, record 2 of 3');
    fireEvent.keyDown(rowOf('Settings changed 2'), { key: 'Enter' });
    await waitFor(() => expect(within(region).getByRole('heading', { name: 'Settings changed 2' })).toHaveFocus());
  });

  it('names Previous and Next without their key letters, which aria-keyshortcuts carries', async () => {
    const user = userEvent.setup();
    renderAudit();
    await user.click(await screen.findByText('Settings changed 2'));
    const sheet = await screen.findByRole('region', { name: 'Settings changed 2' });
    expect(within(sheet).getByRole('button', { name: 'Previous' })).toHaveAttribute('aria-keyshortcuts', 'K');
    expect(within(sheet).getByRole('button', { name: 'Next' })).toHaveAttribute('aria-keyshortcuts', 'J');
  });

  it('marks the open row with more than a tint', async () => {
    const user = userEvent.setup();
    renderAudit();
    await user.click(await screen.findByText('Settings changed 2'));
    await screen.findByRole('region', { name: 'Settings changed 2' });
    const row = rowOf('Settings changed 2');
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(row.querySelector('td')?.className).toContain('before:bg-primary');
    expect(row.className).toContain('forced-colors:data-[state=selected]:outline');
  });

  it('keeps the non-modal inspector open when Esc resets the search draft', async () => {
    const user = userEvent.setup();
    renderAudit();
    await user.click(await screen.findByText('Settings changed 1'));
    expect(await screen.findByRole('region', { name: 'Settings changed 1' })).toBeInTheDocument();
    const box = screen.getByRole('searchbox', { name: 'Search the audit log' });
    await user.click(box);
    await user.type(box, 'abc');
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('');
    expect(box).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Settings changed 1' })).toBeInTheDocument();
    // Esc from the list still closes it.
    act(() => rowOf('Settings changed 1').focus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Settings changed 1' })).toBeNull());
  });

  it('hands focus back to whatever opened the shortcuts', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    act(() => rowOf('Settings changed 2').focus());
    fireEvent.keyDown(rowOf('Settings changed 2'), { key: '?' });
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull());
    await waitFor(() => expect(rowOf('Settings changed 2')).toHaveFocus());
    const button = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    await user.click(button);
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('is non-modal from 1280 px: no overlay, and another row swaps the record', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByText('Settings changed 1'));
    const sheet = await screen.findByRole('region', { name: 'Settings changed 1' });
    expect(sheet).toHaveAttribute('data-audit-inspector', 'region');
    expect(document.querySelector('[data-state="open"].fixed.inset-0')).toBeNull();
    await user.click(screen.getByText('Settings changed 3'));
    expect(await screen.findByRole('region', { name: 'Settings changed 3' })).toBeInTheDocument();
  });

  it('is a modal dialog below 1280 px and hands focus back to the row on Esc', async () => {
    setViewport(1024);
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByText('Settings changed 2'));
    const dialog = await screen.findByRole('dialog', { name: 'Settings changed 2' });
    expect(dialog).toHaveAttribute('data-audit-inspector', 'modal');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(rowOf('Settings changed 2')).toHaveFocus());
    expect(window.location.hash).not.toContain('record=');
  });

  it('walks past the last loaded row into the next page with J', async () => {
    h.list
      .mockResolvedValueOnce(page(rows(2), { total: 3, next_cursor: 'c2' }))
      .mockResolvedValueOnce(page(rows(1, 3), { total: 3, next_cursor: null }));
    renderAudit();
    await screen.findByText('Settings changed 2');
    act(() => rowOf('Settings changed 2').focus());
    fireEvent.keyDown(rowOf('Settings changed 2'), { key: 'j' });
    await waitFor(() => expect(h.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c2' })));
    await waitFor(() => expect(rowOf('Settings changed 3')).toHaveFocus());
    expect(await screen.findByRole('region', { name: 'Settings changed 3' })).toBeInTheDocument();
  });

  it('shows who, what changed, details, the raw record and the record facts', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValue(
      page([
        rec({
          record_id: 'mem:7',
          action: 'user.role_changed',
          action_type: 'user_mgmt',
          outcome: 'success',
          actor: 'trao',
          actor_type: 'human',
          actor_role: 'super_admin',
          event_label: 'User role changed',
          target: { type: 'user', id: 'vpatel', label: 'vpatel', revision: 4 },
          changes: [
            { field: 'role', before: 'analyst_tier1', after: 'analyst_tier2', secret: false },
            { field: 'password', before: null, after: null, secret: true },
          ],
          client: {
            ip: '203.0.113.24',
            ip_source: 'trusted_proxy',
            peer: '10.0.0.5',
            forwarded_for: '198.51.100.1, 203.0.113.24',
            user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36',
          },
          session_ref: '17f06b1799edbe8c',
          request_id: 'req-12345678',
          tool_input: { remembered: true, nested: { a: 1 } },
          truncated_fields: ['result_summary'],
          result_summary: 'updated user vpatel',
        }),
      ]),
    );
    renderAudit();
    await user.click(await screen.findByText('User role changed'));
    const sheet = await screen.findByRole('region', { name: 'User role changed' });
    const s = within(sheet);
    expect(s.getByText('trao changed the role of vpatel from analyst_tier1 to analyst_tier2.')).toBeInTheDocument();
    expect(s.getByText('203.0.113.24')).toBeInTheDocument();
    expect(s.getByText('From the trusted proxy')).toBeInTheDocument();
    await user.click(s.getByRole('button', { name: 'Show forwarded header' }));
    expect(s.getByText('Supplied by the client; not verified')).toBeInTheDocument();
    expect(s.getByText('Chrome 141 on macOS')).toBeInTheDocument();
    expect(s.getByText('remembered')).toBeInTheDocument();
    expect(s.getByRole('heading', { name: 'What changed' })).toBeInTheDocument();
    expect(s.getByText('Changed (secret values are never recorded)')).toBeInTheDocument();
    expect(s.getByText('analyst_tier1')).toHaveClass('line-through');
    expect(s.getByText(/Stored truncated at 1,000 characters: stored summary/)).toBeInTheDocument();
    expect(s.getByText('revision 4')).toBeInTheDocument();
    expect(s.getByRole('link', { name: 'All events for this target' })).toHaveAttribute(
      'href',
      expect.stringContaining('target=vpatel'),
    );
    // The session link names the window it reads (the read API has no session filter).
    const signIns = s.getByRole('link', { name: 'Sign-ins by trao in the 30 days before this event' });
    expect(signIns.getAttribute('href')).toContain('event=auth.login');
    expect(s.getByRole('group', { name: 'Tool input' })).toBeInTheDocument();
  });

  it('shows Raw record as the store holds it, without the read-time projections', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValue(
      page([
        rec({
          record_id: 'mem:5',
          action_type: 'access_denied',
          actor: 'mallory',
          event_label: 'Access denied',
          outcome: 'denied',
          outcome_derived: true,
          actor_type: 'human',
          actor_type_derived: true,
          result_summary: 'refused cases:write',
        }),
      ]),
    );
    renderAudit();
    await user.click(await screen.findByText('Access denied', { selector: 'span' }));
    const sheet = await screen.findByRole('region', { name: 'Access denied' });
    const raw = within(within(sheet).getByRole('region', { name: 'Raw record' })).getByText(/"action_type"/).textContent ?? '';
    const stored = JSON.parse(raw) as Record<string, unknown>;
    expect(stored).toMatchObject({ action_type: 'access_denied', actor: 'mallory', result_summary: 'refused cases:write' });
    for (const key of ['record_id', 'category', 'event_label', 'demo', 'truncated_fields', 'outcome_derived', 'actor_type_derived', 'outcome', 'actor_type']) {
      expect(stored).not.toHaveProperty(key);
    }
    // The derived values stay visible, labelled, where the inspector reads them out.
    expect(within(sheet).getAllByText('(derived)').length).toBeGreaterThan(0);
    expect(within(sheet).getByText(/Person \(derived\)/)).toBeInTheDocument();
  });

  it('shows a recorded outcome and actor kind in Raw record as stored', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValue(page([rec({ record_id: 'mem:6', outcome: 'success', actor_type: 'human', event_label: 'Role updated' })]));
    renderAudit();
    await user.click(await screen.findByText('Role updated'));
    const sheet = await screen.findByRole('region', { name: 'Role updated' });
    const raw = within(within(sheet).getByRole('region', { name: 'Raw record' })).getByText(/"action_type"/).textContent ?? '';
    expect(JSON.parse(raw)).toMatchObject({ outcome: 'success', actor_type: 'human' });
  });

  it('shows a legacy token by its friendly name in the list and unchanged in Raw record and Record', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValue(
      page([rec({ record_id: 'mem:8', action_type: 'playbook', actor: 'run_playbook', event_label: 'Runbook (before Round 14)', category: 'config' })]),
    );
    renderAudit();
    const grid = await screen.findByRole('grid', { name: 'Audit events' });
    expect(await within(grid).findByText('Runbook automation (before Round 14)')).toBeInTheDocument();
    expect(within(grid).queryByText('run_playbook')).toBeNull();
    await user.click(within(grid).getByText('Runbook (before Round 14)'));
    const sheet = await screen.findByRole('region', { name: 'Runbook (before Round 14)' });
    const raw = within(within(sheet).getByRole('region', { name: 'Raw record' })).getByText(/"action_type"/).textContent ?? '';
    expect(raw).toContain('"run_playbook"');
    expect(raw).toContain('"playbook"');
    const record = within(sheet).getByRole('region', { name: 'Record' });
    expect(within(record).getByText('playbook')).toBeInTheDocument();
  });

  it('links the source to its logs for a person who may read sources', async () => {
    const user = userEvent.setup();
    h.authEnabled = true;
    h.perms = new Set(['audit:view', 'sources:read']);
    h.list.mockResolvedValue(page([rec({ record_id: 'mem:9', source_id: 'wazuh-1', event_label: 'Source poll' })]));
    renderAudit();
    await user.click(await screen.findByText('Source poll'));
    const record = within(await screen.findByRole('region', { name: 'Source poll' })).getByRole('region', { name: 'Record' });
    expect(within(record).getByRole('link', { name: 'wazuh-1' })).toHaveAttribute('href', '#/logs?sourceId=wazuh-1');
    cleanup();
    h.perms = new Set(['audit:view']);
    renderAudit();
    await user.click(await screen.findByText('Source poll'));
    const plain = within(await screen.findByRole('region', { name: 'Source poll' })).getByRole('region', { name: 'Record' });
    expect(within(plain).queryByRole('link', { name: 'wazuh-1' })).toBeNull();
    expect(within(plain).getByText('wazuh-1')).toBeInTheDocument();
  });

  it('names the failure row of a write that was not applied, and opens it', async () => {
    const user = userEvent.setup();
    const target = { type: 'setting' as const, id: 'chat', label: 'Chat' };
    h.list.mockResolvedValue(
      page([
        rec({ record_id: 'mem:2', ts: '2026-10-25T15:00:01.000300Z', action: 'settings.update_failed', outcome: 'failure', request_id: 'req-12345678', target, event_label: 'Settings update failed' }),
        rec({ record_id: 'mem:1', ts: '2026-10-25T15:00:01.000100Z', action: 'settings.updated', outcome: 'success', request_id: 'req-12345678', target, event_label: 'Settings changed' }),
      ]),
    );
    renderAudit();
    await user.click(await screen.findByText('Settings changed'));
    const sheet = await screen.findByRole('region', { name: 'Settings changed' });
    expect(within(sheet).getByTestId('audit-not-applied')).toHaveTextContent('Not applied (see the next record)');
    await user.click(within(sheet).getByRole('button', { name: 'see the next record' }));
    const failure = await screen.findByRole('region', { name: 'Settings update failed' });
    await waitFor(() => expect(within(failure).getByRole('heading', { name: 'Settings update failed' })).toHaveFocus());
    expect(within(failure).queryByTestId('audit-not-applied')).toBeNull();
  });

  it('drops the in-memory filters when a Related link is followed', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValue(page([rec({ record_id: 'mem:4', case_id: 'case-214', event_label: 'Case status changed', category: 'case_work' })]));
    renderAudit();
    await screen.findByText('Case status changed');
    await user.click(screen.getByRole('button', { name: 'More filters' }));
    await user.type(await screen.findByLabelText('Surface'), 'settings');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastQuery().surface).toBe('settings'));
    expect(screen.getByText('Surface: settings')).toBeInTheDocument();
    await user.click(screen.getByText('Case status changed'));
    const sheet = await screen.findByRole('region', { name: 'Case status changed' });
    await user.click(within(sheet).getByRole('link', { name: 'All events for this case' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ scope: 'all', case_id: 'case-214' }));
    expect(lastQuery().surface).toBeUndefined();
    expect(screen.queryByText('Surface: settings')).toBeNull();
  });

  it('copies a link that carries the filters and the record', async () => {
    const user = userEvent.setup();
    renderAudit('#/audit?scope=people&from=now-7d&q=chat');
    await user.click(await screen.findByText('Settings changed 1'));
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(h.copy).toHaveBeenCalled());
    const url = String(h.copy.mock.calls[0][0]);
    expect(url).toContain('#/audit?');
    expect(url).toContain('q=chat');
    expect(url).toContain('record=mem%3A1');
    expect(screen.getByTestId('audit-live')).toHaveTextContent('Copied');
  });

  it('reads a deep-linked record the list does not hold, with the page filters', async () => {
    h.request.mockResolvedValue(rec({ record_id: 'sql:42', event_label: 'Signed in', action: 'auth.login' }));
    renderAudit('#/audit?scope=people&from=now-7d&record=sql%3A42');
    expect(await screen.findByRole('region', { name: 'Signed in' })).toBeInTheDocument();
    expect(h.request).toHaveBeenCalledWith(
      'GET',
      'audit/records/sql%3A42',
      expect.objectContaining({ query: expect.objectContaining({ scope: 'people', from: 'now-7d' }) }),
    );
  });

  it('reads a deep-linked record again when a Refresh aborts the first read', async () => {
    const user = userEvent.setup();
    const first = deferred<ReturnType<typeof rec>>();
    h.request
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(rec({ record_id: 'sql:42', event_label: 'Signed in', action: 'auth.login' }));
    renderAudit('#/audit?scope=people&from=now-7d&record=sql%3A42');
    await waitFor(() => expect(h.request).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Refresh the audit log' }));
    await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    // The aborted read answers late: ignored, and no placeholder keeps the sheet loading.
    first.resolve(rec({ record_id: 'sql:42', event_label: 'Stale answer' }));
    expect(await screen.findByRole('region', { name: 'Signed in' })).toBeInTheDocument();
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Loading the record.')).toBeNull();
  });

  it('offers Retry when a deep-linked record cannot be read', async () => {
    const user = userEvent.setup();
    h.request
      .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
      .mockResolvedValue(rec({ record_id: 'sql:42', event_label: 'Signed in', action: 'auth.login' }));
    renderAudit('#/audit?scope=people&from=now-7d&record=sql%3A42');
    const region = await screen.findByRole('region', { name: 'Record not loaded' });
    expect(within(region).getByText('The record could not be loaded.')).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Signed in' })).toBeInTheDocument();
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('says so when a deep-linked record is not in the current store', async () => {
    const user = userEvent.setup();
    h.request.mockRejectedValue(new ApiError(404, 'missing', { detail: { code: 'audit_record_not_found' } }));
    renderAudit('#/audit?scope=people&from=now-7d&record=mem%3A999');
    const region = await screen.findByRole('region', { name: 'Record not found' });
    expect(within(region).getByText('This record is not in the current store.')).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Back to the audit log' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Record not found' })).toBeNull());
  });
});

describe('Audit log: investigations (Agent activity)', () => {
  it('folds a run into one row and says when only part of it is loaded', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValue(
      page(
        [
          rec({ record_id: 'mem:3', run_id: 'inv-1', case_id: 'case-214', action_type: 'decision', event_label: 'Close or escalate decision', result_summary: 'verdict=FALSE_POSITIVE status=closed', outcome: 'success', actor: 'case_manager', actor_type: 'system', category: 'agent' }),
          rec({ record_id: 'mem:2', run_id: 'inv-1', case_id: 'case-214', action_type: 'tool_call', event_label: 'Tool call', outcome: 'success', actor: 'investigator', actor_type: 'agent', category: 'agent' }),
          rec({ record_id: 'mem:1', action_type: 'poll', event_label: 'Source poll', actor: 'poller', actor_type: 'system', category: 'system' }),
        ],
        { total: 12, next_cursor: 'c2', run_totals: { 'inv-1': 10 } },
      ),
    );
    renderAudit('#/audit?scope=agent&from=now-7d');
    expect(await screen.findByText('Investigation of case-214')).toBeInTheDocument();
    const group = screen.getByText('Investigation of case-214').closest('tr')!;
    expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(group).toHaveTextContent('2 of 10 steps shown · closed as false positive');
    expect(within(group).getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    expect(within(group).getByRole('link', { name: 'Open case trace' })).toBeInTheDocument();
    expect(screen.queryByText('Tool call')).toBeNull();
    await user.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Tool call')).toBeInTheDocument();
    // The scope line counts events, never groups.
    expect(screen.getByTestId('audit-scope-line')).toHaveTextContent('Showing 1 to 3 of 12 events');
  });

  it('keeps paging with the keyboard when a page only adds steps to an investigation already listed', async () => {
    const step = (n: number) =>
      rec({ record_id: `mem:${n}`, run_id: 'inv-1', case_id: 'case-214', action_type: 'tool_call', event_label: 'Tool call', actor: 'investigator', actor_type: 'agent', category: 'agent' });
    h.list
      .mockResolvedValueOnce(
        page([rec({ record_id: 'mem:20', action_type: 'poll', event_label: 'Source poll', actor: 'poller', actor_type: 'system', category: 'system' }), step(19), step(18)], {
          total: 30,
          next_cursor: 'c2',
          run_totals: { 'inv-1': 10 },
        }),
      )
      .mockResolvedValueOnce(page([step(17), step(16)], { total: 30, next_cursor: 'c3', run_totals: { 'inv-1': 10 } }))
      .mockResolvedValue(page([], { total: 30, next_cursor: null }));
    renderAudit('#/audit?scope=agent&from=now-7d');
    const group = (await screen.findByText('Investigation of case-214')).closest('tr') as HTMLTableRowElement;
    act(() => group.focus());
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    await waitFor(() => expect(h.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c2' })));
    await waitFor(() => expect(group).toHaveTextContent('4 of 10 steps shown'));
    // The page added no row after the group: the move ended, so the next one reads on.
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    await waitFor(() => expect(h.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c3' })));
  });

  it('keeps J reading on from the inspector when a page only adds steps to a closed investigation', async () => {
    const user = userEvent.setup();
    const step = (n: number) =>
      rec({ record_id: `mem:${n}`, run_id: 'inv-1', case_id: 'case-214', action_type: 'tool_call', event_label: 'Tool call', actor: 'investigator', actor_type: 'agent', category: 'agent' });
    h.list
      .mockResolvedValueOnce(
        page([rec({ record_id: 'mem:20', action_type: 'poll', event_label: 'Source poll', actor: 'poller', actor_type: 'system', category: 'system' }), step(19)], {
          total: 30,
          next_cursor: 'c2',
          run_totals: { 'inv-1': 10 },
        }),
      )
      .mockResolvedValueOnce(page([step(18), step(17)], { total: 30, next_cursor: 'c3', run_totals: { 'inv-1': 10 } }))
      .mockResolvedValue(page([], { total: 30, next_cursor: null }));
    renderAudit('#/audit?scope=agent&from=now-7d');
    await user.click(await screen.findByText('Source poll'));
    await screen.findByRole('region', { name: 'Source poll' });
    fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() => expect(h.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c2' })));
    await waitFor(() => expect(screen.getByText('Investigation of case-214').closest('tr')).toHaveTextContent('3 of 10 steps shown'));
    fireEvent.keyDown(document.body, { key: 'j' });
    await waitFor(() => expect(h.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c3' })));
  });

  it('holds an investigation row\'s Load more while a read is in flight, without opening the row', async () => {
    const user = userEvent.setup();
    const refresh = deferred<AuditPage>();
    const steps = [
      rec({ record_id: 'mem:3', run_id: 'inv-1', case_id: 'case-214', action_type: 'tool_call', event_label: 'Tool call', actor: 'investigator', actor_type: 'agent', category: 'agent' }),
      rec({ record_id: 'mem:2', run_id: 'inv-1', case_id: 'case-214', action_type: 'tool_call', event_label: 'Tool call', actor: 'investigator', actor_type: 'agent', category: 'agent' }),
    ];
    h.list
      .mockResolvedValueOnce(page(steps, { total: 12, next_cursor: 'c2', run_totals: { 'inv-1': 10 } }))
      .mockReturnValueOnce(refresh.promise);
    renderAudit('#/audit?scope=agent&from=now-7d');
    const group = (await screen.findByText('Investigation of case-214')).closest('tr') as HTMLTableRowElement;
    await user.click(screen.getByRole('button', { name: 'Refresh the audit log' }));
    const load = within(group).getByRole('button', { name: 'Load more' });
    expect(load).toHaveAttribute('aria-disabled', 'true');
    await user.click(load);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(group).toHaveAttribute('aria-expanded', 'false');
    await act(async () => refresh.resolve(page(steps, { total: 12, next_cursor: 'c2', run_totals: { 'inv-1': 10 } })));
    await waitFor(() =>
      expect(within(screen.getByText('Investigation of case-214').closest('tr')!).getByRole('button', { name: 'Load more' })).not.toHaveAttribute(
        'aria-disabled',
      ),
    );
  });

  it('names the case by its case number when the read API resolves it', async () => {
    const user = userEvent.setup();
    const internal = 'case-61a0e4f407bf4bf5aa300c98f03c5bf4';
    // `case_label` is the additive read field the server resolves (SPEC §4.9.5).
    const labelled = (r: AuditRecord) => ({ ...r, case_label: 'CASE-000214' }) as AuditRecord;
    h.list.mockResolvedValue(
      page(
        [
          labelled(rec({ record_id: 'mem:3', run_id: 'inv-1', case_id: internal, action_type: 'decision', event_label: 'Close or escalate decision', result_summary: 'verdict=FALSE_POSITIVE status=closed', outcome: 'success', actor: 'case_manager', actor_type: 'system', category: 'agent' })),
          labelled(rec({ record_id: 'mem:2', run_id: 'inv-1', case_id: internal, action_type: 'tool_call', event_label: 'Tool call', outcome: 'success', actor: 'investigator', actor_type: 'agent', category: 'agent' })),
        ],
        { total: 2, run_totals: { 'inv-1': 2 } },
      ),
    );
    renderAudit(`#/audit?scope=agent&from=now-7d&case=${internal}`);
    const group = (await screen.findByText('Investigation of CASE-000214')).closest('tr') as HTMLTableRowElement;
    expect(screen.queryByText(`Investigation of ${internal}`)).toBeNull();
    // The Case chip names the case as its rows do.
    expect(screen.getByText('Case: CASE-000214')).toBeInTheDocument();
    await user.click(group);
    await user.click(screen.getByText('Tool call'));
    const region = await screen.findByRole('region', { name: 'Tool call' });
    const caseLink = within(region).getByRole('link', { name: 'CASE-000214' });
    expect(caseLink.getAttribute('href')).toContain(encodeURIComponent(internal));
    // Raw record shows the stored row: the resolved number was never stored.
    const raw = within(within(region).getByRole('region', { name: 'Raw record' })).getByText(/"action_type"/).textContent ?? '';
    expect(raw).toContain(internal);
    expect(raw).not.toContain('case_label');
    expect(raw).not.toContain('CASE-000214');
  });

  it('stacks an investigation row on a phone: the title, then its actions', async () => {
    setViewport(390);
    h.list.mockResolvedValue(
      page(
        [
          rec({ record_id: 'mem:3', run_id: 'inv-1', case_id: 'case-214', action_type: 'tool_call', event_label: 'Tool call', actor: 'investigator', actor_type: 'agent', category: 'agent' }),
          rec({ record_id: 'mem:2', run_id: 'inv-1', case_id: 'case-214', action_type: 'tool_call', event_label: 'Tool call', actor: 'investigator', actor_type: 'agent', category: 'agent' }),
        ],
        { total: 12, next_cursor: 'c2', run_totals: { 'inv-1': 10 } },
      ),
    );
    renderAudit('#/audit?scope=agent&from=now-7d');
    const title = await screen.findByText('Investigation of case-214');
    const row = title.closest('tr') as HTMLTableRowElement;
    const actions = within(row).getByTestId('audit-group-actions');
    expect(actions).not.toContainElement(title);
    expect(within(actions).getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    expect(within(actions).getByRole('link', { name: 'Open case trace' })).toBeInTheDocument();
    // The title comes first in reading order.
    expect(title.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The row is one cell across the table, so nothing is squeezed into the Event column;
    // its time, outcome and steps sit on a line under the title.
    const cells = row.querySelectorAll('td');
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveAttribute('colspan', '3');
    expect(row.querySelector('time')).not.toBeNull();
    expect(row).toHaveTextContent('2 of 10 steps shown');
  });
});

describe('Audit log: copy', () => {
  const clean = () => {
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text.toLowerCase()).not.toContain('playbook');
  };

  it('never shows an em dash, an en dash or the retired word in what it renders', async () => {
    renderAudit();
    await screen.findByText('Settings changed 1');
    clean();
  });

  it('keeps the inspector, the Event menu and the Actor menu free of them too', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValue(
      page([
        rec({
          record_id: 'mem:7',
          action: 'user.role_changed',
          outcome: 'success',
          actor_type: 'human',
          actor_role: 'super_admin',
          event_label: 'User role changed',
          target: { type: 'user', id: 'vpatel', label: 'vpatel' },
          changes: [{ field: 'role', before: 'analyst_tier1', after: 'analyst_tier2', secret: false }],
          client: { ip: '203.0.113.24', ip_source: 'peer', peer: '203.0.113.24', forwarded_for: null, user_agent: 'curl/8.4.0' },
          session_ref: '17f06b1799edbe8c',
          request_id: 'req-12345678',
          case_id: 'case-214',
        }),
      ]),
    );
    renderAudit();
    await user.click(await screen.findByText('User role changed'));
    await screen.findByRole('region', { name: 'User role changed' });
    clean();
    await user.click(screen.getByRole('button', { name: 'Event' }));
    expect(await screen.findByPlaceholderText('Search events')).toBeInTheDocument();
    clean();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Actor' }));
    expect(await screen.findByLabelText('Name contains')).toBeInTheDocument();
    clean();
  });
});
