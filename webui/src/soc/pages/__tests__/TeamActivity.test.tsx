/**
 * Round 15 Team activity page (SPEC D3.1, D3.3 to D3.5, D3.11).
 *
 * - Behind `PageAccess` (`team:view`): without the grant the page keeps its title and
 *   one refusal, and sends no read.
 * - The header's range control maps presets to the server's window tokens.
 * - One KPI strip, the work per day and the people table, ordered by name, with Not
 *   attributed last; a person's sheet lists their events with case links, and "Open in
 *   Audit log" only for a viewer with `audit:view`.
 * - Honest states: the switch off (`409 team_activity_off`), the role floor while
 *   role-based access is off (`403`), sign-in off, a partial read, a window with no work.
 * - The CSV goes through the shared encoder.
 * - Escape or Close on a person's sheet hands focus back to the row's action; the sheet's
 *   per-day table uses the chart's kinds, and event times are in the operator zone the
 *   days are counted in, which the sheet names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { PersonActivity, TeamActivity, TeamEvents } from '@/lib/types-team';

const h = vi.hoisted(() => ({
  grants: new Set<string>(['team:view', 'audit:view']),
  rbacEnabled: true,
  authEnabled: true,
  activity: vi.fn(),
  events: vi.fn(),
  download: vi.fn(() => true),
}));

vi.mock('@/soc/auth', () => {
  const auth = () => ({
    hasPermission: (resource: string, action: string) => h.grants.has(`${resource}:${action}`),
    username: 'manager',
    authEnabled: h.authEnabled,
    isAuthenticated: true,
    rbacEnabled: h.rbacEnabled,
    refresh: vi.fn(),
  });
  return { useOptionalAuth: () => auth(), useAuth: auth };
});

vi.mock('@/lib/api-team', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api-team')>();
  return { ...real, getTeamActivity: h.activity, getTeamPersonEvents: h.events };
});

vi.mock('@/lib/download', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/download')>();
  return { ...real, downloadText: h.download };
});

import TeamActivityPage, { sortPeople } from '../TeamActivity';
import { TooltipProvider } from '@/ui/tooltip';

const zeros = {
  acknowledged: 0, closed: 0, reopened: 0, escalated: 0, commented: 0, assigned: 0,
  screenshot_added: 0, reviewed: 0, runbook_step_done: 0, signed_in: 0,
};
const reviews = {
  completed: 0, agreed: 0, disagreed: 0, unsure: 0, answered: 0,
  agreement_rate: null, time_spent_median_ms: null, time_to_review_median_seconds: null,
};

function person(key: string, over: Partial<PersonActivity> = {}): PersonActivity {
  return {
    key,
    username: key,
    display_name: '',
    role: 'analyst_tier1',
    active: true,
    kind: 'account',
    counts: { ...zeros },
    closed_by: { true_positive: 0, false_positive: 0, benign: 0, duplicate: 0, other: 0 },
    bulk: { acknowledged: 0, closed: 0, reopened: 0, escalated: 0, assigned: 0 },
    daily: [],
    last_active: null,
    median_ack_seconds: null,
    ack_samples: 0,
    reviews: { ...reviews },
    ...over,
  };
}

function data(over: Partial<TeamActivity> = {}): TeamActivity {
  return {
    window: { token: 'today', label: 'today', start: '2026-11-20T00:00:00+00:00', end: '2026-11-20T15:00:00+00:00' },
    timezone: 'Asia/Kolkata',
    days: ['2026-11-20'],
    // The server orders people by name, with Not attributed last.
    people: [
      person('asha.iyer', { kind: 'demo', role: '', counts: { ...zeros, commented: 1 } }),
      person('zoe', { display_name: 'Zoe Adams', counts: { ...zeros, closed: 2, acknowledged: 3 }, median_ack_seconds: 420 }),
      person('', { username: '', kind: 'unattributed', display_name: 'Not attributed', counts: { ...zeros, assigned: 4 } }),
    ],
    team: {
      people_active: 2,
      counts: { ...zeros, closed: 2, acknowledged: 3, commented: 1, assigned: 4 },
      closed_by: { true_positive: 1, false_positive: 1, benign: 0, duplicate: 0, other: 0 },
      bulk: { acknowledged: 0, closed: 1, reopened: 0, escalated: 0, assigned: 0 },
      daily: [{ date: '2026-11-20', counts: { closed: 2, acknowledged: 3, commented: 1, reviewed: 0, escalated: 0, reopened: 0, other: 4 } }],
      median_ack_seconds: 420,
      ack_samples: 3,
      ack_status: 'measured',
      reviews: { ...reviews },
    },
    exact: true,
    partial_reason: null,
    scanned_rows: 10,
    auth_enabled: true,
    rbac_enabled: true,
    demo: false,
    generated_at: new Date().toISOString(),
    ...over,
  };
}

function refusal(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, body: { detail: { code, message } } });
}

const EVENTS: TeamEvents = {
  username: 'zoe',
  window: { token: 'today', label: 'today', start: null, end: '2026-11-20T15:00:00+00:00' },
  events: [
    { ts: '2026-11-20T10:00:00+00:00', kind: 'closed', label: 'Closed a case', case_id: 'case-1', case_number: 'CASE-0001', detail: 'False positive' },
  ],
  total: 1,
  next_cursor: null,
  exact: true,
  partial_reason: null,
};

function renderPage() {
  return render(
    <TooltipProvider>
      <TeamActivityPage />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  h.grants = new Set(['team:view', 'audit:view']);
  h.rbacEnabled = true;
  h.authEnabled = true;
  h.activity.mockReset();
  h.events.mockReset();
  h.download.mockClear();
  h.activity.mockResolvedValue(data());
  h.events.mockResolvedValue(EVENTS);
});

describe('Team activity', () => {
  it('refuses without team:view and sends no read', () => {
    h.grants = new Set();
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Team activity' })).toBeInTheDocument();
    expect(screen.getByTestId('page-access-refused')).toHaveTextContent('You do not have access to Team activity.');
    expect(h.activity).not.toHaveBeenCalled();
  });

  it('shows the strip, the chart and the people ordered by name with Not attributed last', async () => {
    renderPage();
    expect(h.activity).toHaveBeenCalledWith('today', expect.anything());
    const strip = await screen.findByTestId('team-kpis');
    for (const label of ['People active', 'Cases closed by people', 'Acknowledged', 'Reviews completed', 'Median time to acknowledge']) {
      expect(within(strip).getByText(label)).toBeInTheDocument();
    }
    expect(within(strip).getByText('7m')).toBeInTheDocument();
    // Closes say how many came from bulk actions; acknowledgements none did.
    expect(within(strip).getByText('1 in bulk actions')).toBeInTheDocument();
    expect(within(strip).getByText('one at a time')).toBeInTheDocument();
    expect(screen.getByTestId('team-daily-chart')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'People' });
    const names = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '');
    expect(names[0]).toContain('asha.iyer');
    expect(names[0]).toContain('Demo analyst');
    expect(names[1]).toContain('Zoe Adams');
    expect(names[2]).toContain('Not attributed');
    // The zone is named in the help tip, never as a header description.
    expect(screen.queryByText(/Days are calendar days in Asia\/Kolkata/)).toBeNull();
  });

  it('explains the median time to acknowledge with its cases (numbers review)', async () => {
    const user = userEvent.setup();
    renderPage();
    const strip = await screen.findByTestId('team-kpis');
    const trigger = within(strip).getByRole('button', { name: /^7m\s*, explain$/ });
    await user.click(trigger);
    const panel = await screen.findByRole('dialog');
    expect(panel).toHaveTextContent('Median 7m over 3 cases a person first acknowledged');
    expect(panel).toHaveTextContent('the time at rank 2 of 3 sorted times');
  });

  it('lists the times the median is taken from, and says who People active counted', async () => {
    const user = userEvent.setup();
    const base = data();
    h.activity.mockResolvedValue(data({ team: { ...base.team, ack_sample_seconds: [120, 420, 720], ack_sample_offset: 0 } as TeamActivity['team'] }));
    renderPage();
    const strip = await screen.findByTestId('team-kpis');
    await user.click(within(strip).getByRole('button', { name: /^7m\s*, explain$/ }));
    const median = await screen.findByRole('dialog');
    expect(median).toHaveTextContent('The times, in order');
    expect(median).toHaveTextContent('2m (120 s), 7m (420 s), 12m (720 s)');
    expect(median).toHaveTextContent('the time at rank 2 of 3: 420 seconds');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(within(strip).getByRole('button', { name: /^2\s*, explain$/ }));
    const people = await screen.findByRole('dialog');
    expect(people).toHaveTextContent('People active');
    expect(people).toHaveTextContent('asha.iyer');
    expect(people).toHaveTextContent('Zoe Adams');
    expect(people).toHaveTextContent('5 counted actions');
    expect(people).toHaveTextContent('1 counted action');
    // Not attributed's 4 assignments name no person, so they are not a person counted.
    expect(people).not.toHaveTextContent('4 counted actions');
  });

  it('sorts by a column without ever moving Not attributed off the end', () => {
    const people = data().people;
    const byClosed = sortPeople(people, { id: 'closed', dir: 'desc' });
    expect(byClosed.map((p) => p.key)).toEqual(['zoe', 'asha.iyer', '']);
    const byName = sortPeople(people, { id: 'person', dir: 'desc' });
    expect(byName.map((p) => p.key)).toEqual(['zoe', 'asha.iyer', '']);
    expect(sortPeople(people, null).map((p) => p.key)).toEqual(['asha.iyer', 'zoe', '']);
  });

  it('reads another window from the range control', async () => {
    renderPage();
    await screen.findByTestId('team-kpis');
    fireEvent.click(screen.getByRole('button', { name: 'Today, time range' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(h.activity).toHaveBeenLastCalledWith('now-7d', expect.anything()));
  });

  it("never shows one window's counts under another window's range", async () => {
    renderPage();
    const strip = await screen.findByTestId('team-kpis');
    expect(within(strip).getByText('today')).toBeInTheDocument();
    let resolveWeek: (value: TeamActivity) => void = () => undefined;
    h.activity.mockReturnValue(new Promise<TeamActivity>((resolve) => { resolveWeek = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Today, time range' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Last 7 days' }));
    // While the week loads, the page shows the loading state, not today's figures under
    // "Last 7 days".
    await waitFor(() => expect(screen.queryByTestId('team-kpis')).toBeNull());
    expect(screen.getByText('Loading team activity')).toBeInTheDocument();
    const week = data({ window: { token: 'now-7d', label: 'last 7 days', start: null, end: '2026-11-20T15:00:00+00:00' } });
    week.team.people_active = 9;
    resolveWeek(week);
    const weekStrip = await screen.findByTestId('team-kpis');
    expect(within(weekStrip).getByText('9')).toBeInTheDocument();
    expect(within(weekStrip).getByText('last 7 days')).toBeInTheDocument();
  });

  it('puts the review counts beside the close counts (SPEC D3.5)', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'People' });
    const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent?.trim() ?? '');
    const closed = headers.findIndex((t) => t.startsWith('Closed'));
    expect(closed).toBeGreaterThan(-1);
    expect(headers[closed + 1]).toMatch(/^Reviews/);
  });

  it('fits the people table in a 1440px window with the navigation rail open', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'People' });
    const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent?.trim() ?? '');
    // The chart's kinds, the role under the name; sign-ins, each kind of "Other" and the
    // time to acknowledge are on the person sheet and in the CSV.
    // "Other" names what it adds up on hover: the chart's "Other case work".
    expect(
      within(table).getByTitle('Other case work: assigned, screenshots added and runbook steps done'),
    ).toBeInTheDocument();
    expect(headers).toEqual([
      'Person', 'Closed', 'Reviews', 'Acknowledged', 'Commented', 'Escalated', 'Reopened', 'Other', 'Last active', 'Row actions',
    ]);
    // The planned minimum width (the fixed columns, the Person minimum and the row action)
    // fits the 1,152px the panel has there, so no column, header or open button is cut.
    const terms = table.style.minWidth.replace(/^calc\((.*)\)$/, '$1').split(' + ');
    const px = terms.map((term) => {
      const m = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(term.trim());
      expect(m, `unexpected width term ${term}`).not.toBeNull();
      return Number(m![1]) * (m![2] === 'rem' ? 16 : 1);
    });
    // With room to spare for a classic 17px scrollbar, so the open button is never cut.
    expect(px.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1152 - 17);
    // The Person column keeps at least 220px for the name.
    expect(terms).toContain('220px');
    // A narrower window scrolls with the person kept in view.
    expect(within(table).getAllByRole('columnheader')[0].className).toMatch(/(^|\s)sticky(\s|$)/);
    // The role reads under the name.
    const zoe = within(table).getAllByRole('row').find((row) => row.textContent?.includes('Zoe Adams'))!;
    expect(within(zoe).getAllByRole('cell')[0]).toHaveTextContent('Zoe AdamsAnalyst Tier 1');
  });

  it('gives the name its own line, with its full text as the title while it is cut', async () => {
    const long = person('priya', {
      display_name: 'Priya Ramakrishnan-Venkataraman',
      role: 'soc_manager',
      kind: 'environment',
    });
    h.activity.mockResolvedValue(data({ people: [long] }));
    renderPage();
    const table = await screen.findByRole('table', { name: 'People' });
    const row = within(table).getAllByRole('row').find((r) => r.textContent?.includes('Priya'))!;
    const cell = within(row).getAllByRole('cell')[0];
    const name = within(cell).getByText('Priya Ramakrishnan-Venkataraman');
    const role = within(cell).getByText('SOC manager');
    // The name's line holds the name alone; the role and the kind of account sit under it.
    expect(name.textContent).toBe('Priya Ramakrishnan-Venkataraman');
    expect(name).not.toContainElement(role);
    expect(role.parentElement).not.toBe(name.parentElement);
    expect(role.parentElement).toHaveTextContent('SOC managerEnvironment account');
    expect(name.parentElement).toHaveClass('flex-col');
    // When the role and the badge do not fit side by side, the badge takes its own line.
    expect(role.parentElement).toHaveClass('flex-wrap');
    // Cut names and roles show their full text as the hover title.
    for (const [el, full] of [[name, 'Priya Ramakrishnan-Venkataraman'], [role, 'SOC manager']] as const) {
      expect(el).toHaveClass('truncate');
      Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 300 });
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: 180 });
      fireEvent.pointerEnter(el);
      expect(el).toHaveAttribute('title', full);
    }
  });

  it('shows every count right-aligned with 0 for none, and Last active as not in the window', async () => {
    const asha = person('asha.iyer', {
      kind: 'demo',
      role: '',
      counts: { ...zeros, reviewed: 4, assigned: 1, runbook_step_done: 2 },
      reviews: { ...reviews, completed: 4, agreed: 2, disagreed: 1, unsure: 1, answered: 3 },
      last_active: new Date().toISOString(),
    });
    h.activity.mockResolvedValue(data({ people: [asha, data().people[1]] }));
    renderPage();
    const table = await screen.findByRole('table', { name: 'People' });
    const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent?.trim() ?? '');
    const cellsOf = (name: string) =>
      within(within(table).getAllByRole('row').find((row) => row.textContent?.includes(name))!).getAllByRole('cell');
    const zoe = cellsOf('Zoe Adams');
    // No review: a right-aligned 0 like every other count, never "None".
    const zoeReviews = zoe[headers.indexOf('Reviews')];
    expect(zoeReviews).toHaveTextContent(/^0$/);
    expect(zoeReviews).toHaveClass('text-right');
    expect(table).not.toHaveTextContent('None');
    for (const header of ['Closed', 'Reviews', 'Acknowledged', 'Commented', 'Escalated', 'Reopened', 'Other']) {
      expect(zoe[headers.indexOf(header)]).toHaveClass('text-right');
    }
    // Nothing counted in the window: Last active says so.
    expect(zoe[headers.indexOf('Last active')]).toHaveTextContent('Not in window');
    // Reviews: the count, with how many agreed as its title; Other: assigned plus runbook steps.
    const ashaCells = cellsOf('asha.iyer');
    expect(ashaCells[headers.indexOf('Reviews')]).toHaveTextContent(/^4$/);
    expect(within(ashaCells[headers.indexOf('Reviews')]).getByTitle('2 of 3 agreed, 1 unsure')).toBeInTheDocument();
    expect(ashaCells[headers.indexOf('Other')]).toHaveTextContent(/^3$/);
    expect(sortPeople([data().people[1], asha], { id: 'other', dir: 'desc' }).map((p) => p.key)).toEqual(['asha.iyer', 'zoe']);
  });

  it('writes the auto-close caption with a plain hyphen and proportional figures', async () => {
    renderPage();
    const strip = await screen.findByTestId('team-kpis');
    const caption = within(strip).getByText('auto-close reviews');
    // U+002D, never a non-breaking hyphen or another dash the font draws wide.
    expect(Array.from(caption.textContent ?? '').map((c) => c.codePointAt(0))).toContain(0x2d);
    expect(caption.textContent).toMatch(/^[a-z -]+$/);
    // Inter's tabular figures widen the hyphen ("auto - close"): words stay proportional,
    // and no tabular element on the page holds a hyphenated word.
    expect(caption).not.toHaveClass('tabular-nums');
    const hyphenated = Array.from(document.querySelectorAll<HTMLElement>('.tabular-nums'))
      .map((node) => node.textContent ?? '')
      .filter((text) => /[A-Za-z]-[A-Za-z]/.test(text));
    expect(hyphenated).toEqual([]);
  });

  it('opens a person with their events, case links and the Audit log link', async () => {
    renderPage();
    await screen.findByTestId('team-kpis');
    fireEvent.click(screen.getByRole('button', { name: 'Open the activity of Zoe Adams' }));
    const sheet = await screen.findByTestId('team-person-sheet');
    await waitFor(() => expect(h.events).toHaveBeenCalledWith('zoe', 'today', null, expect.anything()));
    expect(await within(sheet).findByRole('link', { name: 'CASE-0001' })).toHaveAttribute('href', '#/case_manager?caseId=case-1');
    expect(within(sheet).getByText('False positive')).toBeInTheDocument();
    // B56: the Audit log opens on the sheet's own window, as absolute instants. Team's
    // window is [start, end) and the Audit range end is inclusive, so `to` is end - 1 ms.
    const href = within(sheet).getByRole('link', { name: /Open in Audit log/ }).getAttribute('href') ?? '';
    expect(href.startsWith('#/audit?')).toBe(true);
    const query = new URLSearchParams(href.slice('#/audit?'.length));
    expect(query.get('actor')).toBe('zoe');
    expect(query.get('from')).toBe('2026-11-20T00:00:00.000Z');
    expect(query.get('to')).toBe('2026-11-20T14:59:59.999Z');
  });

  it.each(['Escape', 'Close'] as const)('hands focus back to the row action when %s closes the sheet', async (how) => {
    renderPage();
    await screen.findByTestId('team-kpis');
    const opener = screen.getByRole('button', { name: 'Open the activity of Zoe Adams' });
    opener.focus();
    fireEvent.click(opener);
    const sheet = await screen.findByTestId('team-person-sheet');
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole('heading', { name: 'Zoe Adams' })));
    if (how === 'Escape') fireEvent.keyDown(sheet, { key: 'Escape' });
    else fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('team-person-sheet')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open the activity of Zoe Adams' }));
  });

  it("counts the sheet's days by the chart's kinds and shows event times in the operator zone", async () => {
    const zoe = person('zoe', {
      display_name: 'Zoe Adams',
      counts: { ...zeros, reopened: 1, screenshot_added: 2 },
      daily: [{ date: '2026-11-23', counts: { ...zeros, reopened: 1, screenshot_added: 2 } }],
    });
    h.activity.mockResolvedValue(data({ timezone: 'UTC', people: [zoe] }));
    h.events.mockResolvedValue({
      ...EVENTS,
      events: [{ ts: '2026-11-23T20:00:00+00:00', kind: 'reopened', label: 'Reopened a case', case_id: 'case-1', case_number: 'CASE-0001', detail: '' }],
    });
    renderPage();
    await screen.findByTestId('team-kpis');
    fireEvent.click(screen.getByRole('button', { name: 'Open the activity of Zoe Adams' }));
    const sheet = await screen.findByTestId('team-person-sheet');
    const table = within(sheet).getByRole('table', { name: 'Work per day, days in UTC' });
    const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent?.trim());
    expect(headers).toEqual(['Day', 'Closed', 'Reviews', 'Acknowledged', 'Commented', 'Escalated', 'Reopened', 'Other', 'Sign-ins']);
    // The table's outer cells sit on the sheet's text edge, as the "Per day" heading does.
    const heads = within(table).getAllByRole('columnheader');
    expect(heads[0]).toHaveClass('pl-0');
    expect(heads[heads.length - 1]).toHaveClass('pr-0');
    // The sheet keeps the xl width (56rem) whole: a narrower override cuts Sign-ins at 1440px.
    const widths = sheet.className.split(/\s+/).filter((c) => c.startsWith('max-w-'));
    expect(widths).toEqual(['max-w-[56rem]']);
    const cells = within(within(table).getAllByRole('row')[1]).getAllByRole('cell').map((td) => td.textContent);
    // The reopen has its own column, as on the chart; "Other" holds the two screenshots.
    expect(cells[headers.indexOf('Reopened')]).toBe('1');
    expect(cells[headers.indexOf('Other')]).toBe('2');
    expect(within(sheet).getByText('Days in UTC.')).toBeInTheDocument();
    // 20:00Z is listed on 23 Nov, the day the table counts it on, whatever the viewer's zone.
    expect(await within(sheet).findByText('23 Nov, 20:00')).toBeInTheDocument();
    expect(within(sheet).getByText('Times in UTC.')).toBeInTheDocument();
  });

  it("words the sheet's closes and reviews as the sheet's other lines", async () => {
    const zoe = person('zoe', {
      display_name: 'Zoe Adams',
      counts: { ...zeros, closed: 3, acknowledged: 1 },
      closed_by: { true_positive: 1, false_positive: 2, benign: 0, duplicate: 0, other: 0 },
      bulk: { acknowledged: 1, closed: 2, reopened: 0, escalated: 0, assigned: 0 },
    });
    h.activity.mockResolvedValue(data({ people: [zoe] }));
    renderPage();
    await screen.findByTestId('team-kpis');
    fireEvent.click(screen.getByRole('button', { name: 'Open the activity of Zoe Adams' }));
    const sheet = await screen.findByTestId('team-person-sheet');
    expect(within(sheet).getByText('Closed as true positive: 1, false positive: 2.')).toBeInTheDocument();
    // The bulk line below it reads as plainly, the count before the action.
    expect(within(sheet).getByText('In bulk actions: 1 acknowledged, 2 closed.')).toBeInTheDocument();
    expect(sheet).not.toHaveTextContent('Of which');
    // No review in the window: said in words here, a 0 in the table and the counts above.
    expect(within(sheet).getByText('None completed in this window.')).toBeInTheDocument();
  });

  it('gives Not attributed no events and no Audit log link', async () => {
    h.grants = new Set(['team:view']);
    renderPage();
    await screen.findByTestId('team-kpis');
    fireEvent.click(screen.getByRole('button', { name: 'Open the activity of Not attributed' }));
    const sheet = await screen.findByTestId('team-person-sheet');
    expect(within(sheet).getByText('Recorded before sign-in attribution, or with sign-in off.')).toBeInTheDocument();
    expect(within(sheet).queryByRole('link', { name: /Open in Audit log/ })).toBeNull();
    expect(h.events).not.toHaveBeenCalled();
  });

  it('downloads the people table as CSV', async () => {
    renderPage();
    await screen.findByTestId('team-kpis');
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(h.download).toHaveBeenCalledTimes(1);
    const [name, mime, text] = h.download.mock.calls[0] as unknown as [string, string, string];
    expect(name).toMatch(/^agentic-soc-team-activity-today-\d{8}-\d{4}Z\.csv$/);
    expect(mime).toContain('text/csv');
    expect(text).toContain('"Zoe Adams"');
  });

  it('says when the page is turned off', async () => {
    h.activity.mockRejectedValue(refusal(409, 'team_activity_off', 'Team activity is turned off.'));
    renderPage();
    expect(await screen.findByText('Team activity is turned off')).toBeInTheDocument();
    // It names the switch where Settings shows it.
    expect(
      screen.getByText('An administrator can turn it on in Settings, Security & access, Single sign-on & policy, Team activity.'),
    ).toBeInTheDocument();
  });

  it('shows the role floor refusal and the role-based access warning', async () => {
    h.rbacEnabled = false;
    h.activity.mockRejectedValue(
      refusal(403, 'team_activity_role_required', 'Role-based access is off. Only Super admins, SOC managers and Auditors can open Team activity until it is on.'),
    );
    renderPage();
    expect(await screen.findByText(/can open Team activity until it is on/)).toBeInTheDocument();
    const warning = screen.getByTestId('team-rbac-off');
    expect(warning).toHaveTextContent('Only Super admins, SOC managers and Auditors can open this page until it is on.');
    expect(within(warning).getByRole('link', { name: 'Open Roles & permissions' })).toHaveAttribute('href', '#/settings?s=roles');
  });

  it('says sign-in is off instead of showing counts', async () => {
    h.authEnabled = false;
    h.activity.mockResolvedValue(data({ auth_enabled: false, people: [] }));
    renderPage();
    expect(await screen.findByText('Sign-in is off, so work cannot be attributed to people.')).toBeInTheDocument();
    expect(screen.queryByTestId('team-kpis')).toBeNull();
  });

  it('states a partial read, Demo work and a window with no case work', async () => {
    const empty = data({ exact: false, partial_reason: 'row_limit', scanned_rows: 250_000, demo: true });
    empty.team.counts = { ...zeros, signed_in: 2 };
    // A partial read: the server gives no median, and says why.
    empty.team.ack_status = 'partial';
    empty.team.median_ack_seconds = null;
    empty.team.ack_samples = 0;
    h.activity.mockResolvedValue(empty);
    renderPage();
    expect(await screen.findByTestId('team-partial')).toHaveTextContent('250,000');
    expect(screen.getByTestId('team-partial')).toHaveTextContent(
      'The medians and the agreement rate are not measured from part of the window.',
    );
    const kpis = within(screen.getByTestId('team-kpis'));
    expect(kpis.getByText('Not measured')).toBeInTheDocument();
    expect(kpis.getByText('not measured from a partial read')).toBeInTheDocument();
    expect(screen.getByTestId('team-demo-note')).toHaveTextContent('Demo Mode: showing Demo work.');
    expect(screen.getByText('No case work in this window')).toBeInTheDocument();
    // No closes and no acknowledgements: their tiles name the range, never "one at a time".
    expect(within(screen.getByTestId('team-kpis')).queryByText('one at a time')).toBeNull();
    expect(screen.queryByTestId('team-daily-chart')).toBeNull();
  });
});
