/**
 * CaseDetail opens the tab a link asks for (closing QA integ-06): the audit log's "Open
 * case trace" links to `#/case_manager?caseId=…&tab=investigation`, and the case opens on
 * its Investigation tab, where the trace is, never on Overview, with the trace itself open
 * and brought into view once (closing QA integ-06). The trace opens for the linked case
 * only, never for the case it replaces, and an analyst who moves to another tab first
 * keeps their own choice. The request applies when it or the case changes; the analyst's
 * own tab choice stands until then. Anything that is not a case tab is ignored, and the
 * Runbook tab opens only for a viewer who has it. When focus has dropped (the link left
 * with its page), it lands on the trace heading; a control the analyst is using keeps it.
 *
 * The same CaseDetail shows each case the queue opens, so a read still running for the
 * case it replaces never leaves the next case waiting: each lazy read happens once for
 * the next case and nothing stays loading.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { permissions } = vi.hoisted(() => ({ permissions: { runbooks: true } }));

const CASE = {
  case_id: 'c-tab-1',
  case_number: 'CASE-2026-0410',
  title: 'Repeated SSH failures from one source',
  status: 'closed',
  verdict: 'FALSE_POSITIVE',
  decision_by: 'agent',
  risk_score: 30,
  severity_band: 'low',
  updated_at: '2026-10-10T10:00:00Z',
  created_at: '2026-10-10T09:00:00Z',
  history: [],
};

// Only the client is faked: every call on `api` answers `{}` unless a case says otherwise.
// The module's other exports stay real, so `ApiError` (read by CaseDetail and by
// `errorMessage` when a panel shows a load error) is the class the app throws and checks.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const target: Record<string, unknown> = {
    getCase: vi.fn((id: string) => Promise.resolve({ ...CASE, case_id: id })),
  };
  const fake = new Proxy(target, {
    get: (t, prop) => {
      if (prop === 'then') return undefined;
      if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
      return t[prop as string];
    },
  });
  // The Threat tab's read goes through `api.get` here under its real path, so a case can
  // count and hold it like the other tabs' reads.
  target.cases = {
    threatContext: (id: string) => (fake.get as (path: string) => Promise<unknown>)(`cases/${id}/threat-context`),
  };
  return { ...actual, api: fake };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: 'probe',
    user: null,
    hasPermission: (resource: string) => resource !== 'runbooks' || permissions.runbooks,
  }),
  useCan: () => () => true,
}));

import { api, ApiError } from '@/lib/api';
import { CaseDetail } from '@/soc/pages/CaseDetail';

function Host({ caseId = CASE.case_id, tab, search = false }: { caseId?: string; tab?: string | null; search?: boolean }) {
  return (
    <>
      {/* The queue's search beside the case, for a control the analyst may be typing in. */}
      {search ? <input aria-label="Search the queue" /> : null}
      <CaseDetail caseId={caseId} presentation="embedded" onClose={() => undefined} requestedTab={tab} />
    </>
  );
}

const selectedTab = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true');

async function loaded() {
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent(/Repeated SSH failures/));
}

const scrolled: Element[] = [];
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  permissions.runbooks = true;
  scrolled.length = 0;
  // jsdom has no layout: record which element a request brings into view.
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this);
  };
});

/** The faked client calls a case can steer (each answers as the mock above unless told). */
const apiGet = () => api.get as unknown as Mock;
const apiGetCase = () => api.getCase as unknown as Mock;
const apiRationale = () => api.caseRationale as unknown as Mock;
const apiPost = () => api.post as unknown as Mock;

beforeEach(() => {
  // Each case counts only its own reads (implementations stay as the mock gives them).
  apiGet().mockClear();
  apiGetCase().mockClear();
  apiRationale().mockClear();
  apiPost().mockClear();
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  apiGet().mockImplementation(() => Promise.resolve({}));
  apiGetCase().mockImplementation((id: string) => Promise.resolve({ ...CASE, case_id: id }));
  apiRationale().mockImplementation(() => Promise.resolve({}));
  apiPost().mockImplementation(() => Promise.resolve({}));
});

/** The `GET cases/{id}/timeline` reads so far. */
const timelineReads = () => apiGet().mock.calls.filter(([path]) => String(path).endsWith('/timeline')).length;

/** The `GET cases/{caseId}/{read}` reads so far. */
const readsOf = (caseId: string, read: string) =>
  apiGet().mock.calls.filter(([path]) => String(path) === `cases/${caseId}/${read}`).length;

/** The trace's heading, where a request lands focus that had dropped. */
const traceHeading = () => within(screen.getByTestId('investigation-trace')).getByRole('heading', { name: 'Investigation trace' });

/** A read that answers only when `release()` is called, as a slow one does. */
function held(): { gate: Promise<void>; release: () => Promise<void> } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    gate,
    release: () =>
      act(async () => {
        open();
        await gate;
      }),
  };
}

/** Each case the queue opens shows its own title, so a test can wait for the next one. */
function titledCases(): void {
  apiGetCase().mockImplementation((id: string) =>
    Promise.resolve({ ...CASE, case_id: id, title: id === 'c-tab-2' ? 'Next case in the queue' : CASE.title }),
  );
}

async function nextCaseShown() {
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent('Next case in the queue'));
}

/** `c-tab-2` answers only when the case calls `arrive()`, as a slow read does. */
function holdSecondCase(): { arrive: () => Promise<void> } {
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  apiGetCase().mockImplementation((id: string) =>
    id === 'c-tab-2'
      ? pending.then(() => ({ ...CASE, case_id: id, title: 'Linked case from the audit log' }))
      : Promise.resolve({ ...CASE, case_id: id }),
  );
  return {
    arrive: async () => {
      await act(async () => {
        release();
        await pending;
      });
      await waitFor(() =>
        expect(document.querySelector('[data-case-title]')).toHaveTextContent('Linked case from the audit log'),
      );
    },
  };
}

/** Longer than the panel's beat before it brings the open trace into view. */
const pastTheBeat = () => act(() => new Promise<void>((resolve) => window.setTimeout(resolve, 150)));

describe('CaseDetail: the tab a link asks for', () => {
  it('opens on Investigation for "Open case trace"', async () => {
    render(<Host tab="investigation" />);
    await loaded();
    expect(selectedTab()).toHaveTextContent(/^Investigation/);
    expect(screen.getByRole('tab', { name: /^Overview/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('opens the trace and brings it into view for "Open case trace", once', async () => {
    const before = timelineReads();
    render(<Host tab="investigation" />);
    await loaded();
    const trace = await screen.findByTestId('investigation-trace');
    // The link names the trace, so the trace is open (its body rendered) and on screen.
    await waitFor(() => expect(within(trace).getByRole('button', { name: /Hide trace/ })).toBeInTheDocument());
    await waitFor(() => expect(within(trace).getByText('No agent trace yet')).toBeInTheDocument());
    await waitFor(() => expect(scrolled).toContain(trace));
    // The link left with its page, so focus had dropped: it lands on the trace heading,
    // where keyboard and screen reader users carry on reading.
    expect(document.activeElement).toBe(traceHeading());
    // Opening it never doubled the tab's own lazy read of the trace.
    expect(timelineReads() - before).toBe(1);

    // Returning to the tab shows the analyst's view, not the link's request again.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Overview/ }));
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Overview/));
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Investigation/ }));
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Investigation/));
    const again = await screen.findByTestId('investigation-trace');
    expect(within(again).getByRole('button', { name: /Show trace/ })).toBeInTheDocument();
    expect(scrolled.filter((el) => el === again || el === trace)).toHaveLength(1);
  });

  it('opens the trace for a link to the case already on screen, with one read of it', async () => {
    // The tab switch and the panel's mount share one commit here, so the request must not
    // race the tab's own lazy read of the trace.
    const { rerender } = render(<Host />);
    await loaded();
    const before = timelineReads();
    rerender(<Host tab="investigation" />);
    const trace = await screen.findByTestId('investigation-trace');
    await waitFor(() => expect(within(trace).getByRole('button', { name: /Hide trace/ })).toBeInTheDocument());
    await waitFor(() => expect(scrolled).toContain(trace));
    expect(timelineReads() - before).toBe(1);
  });

  it('leaves the trace closed when the Investigation tab is opened by hand', async () => {
    render(<Host />);
    await loaded();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Investigation/ }));
    const trace = await screen.findByTestId('investigation-trace');
    expect(within(trace).getByRole('button', { name: /Show trace/ })).toBeInTheDocument();
    await pastTheBeat();
    expect(scrolled).toHaveLength(0);
    // Only a request moves focus, never a visit.
    expect(document.activeElement).not.toBe(traceHeading());
  });

  it('keeps focus on a control the analyst is using when the request applies', async () => {
    const { rerender } = render(<Host search />);
    await loaded();
    const search = screen.getByRole('textbox', { name: 'Search the queue' });
    search.focus();
    rerender(<Host search tab="investigation" />);
    const trace = await screen.findByTestId('investigation-trace');
    await waitFor(() => expect(scrolled).toContain(trace));
    expect(within(trace).getByRole('button', { name: /Hide trace/ })).toBeInTheDocument();
    expect(document.activeElement).toBe(search);
  });

  it('opens the trace of the linked case, never of the case it replaces', async () => {
    const { rerender } = render(<Host />);
    await loaded();
    const { arrive } = holdSecondCase();
    rerender(<Host caseId="c-tab-2" tab="investigation" />);
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Investigation/));
    // The previous case stays on screen, dimmed, while the linked one loads: its trace is
    // not the one the link names, so it stays as it was.
    const before = await screen.findByTestId('investigation-trace');
    expect(within(before).getByRole('button', { name: /Show trace/ })).toBeInTheDocument();
    await pastTheBeat();
    expect(scrolled).toHaveLength(0);

    await arrive();
    const trace = screen.getByTestId('investigation-trace');
    await waitFor(() => expect(within(trace).getByRole('button', { name: /Hide trace/ })).toBeInTheDocument());
    await waitFor(() => expect(scrolled).toEqual([trace]));
  });

  it('drops the request when the queue opens another case before the linked one arrives', async () => {
    const { rerender } = render(<Host />);
    await loaded();
    // The linked case is slow; a case picked from the queue answers at once.
    const linked = held();
    apiGetCase().mockImplementation((id: string) =>
      id === 'c-tab-2'
        ? linked.gate.then(() => ({ ...CASE, case_id: id, title: 'Linked case from the audit log' }))
        : Promise.resolve({ ...CASE, case_id: id, title: id === 'c-tab-3' ? 'Case picked from the queue' : CASE.title }),
    );
    rerender(<Host caseId="c-tab-2" tab="investigation" />);
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Investigation/));
    // Before it arrives, the analyst opens another case from the queue, with no tab in the
    // address. The tab stays on Investigation, but the link named the other case's trace.
    rerender(<Host caseId="c-tab-3" tab={null} />);
    await waitFor(() =>
      expect(document.querySelector('[data-case-title]')).toHaveTextContent('Case picked from the queue'),
    );
    await pastTheBeat();
    expect(selectedTab()).toHaveTextContent(/^Investigation/);
    expect(within(screen.getByTestId('investigation-trace')).getByRole('button', { name: /Show trace/ })).toBeInTheDocument();
    expect(scrolled).toHaveLength(0);
    expect(document.activeElement).not.toBe(traceHeading());

    // The request went with the switch: reopening the linked case from the queue later is
    // an ordinary visit, not the link replayed.
    rerender(<Host caseId="c-tab-2" tab={null} />);
    await linked.release();
    await waitFor(() =>
      expect(document.querySelector('[data-case-title]')).toHaveTextContent('Linked case from the audit log'),
    );
    await pastTheBeat();
    expect(within(screen.getByTestId('investigation-trace')).getByRole('button', { name: /Show trace/ })).toBeInTheDocument();
    expect(scrolled).toHaveLength(0);
    expect(document.activeElement).not.toBe(traceHeading());
  });

  it('drops the request when the analyst moves to another tab before it applies', async () => {
    const { rerender } = render(<Host />);
    await loaded();
    const { arrive } = holdSecondCase();
    rerender(<Host caseId="c-tab-2" tab="investigation" />);
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Investigation/));
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Timeline/ }));
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Timeline/));
    await arrive();

    // Back on Investigation by hand: an ordinary visit, the trace as the analyst left it.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Investigation/ }));
    const trace = await screen.findByTestId('investigation-trace');
    expect(within(trace).getByRole('button', { name: /Show trace/ })).toBeInTheDocument();
    await pastTheBeat();
    expect(within(trace).getByRole('button', { name: /Show trace/ })).toBeInTheDocument();
    expect(scrolled).toHaveLength(0);
  });

  it('shows a failed read of the trace as a load error, with nothing on the console', async () => {
    // A read that fails is rendered by the shared LoadError, which reads `ApiError` from
    // the client module: the real class, never a missing export of a partial mock.
    const output = (['error', 'warn', 'log', 'info', 'debug'] as const).map((level) => vi.spyOn(console, level));
    try {
      apiGet().mockImplementation((path: unknown) =>
        String(path).endsWith('/timeline')
          ? Promise.reject(new ApiError(503, 'The trace store is unavailable.'))
          : Promise.resolve({}),
      );
      const before = timelineReads();
      const { unmount } = render(<Host tab="investigation" />);
      await loaded();
      const trace = await screen.findByTestId('investigation-trace');
      const alert = await within(trace).findByRole('alert');
      expect(alert).toHaveTextContent('Could not load the timeline');
      expect(alert).toHaveTextContent('The trace store is unavailable.');
      expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      // The trace the link asked for is open on the error, read once and not retried alone.
      expect(within(trace).getByRole('button', { name: /Hide trace/ })).toBeInTheDocument();
      await pastTheBeat();
      expect(timelineReads() - before).toBe(1);
      unmount();
      for (const spy of output) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of output) spy.mockRestore();
    }
  });

  it('opens on Overview with no request, and ignores a value that is not a case tab', async () => {
    const { unmount } = render(<Host />);
    await loaded();
    expect(selectedTab()).toHaveTextContent(/^Overview/);
    unmount();
    render(<Host tab="trace" />);
    await loaded();
    expect(selectedTab()).toHaveTextContent(/^Overview/);
  });

  it('keeps the analyst’s own choice until the link or the case changes', async () => {
    const { rerender } = render(<Host tab="investigation" />);
    await loaded();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Timeline/ }));
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Timeline/));
    // The same request re-rendered changes nothing.
    rerender(<Host tab="investigation" />);
    expect(selectedTab()).toHaveTextContent(/^Timeline/);
    // The queue opened another case without a tab: the analyst's tab stays.
    rerender(<Host caseId="c-tab-2" tab={null} />);
    expect(selectedTab()).toHaveTextContent(/^Timeline/);
    // A link to a case's trace applies again.
    rerender(<Host caseId="c-tab-3" tab="investigation" />);
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Investigation/));
  });

  it('opens the Runbook tab only for a viewer who has it', async () => {
    const { unmount } = render(<Host tab="runbook" />);
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Runbook/));
    unmount();
    permissions.runbooks = false;
    render(<Host tab="runbook" />);
    await loaded();
    expect(selectedTab()).toHaveTextContent(/^Overview/);
    expect(screen.queryByRole('tab', { name: /^Runbook/ })).toBeNull();
  });
});

describe('CaseDetail: the next case while a read for the one it replaces is still running', () => {
  // A read for the replaced case is dropped when it lands, so it never clears the next
  // case's loading state. The switch itself clears it, or the next case's read would
  // wait forever on one that will never report.
  it.each([
    { tab: 'investigation', read: 'timeline' },
    { tab: 'timeline', read: 'stages' },
    { tab: 'threat', read: 'threat-context' },
    { tab: 'collab', read: 'thread' },
  ])('reads the $read of the next case once on the $tab tab', async ({ tab, read }) => {
    titledCases();
    const slow = held();
    apiGet().mockImplementation((path: unknown) =>
      String(path) === `cases/c-tab-1/${read}` ? slow.gate.then(() => ({})) : Promise.resolve({}),
    );
    const { rerender } = render(<Host tab={tab} />);
    await loaded();
    await waitFor(() => expect(readsOf('c-tab-1', read)).toBe(1));

    rerender(<Host caseId="c-tab-2" tab={tab} />);
    await nextCaseShown();
    await slow.release();
    await pastTheBeat();
    expect(readsOf('c-tab-2', read)).toBe(1);
    expect(readsOf('c-tab-1', read)).toBe(1);
  });

  it('opens the linked case’s trace loaded, not loading, after a switch mid-read', async () => {
    titledCases();
    const slow = held();
    apiGet().mockImplementation((path: unknown) =>
      String(path) === 'cases/c-tab-1/timeline' ? slow.gate.then(() => ({})) : Promise.resolve({}),
    );
    const { rerender } = render(<Host tab="investigation" />);
    await loaded();
    await waitFor(() => expect(readsOf('c-tab-1', 'timeline')).toBe(1));
    expect(screen.getByTestId('investigation-trace-counts')).toHaveTextContent('Loading…');

    rerender(<Host caseId="c-tab-2" tab="investigation" />);
    await nextCaseShown();
    // The replaced case's read lands late and is dropped.
    await slow.release();
    await pastTheBeat();
    const trace = screen.getByTestId('investigation-trace');
    expect(within(trace).getByRole('button', { name: /Hide trace/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('investigation-trace-counts')).toHaveTextContent('0 steps · 0 tools'));
    expect(readsOf('c-tab-2', 'timeline')).toBe(1);
  });

  it('reads the next case’s AI assessment once, with no skeleton left behind', async () => {
    titledCases();
    const slow = held();
    apiRationale().mockImplementation((id: string) =>
      id === 'c-tab-1' ? slow.gate.then(() => ({})) : Promise.resolve({}),
    );
    const rationaleReads = (id: string) => apiRationale().mock.calls.filter(([caseId]) => caseId === id).length;
    const { rerender } = render(<Host tab="investigation" />);
    await loaded();
    await waitFor(() => expect(rationaleReads('c-tab-1')).toBe(1));

    rerender(<Host caseId="c-tab-2" tab="investigation" />);
    await nextCaseShown();
    await slow.release();
    await pastTheBeat();
    expect(rationaleReads('c-tab-2')).toBe(1);
    expect(screen.queryByLabelText('Loading AI assessment')).toBeNull();
  });
});

describe('CaseDetail: the next case while a post on the one it replaces is still running', () => {
  // A post refreshes its case's discussion and activity when it lands. Landing after the
  // switch, that refresh is for a case no longer on screen: it never starts, so it cannot
  // leave the next case's discussion refreshing for good.
  const postsTo = (caseId: string) =>
    apiPost().mock.calls.filter(([path]) => String(path) === `cases/${caseId}/thread`).length;

  async function post(text: string) {
    fireEvent.change(await screen.findByPlaceholderText(/Share findings or a hand-off/), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
  }

  it('leaves nothing refreshing on the next case when the post lands late', async () => {
    titledCases();
    const slowPost = held();
    apiPost().mockImplementation((path: unknown) =>
      String(path) === 'cases/c-tab-1/thread' ? slowPost.gate.then(() => ({})) : Promise.resolve({}),
    );
    const { rerender } = render(<Host tab="collab" />);
    await loaded();
    await waitFor(() => expect(readsOf('c-tab-1', 'thread')).toBe(1));
    await waitFor(() => expect(readsOf('c-tab-1', 'activity')).toBe(1));
    await post('Hand-off note for the night shift');
    await waitFor(() => expect(postsTo('c-tab-1')).toBe(1));

    rerender(<Host caseId="c-tab-2" tab="collab" />);
    await nextCaseShown();
    await waitFor(() => expect(readsOf('c-tab-2', 'thread')).toBe(1));
    await waitFor(() => expect(readsOf('c-tab-2', 'activity')).toBe(1));
    await slowPost.release();
    await pastTheBeat();

    expect(screen.queryByRole('progressbar', { name: 'Refreshing discussion' })).toBeNull();
    expect(screen.queryByRole('progressbar', { name: 'Refreshing case activity' })).toBeNull();
    // The replaced case is not read again for a view that no longer shows it.
    expect(readsOf('c-tab-1', 'thread')).toBe(1);
    expect(readsOf('c-tab-1', 'activity')).toBe(1);
    expect(readsOf('c-tab-2', 'thread')).toBe(1);
    expect(readsOf('c-tab-2', 'activity')).toBe(1);
  });

  it('keeps the next case’s own post busy until that post lands', async () => {
    titledCases();
    const firstPost = held();
    const nextPost = held();
    apiPost().mockImplementation((path: unknown) => {
      if (String(path) === 'cases/c-tab-1/thread') return firstPost.gate.then(() => ({}));
      if (String(path) === 'cases/c-tab-2/thread') return nextPost.gate.then(() => ({}));
      return Promise.resolve({});
    });
    const { rerender } = render(<Host tab="collab" />);
    await loaded();
    await post('Hand-off note for the night shift');
    await waitFor(() => expect(postsTo('c-tab-1')).toBe(1));

    rerender(<Host caseId="c-tab-2" tab="collab" />);
    await nextCaseShown();
    await post('First look at the next case');
    await waitFor(() => expect(postsTo('c-tab-2')).toBe(1));
    // A second message waits while the first one is posting.
    fireEvent.change(screen.getByPlaceholderText(/Share findings or a hand-off/), { target: { value: 'Follow-up' } });
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();

    // The replaced case's post landing says nothing about this case's post.
    await firstPost.release();
    await pastTheBeat();
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();

    await nextPost.release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Post' })).toBeEnabled());
  });
});
