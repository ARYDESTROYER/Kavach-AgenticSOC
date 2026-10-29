/**
 * The Dashboards library (Round 14, SPEC §2.2 items 10 to 12, §4.4.1 and §4.4.5; operator
 * choice C2).
 *
 * Pins: the four built-in cards in order with "Default" only on the Cyber Defence Center and
 * the operator's copy; every card is ONE link with the right href, named by the board and
 * described by its badge, window and purpose; the outline preview is decorative; "Yours"
 * lists the personal boards (edited time, widget count, the unsaved role default) and ends
 * with the dashed "New dashboard" tile; a board stored under an id a link cannot carry is
 * linked under its `u:` alias; a stored "Overview" shows as "My dashboard"; hidden
 * built-ins ("Show 1 hidden" is a disclosure of the list) and Unhide (laid over the card
 * foot, a sibling after the link, the card link focused after it); built-in purposes take
 * up to three lines (personal details two), the whole text in `title`; the 24-board limit
 * (no draft offered); loading, error, permission denied, partial permissions, row-level
 * scope, phone structure, keyboard order, Demo Mode, and no em dash or "playbook" in the copy.
 */
import { createHash } from 'node:crypto';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';

const toastMock = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  fn.success = vi.fn();
  fn.error = vi.fn();
  return fn;
});
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));

const apiMocks = vi.hoisted(() => ({
  auth: { me: vi.fn() },
  roles: { get: vi.fn() },
  prefs: { effective: vi.fn(), putUser: vi.fn() },
  dashboards: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMocks }));

const demo = vi.hoisted(() => ({ on: false }));
vi.mock('@/soc/demo', async (orig) => {
  const actual = await orig<typeof import('@/soc/demo')>();
  return {
    ...actual,
    useDemo: () => ({ ...actual.useDemo(), active: demo.on, confirmed: true }),
  };
});

import { AuthProvider } from '@/soc/auth';
import { PrefsProvider } from '@/soc/prefs';
import { ThemeProvider } from '@/soc/theme';
import { RouterProvider } from '@/soc/router';
import { Dashboards, LIBRARY_HELP } from '@/soc/pages/Dashboards';
import { BUILTIN_BOARDS, boardAlias, sha256Hex, unavailableNote } from '@/soc/dashboard/builtins';
import { editedText, widgetCountText } from '@/soc/dashboard/Library';
import { unavailableWidgetCount } from '@/soc/dashboard/registry';
import type { DashboardLayout } from '@/lib/types';

const NOW = Date.parse('2026-10-29T12:00:00Z');

function board(id: string, name: string, widgets: number, updatedAt?: string): DashboardLayout {
  return {
    id,
    name,
    schema_version: 1,
    columns: 12,
    widgets: Array.from({ length: widgets }, (_, i) => ({
      i: `${id}-${i}`,
      type: 'kpi.needs_human',
      x: (i % 4) * 3,
      y: Math.floor(i / 4) * 3,
      w: 3,
      h: 3,
      options: {},
    })),
    updated_at: updatedAt,
  };
}

function authOff() {
  apiMocks.auth.me.mockResolvedValue({ authenticated: false, auth_enabled: false, user: null });
  apiMocks.roles.get.mockResolvedValue({ matrix: {}, rbac_enabled: false });
}

function authAs(role: string, grants: Record<string, string[]>, extra: Record<string, unknown> = {}) {
  apiMocks.auth.me.mockResolvedValue({
    authenticated: true,
    auth_enabled: true,
    user: { username: 'ana', role },
    ...extra,
  });
  apiMocks.roles.get.mockResolvedValue({ matrix: { [role]: grants }, rbac_enabled: true });
}

function renderLibrary(hash = '#/dashboards') {
  window.history.replaceState(null, '', hash);
  return render(
    <ThemeProvider>
      <AuthProvider>
        <PrefsProvider>
          <RouterProvider>
            <Dashboards />
          </RouterProvider>
        </PrefsProvider>
      </AuthProvider>
    </ThemeProvider>,
  );
}

const builtinSection = () => screen.getByRole('region', { name: 'Built-in' });
const yoursSection = () => screen.getByRole('region', { name: 'Yours' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  demo.on = false;
  authOff();
  apiMocks.prefs.effective.mockResolvedValue({ misc: {}, saved_views: [], pinned_view_ids: [], tables: {}, terminology: {} });
  apiMocks.prefs.putUser.mockResolvedValue({});
  apiMocks.dashboards.list.mockResolvedValue({ dashboards: [] });
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '#/');
});

describe('Library: the built-in section', () => {
  it('lists the four built-ins in order with the operator copy and "Default" only on the landing card', async () => {
    renderLibrary();
    const section = await screen.findByRole('region', { name: 'Built-in' });
    const links = within(section).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('aria-labelledby') && a.textContent)).toHaveLength(4);
    expect(links.map((a) => within(a).getByText(/^(Cyber Defence Center|SOC operations|Detection and data health|Executive summary)$/).textContent)).toEqual([
      'Cyber Defence Center',
      'SOC operations',
      'Detection and data health',
      'Executive summary',
    ]);
    // Accessible names are the boards' names.
    expect(within(section).getByRole('link', { name: 'Cyber Defence Center' })).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'SOC operations' })).toBeInTheDocument();

    const [landing, ops, detection, executive] = links;
    expect(within(landing).getByText('Default')).toBeInTheDocument();
    expect(within(landing).queryByText('Built-in')).toBeNull();
    for (const card of [ops, detection, executive]) {
      expect(within(card).getByText('Built-in')).toBeInTheDocument();
      expect(within(card).queryByText('Default')).toBeNull();
    }
    expect(within(section).getAllByText('Default')).toHaveLength(1);

    expect(within(landing).getByText('Last 24 hours')).toBeInTheDocument();
    expect(within(landing).getByText('The landing page: alert flow, case state and response time right now.')).toBeInTheDocument();
    expect(within(landing).getByText('For everyone')).toBeInTheDocument();
    expect(within(ops).getByText('Last 24 hours')).toBeInTheDocument();
    expect(within(ops).getByText('Is the team keeping up today?')).toBeInTheDocument();
    expect(within(ops).getByText('For SOC managers and shift leads')).toBeInTheDocument();
    expect(within(detection).getByText('Last 7 days')).toBeInTheDocument();
    expect(within(detection).getByText('Are we seeing everything, and are the detections any good?')).toBeInTheDocument();
    expect(within(detection).getByText('For detection engineers and platform admins')).toBeInTheDocument();
    expect(within(executive).getByText('Last 30 days')).toBeInTheDocument();
    expect(
      within(executive).getByText('Are we safer and faster than last month, and what does automation cost?'),
    ).toBeInTheDocument();
    expect(within(executive).getByText('For the CISO and leadership')).toBeInTheDocument();

    expect(within(section).getByText('Read-only. Duplicate one to make it your own.')).toBeInTheDocument();
  });

  it('a built-in purpose takes up to three lines (its whole text in title); a personal detail two', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [board('dash-night', 'Night shift triage', 2)] });
    renderLibrary();
    const section = await screen.findByRole('region', { name: 'Built-in' });
    const purpose = 'Are we safer and faster than last month, and what does automation cost?';
    const text = within(within(section).getByRole('link', { name: 'Executive summary' })).getByText(purpose);
    expect(text.className).toContain('line-clamp-3');
    expect(text).toHaveAttribute('title', purpose);
    const landing = within(within(section).getByRole('link', { name: 'Cyber Defence Center' })).getByText(
      'The landing page: alert flow, case state and response time right now.',
    );
    expect(landing.className).toContain('line-clamp-3');
    const night = await within(yoursSection()).findByRole('link', { name: 'Night shift triage' });
    const detail = within(night).getByText('2 widgets');
    expect(detail.className).toContain('line-clamp-2');
    expect(detail).toHaveAttribute('title', '2 widgets');
  });

  it('cards are links to their routes, described by badge, window and purpose', async () => {
    renderLibrary();
    const section = await screen.findByRole('region', { name: 'Built-in' });
    expect(within(section).getByRole('link', { name: 'Cyber Defence Center' })).toHaveAttribute('href', '#/overview');
    expect(within(section).getByRole('link', { name: 'SOC operations' })).toHaveAttribute(
      'href',
      '#/dashboards?board=builtin%3Asoc-operations',
    );
    expect(within(section).getByRole('link', { name: 'Detection and data health' })).toHaveAttribute(
      'href',
      '#/dashboards?board=builtin%3Adetection-data-health',
    );
    expect(within(section).getByRole('link', { name: 'Executive summary' })).toHaveAttribute(
      'href',
      '#/dashboards?board=builtin%3Aexecutive-summary',
    );
    const ops = within(section).getByRole('link', { name: 'SOC operations' });
    expect(ops).toHaveAccessibleDescription(/Built-in.*Last 24 hours.*Is the team keeping up today\?/);
    // The library card says which board it opens, so focus can come back to it.
    expect(ops).toHaveAttribute('data-board-card', 'builtin:soc-operations');
    // The outline preview is decorative.
    const outline = ops.querySelector('[data-board-outline]');
    expect(outline).not.toBeNull();
    expect(outline).toHaveAttribute('aria-hidden', 'true');
  });

  it('the header is the title, a help tip with the description, and a New dashboard link', async () => {
    renderLibrary();
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    // E1: no description line under the title; it is in the help tip.
    expect(screen.queryByText('Built-in boards for each role, and the ones you made.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'About Dashboards' }));
    expect(await screen.findByText(LIBRARY_HELP)).toBeInTheDocument();
    const create = screen.getByTestId('dashboards-new');
    expect(create).toHaveAccessibleName('New dashboard');
    expect(create).toHaveAttribute('href', '#/dashboards?board=new');
    expect(create.closest('[data-page-header-actions]')).not.toBeNull();
  });
});

describe('Library: Yours', () => {
  it('lists personal boards with the edited time and widget count, then the dashed New tile', async () => {
    apiMocks.dashboards.list.mockResolvedValue({
      dashboards: [
        board('dash-night', 'Night shift triage', 6, new Date(NOW - 26 * 3600 * 1000).toISOString()),
        board('dash-hunt', 'Hunting', 1, new Date(NOW - 3 * 86_400 * 1000).toISOString()),
      ],
    });
    renderLibrary();
    await waitFor(() => expect(within(yoursSection()).getByRole('link', { name: 'Night shift triage' })).toBeInTheDocument());
    const yours = yoursSection();
    const links = within(yours).getAllByRole('link');
    // The role default (not saved yet) first, then the stored boards, then the New tile.
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#/dashboards?board=overview',
      '#/dashboards?board=dash-night',
      '#/dashboards?board=dash-hunt',
      '#/dashboards?board=new',
    ]);
    const mine = within(yours).getByRole('link', { name: 'My dashboard' });
    expect(within(mine).getByText('4 widgets · your role default')).toBeInTheDocument();
    expect(within(mine).getByText('Yours')).toBeInTheDocument();
    const night = within(yours).getByRole('link', { name: 'Night shift triage' });
    expect(within(night).getByText('6 widgets')).toBeInTheDocument();
    expect(within(night).getByText('Edited yesterday')).toBeInTheDocument();
    expect(within(night).getByText('Edited yesterday')).toHaveAttribute('title');
    const hunt = within(yours).getByRole('link', { name: 'Hunting' });
    expect(within(hunt).getByText('1 widget')).toBeInTheDocument();
    expect(within(hunt).getByText('Edited 3 days ago')).toBeInTheDocument();
    const tile = links[links.length - 1];
    expect(tile).toHaveTextContent('New dashboard');
    expect(tile.className).toContain('border-dashed');
  });

  it('at 24 dashboards no draft is offered: the tile says why and the header action is disabled', async () => {
    apiMocks.dashboards.list.mockResolvedValue({
      dashboards: Array.from({ length: 24 }, (_, i) => board(`dash-${i}`, `Board ${i}`, 1)),
    });
    renderLibrary();
    const yours = await screen.findByRole('region', { name: 'Yours' });
    const tile = await within(yours).findByTestId('dashboard-new-tile');
    expect(tile).toHaveTextContent('You have 24 dashboards, the most allowed. Delete one to add another.');
    expect(tile.tagName).toBe('P');
    expect(within(yours).queryByRole('link', { name: /New dashboard/ })).toBeNull();
    const create = screen.getByTestId('dashboards-new');
    expect(create.tagName).toBe('BUTTON');
    expect(create).toBeDisabled();
    expect(create).toHaveAccessibleName('New dashboard');
    expect(create).not.toHaveAttribute('href');
  });

  it('below the limit the New tile and the header action are links to the draft', async () => {
    apiMocks.dashboards.list.mockResolvedValue({
      dashboards: Array.from({ length: 23 }, (_, i) => board(`dash-${i}`, `Board ${i}`, 1)),
    });
    renderLibrary();
    const yours = await screen.findByRole('region', { name: 'Yours' });
    await within(yours).findByRole('link', { name: 'Board 22' });
    expect(within(yours).getByTestId('dashboard-new-tile')).toHaveAttribute('href', '#/dashboards?board=new');
    expect(screen.getByTestId('dashboards-new')).toHaveAttribute('href', '#/dashboards?board=new');
  });

  it('a stored role default named "Overview" shows as "My dashboard"', async () => {
    apiMocks.dashboards.list.mockResolvedValue({
      dashboards: [board('overview', 'Overview', 2, new Date(NOW - 60_000).toISOString())],
    });
    renderLibrary();
    const mine = await within(await screen.findByRole('region', { name: 'Yours' })).findByRole('link', { name: 'My dashboard' });
    expect(within(mine).getByText('2 widgets')).toBeInTheDocument();
    expect(within(mine).queryByText(/your role default/)).toBeNull();
    expect(screen.queryByText('Overview')).toBeNull();
  });

  it('a board stored under a reserved id is linked under its u: alias', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [board('new', 'Older board', 2)] });
    renderLibrary();
    const older = await within(await screen.findByRole('region', { name: 'Yours' })).findByRole('link', { name: 'Older board' });
    const sha8 = createHash('sha256').update('new').digest('hex').slice(0, 8);
    expect(boardAlias('new')).toBe(`u:${sha8}`);
    expect(older).toHaveAttribute('href', `#/dashboards?board=u%3A${sha8}`);
  });

  it('shows two skeleton cards while the personal list loads; built-ins stay usable', async () => {
    apiMocks.dashboards.list.mockReturnValue(new Promise(() => {}));
    renderLibrary();
    expect(await screen.findAllByTestId('dashboard-card-skeleton')).toHaveLength(2);
    expect(within(builtinSection()).getAllByRole('link')).toHaveLength(4);
  });

  it('a failed list shows an inline error with Retry; built-ins stay usable', async () => {
    apiMocks.dashboards.list.mockRejectedValueOnce(new Error('network down'));
    renderLibrary();
    expect(await screen.findByText('Your dashboards could not be loaded.')).toBeInTheDocument();
    expect(within(builtinSection()).getAllByRole('link')).toHaveLength(4);
    apiMocks.dashboards.list.mockResolvedValueOnce({ dashboards: [board('dash-night', 'Night shift triage', 2)] });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByRole('link', { name: 'Night shift triage' })).toBeInTheDocument();
    expect(apiMocks.dashboards.list).toHaveBeenCalledTimes(2);
  });
});

describe('Library: hidden built-ins', () => {
  it('leaves hidden boards out until "Show 1 hidden", then offers Unhide outside the link', async () => {
    apiMocks.prefs.effective.mockResolvedValue({ misc: { dashboards_hidden: ['builtin:soc-operations'] } });
    renderLibrary();
    const toggle = await screen.findByRole('button', { name: 'Show 1 hidden' });
    expect(within(builtinSection()).queryByRole('link', { name: 'SOC operations' })).toBeNull();
    expect(within(builtinSection()).getAllByRole('link')).toHaveLength(3);
    // A disclosure of the Built-in list: a constant role, its state in aria-expanded.
    const list = within(builtinSection()).getByRole('list');
    expect(list).toHaveAttribute('id', 'dashboards-builtin-list');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'dashboards-builtin-list');
    expect(toggle).not.toHaveAttribute('aria-pressed');

    fireEvent.click(toggle);
    const ops = within(builtinSection()).getByRole('link', { name: 'SOC operations' });
    expect(within(ops).getByText('Hidden')).toBeInTheDocument();
    const unhide = screen.getByRole('button', { name: 'Unhide SOC operations' });
    // In the card foot, laid over the panel: a sibling right after the link, never in it,
    // and the foot line keeps clear of it.
    expect(unhide.closest('a')).toBeNull();
    expect(ops.nextElementSibling).toBe(unhide);
    expect(unhide.className).toContain('absolute');
    expect(within(ops).getByText('For SOC managers and shift leads').className).toContain('pr-24');
    const fewer = screen.getByRole('button', { name: 'Show fewer' });
    expect(fewer).toHaveAttribute('aria-expanded', 'true');
    expect(fewer).toHaveAttribute('aria-controls', 'dashboards-builtin-list');

    unhide.focus();
    fireEvent.click(unhide);
    // The button is gone with the hidden state: the board's card link takes the focus.
    await waitFor(() => expect(document.activeElement).toBe(within(builtinSection()).getByRole('link', { name: 'SOC operations' })));
    await waitFor(() =>
      expect(apiMocks.prefs.putUser).toHaveBeenCalledWith({ misc: { dashboards_hidden: [] } }),
    );
    expect(toastMock.success).toHaveBeenCalledWith('SOC operations is back in your list.');
    await waitFor(() => expect(screen.queryByRole('button', { name: /hidden|Show fewer/ })).toBeNull());
    expect(within(builtinSection()).getAllByRole('link')).toHaveLength(4);
  });

  it('a failed Unhide puts the list back and says so', async () => {
    apiMocks.prefs.effective.mockResolvedValue({ misc: { dashboards_hidden: ['builtin:executive-summary'] } });
    apiMocks.prefs.putUser.mockRejectedValueOnce(new Error('audit unavailable'));
    renderLibrary();
    fireEvent.click(await screen.findByRole('button', { name: 'Show 1 hidden' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unhide Executive summary' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(toastMock.error.mock.calls[0][0]).toBe('Your dashboard list could not be updated.');
    expect(within(builtinSection()).getByRole('link', { name: 'Executive summary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unhide Executive summary' })).toBeInTheDocument();
  });
});

describe('Library: permissions and scope', () => {
  it('without metrics:view the page says the viewer has no access and reads nothing', async () => {
    authAs('auditor', { audit: ['view'] });
    renderLibrary();
    expect(await screen.findByText('You do not have access to dashboards.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Built-in' })).toBeNull();
    expect(apiMocks.dashboards.list).not.toHaveBeenCalled();
  });

  it('a partly denied built-in says how many panels need other permissions', async () => {
    const grants = { metrics: ['view'], cases: ['read'] };
    authAs('analyst_tier1', grants);
    renderLibrary();
    const section = await screen.findByRole('region', { name: 'Built-in' });
    const can = (r: string, a: string) => (grants as Record<string, string[]>)[r]?.includes(a) ?? false;
    const exec = BUILTIN_BOARDS.find((b) => b.id === 'builtin:executive-summary')!;
    const expected = unavailableNote(unavailableWidgetCount(exec.widgets, { can }));
    expect(expected).toMatch(/panels? needs? permissions your role does not have\./);
    await waitFor(() =>
      expect(within(within(section).getByRole('link', { name: 'Executive summary' })).getByText(expected!)).toBeInTheDocument(),
    );
    // The note is part of the card's description.
    expect(within(section).getByRole('link', { name: 'Executive summary' })).toHaveAccessibleDescription(
      new RegExp(expected!.replace('.', '\\.')),
    );
  });

  it('with row-level scope on, the cards count the case panels as unavailable', async () => {
    authAs('soc_manager', { metrics: ['view'], cases: ['read'], cost: ['view'], sources: ['read'], automation: ['read'] }, {
      object_scoped: true,
    });
    renderLibrary();
    const section = await screen.findByRole('region', { name: 'Built-in' });
    const ops = BUILTIN_BOARDS.find((b) => b.id === 'builtin:soc-operations')!;
    const expected = unavailableNote(unavailableWidgetCount(ops.widgets, { objectScoped: true }));
    expect(expected).not.toBeNull();
    await waitFor(() =>
      expect(within(within(section).getByRole('link', { name: 'SOC operations' })).getByText(expected!)).toBeInTheDocument(),
    );
  });
});

describe('Library: structure, keyboard, Demo Mode and copy', () => {
  it('phone: the header action carries a short "New" label inside the same link', async () => {
    renderLibrary();
    const create = await screen.findByTestId('dashboards-new');
    expect(create).toHaveAccessibleName('New dashboard');
    const short = within(create).getByText('New');
    expect(short.className).toContain('sm:hidden');
    expect(within(create).getByText('New dashboard').className).toContain('max-sm:hidden');
    // The grid is one column below `sm`, two from `sm`, four from `xl`.
    const grid = within(builtinSection()).getByRole('list');
    expect(grid.className).toContain('sm:grid-cols-2');
    expect(grid.className).toContain('xl:grid-cols-4');
  });

  it('every card is a link in reading order, and nothing interactive sits inside a card', async () => {
    renderLibrary();
    await screen.findByRole('link', { name: 'My dashboard' });
    const library = screen.getByTestId('dashboards-library');
    const names = Array.from(library.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(names).toEqual([
      '#/overview',
      '#/dashboards?board=builtin%3Asoc-operations',
      '#/dashboards?board=builtin%3Adetection-data-health',
      '#/dashboards?board=builtin%3Aexecutive-summary',
      '#/dashboards?board=overview',
      '#/dashboards?board=new',
    ]);
    for (const a of Array.from(library.querySelectorAll('a'))) {
      expect(a.querySelector('a, button, input')).toBeNull();
    }
  });

  it('Demo Mode lists the same boards (personal boards and the library are not Demo-swapped)', async () => {
    demo.on = true;
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [board('dash-night', 'Night shift triage', 2)] });
    renderLibrary();
    expect(await screen.findByRole('link', { name: 'Night shift triage' })).toBeInTheDocument();
    expect(within(builtinSection()).getAllByRole('link')).toHaveLength(4);
    expect(apiMocks.dashboards.list).toHaveBeenCalledTimes(1);
  });

  it('no em dash, no en dash and no "playbook" in the library copy', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [board('dash-night', 'Night shift triage', 2)] });
    renderLibrary();
    await screen.findByRole('link', { name: 'Night shift triage' });
    fireEvent.click(screen.getByRole('button', { name: 'About Dashboards' }));
    await screen.findByText(LIBRARY_HELP);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\u2014|\u2013/);
    expect(text.toLowerCase()).not.toContain('playbook');
  });
});

describe('Library helpers', () => {
  it('sha256Hex matches the standard digest', () => {
    for (const value of ['', 'abc', 'new', 'builtin:x', 'tableau de bord é', 'x'.repeat(200)]) {
      expect(sha256Hex(value)).toBe(createHash('sha256').update(value, 'utf8').digest('hex'));
    }
  });

  it('edited time and widget counts read in plain words', () => {
    expect(editedText(new Date(NOW - 10_000).toISOString(), NOW)).toBe('Edited just now');
    expect(editedText(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('Edited 5 minutes ago');
    expect(editedText(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('Edited 3 hours ago');
    expect(editedText(undefined, NOW)).toBeNull();
    expect(editedText('not a time', NOW)).toBeNull();
    expect(widgetCountText(1)).toBe('1 widget');
    expect(widgetCountText(1234)).toBe('1,234 widgets');
    expect(unavailableNote(0)).toBeNull();
    expect(unavailableNote(1)).toBe('1 panel needs permissions your role does not have.');
    expect(unavailableNote(2)).toBe('2 panels need permissions your role does not have.');
  });
});
