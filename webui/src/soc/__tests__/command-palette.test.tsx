/**
 * Command palette (W7c) render + behaviour test.
 *
 * Asserts the palette (a) opens and lists RBAC-filtered NAV targets, (b) debounce-
 * queries GET /api/search and renders the returned case/source hits, and (c) routes
 * a selected nav target through onNavigate. The api client is mocked so the test is
 * fully offline; every provider the palette consumes is supplied real (auth/prefs/
 * theme/demo/router) with mocked load-time api calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      // Provider load-time calls (auth/prefs/theme/demo).
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
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
      // The search surface under test.
      search: searchMock,
    },
  };
});

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CommandPalette } from '../components/CommandPalette';

/**
 * Render the open palette and wait for its lazy chat entries (a `React.lazy` chunk) to
 * arrive, so that chunk always settles inside the test's own waiting, never after it.
 */
async function renderPalette(onNavigate = vi.fn()) {
  const utils = render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <CommandPalette open onOpenChange={vi.fn()} onNavigate={onNavigate} />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
  await waitFor(() =>
    expect(document.querySelector('[cmdk-item][data-value="action-search-chats"]')).toBeTruthy(),
  );
  return { onNavigate, ...utils };
}

describe('CommandPalette (W7c)', () => {
  beforeEach(() => {
    searchMock.mockReset();
    searchMock.mockResolvedValue({ query: '', cases: [], sources: [], nav: [] });
    window.localStorage.clear();
  });

  it('opens and lists nav targets + quick actions', async () => {
    await renderPalette();
    // The dialog input renders.
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/search cases, sources, settings/i),
      ).toBeInTheDocument(),
    );
    // A rail nav target (Cases) and a quick action (Go to Settings) are present.
    // ("Cases" also names a Settings SECTION jump target added in Round-5 Sett-C, so
    // there can be >1 — assert at least one and target the nav one by value below.)
    expect(screen.getAllByText('Cases').length).toBeGreaterThan(0);
    expect(screen.getByText('Go to Settings')).toBeInTheDocument();
    expect(screen.getByText('New chat')).toBeInTheDocument();
    expect(document.querySelector('[cmdk-item][data-value="nav-docs"]')).toBeTruthy();
  });

  it('progressively reveals Settings section jump targets after a query (Round-5 Sett-C)', async () => {
    await renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    expect(document.querySelector('[cmdk-item][data-value="set-general"]')).toBeNull();
    fireEvent.change(input, { target: { value: 'Data scope' } });
    // The palette registers Settings sections as jump targets under a "Settings" group
    // heading (there is also a "Go to Settings" quick action, so match the heading node).
    const heading = document.querySelector('[cmdk-group-heading]');
    expect(
      Array.from(document.querySelectorAll('[cmdk-group-heading]')).some(
        (el) => el.textContent === 'Settings',
      ),
    ).toBe(true);
    expect(heading).toBeTruthy();
    // A known section jump target (Data scope) is present (auth off → all perms granted).
    const item = document.querySelector('[cmdk-item][data-value="set-general"]');
    expect(item).toBeTruthy();
  });

  it('queries GET /api/search and renders the returned case + source hits', async () => {
    searchMock.mockResolvedValue({
      query: 'brute',
      cases: [
        { type: 'case', id: 'case-001', case_number: 'TLSOC-001', title: 'Brute-force burst' },
      ],
      sources: [{ type: 'source', id: 'src-1', label: 'Prod Elastic', source_type: 'elasticsearch' }],
      nav: [],
    });
    await renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: 'brute' } });

    // Debounced search fires with the term.
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith('brute', 20), { timeout: 2000 });
    // The returned (UNTRUSTED) case + source titles render as plain text.
    await waitFor(() => expect(screen.getByText('Brute-force burst')).toBeInTheDocument());
    expect(screen.getByText('Prod Elastic')).toBeInTheDocument();
  });

  it('routes a selected nav target through onNavigate', async () => {
    const { onNavigate } = await renderPalette();
    // Target the RAIL nav "Cases" item explicitly by its cmdk value (`nav-cases`) — a
    // Settings section also renders a "Cases" label now, so a bare text match is ambiguous.
    await waitFor(() =>
      expect(document.querySelector('[cmdk-item][data-value="nav-cases"]')).toBeTruthy(),
    );
    const casesItem = document.querySelector('[cmdk-item][data-value="nav-cases"]') as HTMLElement;
    fireEvent.click(casesItem);
    expect(onNavigate).toHaveBeenCalledWith('cases');
  });

  it('routes a Settings section jump through onNavigate with a section opt', async () => {
    const { onNavigate } = await renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: 'Data scope' } });
    await waitFor(() =>
      expect(document.querySelector('[cmdk-item][data-value="set-general"]')).toBeTruthy(),
    );
    const setItem = document.querySelector('[cmdk-item][data-value="set-general"]') as HTMLElement;
    fireEvent.click(setItem);
    // Jumps to the settings page carrying the section id (no anchor for a section head).
    expect(onNavigate).toHaveBeenCalledWith('settings', { section: 'general', anchor: undefined });
  });

  it('keeps the blank state concise and reveals child destinations only when searched', async () => {
    await renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);

    expect(document.querySelector('[cmdk-item][data-value="nav-metrics"]')).toBeTruthy();
    expect(document.querySelector('[cmdk-item][data-value="navc-metrics-cost"]')).toBeNull();
    expect(screen.getByText(/type to search every page, setting, case, and source/i)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Cost' } });
    await waitFor(() =>
      expect(document.querySelector('[cmdk-item][data-value="navc-metrics-cost"]')).toBeTruthy(),
    );
  });
});

describe('CommandPalette — quick actions group', () => {
  beforeEach(() => {
    searchMock.mockReset();
    searchMock.mockResolvedValue({ query: '', cases: [], sources: [], nav: [] });
    window.localStorage.clear();
  });

  it('shows no empty "Actions" heading when no quick action matches the query', async () => {
    await renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    const headings = () => Array.from(document.querySelectorAll('[cmdk-group-heading]')).map((el) => el.textContent);
    expect(headings()).toContain('Actions');
    fireEvent.change(input, { target: { value: 'cases' } });
    await waitFor(() => expect(headings()).not.toContain('Actions'));
    fireEvent.change(input, { target: { value: 'theme' } });
    await waitFor(() => expect(headings()).toContain('Actions'));
  });
});
