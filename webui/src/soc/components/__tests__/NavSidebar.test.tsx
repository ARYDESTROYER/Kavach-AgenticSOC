/**
 * NavSidebar and the navigation store (Round 14, SPEC §4.8; the Round-3 contracts kept).
 *
 * Pins the load-bearing behaviours of the labelled drawer and its persistence:
 *
 *   1. WAI-ARIA DISCLOSURE semantics: a group row is a link to its page and a separate
 *      chevron button carries `aria-expanded` + `aria-controls` pointing at the group's
 *      list; the closed list is hidden from assistive technology and out of the tab
 *      order; the current page carries `aria-current="page"` exactly once.
 *      (We deliberately do NOT use role="tree": these are page links, not a data tree.)
 *
 *   2. PERSISTENCE: the store hydrates the collapsed flag and the open groups
 *      SYNCHRONOUSLY from a localStorage mirror (no first-paint flash), every change
 *      writes BOTH the mirror and PUT /api/prefs/user, and `useNavPrefsSync` reconciles
 *      once from the server's `UserPrefs.misc` without overwriting a key the viewer
 *      changed before the cascade hydrated.
 *
 * Rail behaviour (hover intent, flyouts, the Tab order, the toggle) is pinned in
 * `soc/__tests__/nav.behaviour.test.tsx`.
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

vi.mock('../../auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

// Prefs: a settled, empty cascade (no server-side misc overrides) by default.
const prefsState = { ready: true, misc: {} as Record<string, unknown> };
vi.mock('../../prefs', () => ({
  usePrefs: () => ({ prefs: { misc: prefsState.misc }, ready: prefsState.ready }),
}));

const putUser = vi.fn(() => Promise.resolve({}));
vi.mock('@/lib/api', () => ({
  api: { prefs: { putUser: (...a: unknown[]) => putUser(...a) } },
}));

import { NavSidebar } from '../NavSidebar';
import { navStore, useNavPrefsSync, useNavState } from '../../nav-store';
import { navLabel, type PageId } from '../../nav';

function renderDrawer(page: PageId = 'cases', open: string[] = []) {
  window.localStorage.setItem('soc.nav.collapsed', '0');
  window.localStorage.setItem('soc.nav.openGroups', JSON.stringify(open));
  navStore.beginSession();
  const onNavigate = vi.fn();
  const utils = render(<NavSidebar page={page} onNavigate={onNavigate} />);
  return { onNavigate, ...utils };
}

beforeEach(() => {
  window.localStorage.clear();
  putUser.mockClear();
  prefsState.ready = true;
  prefsState.misc = {};
});

/* ---- Disclosure semantics ------------------------------------------------- */

describe('NavSidebar: WAI-ARIA disclosure in the labelled drawer', () => {
  it('keeps the Help Center pinned below the scrolling groups and navigates in-app', () => {
    const { onNavigate } = renderDrawer();
    const footer = screen.getByTestId('nav-footer');
    const docs = screen.getByRole('link', { name: 'Help Center' });
    expect(footer).toContainElement(docs);
    fireEvent.click(docs);
    expect(onNavigate).toHaveBeenCalledWith('docs');
  });

  it('renders a closed group: the chevron is collapsed and its list is hidden and untabbable', () => {
    renderDrawer();
    const chevron = screen.getByRole('button', { name: 'Show Overview pages' });
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    const list = document.getElementById(chevron.getAttribute('aria-controls') as string) as HTMLElement;
    expect(list).not.toBeNull();
    expect(list.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(list.closest('[inert]')).not.toBeNull();
    for (const link of list.querySelectorAll('a')) expect(link).toHaveAttribute('tabindex', '-1');
    // Hidden from assistive technology, so not found by role.
    expect(screen.queryByRole('link', { name: 'Standup' })).toBeNull();
  });

  it('reveals the pages (the aria-controls list) when the group is open', () => {
    renderDrawer('cases', ['overview']);
    const chevron = screen.getByRole('button', { name: 'Hide Overview pages' });
    expect(chevron).toHaveAttribute('aria-expanded', 'true');
    const list = document.getElementById(chevron.getAttribute('aria-controls') as string) as HTMLElement;
    expect(list.closest('[aria-hidden="true"]')).toBeNull();
    expect(screen.getByTestId('nav-dashboard')).toHaveTextContent('Cyber Defence Center');
    expect(screen.getByRole('link', { name: 'Standup' })).not.toHaveAttribute('tabindex');
    expect(screen.getByRole('link', { name: navLabel('dashboards') })).toHaveAttribute('href', '#/dashboards');
  });

  it('the chevron toggles the group in the store and never navigates', () => {
    const { onNavigate } = renderDrawer();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Show Overview pages' })));
    expect(navStore.getState().openGroups.has('overview')).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('marks the current page once, on the page inside an open group', () => {
    renderDrawer('standup', ['overview']);
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Standup' })).toHaveAttribute('aria-current', 'page');
  });

  it('renders a plain destination as a link with no chevron, tinted when current', () => {
    renderDrawer('cases');
    const cases = screen.getByTestId('nav-cases');
    expect(cases.tagName).toBe('A');
    expect(cases).toHaveAttribute('href', '#/cases');
    expect(cases).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: /Cases pages/ })).toBeNull();
    // The current page is a tinted pill and a tinted icon; no accent bar at the edge.
    expect(cases.querySelector('.bg-primary\\/10')).not.toBeNull();
    expect(cases.querySelector('svg')).toHaveClass('text-primary');
    expect(cases.querySelector('.w-0\\.5')).toBeNull();
    expect(cases.className).not.toContain('shadow-glow');
  });

  it('marks a host that is also its own page once: the page while open, the row while closed', () => {
    const open = renderDrawer('chat', ['chat']);
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(screen.getByTestId('nav-chat-page')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('nav-chat')).not.toHaveAttribute('aria-current');
    open.unmount();
    renderDrawer('chat', []);
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(screen.getByTestId('nav-chat')).toHaveAttribute('aria-current', 'page');
  });

  it('names its group lists and is axe-clean with groups open and closed', async () => {
    const { container, unmount } = renderDrawer('standup', ['overview', 'chat']);
    expect(screen.getByRole('list', { name: 'Overview pages' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    unmount();
    const closed = renderDrawer('docs');
    expect(await axe(closed.container)).toHaveNoViolations();
  });
});

/* ---- Persistence ---------------------------------------------------------- */

/** Mounts the shell's sync hook and shows the store through markers and buttons. */
const PrefsHarness: React.FC = () => {
  useNavPrefsSync();
  const collapsed = useNavState((s) => s.collapsed);
  const openGroups = useNavState((s) => s.openGroups);
  return (
    <div>
      <span data-testid="collapsed">{String(collapsed)}</span>
      <span data-testid="open">{Array.from(openGroups).join(',')}</span>
      <button type="button" onClick={() => navStore.toggleCollapsed()}>
        toggle-collapsed
      </button>
      <button type="button" onClick={() => navStore.toggleGroup('overview')}>
        toggle-overview
      </button>
    </div>
  );
};

describe('the navigation store: synchronous hydration and dual persistence', () => {
  it('hydrates the collapsed flag synchronously from the localStorage mirror (no flash)', () => {
    window.localStorage.setItem('soc.nav.collapsed', '1');
    render(<PrefsHarness />);
    expect(screen.getByTestId('collapsed').textContent).toBe('true');
  });

  it('hydrates the open groups synchronously from the mirror', () => {
    window.localStorage.setItem('soc.nav.openGroups', JSON.stringify(['overview', 'settings']));
    render(<PrefsHarness />);
    expect(screen.getByTestId('open').textContent).toBe('overview,settings');
  });

  it('ignores a malformed mirror', () => {
    window.localStorage.setItem('soc.nav.openGroups', '{not json');
    render(<PrefsHarness />);
    expect(screen.getByTestId('open').textContent).toBe('');
  });

  it('persists a collapse toggle to BOTH localStorage and PUT /api/prefs/user', () => {
    render(<PrefsHarness />);
    act(() => fireEvent.click(screen.getByText('toggle-collapsed')));
    expect(screen.getByTestId('collapsed').textContent).toBe('true');
    expect(window.localStorage.getItem('soc.nav.collapsed')).toBe('1');
    expect(putUser).toHaveBeenCalledWith({ misc: { nav_collapsed: true } });
  });

  it('persists an open-group toggle to BOTH localStorage and the server', () => {
    render(<PrefsHarness />);
    act(() => fireEvent.click(screen.getByText('toggle-overview')));
    expect(screen.getByTestId('open').textContent).toBe('overview');
    expect(JSON.parse(window.localStorage.getItem('soc.nav.openGroups') as string)).toEqual(['overview']);
    expect(putUser).toHaveBeenCalledWith({ misc: { nav_open_groups: ['overview'] } });
  });

  it('reconciles from the server misc bucket once prefs hydrate, and mirrors it', () => {
    prefsState.misc = { nav_collapsed: true, nav_open_groups: ['settings'] };
    render(<PrefsHarness />);
    expect(screen.getByTestId('collapsed').textContent).toBe('true');
    expect(screen.getByTestId('open').textContent).toBe('settings');
    expect(window.localStorage.getItem('soc.nav.collapsed')).toBe('1');
  });

  it('does not clobber a collapse toggle made before the prefs cascade hydrates', () => {
    prefsState.ready = false;
    prefsState.misc = { nav_collapsed: false };
    const { rerender } = render(<PrefsHarness />);
    expect(screen.getByTestId('collapsed').textContent).toBe('false');
    act(() => fireEvent.click(screen.getByText('toggle-collapsed')));
    expect(screen.getByTestId('collapsed').textContent).toBe('true');
    prefsState.ready = true;
    act(() => rerender(<PrefsHarness />));
    expect(screen.getByTestId('collapsed').textContent).toBe('true');
  });

  it('does not clobber an open-group toggle made before the cascade hydrates', () => {
    prefsState.ready = false;
    prefsState.misc = { nav_open_groups: ['settings'] };
    const { rerender } = render(<PrefsHarness />);
    act(() => fireEvent.click(screen.getByText('toggle-overview')));
    expect(screen.getByTestId('open').textContent).toBe('overview');
    prefsState.ready = true;
    act(() => rerender(<PrefsHarness />));
    expect(screen.getByTestId('open').textContent).toBe('overview');
  });

  it('starts a new session on a new shell: earlier changes no longer block the reconcile', () => {
    prefsState.ready = false;
    const first = render(<PrefsHarness />);
    act(() => fireEvent.click(screen.getByText('toggle-collapsed')));
    first.unmount();
    // Signed out and back in: the server's value now wins for the new session.
    prefsState.ready = true;
    prefsState.misc = { nav_collapsed: false };
    render(<PrefsHarness />);
    expect(screen.getByTestId('collapsed').textContent).toBe('false');
  });
});

describe('the breadcrumb trail', () => {
  it('keeps segments for one page only and clears only that page', () => {
    navStore.beginSession();
    navStore.setTrail('dashboards', [{ label: 'Dashboards', page: 'dashboards' }, { label: 'SOC operations' }]);
    expect(navStore.getState().trail).toEqual({
      page: 'dashboards',
      items: [{ label: 'Dashboards', page: 'dashboards' }, { label: 'SOC operations' }],
    });
    navStore.setTrail('audit', null);
    expect(navStore.getState().trail?.page).toBe('dashboards');
    navStore.setTrail('dashboards', null);
    expect(navStore.getState().trail).toBeNull();
  });
});
