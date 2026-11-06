/**
 * AppShell top-nav search trigger (Round-7 W0.10 / #7).
 *
 * The old compact Cmd-K "Search" outline button was replaced by a WIDE, input-styled
 * trigger that spans the top bar and opens the command palette, plus a `sm:hidden`
 * ghost icon opener for the narrowest widths. Both open the SAME palette that Cmd-K
 * toggles. These tests assert:
 *   - clicking the wide trigger (by its accessible name) opens the palette (the
 *     CommandInput placeholder appears — Radix only portals the Dialog when open);
 *   - the compact mobile opener opens the same palette;
 *   - the two openers carry DISTINCT accessible names (jsdom ignores the responsive
 *     visibility classes, so both are in the tree — disambiguated by name).
 *
 * The api client + every provider the shell consumes (theme/prefs/auth/demo/router)
 * are supplied with mocked load-time calls so the test is fully offline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {
      status: number;
      body: unknown;
      constructor(status = 0, message = '', body: unknown = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
      }
    },
    api: {
      // Generic verbs used by the NotificationBell inbox helpers.
      get: ok({ unread: 0, items: [] }),
      post: ok({ ok: true }),
      put: ok({}),
      del: ok({}),
      // Provider load-time calls (auth/prefs/theme/demo) + shell health poll.
      auth: { me: ok({ auth_enabled: false, authenticated: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
      getBranding: ok({
        org_name: '', product_name: '', logo_data_url: '', favicon_data_url: '',
        accent_color: '', accent_color2: '', theme: '', login_subtitle: '',
      }),
      prefs: {
        effective: ok({
          terminology: {}, theme_mode: 'dark', saved_views: [], pinned_view_ids: [],
          tables: {}, last_list_state: {}, misc: {},
          org: { terminology: {}, default_theme: 'dark', default_saved_views: [], default_pinned_view_ids: [] },
        }),
        putUser: ok({}),
      },
      demo: { status: ok({ mode: 'off', active: false, run_id: null }), enable: ok({}) },
      health: ok({ es_connected: true, store_type: 'memory', version: 'test' }),
      account: { get: ok({}) },
      // Remote palette search — only fires when the palette is open + a term is typed;
      // provided so a stray call never rejects.
      search: ok({ query: '', cases: [], sources: [], nav: [] }),
    },
  };
});

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { AppShell } from '../AppShell';
import { clearChatActivity, putChatActivity } from '../chat-activity/activity';
import type { PageId } from '../nav';

const WIDE_TRIGGER = 'Search cases, sources, and actions';
const MOBILE_OPENER = 'Open search';
const PALETTE_INPUT = /search cases, sources, settings/i;

function setMobileViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes('max-width') ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
}

function renderShell(onNavigate = vi.fn(), page: PageId = 'overview') {
  const result = render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <AppShell page={page} onNavigate={onNavigate}>
                  <div>routed content</div>
                </AppShell>
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
  return { ...result, onNavigate };
}

describe('AppShell top-nav search (W0.10)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setMobileViewport(false);
  });

  it('renders both openers with DISTINCT accessible names', async () => {
    renderShell();
    const wide = await screen.findByRole('button', { name: WIDE_TRIGGER });
    const mobile = await screen.findByRole('button', { name: MOBILE_OPENER });
    expect(wide).toBeInTheDocument();
    expect(mobile).toBeInTheDocument();
    // The visible placeholder is decorative; the accessible name comes from aria-label.
    expect(wide).toHaveTextContent(/Search cases, sources, actions/);
  });

  it('the palette is closed until an opener is clicked', async () => {
    renderShell();
    await screen.findByRole('button', { name: WIDE_TRIGGER });
    // Radix only portals the Dialog content when open → the CommandInput is absent.
    expect(screen.queryByPlaceholderText(PALETTE_INPUT)).toBeNull();
  });

  it('clicking the wide trigger opens the command palette', async () => {
    renderShell();
    const wide = await screen.findByRole('button', { name: WIDE_TRIGGER });
    fireEvent.click(wide);
    // The palette's CommandInput now renders → the palette opened.
    expect(await screen.findByPlaceholderText(PALETTE_INPUT)).toBeInTheDocument();
  });

  it('clicking the compact mobile opener opens the SAME palette', async () => {
    renderShell();
    const mobile = await screen.findByRole('button', { name: MOBILE_OPENER });
    fireEvent.click(mobile);
    expect(await screen.findByPlaceholderText(PALETTE_INPUT)).toBeInTheDocument();
  });

  it('restores focus to the exact external palette opener after Escape', async () => {
    renderShell();
    const wide = await screen.findByRole('button', { name: WIDE_TRIGGER });
    const mobile = await screen.findByRole('button', { name: MOBILE_OPENER });

    wide.focus();
    fireEvent.click(wide);
    expect(await screen.findByPlaceholderText(PALETTE_INPUT)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByPlaceholderText(PALETTE_INPUT)).toBeNull());
    await waitFor(() => expect(wide).toHaveFocus());

    mobile.focus();
    fireEvent.click(mobile);
    expect(await screen.findByPlaceholderText(PALETTE_INPUT)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByPlaceholderText(PALETTE_INPUT)).toBeNull());
    await waitFor(() => expect(mobile).toHaveFocus());
  });

  it('the old "Open command palette" outline button no longer exists', async () => {
    renderShell();
    await screen.findByRole('button', { name: WIDE_TRIGGER });
    expect(screen.queryByRole('button', { name: 'Open command palette' })).toBeNull();
  });

  it('keeps the desktop hamburger keyboard-operable and persists its rail state', async () => {
    renderShell();
    const collapse = await screen.findByRole('button', { name: 'Collapse navigation' });
    expect(collapse).toHaveAttribute('aria-keyshortcuts', 'Control+B Meta+B');

    fireEvent.click(collapse);
    expect(await screen.findByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem('soc.nav.collapsed')).toBe('1'));

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(await screen.findByRole('button', { name: 'Collapse navigation' })).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem('soc.nav.collapsed')).toBe('0'));
  });

  it('keeps a collapsed-rail destination stable from focus through activation', async () => {
    window.localStorage.setItem('soc.nav.collapsed', '1');
    const { onNavigate } = renderShell();

    const frame = await screen.findByTestId('desktop-navigation-frame');
    const tuning = await screen.findByTestId('nav-tuning');
    expect(frame).toHaveClass('w-16');
    expect(tuning.closest('aside')).toHaveAttribute('data-nav-state', 'collapsed');

    // Pointer hover and keyboard focus must not swap the locked icon rail for a
    // differently laid-out drawer. Grouped destinations reveal compact flyouts instead;
    // the full drawer opens only through the explicit toggle / Cmd-Ctrl+B contract.
    fireEvent.mouseEnter(frame);
    expect(frame).toHaveClass('w-16');
    expect(tuning.closest('aside')).toHaveAttribute('data-nav-state', 'collapsed');

    fireEvent.focus(tuning);
    expect(screen.getByTestId('nav-tuning')).toBe(tuning);
    expect(tuning.closest('aside')).toHaveAttribute('data-nav-state', 'collapsed');

    fireEvent.click(tuning);
    expect(onNavigate).toHaveBeenCalledWith('tuning');
  });

  it('uses a zero-footprint off-canvas navigation on mobile and closes it after navigation', async () => {
    setMobileViewport(true);
    const { onNavigate } = renderShell();

    // The in-flow desktop rail is not mounted at this breakpoint; navigation starts
    // behind one compact top-bar control instead of consuming 240px of page width.
    const opener = await screen.findByRole('button', { name: 'Open navigation' });
    expect(screen.queryByLabelText('Primary navigation')).toBeNull();

    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Primary navigation' });
    expect(within(dialog).getByLabelText('Primary navigation')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByTestId('nav-cases'));
    expect(onNavigate).toHaveBeenCalledWith('cases');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Primary navigation' })).toBeNull());
  });

  it('keeps release identity direct and groups secondary mobile utilities in one labelled sheet', async () => {
    setMobileViewport(true);
    renderShell();

    expect(await screen.findByTestId('release-badge')).toBeVisible();
    expect(screen.queryByRole('button', { name: /notifications/i })).toBeNull();

    const opener = screen.getByRole('button', { name: 'Open console controls' });
    fireEvent.click(opener);
    const sheet = await screen.findByRole('dialog', { name: 'Console controls' });
    expect(within(sheet).getByRole('button', { name: /notifications, none unread/i })).toBeVisible();
    expect(within(sheet).getByRole('button', { name: /switch to light mode/i })).toBeVisible();
    expect(within(sheet).getByRole('status', { name: /platform health/i })).toBeVisible();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Console controls' })).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('keeps the bottom Docs destination reachable from mobile navigation', async () => {
    setMobileViewport(true);
    const { onNavigate } = renderShell();

    fireEvent.click(await screen.findByRole('button', { name: 'Open navigation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Primary navigation' });
    // Destinations are links (Round 14, SPEC §3.3); D25 renamed the item "Help Center".
    const docs = within(dialog).getByRole('link', { name: 'Help Center' });
    expect(within(dialog).getByTestId('nav-footer')).toContainElement(docs);

    fireEvent.click(docs);
    expect(onNavigate).toHaveBeenCalledWith('docs');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Primary navigation' })).toBeNull(),
    );
  });

  it('opens mobile navigation on the semantic current route instead of Overview', async () => {
    setMobileViewport(true);
    renderShell(vi.fn(), 'logs');

    fireEvent.click(await screen.findByRole('button', { name: 'Open navigation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Primary navigation' });
    const logs = within(dialog).getByTestId('nav-logs');
    const overview = within(dialog).getByTestId('nav-overview');

    expect(logs).toHaveAttribute('aria-current', 'page');
    expect(overview).not.toHaveAttribute('aria-current');
    await waitFor(() => expect(logs).toHaveFocus());
  });

  it('expands and focuses the active trail for a directly-loaded nested mobile route', async () => {
    setMobileViewport(true);
    window.localStorage.setItem('soc.nav.openGroups', '[]');
    renderShell(vi.fn(), 'users');

    fireEvent.click(await screen.findByRole('button', { name: 'Open navigation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Primary navigation' });
    const users = await within(dialog).findByTestId('nav-users');

    expect(users).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(users).toHaveFocus());
  });
});

describe('AppShell mobile menu activity (Round 13, SPEC-chat T32)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearChatActivity();
  });

  it('marks a working answer with a 6 px dot on the menu button, never a ring around it', async () => {
    setMobileViewport(true);
    putChatActivity({
      scope: 'conv:c1',
      kind: 'workspace',
      conversationId: 'c1',
      caseId: null,
      turnId: 't1',
      requestKey: null,
      title: 'Investigate host X',
      label: null,
      lookups: 0,
      status: 'running',
      startedAt: 1,
      source: 'local',
    });
    renderShell();
    const opener = await screen.findByRole('button', { name: 'Open navigation' });
    // Let the lazily loaded activity effects settle inside act.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(opener.querySelector('[data-activity="running"]')).toBeNull();
    const dot = opener.querySelector('[data-activity="working"]');
    expect(dot).not.toBeNull();
    expect(dot).toHaveClass('chat-activity', 'chat-activity-badge', 'size-1.5');
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    // The words stay in the button's description.
    expect(opener).toHaveAttribute('aria-describedby', 'mobile-nav-activity');
    act(() => clearChatActivity());
  });
});
