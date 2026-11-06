/**
 * Render regression test for the Settings page — guards the React #310 bug.
 *
 * The default <Settings/> component had hooks (the section-rail useMemos +
 * a section-sync useEffect) sitting AFTER an `if (loading) return <Skeleton/>`
 * early return. On the first data load `loading` flips false, the post-return
 * hooks suddenly run, the hook count changes between renders, and React throws
 * #310 ("Rendered more hooks than during the previous render") in production.
 *
 * This test mounts <Settings/> with the auth context + a mocked api, resolves
 * the mocked getSettings()/getModels(), and asserts the section rail renders
 * (a known section label is in the document) WITHOUT throwing. If the hooks
 * ever drift back below an early return, this test crashes on the loading→ready
 * transition and fails — exactly the regression we want to catch.
 *
 * A tiny smoke for the Overview page (another Wave-7 early-return page) is added
 * at the end so the loading→ready transition is exercised there too.
 */
import type * as React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the typed api client BEFORE importing anything that pulls it in.
vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  const prefs = {
    // A representative slice of Preferences. Everything the General section reads
    // is present; the rest of the page tolerates undefined fields.
    data_view_pattern: 'all-logs-*',
    time_field: '@timestamp',
    source_ip_field: 'source.ip',
    user_field: 'user.name',
    host_field: 'host.name',
    rule_field: 'rule.id',
    rule_name_field: 'rule.name',
    severity_field: 'event.severity',
    severity_threshold: 3,
    investigate_lookback: 'now-24h',
    polling_enabled: false,
    poll_interval_seconds: 60,
    poll_batch_size: 100,
    cold_start_lookback_minutes: 60,
    sources: [],
    setup_complete: true,
  };
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: {
        me: ok({ auth_enabled: false, authenticated: true, user: null }),
        logout: ok({ ok: true }),
        sso: { setSecret: ok({ configured: true }) },
      },
      roles: {
        get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }),
      },
      // The two calls the Settings load() fires in parallel.
      getSettings: ok({ prefs, configured: {}, read_only: false }),
      getModels: ok({ providers: { anthropic: ['claude-sonnet'] } }),
      putSettings: vi.fn(async (patch: Record<string, unknown>) => ({
        prefs: { ...prefs, ...patch },
        configured: {},
        read_only: false,
      })),
      updateSecrets: vi.fn(async (body: Record<string, string>) => ({
        configured: Object.fromEntries(Object.keys(body).map((key) => [key, true])),
      })),
      // Round-5 Sett-C — the schema-driven "All settings" section fetches this.
      getSettingsSchema: ok({ sections: [] }),
      // Used by sub-sections that may lazily mount; harmless to provide.
      getBranding: ok({}),
      caseIdPreview: ok({ samples: [], valid: true }),
      // Round-2 Wave 4 — the embedded Account/Admin sub-section bodies fetch these
      // when their Settings section is active.
      account: {
        get: ok({ username: '', role: '', env_managed: false }),
        put: ok({}),
        avatar: ok({}),
        // The effective grants the AuthProvider reads (GET /api/account/permissions).
        permissions: ok({ authenticated: false, role: 'super_admin', custom_roles: [], rbac_enabled: false, permissions: {} }),
      },
      account_activity: ok({ events: [] }),
      sessions: { list: ok({ sessions: [] }), revoke: ok({ ok: true }), revokeOthers: ok({ revoked: 0 }) },
      users: { list: ok({ users: [] }), create: ok({}), update: ok({}), remove: ok({}) },
      admin: {
        sessions: { list: ok({ sessions: [] }), revoke: ok({ ok: true }) },
        users: { revokeAll: ok({ ok: true, revoked: 0 }) },
      },
    },
  };
});

import { AuthProvider, useAuth } from '../auth';
import { RouterProvider, useNavigate } from '../router';
import { api } from '@/lib/api';
import { TooltipProvider } from '@/ui/tooltip';
import Settings from '../pages/Settings';
import Overview, { PAGE_TITLE } from '../pages/Overview';
import { SECTION_META_BY_ID } from '../pages/settings/settings-sections-meta';

/**
 * Pages mount once the session and its grants are known, as the Console shell does (it
 * shows "Starting console" until then). Without this a page would first render with the
 * signed-out allow-all and could mount a section the viewer may not open.
 */
function AuthReady({ children }: { children: React.ReactNode }) {
  return useAuth().loading ? null : <>{children}</>;
}

function renderWithProviders(node: React.ReactNode) {
  return render(
    <AuthProvider>
      <AuthReady>
        <RouterProvider>
          <TooltipProvider>{node}</TooltipProvider>
        </RouterProvider>
      </AuthReady>
    </AuthProvider>,
  );
}

function LeaveSettingsProbe() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('overview')}>Go to Overview</button>;
}

beforeEach(() => {
  vi.mocked(api.putSettings).mockClear();
  vi.mocked(api.updateSecrets).mockClear();
  window.location.hash = '';
});

describe('Settings page — #310 render regression', () => {
  it('mounts and survives the loading→ready transition, rendering the section rail', async () => {
    renderWithProviders(<Settings />);

    // Once getSettings() resolves, `loading` flips false and the (now-hoisted)
    // section-rail hooks run. The known "Data scope" section label (Round-5 Sett-B
    // relabel of the former "General & data scope") appears BOTH as the rail nav
    // button and as the rendered section title — its presence proves the rail
    // rendered AND that React did not throw #310 during the loading→ready transition.
    await waitFor(
      () => expect(screen.getAllByText('Data scope').length).toBeGreaterThan(0),
      { timeout: 5000 },
    );

    // The page title is present too (it renders in both loading and ready states).
    expect(screen.getAllByText('Settings').length).toBeGreaterThan(0);
  });
});

describe('Settings IA consolidation (Round-5 Sett-B: 5 groups, Security promoted)', () => {
  it('shows the folded-in Account + Security & access sections in the auth-off default', async () => {
    renderWithProviders(<Settings />);
    await waitFor(
      () => expect(screen.getByTestId('settings-section-general')).toBeInTheDocument(),
      { timeout: 5000 },
    );
    // Each rail entry is anchored by its stable section id (reword-proof), and we KEEP
    // the display-label assertion so a relabel that drops the concept still fails.
    // Personal Account group (no perm → always visible).
    expect(screen.getByTestId('settings-section-profile')).toBeInTheDocument();
    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-account_security')).toBeInTheDocument();
    expect(screen.getByText('Security & two-factor')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-sessions')).toBeInTheDocument();
    expect(screen.getByText('Sessions & activity')).toBeInTheDocument();
    // Security & access group (NEW top-level, promoted) — in the auth-off default,
    // hasPermission() is true so the perm-gated sections still render in the rail.
    expect(screen.getByTestId('settings-section-admin_users')).toBeInTheDocument();
    expect(screen.getByText('Users')).toBeInTheDocument();
    // Roles is split out of Users into its own Security & access section (Sett-B).
    expect(screen.getByTestId('settings-section-roles')).toBeInTheDocument();
    expect(screen.getByText('Roles & permissions')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-security')).toBeInTheDocument();
    expect(screen.getByText('Single sign-on & policy')).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-admin_sessions')).toBeInTheDocument();
    expect(screen.getByText('Active sessions')).toBeInTheDocument();
    // Secret keys moved into Security & access (high-blast-radius credentials).
    expect(screen.getByTestId('settings-section-keys')).toBeInTheDocument();
    // Organization group ends with the isolated Danger zone.
    expect(screen.getByTestId('settings-section-danger')).toBeInTheDocument();
    expect(screen.getByText('Danger zone')).toBeInTheDocument();
    // The FIVE new group labels are present in the rail.
    for (const label of ['Account', 'General', 'Integrations', 'Security & access', 'Organization']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('shows the page title with a help tip and one section heading, nothing else at rest', async () => {
    renderWithProviders(<Settings />);
    await waitFor(
      () => expect(screen.getByTestId('settings-section-general')).toBeInTheDocument(),
      { timeout: 5000 },
    );

    // SPEC §4.9.6: the header is the title and a help tip; no description, no
    // "Preferences saved" pill, no section count, no breadcrumb context line.
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Settings' })).toBeInTheDocument();
    expect(screen.queryByText('Preferences saved')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-active-context')).not.toBeInTheDocument();
    expect(screen.queryByText(/sections$/i)).not.toBeInTheDocument();
    // The rail group labels are text, not headings: one h2, the active section's title.
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Data scope', level: 2 })).toBeInTheDocument();
    const labels = [...document.querySelectorAll('[data-settings-group-label]')].map((el) => el.textContent);
    expect(labels).toContain('General');
    for (const label of labels) expect(label).not.toMatch(/\d/);
    // Without a wizard handler there is no Re-run action at all.
    expect(screen.queryByTestId('settings-rerun-wizard')).not.toBeInTheDocument();
  });

  it('puts Re-run setup wizard at the foot of the Settings rail', async () => {
    const onRerunWizard = vi.fn();
    renderWithProviders(<Settings onRerunWizard={onRerunWizard} />);
    const rerun = await screen.findByTestId('settings-rerun-wizard', undefined, { timeout: 5000 });
    // In the rail's navigation, after the last group, never in the page header.
    const nav = rerun.closest('nav') as HTMLElement;
    expect(nav).not.toBeNull();
    const groups = nav.querySelectorAll('[data-settings-group-label]');
    expect(
      groups[groups.length - 1].compareDocumentPosition(rerun) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.click(rerun);
    expect(onRerunWizard).toHaveBeenCalledTimes(1);
  });

  it('shows the save footer only on sections that own preferences or secrets', async () => {
    window.location.hash = '#/settings?s=general';
    renderWithProviders(<Settings />);
    await screen.findByLabelText('Log index pattern');
    expect(screen.getByTestId('settings-save-note')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('settings-section-admin_users'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Users', level: 2 })).toBeInTheDocument());
    expect(screen.queryByTestId('settings-save-note')).not.toBeInTheDocument();
    window.location.hash = '';
  });

  it('keeps the embedded SSO editor under one section heading with grouped panels', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Settings />);
    await waitFor(
      () => expect(screen.getByTestId('settings-section-security')).toBeInTheDocument(),
      { timeout: 5000 },
    );

    await user.click(screen.getByTestId('settings-section-security'));

    expect(
      await screen.findByRole('heading', { name: 'Single sign-on & policy', level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Session lifetime', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Single sign-on (OIDC)', level: 3 })).toBeInTheDocument();

    // The switch is a row on its group's panel.
    const ssoToggle = screen.getByRole('switch', { name: 'Enable single sign-on' });
    expect(ssoToggle.closest('[data-setting-row="switch"]')).not.toBeNull();
    expect(ssoToggle.closest('[data-settings-panel]')).not.toBeNull();
  });

  it('contains nested section-rail momentum instead of chaining it into the page', async () => {
    renderWithProviders(<Settings />);
    await waitFor(
      () => expect(screen.getByTestId('settings-desktop-section-scroll')).toBeInTheDocument(),
      { timeout: 5000 },
    );

    expect(screen.getByTestId('settings-desktop-section-scroll')).toHaveClass(
      'overflow-y-auto',
      'overscroll-y-contain',
    );

    await userEvent.click(screen.getByTestId('settings-mobile-nav-trigger'));
    expect(screen.getByTestId('settings-compact-section-scroll')).toHaveClass(
      'overflow-y-auto',
      'overscroll-y-contain',
    );
  });

  it('opens a grouped compact chooser and preserves section deep-link navigation', async () => {
    renderWithProviders(<Settings />);
    await waitFor(
      () => expect(screen.getByTestId('settings-mobile-nav-trigger')).toBeInTheDocument(),
      { timeout: 5000 },
    );

    await userEvent.click(screen.getByTestId('settings-mobile-nav-trigger'));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('settings-mobile-section-models'));

    await waitFor(
      () => expect(screen.getByTestId('settings-section-models')).toHaveAttribute('aria-current', 'page'),
      { timeout: 5000 },
    );
    expect(window.location.hash).toBe('#/settings?s=models');
    window.location.hash = '';
  });

  it('searches setting-level anchors and offers a clear action', async () => {
    renderWithProviders(<Settings />);
    await waitFor(
      () => expect(screen.getByTestId('settings-section-general')).toBeInTheDocument(),
      { timeout: 5000 },
    );

    await userEvent.type(screen.getByLabelText('Search settings sections'), 'auto-close');
    expect(screen.getByTestId('settings-anchor-detection-autoclose')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear settings search' }));
    expect(screen.queryByRole('button', { name: 'Clear settings search' })).not.toBeInTheDocument();
  });

  it('surfaces section and workspace draft state without changing the save contract', async () => {
    window.location.hash = '#/settings?s=general';
    renderWithProviders(<Settings />);
    const indexPattern = await screen.findByLabelText('Log index pattern');

    await userEvent.clear(indexPattern);
    await userEvent.type(indexPattern, 'security-events-*');

    // The rail dot marks the section; the save bar carries the count (nothing else).
    expect(
      screen.getByTestId('settings-section-general').querySelector('[data-settings-dirty-dot]'),
    ).not.toBeNull();
    expect(screen.queryByText('1 pending change')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toBeInTheDocument();

    const unload = new Event('beforeunload', { cancelable: true });
    await waitFor(() => {
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
    });
    window.location.hash = '';
  });

  it('counts the values changed, not the sections (two Chat assistant fields are two changes)', async () => {
    const { CHAT_AGENT_DEFAULTS } = await import('../pages/settings/chat-agent');
    const loaded = await vi.mocked(api.getSettings)();
    vi.mocked(api.getSettings).mockResolvedValueOnce({
      ...loaded,
      prefs: { ...loaded.prefs, chat_agent: { ...CHAT_AGENT_DEFAULTS } },
    } as never);
    window.location.hash = '#/settings?s=chat_agent';
    renderWithProviders(<Settings />);
    const lookupTimeout = await screen.findByRole('spinbutton', { name: /Lookup timeout/ }, { timeout: 5000 });
    await userEvent.clear(lookupTimeout);
    await userEvent.type(lookupTimeout, '60');
    await userEvent.tab();
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar).toHaveTextContent('1 unsaved change.');

    const modelTimeout = screen.getByRole('spinbutton', { name: /Model call timeout/ });
    await userEvent.clear(modelTimeout);
    await userEvent.type(modelTimeout, '1200');
    await userEvent.tab();
    // One section and one top-level key, two values: the bar says two, as the audit row will.
    expect(bar).toHaveTextContent('2 unsaved changes.');
    expect(
      screen.getByTestId('settings-section-chat_agent').querySelector('[data-settings-dirty-dot]'),
    ).not.toBeNull();
    window.location.hash = '';
  }, 15_000);

  it('uses the sole sticky action bar to save a write-only secret draft', async () => {
    window.location.hash = '#/settings?s=keys';
    renderWithProviders(<Settings />);
    const openAiKey = await screen.findByLabelText('OpenAI API key');

    await userEvent.type(openAiKey, 'replacement-key');

    expect(
      screen.getByTestId('settings-section-keys').querySelector('[data-settings-dirty-dot]'),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Update keys' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent(
      '1 unsaved secret value',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(api.updateSecrets).toHaveBeenCalledWith({ openai_api_key: 'replacement-key' }),
    );
    await waitFor(() => expect(openAiKey).toHaveValue(''));
    expect(api.putSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('guards cross-page navigation while a write-only secret draft is pending', async () => {
    window.location.hash = '#/settings?s=keys';
    renderWithProviders(
      <>
        <Settings />
        <LeaveSettingsProbe />
      </>,
    );
    const openAiKey = await screen.findByLabelText('OpenAI API key');
    await userEvent.type(openAiKey, 'unfinished-key');

    await userEvent.click(screen.getByRole('button', { name: 'Go to Overview' }));
    expect(window.location.hash).toBe('#/settings?s=keys');
    expect(
      screen.getByRole('alertdialog', { name: 'Leave Settings with unsaved changes?' }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(openAiKey).toHaveValue('unfinished-key');
  });

  it('saves preference and secret drafts through one ordered Settings action', async () => {
    window.location.hash = '#/settings?s=general';
    renderWithProviders(<Settings />);
    const indexPattern = await screen.findByLabelText('Log index pattern');
    await userEvent.clear(indexPattern);
    await userEvent.type(indexPattern, 'security-events-*');

    await userEvent.click(screen.getByTestId('settings-section-keys'));
    const openAiKey = await screen.findByLabelText('OpenAI API key');
    await userEvent.type(openAiKey, 'replacement-key');

    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent(
      '2 unsaved changes: 1 preference and 1 secret value',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.putSettings).toHaveBeenCalledTimes(1));
    expect(api.putSettings).toHaveBeenCalledWith({ data_view_pattern: 'security-events-*' });
    await waitFor(() =>
      expect(api.updateSecrets).toHaveBeenCalledWith({ openai_api_key: 'replacement-key' }),
    );
    await waitFor(() => expect(openAiKey).toHaveValue(''));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('keeps a failed secret draft recoverable after preferences save successfully', async () => {
    vi.mocked(api.updateSecrets).mockRejectedValueOnce(new Error('Key vault unavailable'));
    window.location.hash = '#/settings?s=general';
    renderWithProviders(<Settings />);
    const indexPattern = await screen.findByLabelText('Log index pattern');
    await userEvent.clear(indexPattern);
    await userEvent.type(indexPattern, 'security-events-*');

    await userEvent.click(screen.getByTestId('settings-section-keys'));
    const openAiKey = await screen.findByLabelText('OpenAI API key');
    await userEvent.type(openAiKey, 'keep-me');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.putSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.updateSecrets).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(openAiKey).toHaveValue('keep-me'));
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent(
      '1 unsaved secret value',
    );
    expect(
      screen.getByTestId('settings-section-keys').querySelector('[data-settings-dirty-dot]'),
    ).not.toBeNull();
  });

  it('discards preference and write-only secret drafts together', async () => {
    window.location.hash = '#/settings?s=general';
    renderWithProviders(<Settings />);
    const indexPattern = await screen.findByLabelText('Log index pattern');
    await userEvent.clear(indexPattern);
    await userEvent.type(indexPattern, 'security-events-*');

    await userEvent.click(screen.getByTestId('settings-section-keys'));
    const openAiKey = await screen.findByLabelText('OpenAI API key');
    await userEvent.type(openAiKey, 'discard-me');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(openAiKey).toHaveValue('');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('settings-section-general'));
    expect(await screen.findByLabelText('Log index pattern')).toHaveValue('all-logs-*');
  });

  it('keeps a dirty Settings draft mounted until in-app navigation is confirmed', async () => {
    window.location.hash = '#/settings?s=general';
    renderWithProviders(
      <>
        <Settings />
        <LeaveSettingsProbe />
      </>,
    );
    const indexPattern = await screen.findByLabelText('Log index pattern');
    await userEvent.clear(indexPattern);
    await userEvent.type(indexPattern, 'security-events-*');

    await userEvent.click(screen.getByRole('button', { name: 'Go to Overview' }));
    expect(window.location.hash).toBe('#/settings?s=general');
    expect(
      screen.getByRole('alertdialog', { name: 'Leave Settings with unsaved changes?' }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(window.location.hash).toBe('#/settings?s=general');
    expect(indexPattern).toHaveValue('security-events-*');

    await userEvent.click(screen.getByRole('button', { name: 'Go to Overview' }));
    await userEvent.click(screen.getByRole('button', { name: 'Leave Settings' }));
    await waitFor(() => expect(window.location.hash).toBe('#/overview'));
    window.location.hash = '';
  });

  it('deep-links to an admin section via #/settings?s=admin_users', async () => {
    window.location.hash = '#/settings?s=admin_users';
    renderWithProviders(<Settings />);
    // The embedded Users body renders its "Add user" affordance (auth-off → allow-all).
    await waitFor(() => expect(screen.getByText('Add user')).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Users', level: 2 })).toBeInTheDocument();
    window.location.hash = '';
  });

  describe('the rail keeps the current section in view (composites-01)', () => {
    const RAIL = 'settings-desktop-section-scroll';
    const COMPACT = 'settings-compact-section-scroll';
    let scrollTops: WeakMap<Element, number>;
    let restore: () => void;
    beforeEach(() => {
      // jsdom has no layout: give the rail scroller and its current item the geometry the
      // live page has at 1440 by 900 (the sticky rail runs below the fold at rest), and a
      // scrollTop the item's position follows.
      scrollTops = new WeakMap();
      const store = scrollTops;
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get(this: HTMLElement) {
          return store.get(this) ?? 0;
        },
        set(this: HTMLElement, value: number) {
          store.set(this, value);
        },
      });
      const box = (top: number, bottom: number) =>
        ({ top, bottom, left: 0, right: 240, width: 240, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
      const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.dataset.testid === RAIL) return box(213, 973);
        // The phone section sheet's list scrolls inside the sheet, from 140 to 760.
        if (this.dataset.testid === COMPACT) return box(140, 760);
        const rail = this.closest(`[data-testid="${RAIL}"], [data-testid="${COMPACT}"]`);
        if (rail && this.getAttribute('aria-current') === 'page') {
          const offset = store.get(rail) ?? 0;
          // Users sits low in the rail; Data scope near its top.
          const low = /^settings-(mobile-)?section-admin_users$/.test(this.dataset.testid ?? '');
          const top = low ? 1039 : 300;
          return box(top - offset, top + 36 - offset);
        }
        return box(0, 0);
      });
      const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
      restore = () => {
        spy.mockRestore();
        delete (HTMLElement.prototype as unknown as { scrollTop?: number }).scrollTop;
        if (innerHeight) Object.defineProperty(window, 'innerHeight', innerHeight);
      };
    });
    afterEach(() => {
      restore();
      window.location.hash = '';
    });

    it('scrolls only the rail so a deep-linked section low in it is visible', async () => {
      window.location.hash = '#/settings?s=admin_users';
      renderWithProviders(<Settings />);
      const rail = await screen.findByTestId(RAIL, undefined, { timeout: 5000 });
      await waitFor(() => expect(screen.getByTestId('settings-section-admin_users')).toHaveAttribute('aria-current', 'page'));
      // The item ends at 1075 and the visible part of the rail at the window's 900, so the
      // rail moves by the overlap plus an 8 px margin.
      await waitFor(() => expect(rail.scrollTop).toBe(1075 - 900 + 8));
    });

    it('leaves the rail where it is when the current section is already in view', async () => {
      window.location.hash = '#/settings?s=general';
      renderWithProviders(<Settings />);
      const rail = await screen.findByTestId(RAIL, undefined, { timeout: 5000 });
      await screen.findByLabelText('Log index pattern', undefined, { timeout: 5000 });
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
      expect(rail.scrollTop).toBe(0);
    });

    it('scrolls the rail when a hash change opens a section low in it', async () => {
      window.location.hash = '#/settings?s=general';
      renderWithProviders(<Settings />);
      const rail = await screen.findByTestId(RAIL, undefined, { timeout: 5000 });
      await screen.findByLabelText('Log index pattern', undefined, { timeout: 5000 });
      expect(rail.scrollTop).toBe(0);
      act(() => {
        window.location.hash = '#/settings?s=admin_users';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await waitFor(() => expect(screen.getByTestId('settings-section-admin_users')).toHaveAttribute('aria-current', 'page'));
      await waitFor(() => expect(rail.scrollTop).toBe(1075 - 900 + 8));
    });

    it('scrolls the rail to a section chosen from a search once the search is cleared', async () => {
      window.location.hash = '#/settings?s=general';
      renderWithProviders(<Settings />);
      const rail = await screen.findByTestId(RAIL, undefined, { timeout: 5000 });
      await screen.findByLabelText('Log index pattern', undefined, { timeout: 5000 });
      const search = screen.getAllByRole('textbox', { name: 'Search settings sections' })[0];
      await userEvent.type(search, 'users');
      await userEvent.click(await within(rail).findByTestId('settings-section-admin_users'));
      await userEvent.clear(search);
      await waitFor(() => expect(screen.getByTestId('settings-section-admin_users')).toHaveAttribute('aria-current', 'page'));
      // The full list is back, and the chosen item, low in it, is scrolled into view.
      await waitFor(() => expect(rail.scrollTop).toBe(1075 - 900 + 8));
    });

    it('scrolls the phone section sheet so the current section is in view when it opens', async () => {
      window.location.hash = '#/settings?s=admin_users';
      renderWithProviders(<Settings />);
      await screen.findByTestId(RAIL, undefined, { timeout: 5000 });
      await userEvent.click(screen.getByTestId('settings-mobile-nav-trigger'));
      const sheet = await screen.findByTestId(COMPACT);
      expect(within(sheet).getByTestId('settings-mobile-section-admin_users')).toHaveAttribute('aria-current', 'page');
      // The item ends at 1075 and the sheet's list at 760: it moves by the overlap and 8 px.
      await waitFor(() => expect(sheet.scrollTop).toBe(1075 - 760 + 8));
    });
  });

  it('deep-links to the NEW Roles section via #/settings?s=roles', async () => {
    window.location.hash = '#/settings?s=roles';
    renderWithProviders(<Settings />);
    // The active rail entry for roles is present (deep-link resolved to the section).
    await waitFor(
      () => expect(screen.getByTestId('settings-section-roles')).toHaveAttribute('aria-current', 'page'),
      { timeout: 5000 },
    );
    window.location.hash = '';
  });

  it('Round-5 Sett-C: a `&a=<anchor>` card deep-link scrolls to + highlights the card', async () => {
    // jsdom has no layout, but scrollIntoView is stubbed so the effect runs end-to-end.
    const scrollSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.HTMLElement.prototype as any).scrollIntoView = scrollSpy;
    window.location.hash = '#/settings?s=detection&a=detection-autoclose';
    renderWithProviders(<Settings />);
    // The detection section renders the auto-close card (id = the anchor).
    await waitFor(
      () => expect(document.getElementById('detection-autoclose')).toBeInTheDocument(),
      { timeout: 5000 },
    );
    // The scroll+highlight effect fires: scrollIntoView called on the anchored card and
    // the reduced-motion-safe highlight class is applied.
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled(), { timeout: 5000 });
    await waitFor(
      () =>
        expect(
          document.getElementById('detection-autoclose')?.classList.contains('animate-settings-highlight'),
        ).toBe(true),
      { timeout: 5000 },
    );
    window.location.hash = '';
  });

  it('Round-5 Sett-C: the schema-driven "All settings" section is deep-linkable', async () => {
    window.location.hash = '#/settings?s=advanced_all';
    renderWithProviders(<Settings />);
    await waitFor(
      () =>
        expect(screen.getByTestId('settings-section-advanced_all')).toHaveAttribute('aria-current', 'page'),
      { timeout: 5000 },
    );
    window.location.hash = '';
  });
});

/**
 * Sign in as a role with exactly these grants (RBAC on), instead of the auth-off default
 * where every grant is held. Restored after each test.
 */
function signInWith(grants: Record<string, string[]>) {
  vi.mocked(api.auth.me).mockResolvedValue({
    auth_enabled: true,
    authenticated: true,
    user: { username: 'viewer', role: 'analyst_tier1' },
  } as never);
  vi.mocked(api.account.permissions).mockResolvedValue({
    authenticated: true,
    role: 'analyst_tier1',
    custom_roles: [],
    rbac_enabled: true,
    permissions: grants,
  } as never);
}

describe('Settings Round 14 review fixes', () => {
  const defaultMe = { auth_enabled: false, authenticated: true, user: null };
  const defaultAccess = { authenticated: false, role: 'super_admin', custom_roles: [], rbac_enabled: false, permissions: {} };
  afterEach(() => {
    vi.mocked(api.auth.me).mockResolvedValue(defaultMe as never);
    vi.mocked(api.account.permissions).mockResolvedValue(defaultAccess as never);
    window.location.hash = '';
  });

  it('opens a hyphenated section id from the hash (#/settings?s=discounted-inference)', async () => {
    window.location.hash = '#/settings?s=discounted-inference';
    renderWithProviders(<Settings />);
    expect(
      await screen.findByRole('heading', { name: 'Discounted inference', level: 2 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('settings-section-discounted-inference')).toHaveAttribute('aria-current', 'page');
  });

  it('hides Discounted inference without models:read and refuses its deep link in place', async () => {
    signInWith({ settings: ['read'] });
    window.location.hash = '#/settings?s=discounted-inference';
    renderWithProviders(<Settings />);
    // The deep link keeps its section and says why it cannot open (roles-06), instead of a
    // silent switch to the first section the viewer can see.
    const notice = await screen.findByTestId('settings-section-restricted', undefined, { timeout: 5000 });
    // The Console's one permission state, under the section's own title.
    expect(notice).toHaveTextContent('Access restricted');
    expect(notice).toHaveTextContent('You do not have access to Discounted inference.');
    expect(notice).toHaveAccessibleName('Discounted inference');
    expect(
      within(notice).getByRole('heading', { level: 2, name: 'Discounted inference' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings?s=discounted-inference');
    expect(screen.queryByTestId('settings-section-discounted-inference')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Batch routing' })).not.toBeInTheDocument();
    // Neither the view-only warning nor the save note belongs to a section that is refused.
    expect(screen.queryByTestId('settings-view-only')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-save-note')).not.toBeInTheDocument();
    // Runbooks needs settings management, which this viewer lacks.
    expect(screen.queryByTestId('settings-section-runbooks')).not.toBeInTheDocument();
  });

  it.each([
    ['#/settings?s=admin_users', 'Users'],
    ['#/settings?s=data_export', 'Data export'],
    ['#/settings?s=notifications', 'Alerting & notifications'],
  ])('refuses the deep link %s with the Restricted notice and sends none of its reads', async (hash, title) => {
    vi.mocked(api.users.list).mockClear();
    signInWith({ settings: ['read'], cases: ['read'] });
    window.location.hash = hash;
    renderWithProviders(<Settings />);
    const notice = await screen.findByTestId('settings-section-restricted', undefined, { timeout: 5000 });
    expect(notice).toHaveTextContent(`You do not have access to ${title}.`);
    expect(within(notice).getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    expect(window.location.hash).toBe(hash);
    // No rail item is current: the refused section is not one the rail offers.
    expect(screen.getByRole('navigation', { name: 'Settings categories' }).querySelector('[aria-current="page"]')).toBeNull();
    // The Users body (GET /api/users needs users:manage) never mounts, so it never asks.
    expect(api.users.list).not.toHaveBeenCalled();
  }, 15_000);

  it('says the grants could not be loaded, with a Retry, instead of refusing a deep link', async () => {
    vi.mocked(api.auth.me).mockResolvedValue({
      auth_enabled: true,
      authenticated: true,
      user: { username: 'viewer', role: 'analyst_tier1' },
    } as never);
    vi.mocked(api.account.permissions).mockRejectedValue(new Error('grants offline'));
    window.location.hash = '#/settings?s=admin_users';
    renderWithProviders(<Settings />);
    const notice = await screen.findByTestId('settings-section-unavailable', undefined, { timeout: 5000 });
    expect(within(notice).getByRole('heading', { level: 2, name: 'Users' })).toBeInTheDocument();
    expect(notice).toHaveTextContent('Your permissions could not be loaded.');
    expect(screen.queryByText(/You do not have access/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-section-restricted')).not.toBeInTheDocument();
    // Retry loads the grants again; with them the section opens.
    signInWith({ settings: ['read'], users: ['manage'] });
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('settings-section-unavailable')).not.toBeInTheDocument());
    expect(screen.getByTestId('settings-section-admin_users')).toHaveAttribute('aria-current', 'page');
  }, 15_000);

  it('does not call a section view-only while the grants could not be loaded', async () => {
    vi.mocked(api.auth.me).mockResolvedValue({
      auth_enabled: true,
      authenticated: true,
      user: { username: 'viewer', role: 'analyst_tier1' },
    } as never);
    vi.mocked(api.account.permissions).mockRejectedValue(new Error('grants offline'));
    window.location.hash = '#/settings?s=general';
    renderWithProviders(<Settings />);
    const indexPattern = await screen.findByLabelText('Log index pattern', undefined, { timeout: 5000 });
    const active = screen.getByTestId('settings-active-section');
    // The save check denies only because the grants read failed, which says nothing about
    // the role: the load failure and its Retry stand where the view-only warning would.
    expect(screen.queryByTestId('settings-view-only')).not.toBeInTheDocument();
    expect(screen.queryByText(/needs the settings management permission/)).not.toBeInTheDocument();
    expect(screen.queryByText(/You can view these settings but not change them/)).not.toBeInTheDocument();
    const notice = within(active).getByTestId('grants-unknown');
    expect(notice).toHaveTextContent('Your permissions could not be loaded.');
    expect(notice).toHaveTextContent('Try again to check whether you can change these settings.');
    // An edit shows the bar with Save off and the same load failure, not a refusal.
    await userEvent.clear(indexPattern);
    await userEvent.type(indexPattern, 'x-*');
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar).toHaveTextContent('Your permissions could not be loaded.');
    expect(bar).not.toHaveTextContent('You can view these settings but not change them.');
    expect(within(bar).getByRole('button', { name: 'Save changes' })).toBeDisabled();
    // Retry loads the grants again; with settings management the section can be saved.
    signInWith({ settings: ['read', 'manage'] });
    await userEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('grants-unknown')).not.toBeInTheDocument());
    expect(screen.queryByTestId('settings-view-only')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save changes' }),
    ).toBeEnabled();
    expect(api.putSettings).not.toHaveBeenCalled();
  }, 15_000);

  it('moves from a refused deep link to the first match once the viewer searches', async () => {
    signInWith({ settings: ['read'] });
    window.location.hash = '#/settings?s=admin_users';
    renderWithProviders(<Settings />);
    await screen.findByTestId('settings-section-restricted', undefined, { timeout: 5000 });
    await userEvent.type(screen.getAllByRole('textbox', { name: 'Search settings sections' })[0], 'profile');
    await waitFor(() => expect(screen.getByTestId('settings-section-profile')).toHaveAttribute('aria-current', 'page'));
    expect(screen.queryByTestId('settings-section-restricted')).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings?s=profile');
  });

  it('shows a read-only viewer the warning, keeps Save off, and disables Discounted inference', async () => {
    signInWith({ settings: ['read'], models: ['read'] });
    window.location.hash = '#/settings?s=discounted-inference';
    renderWithProviders(<Settings />);
    await screen.findByRole('heading', { name: 'Discounted inference', level: 2 }, { timeout: 5000 });
    const warning = screen.getByTestId('settings-view-only');
    expect(warning).toHaveTextContent('You can view these settings but not change them');
    expect(warning).toHaveAttribute('data-callout', 'warning');
    expect(screen.getByRole('switch', { name: 'Batch routing' })).toBeDisabled();

    // A section that saves through the page: an edit shows the bar with Save off.
    await userEvent.click(screen.getByTestId('settings-section-general'));
    const indexPattern = await screen.findByLabelText('Log index pattern');
    expect(screen.getByTestId('settings-view-only')).toBeInTheDocument();
    await userEvent.clear(indexPattern);
    await userEvent.type(indexPattern, 'x-*');
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar).toHaveTextContent('You can view these settings but not change them.');
    expect(within(bar).getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(api.putSettings).not.toHaveBeenCalled();
  });

  it('does not show the read-only warning on a section that saves through its own controls', async () => {
    signInWith({ settings: ['read'], models: ['read'] });
    window.location.hash = '#/settings?s=profile';
    renderWithProviders(<Settings />);
    await screen.findByRole('heading', { name: 'Profile', level: 2 }, { timeout: 5000 });
    expect(screen.queryByTestId('settings-view-only')).not.toBeInTheDocument();
  });

  // Each case mounts the whole Settings page and opens a section (the heaviest sweep in
  // this file). Under a loaded test:strict run a mount can take seconds, so every wait has
  // an explicit timeout and each case gets 15 s, three times the slowest wait it holds.
  it.each(['detection', 'enrichment', 'admin_users', 'sessions', 'admin_sessions', 'discounted-inference'])(
    'shows %s the registry help, never a second copy from the section body',
    async (id) => {
      window.location.hash = `#/settings?s=${id}`;
      const meta = SECTION_META_BY_ID[id];
      renderWithProviders(<Settings />);
      const tip = await screen.findByRole('button', { name: `About ${meta.title}` }, { timeout: 5000 });
      await userEvent.click(tip);
      expect(await screen.findByText(meta.help as string, undefined, { timeout: 5000 })).toBeInTheDocument();
    },
    15_000,
  );

  it('names the unsaved state in the compact section button, and draws the dot in forced colours', async () => {
    window.location.hash = '#/settings?s=general';
    renderWithProviders(<Settings />);
    const indexPattern = await screen.findByLabelText('Log index pattern');
    const trigger = screen.getByTestId('settings-mobile-nav-trigger');
    expect(trigger).toHaveAccessibleName('Settings section: Data scope. Choose a section');
    await userEvent.type(indexPattern, 'x');
    expect(trigger).toHaveAccessibleName('Settings section: Data scope, unsaved changes. Choose a section');
    const dot = screen.getByTestId('settings-section-general').querySelector('[data-settings-dirty-dot]') as HTMLElement;
    expect(dot.className).toContain('forced-colors:bg-[CanvasText]');
    expect(dot.className).toContain('forced-colors:[forced-color-adjust:none]');
  });

  it('labels the rail groups as groups inside the one navigation landmark', async () => {
    renderWithProviders(<Settings />);
    await screen.findByTestId('settings-section-general', undefined, { timeout: 5000 });
    expect(screen.getByRole('group', { name: 'General' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Settings categories' });
    expect(nav.querySelectorAll('section')).toHaveLength(0);
  });

  it('states the kill switch from the saved settings, never from the draft', async () => {
    window.location.hash = '#/settings?s=advanced';
    renderWithProviders(<Settings />);
    const toggle = await screen.findByRole('switch', { name: 'Kill switch' }, { timeout: 5000 });
    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    // Turned on in the draft only: nothing is stopped yet, so no warning.
    expect(screen.queryByText('The kill switch is on')).not.toBeInTheDocument();
  });
});

describe('Overview page — render smoke', () => {
  it('mounts without throwing through the loading→ready transition', async () => {
    // Augment the mocked api with the calls Overview's load() makes. The module
    // mock above only stubs a subset, so add Overview's surface here.
    const { api } = await import('@/lib/api');
    const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
    Object.assign(api as Record<string, unknown>, {
      listCases: ok({ cases: [], total: 0 }),
      getMetrics: ok({ by_status: {}, by_verdict: {}, total_cases: 0 }),
      usageSummary: ok({
        total_cost: 0,
        total_tokens: 0,
        total_calls: 0,
        by_model: [],
        by_role: [],
        by_surface: [],
        series: [],
      }),
      ragStats: ok({ total_chunks: 0, document_count: 0, embedding_model: '', vector_dims: 0, by_source: [] }),
    });

    renderWithProviders(<Overview />);

    // The Overview hero renders after the data resolves. Anchor on the stable
    // `page-hero` testid (reword-proof) + the current title constant.
    await waitFor(() => expect(screen.getByTestId('page-hero')).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(screen.getByTestId('page-hero')).toHaveTextContent(PAGE_TITLE);
  });
});
