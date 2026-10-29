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

    expect(document.querySelector('[cmdk-item][data-value="nav-analytics"]')).toBeTruthy();
    expect(document.querySelector('[cmdk-item][data-value="navc-analytics-cost"]')).toBeNull();
    expect(screen.getByText(/type to search every page, setting, case, and source/i)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Cost' } });
    await waitFor(() =>
      expect(document.querySelector('[cmdk-item][data-value="navc-analytics-cost"]')).toBeTruthy(),
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

describe('CommandPalette: destinations open what the navigation opens (Round 14, SPEC §2.2 item 13)', () => {
  beforeEach(() => {
    searchMock.mockReset();
    searchMock.mockResolvedValue({ query: '', cases: [], sources: [], nav: [] });
    window.localStorage.clear();
  });

  const item = (value: string) => document.querySelector(`[cmdk-item][data-value="${value}"]`) as HTMLElement | null;

  it('"Cyber Defence Center" opens the landing page and "Dashboards" the library', async () => {
    const { onNavigate } = await renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: 'Cyber Defence' } });
    await waitFor(() => expect(item('navc-overview-dashboard')).toBeTruthy());
    expect(item('navc-overview-dashboard')).toHaveTextContent('Cyber Defence Center');
    fireEvent.click(item('navc-overview-dashboard') as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith('overview');
  });

  it('the Overview row opens the Dashboards library, like the navigation', async () => {
    const { onNavigate } = await renderPalette();
    await waitFor(() => expect(item('nav-overview')).toBeTruthy());
    fireEvent.click(item('nav-overview') as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith('dashboards');
  });

  it('lists one Runbooks destination and names the Help Center', async () => {
    await renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: 'book' } });
    await waitFor(() => expect(item('navc-intelligence-runbooks')).toBeTruthy());
    expect(item('navc-intelligence-runbooks')).toHaveTextContent('Runbooks');
    expect(item('navc-intelligence-playbooks')).toBeNull();
    fireEvent.change(input, { target: { value: 'help' } });
    await waitFor(() => expect(item('nav-docs')).toHaveTextContent('Help Center'));
  });
});

describe('CommandPalette: recents read as what they open today (Round 14, D25)', () => {
  beforeEach(() => {
    searchMock.mockReset();
    searchMock.mockResolvedValue({ query: '', cases: [], sources: [], nav: [] });
    window.localStorage.clear();
  });

  const recentItems = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]')).filter((el) =>
      /^recent /i.test(el.getAttribute('data-value') ?? ''),
    );

  it('resolves retired routes, renames pages by the navigation and shows each page once', async () => {
    window.localStorage.setItem(
      'tlsoc.cmdk.recents',
      JSON.stringify([
        { page: 'playbooks', label: 'Response playbooks' },
        { page: 'runbooks', label: 'Reference runbooks' },
        { page: 'docs', label: 'Documentation' },
        { page: 'dashboards', label: 'Overview' },
        { page: 'scans', label: 'Automated scans (legacy)' },
        { page: 'cases', label: 'Phishing burst', kind: 'item' },
      ]),
    );
    const { onNavigate } = await renderPalette();
    await waitFor(() => expect(recentItems().length).toBeGreaterThan(0));
    expect(recentItems().map((el) => el.textContent)).toEqual([
      'Runbooks',
      'Help Center',
      'Dashboards',
      'Case Manager',
      'Phishing burst',
    ]);
    expect(document.body.textContent).not.toMatch(/playbook/i);
    fireEvent.click(recentItems()[0]);
    expect(onNavigate).toHaveBeenCalledWith('runbooks');
  });

  it('stores the page a jump resolves to, under its navigation name', async () => {
    window.localStorage.setItem('tlsoc.cmdk.recents', JSON.stringify([{ page: 'catalog', label: 'Catalog' }]));
    await renderPalette();
    await waitFor(() => expect(recentItems()).toHaveLength(1));
    fireEvent.click(recentItems()[0]);
    expect(JSON.parse(window.localStorage.getItem('tlsoc.cmdk.recents') ?? '[]')).toEqual([
      { page: 'runbooks', label: 'Runbooks', kind: 'page' },
    ]);
  });
});

describe('CommandPalette: a page named exactly by the query comes first (Round 14)', () => {
  beforeEach(() => {
    searchMock.mockReset();
    searchMock.mockResolvedValue({ query: '', cases: [], sources: [], nav: [] });
    window.localStorage.clear();
  });

  const items = () => Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]'));
  const headings = () => Array.from(document.querySelectorAll('[cmdk-group-heading]')).map((el) => el.textContent);

  // Every one of these also matches a Settings section, a setting or an action by its
  // words; the page itself must still take the default Enter.
  for (const query of ['Approvals', 'Cases', 'Models', 'Runbooks', 'Sources', 'Chat', 'Cost', 'Notifications', 'Users', 'Roles']) {
    it(`"${query.toLowerCase()}" puts the ${query} page first, above every Settings target`, async () => {
      await renderPalette();
      const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
      fireEvent.change(input, { target: { value: query.toLowerCase() } });
      await waitFor(() => expect(headings()[0]).toBe('Go to page'));
      const first = items()[0];
      expect(first.textContent).toBe(query);
      expect(first.getAttribute('data-value')).toMatch(/^navc?-/);
      expect(first).toHaveAttribute('data-selected', 'true');
      // Listed once: the page is not repeated in its rail group further down.
      expect(items().filter((el) => el.getAttribute('data-value') === first.getAttribute('data-value'))).toHaveLength(1);
      const settingsHeading = headings().indexOf('Settings');
      if (settingsHeading >= 0) expect(settingsHeading).toBeGreaterThan(0);
    });
  }

  it('opens the page on Enter even though a Runbooks setting mentions step approvals', async () => {
    const { onNavigate } = await renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: 'approvals' } });
    // The Runbooks section is still found by its words, below the page.
    await waitFor(() => expect(document.querySelector('[cmdk-item][data-value="set-runbooks"]')).toBeTruthy());
    expect(items()[0].getAttribute('data-value')).toBe('nav-approvals');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('approvals');
  });

  it('adds no "Go to page" group for a partial name', async () => {
    await renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: 'appro' } });
    await waitFor(() => expect(document.querySelector('[cmdk-item][data-value="nav-approvals"]')).toBeTruthy());
    expect(headings()).not.toContain('Go to page');
  });
});
