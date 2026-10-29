/**
 * Round 14 left navigation (SPEC §4.8, C6 A "docked rail with a stable morph"): the
 * regression guards of §4.8.3 that jsdom can check (structure, events and fake timers).
 * Geometry and frame timing are measured by the live QA harness instead (§8.3).
 *
 *   - one DOM for both states: the same rows and icon cells before and after a toggle;
 *   - focus stays on the toggle after a keyboard toggle, both ways;
 *   - a pointer that never rests 300 ms mounts no flyout and no tooltip; a rest mounts one;
 *   - a press on a grouped icon navigates at once and mounts no flyout;
 *   - the aria-haspopup / aria-expanded / aria-controls / aria-current rules (§2.2 item 9);
 *   - pressing the Overview row leaves its group as it was (E13) and opens the library;
 *   - the Tab order of the collapsed rail, and Tab, arrows and Escape around a flyout;
 *   - the 120 ms neighbour switch, the safe triangle and the flyout's viewport clamp;
 *   - content on hover (WCAG 1.4.13): Escape dismisses the tooltip and a hover flyout,
 *     and the tooltip stays while the pointer is over it;
 *   - a state switch from the shell (Ctrl+B) cancels pending rest timers, and collapsing
 *     never strands focus on an element that becomes inert;
 *   - the click strip stays off the scrollbar, and forced colours keep focus and the
 *     current page visible.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

// jsdom has no PointerEvent, so a fired pointer event would carry no coordinates and the
// hover-intent geometry (rest slop, safe triangle) could not be exercised. A MouseEvent
// subclass carries clientX and clientY, as a browser's PointerEvent does.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventWithCoordinates extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: PointerEventWithCoordinates });
}

/** RBAC for the test: grant everything unless a test narrows it. */
let grant: (resource: string, action: string) => boolean = () => true;
vi.mock('../auth', () => ({ useAuth: () => ({ hasPermission: (r: string, a: string) => grant(r, a) }) }));
vi.mock('../prefs', () => ({ usePrefs: () => ({ prefs: { misc: {} }, ready: true }) }));
const putUser = vi.fn(() => Promise.resolve({}));
vi.mock('@/lib/api', () => ({ api: { prefs: { putUser: (...a: unknown[]) => putUser(...a) } } }));

import { NavSidebar, NAV_COPY, navToggleShortcut } from '../components/NavSidebar';
import {
  NAV_GRACE_MS,
  NAV_REST_MS,
  NAV_SWITCH_REST_MS,
  openFlyout,
  pointerLeftTrigger,
  pointerOverTrigger,
  pointerTrack,
  pointInTriangle,
  registerPanel,
  registerTrigger,
  resetNavHoverIntent,
  safeTriangle,
} from '../components/nav-hover-intent';
import { RAIL_TIP_GRACE_MS, RAIL_TIP_REST_MS, resetRailTip } from '../components/nav-rail-tip';
import { loadRailInteractions } from '../components/nav-rail-loader';
import { navStore } from '../nav-store';
import type { PageId } from '../nav';

interface Setup {
  page?: PageId;
  collapsed?: boolean;
  open?: string[];
  variant?: 'rail' | 'sheet';
}

function setup({ page = 'cases', collapsed = false, open = [], variant = 'rail' }: Setup = {}) {
  window.localStorage.setItem('soc.nav.collapsed', collapsed ? '1' : '0');
  window.localStorage.setItem('soc.nav.openGroups', JSON.stringify(open));
  navStore.beginSession();
  const onNavigate = vi.fn();
  const utils = render(<NavSidebar page={page} onNavigate={onNavigate} variant={variant} />);
  const rerender = (next: PageId) =>
    utils.rerender(<NavSidebar page={next} onNavigate={onNavigate} variant={variant} />);
  return { ...utils, onNavigate, rerender };
}

/** The navigation landmark: it holds the destinations AND the rail's flyout. */
const landmark = () => screen.getByRole('navigation', { name: 'Console destinations' });
/** `aria-current` inside the landmark (SPEC §2.2 item 9 counts there), and nowhere else. */
const currentMarkers = () => {
  const inside = Array.from(landmark().querySelectorAll('[aria-current="page"]'));
  expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(inside.length);
  return inside;
};
const flyouts = () => document.querySelectorAll('[data-testid^="nav-flyout-"]');
const tips = () => document.querySelectorAll('[data-testid="nav-rail-tip"]');
const aside = () => screen.getByRole('complementary', { name: 'Primary navigation' });

// The rail's interaction layer is a lazy chunk (`nav-rail-loader.ts`); these tests pin its
// behaviour once loaded, so it is loaded before the first render. The load itself, and the
// replay of a first interaction that arrives before it, are pinned in nav.lazy-rail.test.tsx.
beforeAll(async () => {
  await loadRailInteractions();
});

beforeEach(() => {
  grant = () => true;
  window.localStorage.clear();
  putUser.mockClear();
  resetNavHoverIntent();
  resetRailTip();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('one DOM for both states', () => {
  it('keeps the same rows and icon cells across a toggle (no unmount, no swap)', () => {
    setup({ page: 'cases' });
    const rows = ['overview', 'cases', 'chat', 'settings', 'docs'].map((id) => screen.getByTestId(`nav-${id}`));
    const cells = rows.map((row) => row.querySelector('svg')?.parentElement as HTMLElement);
    const classesBefore = cells.map((cell) => cell.className);
    const toggle = screen.getByTestId('nav-toggle');

    act(() => fireEvent.click(toggle));
    expect(aside()).toHaveAttribute('data-nav-state', 'collapsed');
    rows.forEach((row, i) => expect(screen.getByTestId(row.dataset.testid as string)).toBe(row));
    expect(cells.map((cell) => cell.className)).toEqual(classesBefore);

    act(() => fireEvent.click(toggle));
    expect(aside()).toHaveAttribute('data-nav-state', 'expanded');
    rows.forEach((row) => expect(screen.getByTestId(row.dataset.testid as string)).toBe(row));
    expect(cells.map((cell) => cell.className)).toEqual(classesBefore);
  });

  it('changes the in-flow spacer once (64 or 240 px) and keeps the panel 240 px wide', () => {
    setup();
    const frame = screen.getByTestId('desktop-navigation-frame');
    expect(frame).toHaveClass('w-60');
    expect(frame.className).not.toMatch(/transition/);
    expect(aside()).toHaveClass('fixed', 'w-60');
    act(() => navStore.toggleCollapsed());
    expect(frame).toHaveClass('w-16');
    expect(aside()).toHaveClass('fixed', 'w-60');
  });

  it('persists the state to the mirror and the server', () => {
    setup();
    act(() => fireEvent.click(screen.getByTestId('nav-toggle')));
    expect(window.localStorage.getItem('soc.nav.collapsed')).toBe('1');
    expect(putUser).toHaveBeenCalledWith({ misc: { nav_collapsed: true } });
  });
});

describe('the toggle', () => {
  it('keeps focus on the toggle after a keyboard toggle, both ways, and names the state', () => {
    setup();
    const toggle = screen.getByTestId('nav-toggle');
    act(() => toggle.focus());
    expect(toggle).toHaveAccessibleName(NAV_COPY.collapse);
    // Enter on a focused button is a click.
    act(() => fireEvent.click(toggle));
    expect(document.activeElement).toBe(toggle);
    expect(toggle).toHaveAccessibleName(NAV_COPY.expand);
    act(() => fireEvent.click(toggle));
    expect(document.activeElement).toBe(toggle);
    expect(toggle).toHaveAccessibleName(NAV_COPY.collapse);
    expect(toggle).toHaveAttribute('aria-keyshortcuts', 'Control+B Meta+B');
  });

  it('shows the shortcut in the platform spelling', () => {
    expect(navToggleShortcut(false)).toBe('Ctrl+B');
    expect(navToggleShortcut(true)).toBe('⌘B');
    setup();
    expect(within(screen.getByTestId('nav-toggle')).getByText(navToggleShortcut())).toBeInTheDocument();
  });

  it('shows "Expand navigation" and the shortcut in the rail tooltip on keyboard focus', () => {
    setup({ collapsed: true });
    act(() => screen.getByTestId('nav-toggle').focus());
    const tip = screen.getByTestId('nav-rail-tip');
    expect(tip).toHaveTextContent(`${NAV_COPY.expand}${navToggleShortcut()}`);
    expect(tip).toHaveAttribute('aria-hidden', 'true');
  });

  it('collapses from the edge strip too, and never opens on hover', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    const frame = screen.getByTestId('desktop-navigation-frame');
    fireEvent.pointerEnter(aside());
    fireEvent.pointerMove(screen.getByTestId('nav-cases'), { clientX: 30, clientY: 120 });
    act(() => vi.advanceTimersByTime(2_000));
    expect(aside()).toHaveAttribute('data-nav-state', 'collapsed');
    expect(frame).toHaveClass('w-16');
    const strip = aside().querySelector('.nav-strip') as HTMLElement;
    expect(strip).toHaveAttribute('aria-hidden', 'true');
    expect(strip).toHaveAttribute('tabindex', '-1');
    act(() => fireEvent.click(strip));
    expect(aside()).toHaveAttribute('data-nav-state', 'expanded');
  });
});

describe('hover intent in the 64 px rail', () => {
  it('mounts no flyout and no tooltip while the pointer never rests; a rest mounts one', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    // A sweep down the rail: every icon is crossed, none is rested on.
    const sweep = ['overview', 'cases', 'case_manager', 'chat', 'intelligence', 'analytics', 'settings'];
    for (const id of sweep) {
      const row = screen.getByTestId(`nav-${id}`);
      for (let i = 0; i < 4; i += 1) {
        fireEvent.pointerMove(row, { clientX: 30, clientY: 100 + i * 5 });
        act(() => vi.advanceTimersByTime(60));
        expect(flyouts()).toHaveLength(0);
        expect(tips()).toHaveLength(0);
      }
      fireEvent.pointerLeave(row, { clientX: 30, clientY: 130 });
    }
    act(() => vi.advanceTimersByTime(NAV_REST_MS * 3));
    expect(flyouts()).toHaveLength(0);
    expect(tips()).toHaveLength(0);

    // A rest on a grouped icon opens its flyout (and no tooltip).
    const intelligence = screen.getByTestId('nav-intelligence');
    fireEvent.pointerMove(intelligence, { clientX: 30, clientY: 300 });
    act(() => vi.advanceTimersByTime(NAV_REST_MS - 1));
    expect(flyouts()).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(flyouts()).toHaveLength(1);
    expect(tips()).toHaveLength(0);
  });

  it('shows one tooltip after a rest on a plain icon, and none after a press', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    const cases = screen.getByTestId('nav-cases');
    fireEvent.pointerMove(cases, { clientX: 30, clientY: 120 });
    act(() => vi.advanceTimersByTime(RAIL_TIP_REST_MS));
    expect(tips()).toHaveLength(1);
    expect(screen.getByTestId('nav-rail-tip')).toHaveTextContent('Cases');
    fireEvent.pointerDown(cases);
    expect(tips()).toHaveLength(0);
  });

  it('a press on a grouped icon navigates at once and mounts no flyout', () => {
    vi.useFakeTimers();
    const { onNavigate } = setup({ collapsed: true, page: 'cases' });
    const chat = screen.getByTestId('nav-chat');
    fireEvent.pointerMove(chat, { clientX: 30, clientY: 200 });
    fireEvent.pointerDown(chat, { button: 0 });
    fireEvent.click(chat);
    expect(onNavigate).toHaveBeenCalledWith('chat');
    act(() => vi.advanceTimersByTime(NAV_REST_MS * 3));
    expect(flyouts()).toHaveLength(0);
  });

  it('closes a flyout 400 ms after the pointer leaves the icon and the flyout', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    const analytics = screen.getByTestId('nav-analytics');
    fireEvent.pointerMove(analytics, { clientX: 30, clientY: 300 });
    act(() => vi.advanceTimersByTime(NAV_REST_MS));
    const panel = screen.getByTestId('nav-flyout-analytics');
    fireEvent.pointerLeave(analytics, { clientX: 60, clientY: 300 });
    fireEvent.pointerEnter(panel);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId('nav-flyout-analytics')).toBeInTheDocument();
    fireEvent.pointerLeave(panel, { clientX: 400, clientY: 600 });
    act(() => vi.advanceTimersByTime(399));
    expect(flyouts()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(flyouts()).toHaveLength(0);
  });
});

describe('ARIA in the 64 px rail', () => {
  it('a grouped icon is a link with aria-haspopup, aria-expanded and aria-controls naming its list', () => {
    setup({ collapsed: true, page: 'cases' });
    const overview = screen.getByTestId('nav-overview');
    expect(overview.tagName).toBe('A');
    expect(overview).toHaveAttribute('aria-haspopup', 'true');
    expect(overview).toHaveAttribute('aria-expanded', 'false');
    expect(overview).toHaveAttribute('aria-controls', 'nav-fly-overview');
    // Keyboard focus opens the flyout at once.
    act(() => overview.focus());
    expect(overview).toHaveAttribute('aria-expanded', 'true');
    const list = document.getElementById('nav-fly-overview') as HTMLElement;
    expect(list.tagName).toBe('UL');
    expect(list).toHaveAccessibleName('Overview pages');
    // Flyout pages are links out of the tab order.
    for (const link of within(list).getAllByRole('link')) expect(link).toHaveAttribute('tabindex', '-1');
  });

  it('carries one aria-current: the icon while closed, the current page while its flyout is open', () => {
    setup({ collapsed: true, page: 'standup' });
    const overview = screen.getByTestId('nav-overview');
    expect(currentMarkers()).toEqual([overview]);
    act(() => overview.focus());
    const standup = within(document.getElementById('nav-fly-overview') as HTMLElement).getByRole('link', { name: 'Standup' });
    expect(currentMarkers()).toEqual([standup]);
  });

  it('a plain icon has no popup semantics', () => {
    setup({ collapsed: true, page: 'cases' });
    const cases = screen.getByTestId('nav-cases');
    expect(cases).not.toHaveAttribute('aria-haspopup');
    expect(cases).not.toHaveAttribute('aria-expanded');
    expect(cases).toHaveAttribute('aria-current', 'page');
  });
});

describe('the Overview row and its group (SPEC §2.2, E13)', () => {
  it('opens the Dashboards library and leaves the group closed', () => {
    const { onNavigate } = setup({ page: 'cases', open: [] });
    const row = screen.getByTestId('nav-overview');
    expect(row).toHaveAttribute('href', '#/dashboards');
    act(() => fireEvent.click(row));
    expect(onNavigate).toHaveBeenCalledWith('dashboards');
    expect(navStore.getState().openGroups.has('overview')).toBe(false);
    expect(screen.getByRole('button', { name: 'Show Overview pages' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('leaves an open group open', () => {
    setup({ page: 'cases', open: ['overview'] });
    act(() => fireEvent.click(screen.getByTestId('nav-overview')));
    expect(navStore.getState().openGroups.has('overview')).toBe(true);
  });

  it('opens the Cyber Defence Center for a viewer without metrics:view, and hides Dashboards', () => {
    grant = (resource, action) => !(resource === 'metrics' && action === 'view');
    const { onNavigate } = setup({ page: 'cases', open: ['overview'] });
    const row = screen.getByTestId('nav-overview');
    expect(row).toHaveAttribute('href', '#/overview');
    act(() => fireEvent.click(row));
    expect(onNavigate).toHaveBeenCalledWith('overview');
    expect(screen.queryByTestId('nav-dashboards')).toBeNull();
  });

  it('lists Cyber Defence Center, Dashboards and Standup, the first opening the landing page', () => {
    const { onNavigate } = setup({ page: 'cases', open: ['overview'] });
    const pages = within(document.getElementById('nav-group-overview') as HTMLElement).getAllByRole('link');
    expect(pages.map((link) => link.textContent)).toEqual(['Cyber Defence Center', 'Dashboards', 'Standup']);
    expect(pages.map((link) => link.getAttribute('href'))).toEqual(['#/overview', '#/dashboards', '#/standup']);
    act(() => fireEvent.click(pages[0]));
    expect(onNavigate).toHaveBeenCalledWith('overview');
  });

  it('the chevron only shows or hides the pages, never navigates', () => {
    const { onNavigate } = setup({ page: 'cases' });
    const chevron = screen.getByRole('button', { name: 'Show Overview pages' });
    expect(chevron).toHaveAttribute('aria-controls', 'nav-group-overview');
    act(() => fireEvent.click(chevron));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Hide Overview pages' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('a modified click is left to the browser (open in a new tab)', () => {
    const { onNavigate } = setup({ page: 'cases' });
    const row = screen.getByTestId('nav-cases');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('what the navigation highlights (SPEC §2.2 item 9)', () => {
  const highlight: [PageId, string][] = [
    ['overview', 'Cyber Defence Center'],
    ['dashboards', 'Dashboards'],
    ['standup', 'Standup'],
  ];

  it.each(highlight)('labelled drawer, group open: %s marks "%s" and tints the group', (page, label) => {
    setup({ page, open: ['overview'] });
    const markers = currentMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveTextContent(label);
    expect(screen.getByTestId('nav-overview')).toHaveAttribute('data-active-trail', 'true');
  });

  it.each(highlight)('labelled drawer, group closed: %s marks the Overview row', (page) => {
    setup({ page, open: [] });
    expect(currentMarkers()).toEqual([screen.getByTestId('nav-overview')]);
  });

  it.each(highlight)('64 px rail: %s marks the Overview icon', (page) => {
    setup({ page, collapsed: true, open: ['overview'] });
    expect(currentMarkers()).toEqual([screen.getByTestId('nav-overview')]);
  });

  it.each(highlight)('phone sheet: %s opens the group and marks "%s"', (page, label) => {
    setup({ page, variant: 'sheet', open: [] });
    const markers = currentMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveTextContent(label);
  });

  it('marks the Metrics page once: its child while Analytics is open, the group row while closed', () => {
    // The Analytics group has its own id (finding 20), so the row and its Metrics child are
    // two elements with two names; the open group marks the child, which names the page.
    const open = setup({ page: 'metrics', open: ['analytics'] });
    expect(currentMarkers()).toHaveLength(1);
    expect(currentMarkers()[0]).toHaveTextContent(/^Metrics$/);
    expect(screen.getByTestId('nav-analytics')).not.toHaveAttribute('aria-current');
    open.unmount();
    setup({ page: 'metrics', open: [] });
    expect(currentMarkers()).toEqual([screen.getByTestId('nav-analytics')]);
  });
});

describe('keyboard in the 64 px rail', () => {
  it('reaches Settings as the 16th tab stop: the brand, the toggle and 14 destinations', () => {
    setup({ collapsed: true, page: 'cases' });
    const tabbable = Array.from(aside().querySelectorAll<HTMLElement>('a[href], button')).filter(
      (el) => el.tabIndex >= 0 && !el.closest('[aria-hidden="true"]') && !el.closest('[inert]'),
    );
    const names = tabbable.map((el) => el.dataset.testid ?? el.getAttribute('aria-label'));
    expect(names).toEqual([
      'Agentic SOC home',
      'nav-toggle',
      'nav-overview',
      'nav-cases',
      'nav-case_manager',
      'nav-campaigns',
      'nav-logs',
      'nav-chat',
      'nav-approvals',
      'nav-intelligence',
      'nav-analytics',
      'nav-inbox',
      'nav-sources',
      'nav-audit',
      'nav-tuning',
      'nav-settings',
      'nav-docs',
    ]);
    expect(names.indexOf('nav-settings') + 1).toBe(16);
  });

  it('ArrowRight enters a flyout, arrows and End move, Escape returns to the icon', () => {
    setup({ collapsed: true, page: 'cases' });
    const chat = screen.getByTestId('nav-chat');
    act(() => chat.focus());
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    act(() => fireEvent.keyDown(chat, { key: 'ArrowRight' }));
    const links = within(screen.getByTestId('nav-flyout-chat')).getAllByRole('link');
    expect(document.activeElement).toBe(links[0]);
    act(() => fireEvent.keyDown(links[0], { key: 'ArrowDown' }));
    expect(document.activeElement).toBe(links[1]);
    act(() => fireEvent.keyDown(links[1], { key: 'End' }));
    expect(document.activeElement).toBe(links[links.length - 1]);
    act(() => fireEvent.keyDown(links[links.length - 1], { key: 'Escape' }));
    expect(flyouts()).toHaveLength(0);
    expect(document.activeElement).toBe(chat);
    raf.mockRestore();
  });

  it('Tab from inside a flyout moves on to the next rail destination', () => {
    setup({ collapsed: true, page: 'cases' });
    const chat = screen.getByTestId('nav-chat');
    act(() => chat.focus());
    const first = within(screen.getByTestId('nav-flyout-chat')).getAllByRole('link')[0];
    act(() => first.focus());
    act(() => fireEvent.keyDown(first, { key: 'Tab' }));
    expect(document.activeElement).toBe(screen.getByTestId('nav-approvals'));
    expect(flyouts()).toHaveLength(0);
  });

  it('Space on a grouped icon does what a click does (opens its page)', () => {
    const { onNavigate } = setup({ collapsed: true, page: 'cases' });
    const analytics = screen.getByTestId('nav-analytics');
    act(() => fireEvent.keyDown(analytics, { key: ' ' }));
    expect(onNavigate).toHaveBeenCalledWith('metrics');
  });
});

describe('destinations', () => {
  it('shows one Runbooks destination and no retired one', () => {
    setup({ page: 'cases', open: ['intelligence'] });
    const intelligence = within(document.getElementById('nav-group-intelligence') as HTMLElement);
    expect(intelligence.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Knowledge corpus',
      'Runbooks',
      'Operator memory',
      'Agent personas',
    ]);
    expect(screen.queryByTestId('nav-playbooks')).toBeNull();
  });

  it('draws Notifications as a plain destination (no chevron) and names the Help Center', () => {
    setup({ page: 'cases' });
    expect(screen.queryByRole('button', { name: /Notifications pages/ })).toBeNull();
    expect(screen.getByTestId('nav-inbox')).toHaveAttribute('href', '#/inbox');
    expect(within(screen.getByTestId('nav-footer')).getByRole('link', { name: 'Help Center' })).toBeInTheDocument();
  });

  it('gives a group that repeats its one item a hairline, not a heading', () => {
    setup({ page: 'cases' });
    const nav = screen.getByRole('navigation', { name: 'Console destinations' });
    // Triage and Platform name themselves; Intelligence, Analytics and Notifications do not.
    expect(within(nav).getByText('Triage')).toBeInTheDocument();
    expect(within(nav).getByText('Platform')).toBeInTheDocument();
    expect(nav.querySelectorAll('[id^="nav-heading-"]')).toHaveLength(2);
    expect(within(nav).getByRole('list', { name: 'Triage' })).toBeInTheDocument();
  });

  it('carries no em dash and never the retired word in its copy', () => {
    setup({ page: 'cases', open: ['overview', 'chat', 'intelligence', 'analytics', 'settings'] });
    const text = aside().textContent ?? '';
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/playbook/i);
  });

  it('is axe-clean in the drawer, the rail with a flyout open, and the phone sheet', async () => {
    const drawer = setup({ page: 'standup', open: ['overview'] });
    expect(await axe(drawer.container)).toHaveNoViolations();
    drawer.unmount();
    const rail = setup({ page: 'standup', collapsed: true });
    act(() => screen.getByTestId('nav-overview').focus());
    expect(await axe(rail.container)).toHaveNoViolations();
    rail.unmount();
    const sheet = setup({ page: 'standup', variant: 'sheet' });
    expect(await axe(sheet.container)).toHaveNoViolations();
  });
});

describe('reduced motion', () => {
  it('marks the panel so layout changes are instant and fades are opacity only', () => {
    window.localStorage.setItem('soc.nav.collapsed', '0');
    navStore.beginSession();
    render(<NavSidebar page="cases" onNavigate={vi.fn()} reducedMotion />);
    expect(aside()).toHaveAttribute('data-reduced-motion', 'true');
    expect(aside()).toHaveClass('nav-root');
  });
});

describe('switching between flyouts (SPEC §4.8.1 "Flyouts")', () => {
  it('switches to a neighbour after a 120 ms rest once one is open, one flyout throughout', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    const analytics = screen.getByTestId('nav-analytics');
    const intelligence = screen.getByTestId('nav-intelligence');
    fireEvent.pointerMove(analytics, { clientX: 30, clientY: 400 });
    act(() => vi.advanceTimersByTime(NAV_REST_MS));
    expect(screen.getByTestId('nav-flyout-analytics')).toBeInTheDocument();
    fireEvent.pointerLeave(analytics, { clientX: 30, clientY: 380 });
    fireEvent.pointerMove(intelligence, { clientX: 30, clientY: 360 });
    act(() => vi.advanceTimersByTime(NAV_SWITCH_REST_MS - 1));
    expect(flyouts()).toHaveLength(1);
    expect(screen.getByTestId('nav-flyout-analytics')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(flyouts()).toHaveLength(1);
    expect(screen.getByTestId('nav-flyout-intelligence')).toBeInTheDocument();
  });

  it('a neighbour crossed inside the safe triangle never steals the open flyout', () => {
    vi.useFakeTimers();
    navStore.beginSession();
    registerTrigger('a', document.createElement('a'));
    registerTrigger('b', document.createElement('a'));
    const panel = document.createElement('div');
    panel.getBoundingClientRect = () =>
      ({ left: 72, right: 296, top: 100, bottom: 300, width: 224, height: 200, x: 72, y: 100, toJSON: () => ({}) }) as DOMRect;
    registerPanel(panel);
    openFlyout('a');
    // Leaving A toward its flyout, the pointer crosses B on the way.
    pointerLeftTrigger('a', { x: 56, y: 200 });
    pointerOverTrigger('b', { x: 60, y: 210 });
    act(() => vi.advanceTimersByTime(NAV_SWITCH_REST_MS));
    expect(navStore.getState().flyout).toBe('a');
    act(() => vi.advanceTimersByTime(NAV_SWITCH_REST_MS));
    expect(navStore.getState().flyout).toBe('a');
    // Out of the triangle (resting on B, away from the flyout): B takes over.
    pointerTrack({ x: 30, y: 420 });
    act(() => vi.advanceTimersByTime(NAV_SWITCH_REST_MS));
    expect(navStore.getState().flyout).toBe('b');
    // The grace close armed when A was left does not close B.
    act(() => vi.advanceTimersByTime(NAV_GRACE_MS));
    expect(navStore.getState().flyout).toBe('b');
  });

  it('pointInTriangle includes the edges; safeTriangle runs from the leave point to the flyout edge', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    const c = { x: 0, y: 10 };
    expect(pointInTriangle({ x: 2, y: 2 }, a, b, c)).toBe(true);
    expect(pointInTriangle({ x: 0, y: 5 }, a, b, c)).toBe(true);
    expect(pointInTriangle({ x: 8, y: 8 }, a, b, c)).toBe(false);
    expect(pointInTriangle({ x: -1, y: 1 }, a, b, c)).toBe(false);
    const safe = safeTriangle({ x: 56, y: 200 }, { left: 72, top: 100, bottom: 300 });
    expect(safe({ x: 60, y: 200 })).toBe(true);
    expect(safe({ x: 72, y: 110 })).toBe(true);
    expect(safe({ x: 72, y: 290 })).toBe(true);
    expect(safe({ x: 60, y: 120 })).toBe(false);
    expect(safe({ x: 40, y: 200 })).toBe(false);
    expect(safe({ x: 80, y: 200 })).toBe(false);
  });

  it('clamps the flyout inside the viewport, 8 px from either edge', () => {
    setup({ collapsed: true, page: 'cases' });
    const height = 180;
    const offset = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height);
    const overview = screen.getByTestId('nav-overview');
    const rectAt = (top: number) => () =>
      ({ top, bottom: top + 36, left: 8, right: 56, width: 48, height: 36, x: 8, y: top, toJSON: () => ({}) }) as DOMRect;

    overview.getBoundingClientRect = rectAt(window.innerHeight - 20);
    act(() => overview.focus());
    const panel = screen.getByTestId('nav-flyout-overview');
    // Fixed to the viewport, outside the clipping layer, so nothing clips or scrolls it.
    expect(panel).toHaveClass('fixed');
    expect(panel.closest('.nav-clip')).toBeNull();
    expect(parseFloat(panel.style.top)).toBe(window.innerHeight - height - 8);

    act(() => overview.blur());
    expect(flyouts()).toHaveLength(0);
    overview.getBoundingClientRect = rectAt(0);
    act(() => overview.focus());
    expect(parseFloat(screen.getByTestId('nav-flyout-overview').style.top)).toBe(8);
    offset.mockRestore();
  });

  it('keeps the pinned Help Center labelled and current in the collapsed rail', () => {
    setup({ collapsed: true, page: 'docs' });
    const docs = screen.getByTestId('nav-docs');
    expect(docs).toHaveAccessibleName('Help Center');
    expect(within(screen.getByTestId('nav-footer')).getByRole('link', { name: 'Help Center' })).toBe(docs);
    expect(currentMarkers()).toEqual([docs]);
  });

  it('keeps the flyout inside the navigation landmark', () => {
    setup({ collapsed: true, page: 'standup' });
    act(() => screen.getByTestId('nav-overview').focus());
    expect(landmark()).toContainElement(screen.getByTestId('nav-flyout-overview'));
  });
});

describe('content on hover or focus (WCAG 2.2 SC 1.4.13)', () => {
  const escape = (target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };

  it('Escape dismisses a keyboard tooltip without moving focus; it returns once focus moves', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    const cases = screen.getByTestId('nav-cases');
    act(() => cases.focus());
    expect(tips()).toHaveLength(1);
    expect(escape(cases).defaultPrevented).toBe(true);
    expect(tips()).toHaveLength(0);
    expect(document.activeElement).toBe(cases);
    // A pointer rest on the same icon does not bring it back while focus stays.
    fireEvent.pointerMove(cases, { clientX: 30, clientY: 120 });
    act(() => vi.advanceTimersByTime(RAIL_TIP_REST_MS * 2));
    expect(tips()).toHaveLength(0);
    act(() => screen.getByTestId('nav-logs').focus());
    expect(screen.getByTestId('nav-rail-tip')).toHaveTextContent('Logs');
    act(() => cases.focus());
    expect(screen.getByTestId('nav-rail-tip')).toHaveTextContent('Cases');
  });

  it('Escape dismisses a pointer tooltip wherever focus is; it returns after the pointer leaves', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    const cases = screen.getByTestId('nav-cases');
    fireEvent.pointerMove(cases, { clientX: 30, clientY: 120 });
    act(() => vi.advanceTimersByTime(RAIL_TIP_REST_MS));
    expect(tips()).toHaveLength(1);
    expect(escape().defaultPrevented).toBe(true);
    expect(tips()).toHaveLength(0);
    fireEvent.pointerMove(cases, { clientX: 34, clientY: 126 });
    act(() => vi.advanceTimersByTime(RAIL_TIP_REST_MS * 2));
    expect(tips()).toHaveLength(0);
    fireEvent.pointerLeave(cases, { clientX: 120, clientY: 126 });
    fireEvent.pointerMove(cases, { clientX: 30, clientY: 120 });
    act(() => vi.advanceTimersByTime(RAIL_TIP_REST_MS));
    expect(tips()).toHaveLength(1);
  });

  it('leaves Escape to the page when no tooltip or flyout is showing', () => {
    setup({ collapsed: true });
    expect(escape().defaultPrevented).toBe(false);
  });

  it('the tooltip is hoverable: it stays while the pointer is over it and goes once it leaves both', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    const cases = screen.getByTestId('nav-cases');
    fireEvent.pointerMove(cases, { clientX: 30, clientY: 120 });
    act(() => vi.advanceTimersByTime(RAIL_TIP_REST_MS));
    const tip = screen.getByTestId('nav-rail-tip');
    // The panel around it passes the pointer through, so the tooltip takes it back.
    expect(tip).toHaveClass('pointer-events-auto');
    // Crossing from the icon onto the tooltip.
    fireEvent.pointerLeave(cases, { clientX: 57, clientY: 120 });
    act(() => vi.advanceTimersByTime(RAIL_TIP_GRACE_MS - 1));
    expect(tips()).toHaveLength(1);
    fireEvent.pointerEnter(tip);
    act(() => vi.advanceTimersByTime(2_000));
    expect(tips()).toHaveLength(1);
    fireEvent.pointerLeave(tip);
    act(() => vi.advanceTimersByTime(RAIL_TIP_GRACE_MS));
    expect(tips()).toHaveLength(0);
  });

  it('Escape closes a flyout the pointer opened, wherever focus is; it stays closed until the pointer leaves', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    const analytics = screen.getByTestId('nav-analytics');
    fireEvent.pointerMove(analytics, { clientX: 30, clientY: 300 });
    act(() => vi.advanceTimersByTime(NAV_REST_MS));
    expect(flyouts()).toHaveLength(1);
    expect(escape().defaultPrevented).toBe(true);
    expect(flyouts()).toHaveLength(0);
    fireEvent.pointerMove(analytics, { clientX: 34, clientY: 306 });
    act(() => vi.advanceTimersByTime(NAV_REST_MS * 2));
    expect(flyouts()).toHaveLength(0);
    fireEvent.pointerLeave(analytics, { clientX: 30, clientY: 360 });
    fireEvent.pointerMove(analytics, { clientX: 30, clientY: 300 });
    act(() => vi.advanceTimersByTime(NAV_REST_MS));
    expect(flyouts()).toHaveLength(1);
  });

  it('Escape on a grouped icon closes its keyboard flyout, which stays closed while focus stays', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    const analytics = screen.getByTestId('nav-analytics');
    act(() => analytics.focus());
    expect(flyouts()).toHaveLength(1);
    act(() => fireEvent.keyDown(analytics, { key: 'Escape' }));
    expect(flyouts()).toHaveLength(0);
    expect(document.activeElement).toBe(analytics);
    fireEvent.pointerMove(analytics, { clientX: 30, clientY: 300 });
    act(() => vi.advanceTimersByTime(NAV_REST_MS * 2));
    expect(flyouts()).toHaveLength(0);
  });
});

describe('a state switch from anywhere (the toggle, the strip or the shell Ctrl+B)', () => {
  it('cancels a pending flyout rest: nothing opens over the drawer', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    fireEvent.pointerMove(screen.getByTestId('nav-analytics'), { clientX: 30, clientY: 300 });
    act(() => vi.advanceTimersByTime(100));
    // What the shell's Ctrl+B handler runs (it never goes through the toggle).
    act(() => navStore.toggleCollapsed());
    act(() => vi.advanceTimersByTime(NAV_REST_MS * 2));
    expect(aside()).toHaveAttribute('data-nav-state', 'expanded');
    expect(navStore.getState().flyout).toBeNull();
    expect(flyouts()).toHaveLength(0);
  });

  it('cancels a pending tooltip rest too', () => {
    vi.useFakeTimers();
    setup({ collapsed: true });
    fireEvent.pointerMove(screen.getByTestId('nav-cases'), { clientX: 30, clientY: 120 });
    act(() => vi.advanceTimersByTime(100));
    act(() => navStore.toggleCollapsed());
    act(() => vi.advanceTimersByTime(RAIL_TIP_REST_MS * 2));
    expect(tips()).toHaveLength(0);
  });

  it('never draws a flyout over the labelled drawer', () => {
    setup({ collapsed: false });
    act(() => navStore.setFlyout('analytics', 120));
    expect(flyouts()).toHaveLength(0);
  });

  it('collapsing hands focus from a chevron or a group page to the group row, never to <body>', () => {
    setup({ page: 'standup', open: ['overview'] });
    const overview = screen.getByTestId('nav-overview');
    act(() => screen.getByRole('button', { name: 'Hide Overview pages' }).focus());
    act(() => navStore.toggleCollapsed());
    expect(document.activeElement).toBe(overview);
    expect(overview.closest('[inert]')).toBeNull();
    expect(flyouts()).toHaveLength(0);

    act(() => navStore.toggleCollapsed());
    act(() => screen.getByTestId('nav-standup').focus());
    act(() => navStore.toggleCollapsed());
    expect(document.activeElement).toBe(overview);
    expect(flyouts()).toHaveLength(0);
  });

  it('leaves focus where it is when that element stays (a row, the toggle)', () => {
    setup({ page: 'cases' });
    const cases = screen.getByTestId('nav-cases');
    act(() => cases.focus());
    act(() => navStore.toggleCollapsed());
    expect(document.activeElement).toBe(cases);
  });
});

describe('the phone sheet saves the groups it shows', () => {
  it('hiding the current group the sheet opened stores it closed, never open', () => {
    setup({ page: 'standup', variant: 'sheet', open: [] });
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Hide Overview pages' })));
    expect(navStore.getState().openGroups.has('overview')).toBe(false);
    expect(putUser).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Show Overview pages' })).toHaveAttribute('aria-expanded', 'false');
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Show Overview pages' })));
    expect(navStore.getState().openGroups.has('overview')).toBe(true);
    expect(putUser).toHaveBeenLastCalledWith({ misc: { nav_open_groups: ['overview'] } });
  });

  it('hiding a group the store has open closes it in both', () => {
    setup({ page: 'cases', variant: 'sheet', open: ['analytics'] });
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Hide Analytics pages' })));
    expect(navStore.getState().openGroups.has('analytics')).toBe(false);
    expect(putUser).toHaveBeenLastCalledWith({ misc: { nav_open_groups: [] } });
  });
});

describe('the click strip and the rail scrollbar', () => {
  const css = readFileSync(path.resolve(process.cwd(), 'src/styles/nav.css'), 'utf8');

  it('sits just past the panel edge, outside the clipping layer and the scroller', () => {
    setup();
    const strip = screen.getByTestId('nav-strip');
    expect(strip.closest('.nav-clip')).toBeNull();
    expect(strip.closest('.nav-scroll')).toBeNull();
    expect(strip).toHaveClass('left-60', 'w-1.5', 'pointer-events-auto');
    expect(aside().querySelector('.nav-clip')).toHaveClass('left-0', 'w-60');
  });

  it('moves with the visible edge, and the rail scroller is as wide as the rail (styles/nav.css)', () => {
    expect(css).toMatch(
      /\.nav-root\[data-nav-state='collapsed'\] \.nav-clip,\s*\.nav-root\[data-nav-state='collapsed'\] \.nav-strip \{\s*transform: translate3d\(-176px, 0, 0\);/,
    );
    expect(css).toMatch(/\.nav-root\[data-nav-state='collapsed'\] \.nav-scroll \{\s*margin-right: 176px;/);
  });
});

describe('forced colours (Windows high contrast)', () => {
  const css = readFileSync(path.resolve(process.cwd(), 'src/styles/nav.css'), 'utf8');
  const bareOutline = (root: ParentNode) =>
    Array.from(root.querySelectorAll<HTMLElement>('a, button')).filter((el) =>
      el.className.split(/\s+/).includes('outline-none'),
    );

  it('no navigation control drops its outline outside focus-visible (forced colours paint it)', () => {
    setup({ page: 'standup', open: ['overview', 'analytics'] });
    expect(bareOutline(aside())).toEqual([]);
    for (const id of ['nav-overview', 'nav-standup', 'nav-toggle']) {
      expect(screen.getByTestId(id)).toHaveClass('focus-visible:outline-none');
    }
  });

  it('marks the visible current pill for an outline: the page, the closed group, the flyout', () => {
    const open = setup({ page: 'standup', open: ['overview'] });
    let marked = aside().querySelectorAll('.nav-tint[data-active]');
    expect(marked).toHaveLength(1);
    expect(screen.getByTestId('nav-standup')).toContainElement(marked[0] as HTMLElement);
    open.unmount();

    const closed = setup({ page: 'standup', open: [] });
    marked = aside().querySelectorAll('.nav-tint[data-active]');
    expect(Array.from(marked).every((el) => screen.getByTestId('nav-overview').contains(el))).toBe(true);
    expect(marked.length).toBeGreaterThan(0);
    closed.unmount();

    setup({ page: 'standup', collapsed: true });
    act(() => screen.getByTestId('nav-overview').focus());
    const flyoutCurrent = within(screen.getByTestId('nav-flyout-overview')).getByRole('link', { name: 'Standup' });
    expect(flyoutCurrent.querySelector('.nav-tint[data-active]')).not.toBeNull();
    expect(bareOutline(screen.getByTestId('nav-flyout-overview'))).toEqual([]);
  });

  it('draws that pill as a system Highlight outline (styles/nav.css)', () => {
    expect(css).toMatch(/@media \(forced-colors: active\) \{\s*\.nav-tint\[data-active\] \{\s*outline: 2px solid Highlight;/);
  });
});
