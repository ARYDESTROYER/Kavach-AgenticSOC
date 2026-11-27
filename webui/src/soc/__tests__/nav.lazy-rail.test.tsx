/**
 * The collapsed rail's interaction layer is a lazy chunk (Round 14, SPEC §3.4 and §4.8.1;
 * `components/nav-rail-loader.ts`). These tests pin what first paint and the first
 * interaction look like before it has loaded:
 *
 *   - the rail paints complete without it: every row, the toggle, and the grouped icons'
 *     aria-haspopup / aria-expanded / aria-controls, with no flyout and no tooltip;
 *   - navigation and the toggle work before it loads;
 *   - the first pointer move or focus on the rail loads it, and that first interaction is
 *     not lost: keyboard focus on a plain icon shows its tooltip, keyboard focus on a
 *     grouped icon opens its flyout beside the icon, a pointer resting on a grouped icon
 *     opens its flyout after the 300 ms rest, all once the handlers are attached;
 *   - a control the pointer or focus has already left is never replayed, and a press
 *     before it lands acts as a press does once loaded (no tooltip; on a grouped icon, no
 *     flyout until the pointer leaves);
 *   - once loaded, the root's primers are gone (they remember nothing more);
 *   - a failed load is retried on a later interaction after a pause, never on every
 *     pointer move;
 *   - the phone sheet never loads it (it has no tooltips and no flyouts);
 *   - the desktop rail warms it into the HTTP cache once the browser is idle (one idle
 *     callback, cancelled on unmount; the phone sheet schedules none).
 *
 * The behaviour once loaded is pinned in nav.behaviour.test.tsx.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// jsdom has no PointerEvent: a MouseEvent subclass carries clientX and clientY, as a
// browser's PointerEvent does (the replay dispatches the same class).
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

vi.mock('../auth', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../prefs', () => ({ usePrefs: () => ({ prefs: { misc: {} }, ready: true }) }));
vi.mock('@/lib/api', () => ({ api: { prefs: { putUser: () => Promise.resolve({}) } } }));

import { NavSidebar } from '../components/NavSidebar';
import {
  RAIL_RETRY_PAUSE_MS,
  loadRailInteractions,
  railLayerSource,
  replayFirstInteraction,
  resetRailInteractions,
} from '../components/nav-rail-loader';
import { resetNavHoverIntent } from '../components/nav-hover-intent';
import { resetRailTip } from '../components/nav-rail-tip';
import { navStore } from '../nav-store';

function setup({ collapsed = true, variant = 'rail' as 'rail' | 'sheet' } = {}) {
  window.localStorage.setItem('soc.nav.collapsed', collapsed ? '1' : '0');
  window.localStorage.setItem('soc.nav.openGroups', '[]');
  navStore.beginSession();
  const onNavigate = vi.fn();
  return { onNavigate, ...render(<NavSidebar page="cases" onNavigate={onNavigate} variant={variant} />) };
}

const flyouts = () => document.querySelectorAll('[data-testid^="nav-flyout-"]');
const tips = () => document.querySelectorAll('[data-testid="nav-rail-tip"]');
const aside = () => screen.getByRole('complementary', { name: 'Primary navigation' });
/** Let the dynamic import settle and React commit what it triggers. */
const settle = () => act(async () => {
  await loadRailInteractions();
  await Promise.resolve();
});

beforeEach(() => {
  window.localStorage.clear();
  resetRailInteractions();
  resetNavHoverIntent();
  resetRailTip();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('first paint without the rail layer', () => {
  it('paints every row, the toggle and the disclosure attributes, with no flyout and no tooltip', () => {
    setup();
    expect(aside()).toHaveAttribute('data-nav-state', 'collapsed');
    expect(screen.getByTestId('nav-toggle')).toHaveAccessibleName('Expand navigation');
    for (const id of ['overview', 'cases', 'chat', 'settings', 'docs']) expect(screen.getByTestId(`nav-${id}`)).toBeInTheDocument();
    const intelligence = screen.getByTestId('nav-intelligence');
    expect(intelligence).toHaveAttribute('aria-haspopup', 'true');
    expect(intelligence).toHaveAttribute('aria-expanded', 'false');
    expect(intelligence).toHaveAttribute('aria-controls', 'nav-fly-intelligence');
    expect(flyouts()).toHaveLength(0);
    expect(tips()).toHaveLength(0);
  });

  it('navigates and toggles before the layer has loaded', () => {
    const { onNavigate } = setup();
    fireEvent.click(screen.getByTestId('nav-intelligence'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    act(() => fireEvent.click(screen.getByTestId('nav-toggle')));
    expect(aside()).toHaveAttribute('data-nav-state', 'expanded');
  });

  it('never loads the layer for the phone sheet', async () => {
    const source = vi.spyOn(railLayerSource, 'load');
    setup({ collapsed: false, variant: 'sheet' });
    const cases = screen.getByTestId('nav-cases');
    fireEvent.pointerMove(cases, { clientX: 30, clientY: 120 });
    act(() => cases.focus());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // No primer starts a load from the sheet (and the idle warm skips it, below).
    expect(source).not.toHaveBeenCalled();
    expect(flyouts()).toHaveLength(0);
    expect(tips()).toHaveLength(0);
  });
});

describe('the first interaction loads the layer and is not lost', () => {
  it('keyboard focus on a plain icon shows its tooltip once the layer lands', async () => {
    setup();
    act(() => screen.getByTestId('nav-cases').focus());
    await waitFor(() => expect(screen.getByTestId('nav-rail-tip')).toHaveTextContent('Cases'));
  });

  it('keyboard focus on a grouped icon opens its flyout once the layer lands', async () => {
    setup();
    act(() => screen.getByTestId('nav-intelligence').focus());
    await waitFor(() => expect(screen.getByTestId('nav-flyout-intelligence')).toBeInTheDocument());
    expect(screen.getByTestId('nav-intelligence')).toHaveAttribute('aria-expanded', 'true');
  });

  it('a flyout opened by that first focus sits beside its icon, not at the top of the window', async () => {
    // The replay runs in the rail's layout effect, in the commit that attaches the handlers:
    // the grouped icon must already be registered then, or the flyout is placed at top 0.
    setup();
    const intelligence = screen.getByTestId('nav-intelligence');
    vi.spyOn(intelligence, 'getBoundingClientRect').mockReturnValue(
      { top: 300, bottom: 336, height: 36, left: 12, right: 52, width: 40, x: 12, y: 300, toJSON: () => ({}) } as DOMRect,
    );
    act(() => intelligence.focus());
    const flyout = await screen.findByTestId('nav-flyout-intelligence');
    expect(navStore.getState().flyoutTop).toBe(300);
    // jsdom lays out nothing: the flyout's height falls back to 200 and the window is 768
    // tall, so it sits 8 px above its icon's top (292), well clear of the 8 px floor.
    await waitFor(() => expect(flyout.style.top).toBe('292px'));
    expect(flyout.style.visibility).toBe('');
  });

  it('a pointer that comes to rest on a grouped icon before the layer lands opens its flyout after the rest', async () => {
    setup();
    fireEvent.pointerMove(screen.getByTestId('nav-intelligence'), { clientX: 30, clientY: 300 });
    await settle();
    // The rest clock starts when the handlers are attached: nothing yet.
    expect(flyouts()).toHaveLength(0);
    await waitFor(() => expect(flyouts()).toHaveLength(1), { timeout: 2_000 });
    expect(tips()).toHaveLength(0);
  });

  it('a pointer resting on a plain icon gets its tooltip after the rest', async () => {
    setup();
    fireEvent.pointerMove(screen.getByTestId('nav-cases'), { clientX: 30, clientY: 120 });
    await settle();
    await waitFor(() => expect(screen.getByTestId('nav-rail-tip')).toHaveTextContent('Cases'), { timeout: 2_000 });
  });

  it('a press on a grouped icon before the layer lands navigates and keeps its flyout away until the pointer leaves', async () => {
    const { onNavigate } = setup();
    const intelligence = screen.getByTestId('nav-intelligence');
    fireEvent.pointerMove(intelligence, { clientX: 30, clientY: 300 });
    fireEvent.pointerDown(intelligence, { button: 0, clientX: 30, clientY: 300 });
    fireEvent.click(intelligence);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    await settle();
    // At rest, and after a small move on the same icon: no flyout (as with the layer loaded).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    fireEvent.pointerMove(intelligence, { clientX: 31, clientY: 301 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(flyouts()).toHaveLength(0);
    // Once the pointer has left the icon, a later rest opens it again.
    fireEvent.pointerLeave(intelligence, { clientX: 200, clientY: 300 });
    fireEvent.pointerMove(intelligence, { clientX: 30, clientY: 300 });
    await waitFor(() => expect(flyouts()).toHaveLength(1), { timeout: 2_000 });
  });

  it('a press on a plain icon before the layer lands cancels its pending tooltip', async () => {
    setup();
    const cases = screen.getByTestId('nav-cases');
    fireEvent.pointerMove(cases, { clientX: 30, clientY: 120 });
    fireEvent.pointerDown(cases, { button: 0, clientX: 30, clientY: 120 });
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(tips()).toHaveLength(0);
  });

  it('forgets a control the pointer has left before the layer lands', async () => {
    setup();
    const cases = screen.getByTestId('nav-cases');
    fireEvent.pointerMove(cases, { clientX: 30, clientY: 120 });
    fireEvent.pointerOut(cases, { relatedTarget: document.body });
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(tips()).toHaveLength(0);
    expect(flyouts()).toHaveLength(0);
  });

  it('forgets a control that lost focus before the layer lands', async () => {
    setup();
    const intelligence = screen.getByTestId('nav-intelligence');
    act(() => intelligence.focus());
    act(() => intelligence.blur());
    await settle();
    expect(flyouts()).toHaveLength(0);
    expect(tips()).toHaveLength(0);
  });

  it('attaches the handlers for good once loaded (the root primers are gone)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    fireEvent.pointerMove(aside(), { clientX: 200, clientY: 10 });
    await settle();
    // A primer still on the root would remember this control, and a replay would send it
    // the move again: nothing is remembered, so nothing is replayed.
    const cases = screen.getByTestId('nav-cases');
    fireEvent.pointerMove(cases, { clientX: 30, clientY: 120 });
    const dispatched = vi.spyOn(cases, 'dispatchEvent');
    replayFirstInteraction();
    expect(dispatched).not.toHaveBeenCalled();
    // A later rest behaves exactly as in nav.behaviour.test.tsx.
    act(() => vi.advanceTimersByTime(299));
    expect(tips()).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(tips()).toHaveLength(1);
    // Focus is not remembered either.
    const chat = screen.getByTestId('nav-chat');
    act(() => chat.focus());
    const focusDispatched = vi.spyOn(chat, 'dispatchEvent');
    replayFirstInteraction();
    expect(focusDispatched).not.toHaveBeenCalled();
  });
});

describe('a failed load', () => {
  it('is retried on a later interaction after a pause, never on every pointer move', async () => {
    // The clock moves only when the test says so (plus real time); timers stay real, so the
    // retry's import and the rest that follows run as they do in a browser.
    const realNow = Date.now.bind(Date);
    let skipped = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skipped);
    const source = vi.spyOn(railLayerSource, 'load').mockRejectedValueOnce(new Error('Failed to fetch'));
    const { onNavigate } = setup();
    const cases = screen.getByTestId('nav-cases');
    const sweep = async () => {
      for (let i = 0; i < 50; i += 1) fireEvent.pointerMove(cases, { clientX: 30, clientY: 110 + (i % 20) });
      // Let an attempt that started settle.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };

    await sweep();
    expect(source).toHaveBeenCalledTimes(1);
    expect(tips()).toHaveLength(0);
    // Halfway through the pause: moves and focus start nothing, and the rail still navigates.
    skipped += RAIL_RETRY_PAUSE_MS / 2;
    await sweep();
    act(() => screen.getByTestId('nav-intelligence').focus());
    expect(source).toHaveBeenCalledTimes(1);
    fireEvent.click(cases);
    expect(onNavigate).toHaveBeenCalledWith('cases');

    // Once the pause has passed, the next move tries again; it loads, and the pointer
    // resting on Cases gets its tooltip.
    skipped += RAIL_RETRY_PAUSE_MS / 2;
    act(() => screen.getByTestId('nav-intelligence').blur());
    // (Never settle() here: it would load the layer itself, not through the interaction.)
    fireEvent.pointerMove(cases, { clientX: 30, clientY: 120 });
    expect(source).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId('nav-rail-tip')).toHaveTextContent('Cases'), { timeout: 2_000 });
  });

  it('pauses longer after each further failure, up to a minute', async () => {
    const realNow = Date.now.bind(Date);
    let skipped = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skipped);
    const source = vi.spyOn(railLayerSource, 'load').mockRejectedValue(new Error('Failed to fetch'));
    setup();
    const cases = screen.getByTestId('nav-cases');
    const move = async () => {
      fireEvent.pointerMove(cases, { clientX: 30, clientY: 120 });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    await move();
    expect(source).toHaveBeenCalledTimes(1);
    // 5 s, then 10 s, 20 s, 40 s, then 60 s each time.
    for (const [pause, calls] of [
      [5_000, 2],
      [10_000, 3],
      [20_000, 4],
      [40_000, 5],
      [60_000, 6],
      [60_000, 7],
    ] as const) {
      skipped += pause - 1_000;
      await move();
      expect(source).toHaveBeenCalledTimes(calls - 1);
      skipped += 1_000;
      await move();
      expect(source).toHaveBeenCalledTimes(calls);
    }
  });
});

describe('the idle warm', () => {
  // jsdom has no requestIdleCallback; each test installs a recording one and restores what
  // was there (undefined) afterwards.
  const original = { request: window.requestIdleCallback, cancel: window.cancelIdleCallback };
  const install = (key: 'requestIdleCallback' | 'cancelIdleCallback', value: unknown) =>
    Object.defineProperty(window, key, { configurable: true, writable: true, value });
  let request = vi.fn<[() => void, { timeout: number }?], number>();
  let cancel = vi.fn<[number], void>();

  beforeEach(() => {
    request = vi.fn<[() => void, { timeout: number }?], number>(() => 7);
    cancel = vi.fn<[number], void>();
    install('requestIdleCallback', request);
    install('cancelIdleCallback', cancel);
  });

  afterEach(() => {
    install('requestIdleCallback', original.request);
    install('cancelIdleCallback', original.cancel);
  });

  it('schedules one idle prefetch for the desktop rail and cancels it on unmount', () => {
    const { unmount } = setup();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual({ timeout: 15_000 });
    // Unbuilt (tests, the dev server) the chunk list mark stays, so the warm adds no link
    // and loads nothing: a prefetch only fills the HTTP cache of a built Console.
    act(() => request.mock.calls[0][0]());
    expect(document.head.querySelector('link[rel="prefetch"]')).toBeNull();
    expect(flyouts()).toHaveLength(0);
    expect(tips()).toHaveLength(0);
    unmount();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('never warms for the phone sheet', () => {
    setup({ collapsed: false, variant: 'sheet' });
    expect(request).not.toHaveBeenCalled();
  });
});
